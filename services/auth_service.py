import re
import hashlib
import secrets
from datetime import datetime, timedelta
from sqlalchemy.exc import SQLAlchemyError, IntegrityError
from models import db, User, CartItem
from services.email_service import send_verification_email, send_password_reset_email, EmailSendError

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD_LENGTH = 8
VERIFICATION_CODE_TTL_MINUTES = 10
VERIFICATION_RESEND_COOLDOWN_SECONDS = 60
MAX_VERIFICATION_ATTEMPTS = 5
PASSWORD_RESET_TOKEN_TTL_MINUTES = 30
PASSWORD_RESET_COOLDOWN_SECONDS = 60


def validate_name(name):
    """
    Just a presence/length check — name is deliberately NOT unique
    (see User.name in models/user.py), so there's no lookup here, only
    basic sanity on the input itself.
    """
    if not name or not name.strip():
        return False, "Name is required"
    if len(name.strip()) > 120:
        return False, "Name must be 120 characters or fewer"
    return True, None


def validate_address(address):
    if not address or not address.strip():
        return False, "Address is required"
    return True, None


def validate_email(email):
    if not email or not EMAIL_RE.match(email):
        return False, "Please enter a valid email address"
    return True, None


def _generate_verification_code():
    """6-digit numeric code, e.g. '042317'. Uses secrets, not random,
    since this gates account access."""
    return f"{secrets.randbelow(1_000_000):06d}"


def _cooldown_active(expires_at, ttl_minutes, cooldown_seconds):
    """
    True if something was issued less than `cooldown_seconds` ago.
    "Issued at" is derived as expires_at - ttl, so no extra DB column
    is needed to track when a code/token was last sent.
    """
    if not expires_at:
        return False
    issued_at = expires_at - timedelta(minutes=ttl_minutes)
    return datetime.utcnow() < issued_at + timedelta(seconds=cooldown_seconds)


def _issue_verification_code(user):
    """
    Generates a fresh 6-digit code for `user`, resets the wrong-guess
    counter, and emails it. Returns (ok, error).

    If a code was issued less than VERIFICATION_RESEND_COOLDOWN_SECONDS
    ago, nothing is sent and (True, None) is returned — deliberately
    indistinguishable from a real send, so callers (signup, login,
    resend) don't leak anything and the earlier code stays valid.

    If the email fails to send, the code is cleared again so the
    cooldown doesn't block an immediate retry for a code that never
    reached anyone.
    """
    if _cooldown_active(user.verification_code_expires_at,
                        VERIFICATION_CODE_TTL_MINUTES,
                        VERIFICATION_RESEND_COOLDOWN_SECONDS):
        return True, None

    code = _generate_verification_code()
    user.verification_code = code
    user.verification_code_expires_at = datetime.utcnow() + timedelta(minutes=VERIFICATION_CODE_TTL_MINUTES)
    user.verification_attempts = 0
    db.session.commit()

    try:
        send_verification_email(user.email, code)
    except EmailSendError:
        user.verification_code = None
        user.verification_code_expires_at = None
        db.session.commit()
        return False, "Could not send verification email. Please try again."

    return True, None


def _hash_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def validate_password_strength(password):
    if not password or len(password) < MIN_PASSWORD_LENGTH:
        return False, f"Password must be at least {MIN_PASSWORD_LENGTH} characters"
    return True, None


def register_user(name, phone_number, email, address, password, social_platform=None, social_handle=None):
    """
    Creates a new, unverified user with a securely hashed password and
    emails them a 6-digit verification code. Returns (user, error) —
    user is None on failure, error is a user-safe message. The row is
    committed immediately (is_verified=False) rather than held in
    memory, so login/authenticate_user is what actually gates access
    until verify_email_code() is called.

    Only email is checked for uniqueness — name is deliberately NOT
    unique (two people can share a name; email is the login
    identifier, see authenticate_user). Uniqueness is enforced both
    here (pre-check for a fast, friendly error) and at the DB level
    (unique constraint on email) to close the race-condition window
    between check and insert.

    If a matching email already exists but was never verified, the
    stored details (name, phone, address, password, social) are left
    untouched and the newly submitted ones are ignored. A fresh code
    is sent (subject to the resend cooldown, see
    _issue_verification_code) and the existing user is returned, so
    the frontend jumps straight to the code-entry step — the response
    is identical to a brand-new signup, so it reveals nothing new about
    the email. Trade-off: someone who mistyped their password at their
    first signup keeps that password until they use forgot-password.
    """
    valid, err = validate_name(name)
    if not valid:
        return None, err

    valid, err = validate_email(email)
    if not valid:
        return None, err

    valid, err = validate_address(address)
    if not valid:
        return None, err

    valid, err = validate_password_strength(password)
    if not valid:
        return None, err

    if not phone_number:
        return None, "Phone number is required"

    try:
        existing = User.query.filter_by(email=email).first()
        if existing and not existing.is_verified:
            ok, err = _issue_verification_code(existing)
            if not ok:
                return None, err
            return existing, None
        if existing:
            return None, "An account with this email already exists"

        user = User(
            name=name.strip(),
            phone_number=phone_number,
            email=email,
            address=address.strip(),
            social_platform=social_platform or None,
            social_handle=social_handle or None,
            is_verified=False,
        )
        user.set_password(password)

        db.session.add(user)
        db.session.commit()

        # The account row exists and is correctly unverified either
        # way; if the email fails the person can retry by submitting
        # signup again (or logging in) — both resend a code.
        ok, err = _issue_verification_code(user)
        if not ok:
            return None, "Could not send verification email. Please try again or contact support."

        return user, None
    except IntegrityError:
        db.session.rollback()
        return None, "An account with this email already exists"
    except SQLAlchemyError as e:
        db.session.rollback()
        return None, f"Database error: {str(e)}"


def verify_email_code(email, code):
    """
    Checks the submitted code against the pending user's stored code
    and expiry. On success, marks the account verified and clears the
    code fields so it can't be replayed. Returns (user, error).

    Wrong guesses are counted per code; after MAX_VERIFICATION_ATTEMPTS
    the code is locked (even the correct code is refused) until a new
    one is issued. The row is locked (SELECT ... FOR UPDATE) for the
    duration so parallel requests can't race past the limit.
    """
    if not email or not code:
        return None, "Email and verification code are required"

    try:
        user = User.query.filter_by(email=email).with_for_update().first()
        # Same generic-error approach as authenticate_user: don't reveal
        # whether the email exists.
        if not user:
            return None, "Invalid or expired verification code"

        if user.is_verified:
            return None, "This account is already verified"

        if not user.verification_code or not user.verification_code_expires_at:
            return None, "Invalid or expired verification code"

        if user.verification_attempts >= MAX_VERIFICATION_ATTEMPTS:
            return None, "Too many incorrect attempts. Please request a new code."

        if datetime.utcnow() > user.verification_code_expires_at:
            return None, "Verification code has expired. Please request a new one."

        if not secrets.compare_digest(user.verification_code.encode("utf-8"), code.encode("utf-8")):
            user.verification_attempts += 1
            db.session.commit()
            if user.verification_attempts >= MAX_VERIFICATION_ATTEMPTS:
                return None, "Too many incorrect attempts. Please request a new code."
            return None, "Invalid or expired verification code"

        user.is_verified = True
        user.verification_code = None
        user.verification_code_expires_at = None
        user.verification_attempts = 0
        db.session.commit()
        return user, None
    except SQLAlchemyError as e:
        db.session.rollback()
        return None, f"Database error: {str(e)}"


def resend_verification_code(email):
    """
    Regenerates and re-sends a verification code for an existing,
    unverified account. Returns (success: bool, error). Deliberately
    returns success=True even when no matching unverified account
    exists, or when the resend cooldown is still active, so this
    endpoint can't be used to enumerate registered emails — the real
    outcome only differs in whether an email actually goes out, not in
    the response.
    """
    if not email:
        return False, "Email is required"

    try:
        user = User.query.filter_by(email=email).first()
        if not user or user.is_verified:
            return True, None

        return _issue_verification_code(user)
    except SQLAlchemyError as e:
        db.session.rollback()
        return False, f"Database error: {str(e)}"


def authenticate_user(email, password):
    """
    Validates credentials. Returns (user, error, error_code).
    error_code is "unverified" when the credentials are correct but the
    account hasn't completed email verification yet — distinguished
    from bad credentials so the frontend can offer a "resend code"
    action specifically in that case, without this generic-error
    function otherwise revealing whether an email is registered.

    Looks up by email (not name) — name is not unique, so it can't
    identify a single account (see User.name in models/user.py).
    """
    if not email or not password:
        return None, "Email and password are required", None

    try:
        user = User.query.filter_by(email=email).first()
        if not user or not user.check_password(password):
            return None, "Invalid email or password", None
        if not user.is_verified:
            return None, "Please verify your email before logging in.", "unverified"
        return user, None, None
    except SQLAlchemyError as e:
        return None, f"Database error: {str(e)}", None


def update_profile_fields(user_id, name=None, phone_number=None, address=None,
                           social_platform=None, social_handle=None):
    """
    Updates the non-sensitive profile fields on the account settings
    page. Email and password are handled by their own dedicated
    functions below (email needs re-verification; password needs
    current-password confirmation), so neither is touched here even
    if passed in.

    Each field is optional — only the ones actually provided (not
    None) are validated and updated, so a partial-form submit from
    the frontend doesn't wipe out fields the user didn't touch.
    Returns (user, error).
    """
    try:
        user = User.query.get(user_id)
        if not user:
            return None, "Account not found"

        if name is not None:
            valid, err = validate_name(name)
            if not valid:
                return None, err
            user.name = name.strip()

        if phone_number is not None:
            if not phone_number.strip():
                return None, "Phone number is required"
            user.phone_number = phone_number.strip()

        if address is not None:
            valid, err = validate_address(address)
            if not valid:
                return None, err
            user.address = address.strip()

        # Social handle is optional even when the platform is set, and
        # vice versa isn't enforced here — matches register_user, which
        # also accepts either independently.
        if social_platform is not None:
            user.social_platform = social_platform.strip() or None
        if social_handle is not None:
            user.social_handle = social_handle.strip() or None

        db.session.commit()
        return user, None
    except SQLAlchemyError as e:
        db.session.rollback()
        return None, f"Database error: {str(e)}"


def request_email_change(user_id, new_email, current_password):
    """
    Changes the account's email address immediately and re-triggers
    verification — same pattern as a fresh signup: `email` is
    overwritten right away, `is_verified` flips to False, and a new
    6-digit code is emailed to the new address using the existing
    verification_code/verification_code_expires_at columns (no
    separate pending_* fields).

    Requires the current password first (so a hijacked logged-in
    session can't redirect the account to an attacker's address).

    Effect: the OLD email stops being usable immediately (login is
    blocked while is_verified is False — see authenticate_user). The
    current browser session is NOT cleared, so this device stays
    logged in; it's the next login attempt (this device or another)
    that requires verify_email_code() first. Returns (user, error).
    """
    new_email = (new_email or "").strip().lower()

    valid, err = validate_email(new_email)
    if not valid:
        return None, err

    if not current_password:
        return None, "Please enter your current password to change your email"

    try:
        user = User.query.get(user_id)
        if not user:
            return None, "Account not found"

        if not user.check_password(current_password):
            return None, "Current password is incorrect"

        if new_email == user.email:
            return None, "That's already your current email address"

        existing = User.query.filter(User.email == new_email, User.id != user.id).first()
        if existing:
            return None, "That email address is already in use"

        code = _generate_verification_code()
        user.email = new_email
        user.is_verified = False
        user.verification_code = code
        user.verification_code_expires_at = datetime.utcnow() + timedelta(minutes=VERIFICATION_CODE_TTL_MINUTES)
        user.verification_attempts = 0
        db.session.commit()

        try:
            send_verification_email(new_email, code)
        except EmailSendError:
            # Clear the code so the resend cooldown doesn't block a
            # retry for a code that never went out.
            user.verification_code = None
            user.verification_code_expires_at = None
            db.session.commit()
            # The email column is already changed and is_verified is
            # already False at this point — same as register_user's
            # equivalent case, we don't roll that back (the row is
            # correctly in an unverified state either way); the user
            # can retry via resend_verification_code.
            return None, "Could not send verification email. Please try again or contact support."

        return user, None
    except IntegrityError:
        db.session.rollback()
        return None, "That email address is already in use"
    except SQLAlchemyError as e:
        db.session.rollback()
        return None, f"Database error: {str(e)}"


def change_password(user_id, current_password, new_password):
    """
    Requires the current password (standard re-auth-for-sensitive-
    action pattern — same reasoning as request_email_change above),
    validates the new password's strength, and rejects a "new"
    password identical to the current one. Session is left alive
    (no forced re-login) — matches how signup/login work today.
    Returns (user, error).
    """
    if not current_password:
        return None, "Please enter your current password"

    valid, err = validate_password_strength(new_password)
    if not valid:
        return None, err

    try:
        user = User.query.get(user_id)
        if not user:
            return None, "Account not found"

        if not user.check_password(current_password):
            return None, "Current password is incorrect"

        if user.check_password(new_password):
            return None, "New password must be different from your current password"

        user.set_password(new_password)
        db.session.commit()
        return user, None
    except SQLAlchemyError as e:
        db.session.rollback()
        return None, f"Database error: {str(e)}"


def request_password_reset(email):
    """
    Starts a password reset: generates a single-use random token,
    stores only its SHA-256 hash with an expiry, and emails the person
    a link containing the raw token. Returns (success: bool, error).

    Like resend_verification_code, returns success=True when the email
    isn't registered or the cooldown is still active, so the endpoint
    can't be used to enumerate accounts. Requesting a new link
    replaces (invalidates) any earlier unused one. Works for
    unverified accounts too — see reset_password_with_token.
    """
    valid, err = validate_email(email)
    if not valid:
        return False, err

    try:
        user = User.query.filter_by(email=email).first()
        if not user:
            return True, None

        if _cooldown_active(user.reset_token_expires_at,
                            PASSWORD_RESET_TOKEN_TTL_MINUTES,
                            PASSWORD_RESET_COOLDOWN_SECONDS):
            return True, None

        token = secrets.token_urlsafe(32)
        user.reset_token_hash = _hash_token(token)
        user.reset_token_expires_at = datetime.utcnow() + timedelta(minutes=PASSWORD_RESET_TOKEN_TTL_MINUTES)
        db.session.commit()

        try:
            send_password_reset_email(user.email, token, PASSWORD_RESET_TOKEN_TTL_MINUTES)
        except EmailSendError:
            user.reset_token_hash = None
            user.reset_token_expires_at = None
            db.session.commit()
            return False, "Could not send reset email. Please try again."

        return True, None
    except SQLAlchemyError as e:
        db.session.rollback()
        return False, f"Database error: {str(e)}"


def reset_password_with_token(token, new_password):
    """
    Completes a password reset. Looks the user up by the hash of the
    submitted token, checks expiry, sets the new password, and burns
    the token (single use). Returns (user, error).

    A successful reset also marks the email verified and clears any
    pending verification code: the person just proved they control the
    inbox by clicking a link sent to it, so making them verify again
    would be redundant. It does NOT log them in — they go back to the
    login page.

    The token is 256 bits of randomness, so guessing is infeasible and
    no attempt counter is needed here (unlike the 6-digit
    verification code).
    """
    invalid_msg = "This reset link is invalid or has expired. Please request a new one."

    if not token or not isinstance(token, str):
        return None, invalid_msg

    valid, err = validate_password_strength(new_password)
    if not valid:
        return None, err

    try:
        user = User.query.filter_by(reset_token_hash=_hash_token(token)).with_for_update().first()
        if (not user
                or not user.reset_token_expires_at
                or datetime.utcnow() > user.reset_token_expires_at):
            return None, invalid_msg

        user.set_password(new_password)
        user.reset_token_hash = None
        user.reset_token_expires_at = None
        user.is_verified = True
        user.verification_code = None
        user.verification_code_expires_at = None
        user.verification_attempts = 0
        db.session.commit()
        return user, None
    except SQLAlchemyError as e:
        db.session.rollback()
        return None, f"Database error: {str(e)}"


def migrate_guest_cart_to_user(guest_id, user_id):
    """
    Re-parents every cart line from a guest_id to a logged-in user_id,
    called right after signup/login. If the user already had items in
    their own cart from a previous session, guest lines are simply
    added alongside them (no merge/dedupe of identical product+variant
    rows — same behavior as the cart naturally allowing repeat rows
    today).
    """
    if not guest_id:
        return
    try:
        CartItem.query.filter_by(guest_id=guest_id).update({
            "user_id": user_id,
            "guest_id": None
        })
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()
        raise



