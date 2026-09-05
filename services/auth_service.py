import re
import secrets
from datetime import datetime, timedelta
from sqlalchemy.exc import SQLAlchemyError, IntegrityError
from models import db, User, CartItem
from email_service import send_verification_email, EmailSendError

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_.]{3,80}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD_LENGTH = 8
VERIFICATION_CODE_TTL_MINUTES = 10


def validate_username(username):
    if not username or not USERNAME_RE.match(username):
        return False, "Username must be 3-80 characters (letters, numbers, underscore, period only)"
    return True, None


def validate_email(email):
    if not email or not EMAIL_RE.match(email):
        return False, "Please enter a valid email address"
    return True, None


def _generate_verification_code():
    """6-digit numeric code, e.g. '042317'. Uses secrets, not random,
    since this gates account access."""
    return f"{secrets.randbelow(1_000_000):06d}"


def validate_password_strength(password):
    if not password or len(password) < MIN_PASSWORD_LENGTH:
        return False, f"Password must be at least {MIN_PASSWORD_LENGTH} characters"
    return True, None


def register_user(username, phone_number, email, password, social_platform=None, social_handle=None):
    """
    Creates a new, unverified user with a securely hashed password and
    emails them a 6-digit verification code. Returns (user, error) —
    user is None on failure, error is a user-safe message. The row is
    committed immediately (is_verified=False) rather than held in
    memory, so login/authenticate_user is what actually gates access
    until verify_email_code() is called.

    Uniqueness is enforced both here (pre-check for a fast, friendly
    error) and at the DB level (unique constraints on username/email)
    to close the race-condition window between check and insert.

    If a matching username or email already exists but was never
    verified, signup is blocked (not silently resumed) — the caller is
    told to use "resend code" from the login page instead, per product
    decision, so a duplicate submit doesn't quietly regenerate codes
    for an address someone else may have mistyped.
    """
    valid, err = validate_username(username)
    if not valid:
        return None, err

    valid, err = validate_email(email)
    if not valid:
        return None, err

    valid, err = validate_password_strength(password)
    if not valid:
        return None, err

    if not phone_number:
        return None, "Phone number is required"

    try:
        existing = User.query.filter(
            (User.username == username) | (User.email == email)
        ).first()
        if existing and not existing.is_verified:
            return None, (
                "An account with this username or email is already pending verification. "
                "Please use \"resend code\" on the login page."
            )
        if existing:
            return None, "Username or email is already taken"

        code = _generate_verification_code()
        user = User(
            username=username,
            phone_number=phone_number,
            email=email,
            social_platform=social_platform or None,
            social_handle=social_handle or None,
            is_verified=False,
            verification_code=code,
            verification_code_expires_at=datetime.utcnow() + timedelta(minutes=VERIFICATION_CODE_TTL_MINUTES),
        )
        user.set_password(password)

        db.session.add(user)
        db.session.commit()

        try:
            send_verification_email(email, code)
        except EmailSendError:
            # The account row exists and is correctly unverified either
            # way; the person can retry via "resend code" on login.
            # We still surface an error here so signup doesn't silently
            # report success while no email actually went out.
            return None, "Could not send verification email. Please try again or contact support."

        return user, None
    except IntegrityError:
        db.session.rollback()
        return None, "Username or email is already taken"
    except SQLAlchemyError as e:
        db.session.rollback()
        return None, f"Database error: {str(e)}"


def verify_email_code(email, code):
    """
    Checks the submitted code against the pending user's stored code
    and expiry. On success, marks the account verified and clears the
    code fields so it can't be replayed. Returns (user, error).
    """
    if not email or not code:
        return None, "Email and verification code are required"

    try:
        user = User.query.filter_by(email=email).first()
        # Same generic-error approach as authenticate_user: don't reveal
        # whether the email exists.
        if not user:
            return None, "Invalid or expired verification code"

        if user.is_verified:
            return None, "This account is already verified"

        if not user.verification_code or not user.verification_code_expires_at:
            return None, "Invalid or expired verification code"

        if datetime.utcnow() > user.verification_code_expires_at:
            return None, "Verification code has expired. Please request a new one."

        if not secrets.compare_digest(user.verification_code, code):
            return None, "Invalid or expired verification code"

        user.is_verified = True
        user.verification_code = None
        user.verification_code_expires_at = None
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
    exists, so this endpoint can't be used to enumerate registered
    emails — the real outcome only differs in whether an email
    actually goes out, not in the response.
    """
    if not email:
        return False, "Email is required"

    try:
        user = User.query.filter_by(email=email).first()
        if not user or user.is_verified:
            return True, None

        code = _generate_verification_code()
        user.verification_code = code
        user.verification_code_expires_at = datetime.utcnow() + timedelta(minutes=VERIFICATION_CODE_TTL_MINUTES)
        db.session.commit()

        try:
            send_verification_email(email, code)
        except EmailSendError:
            return False, "Could not send verification email. Please try again."

        return True, None
    except SQLAlchemyError as e:
        db.session.rollback()
        return False, f"Database error: {str(e)}"


def authenticate_user(username, password):
    """
    Validates credentials. Returns (user, error, error_code).
    error_code is "unverified" when the credentials are correct but the
    account hasn't completed email verification yet — distinguished
    from bad credentials so the frontend can offer a "resend code"
    action specifically in that case, without this generic-error
    function otherwise revealing whether a username exists.
    """
    if not username or not password:
        return None, "Username and password are required", None

    try:
        user = User.query.filter_by(username=username).first()
        if not user or not user.check_password(password):
            return None, "Invalid username or password", None
        if not user.is_verified:
            return None, "Please verify your email before logging in.", "unverified"
        return user, None, None
    except SQLAlchemyError as e:
        return None, f"Database error: {str(e)}", None


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

