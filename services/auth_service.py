import re
from sqlalchemy.exc import SQLAlchemyError, IntegrityError
from models import db, User, CartItem

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_.]{3,80}$")
MIN_PASSWORD_LENGTH = 8


def validate_username(username):
    if not username or not USERNAME_RE.match(username):
        return False, "Username must be 3-80 characters (letters, numbers, underscore, period only)"
    return True, None


def validate_password_strength(password):
    if not password or len(password) < MIN_PASSWORD_LENGTH:
        return False, f"Password must be at least {MIN_PASSWORD_LENGTH} characters"
    return True, None


def register_user(username, phone_number, password, social_platform=None, social_handle=None):
    """
    Creates a new user with a securely hashed password. Returns
    (user, error) — user is None on failure, error is a user-safe
    message. Uniqueness is enforced both here (pre-check for a fast,
    friendly error) and at the DB level (unique constraint on
    username) to close the race-condition window between check and
    insert.
    """
    valid, err = validate_username(username)
    if not valid:
        return None, err

    valid, err = validate_password_strength(password)
    if not valid:
        return None, err

    if not phone_number:
        return None, "Phone number is required"

    try:
        existing = User.query.filter_by(username=username).first()
        if existing:
            return None, "Username is already taken"

        user = User(
            username=username,
            phone_number=phone_number,
            social_platform=social_platform or None,
            social_handle=social_handle or None,
        )
        user.set_password(password)

        db.session.add(user)
        db.session.commit()
        return user, None
    except IntegrityError:
        db.session.rollback()
        return None, "Username is already taken"
    except SQLAlchemyError as e:
        db.session.rollback()
        return None, f"Database error: {str(e)}"


def authenticate_user(username, password):
    """
    Validates credentials. Returns (user, error). Uses a generic error
    message for both "no such user" and "wrong password" so a failed
    login never reveals whether the username exists (standard
    enumeration-prevention practice).
    """
    if not username or not password:
        return None, "Username and password are required"

    try:
        user = User.query.filter_by(username=username).first()
        if not user or not user.check_password(password):
            return None, "Invalid username or password"
        return user, None
    except SQLAlchemyError as e:
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
