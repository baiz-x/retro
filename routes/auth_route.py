import logging
from functools import wraps
from flask import Blueprint, request, jsonify, session
from models import User
from services.auth_service import (
    register_user,
    authenticate_user,
    migrate_guest_cart_to_user,
    verify_email_code,
    resend_verification_code,
    update_profile_fields,
    request_email_change,
    change_password,
)

logger = logging.getLogger(__name__)

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")


def api_login_required(view_func):
    """
    Guards the account-editing JSON routes below. Lives here (not a
    separate decorators.py) since it's only used within this
    blueprint. Returns 401 JSON rather than a redirect — a fetch()
    call can't usefully follow an HTML redirect.
    """
    @wraps(view_func)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        return view_func(*args, **kwargs)
    return wrapped



def _log_user_in(user):
    """
    Rotates the session on login/signup (session.clear() before setting
    user_id) to prevent session fixation — an attacker who fixed a
    victim's pre-login session id gets a dead session, not an
    authenticated one. guest_id is deliberately preserved across the
    clear so the cart migration below still has something to migrate.
    """
    guest_id = session.get("guest_id")
    session.clear()
    if guest_id:
        session["guest_id"] = guest_id
    session["user_id"] = user.id
    session.permanent = True


@auth_bp.route("/signup", methods=["POST"])
def signup():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"status": "error", "message": "Missing request body"}), 400

        name = (data.get("name") or "").strip()
        phone_number = (data.get("phone_number") or "").strip()
        email = (data.get("email") or "").strip().lower()
        address = (data.get("address") or "").strip()
        password = data.get("password") or ""
        social_platform = data.get("social_platform")
        social_handle = data.get("social_handle")

        user, error = register_user(name, phone_number, email, address, password, social_platform, social_handle)
        if error:
            return jsonify({"status": "error", "message": error}), 400

        # Account is created but unverified — no session yet. The
        # cart is NOT migrated here; that now happens on the
        # verify-email step below, once the account is actually usable.
        return jsonify({
            "status": "pending_verification",
            "message": "We've sent a verification code to your email.",
            "data": {"email": user.email},
        }), 201
    except Exception as e:
        logger.error(f"Unexpected error in signup: {str(e)}", exc_info=True)
        return jsonify({"status": "error", "message": "An internal error occurred"}), 500


@auth_bp.route("/login", methods=["POST"])
def login():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"status": "error", "message": "Missing request body"}), 400

        email = (data.get("email") or "").strip().lower()
        password = data.get("password") or ""

        user, error, error_code = authenticate_user(email, password)
        if error:
            body = {"status": "error", "message": error}
            if error_code:
                body["error_code"] = error_code
            return jsonify(body), 401

        guest_id = session.get("guest_id")
        _log_user_in(user)

        if guest_id:
            migrate_guest_cart_to_user(guest_id, user.id)

        return jsonify({"status": "success", "data": user.to_dict()}), 200
    except Exception as e:
        logger.error(f"Unexpected error in login: {str(e)}", exc_info=True)
        return jsonify({"status": "error", "message": "An internal error occurred"}), 500


@auth_bp.route("/verify-email", methods=["POST"])
def verify_email():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"status": "error", "message": "Missing request body"}), 400

        email = (data.get("email") or "").strip().lower()
        code = (data.get("code") or "").strip()

        user, error = verify_email_code(email, code)
        if error:
            return jsonify({"status": "error", "message": error}), 400

        # Now that the account is verified, log them in and migrate
        # any guest cart — mirrors what signup/login did before.
        guest_id = session.get("guest_id")
        _log_user_in(user)

        if guest_id:
            migrate_guest_cart_to_user(guest_id, user.id)

        return jsonify({"status": "success", "data": user.to_dict()}), 200
    except Exception as e:
        logger.error(f"Unexpected error in verify_email: {str(e)}", exc_info=True)
        return jsonify({"status": "error", "message": "An internal error occurred"}), 500


@auth_bp.route("/resend-code", methods=["POST"])
def resend_code():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"status": "error", "message": "Missing request body"}), 400

        email = (data.get("email") or "").strip().lower()

        success, error = resend_verification_code(email)
        if not success:
            return jsonify({"status": "error", "message": error}), 400

        # Always the same message whether or not the email existed —
        # see resend_verification_code's docstring on enumeration.
        return jsonify({
            "status": "success",
            "message": "If an account with that email needs verification, a new code has been sent.",
        }), 200
    except Exception as e:
        logger.error(f"Unexpected error in resend_code: {str(e)}", exc_info=True)
        return jsonify({"status": "error", "message": "An internal error occurred"}), 500


@auth_bp.route("/logout", methods=["POST"])
def logout():
    session.pop("user_id", None)
    return jsonify({"status": "success", "message": "Logged out"}), 200


@auth_bp.route("/update-profile", methods=["POST"])
@api_login_required
def update_profile():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"status": "error", "message": "Missing request body"}), 400

        # Distinguish "field omitted" (leave unchanged) from "field
        # sent as empty string" (validate/clear it) using a sentinel,
        # rather than data.get(...) which can't tell the two apart.
        _missing = object()
        name = data.get("name", _missing)
        phone_number = data.get("phone_number", _missing)
        address = data.get("address", _missing)
        social_platform = data.get("social_platform", _missing)
        social_handle = data.get("social_handle", _missing)

        user, error = update_profile_fields(
            session["user_id"],
            name=None if name is _missing else name,
            phone_number=None if phone_number is _missing else phone_number,
            address=None if address is _missing else address,
            social_platform=None if social_platform is _missing else social_platform,
            social_handle=None if social_handle is _missing else social_handle,
        )
        if error:
            return jsonify({"status": "error", "message": error}), 400

        return jsonify({"status": "success", "data": user.to_dict()}), 200
    except Exception as e:
        logger.error(f"Unexpected error in update_profile: {str(e)}", exc_info=True)
        return jsonify({"status": "error", "message": "An internal error occurred"}), 500


@auth_bp.route("/request-email-change", methods=["POST"])
@api_login_required
def request_email_change_route():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"status": "error", "message": "Missing request body"}), 400

        new_email = (data.get("new_email") or "").strip().lower()
        current_password = data.get("current_password") or ""

        user, error = request_email_change(session["user_id"], new_email, current_password)
        if error:
            return jsonify({"status": "error", "message": error}), 400

        # Email is already changed at this point (is_verified is now
        # False) — the response reflects the new live state, not a
        # pending one.
        return jsonify({
            "status": "pending_verification",
            "message": f"Your email has been changed to {user.email}. We've sent a verification code — please verify to keep logging in.",
            "data": user.to_dict(),
        }), 200
    except Exception as e:
        logger.error(f"Unexpected error in request_email_change_route: {str(e)}", exc_info=True)
        return jsonify({"status": "error", "message": "An internal error occurred"}), 500


@auth_bp.route("/confirm-email-change", methods=["POST"])
@api_login_required
def confirm_email_change_route():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"status": "error", "message": "Missing request body"}), 400

        code = (data.get("code") or "").strip()

        # Look the user up by session id (not a client-supplied email)
        # so confirmation is tied to the actual logged-in account, then
        # reuse verify_email_code — it already does exactly what's
        # needed here: check code/expiry against this same email
        # column and flip is_verified back to True.
        current_user = User.query.get(session["user_id"])
        if not current_user:
            return jsonify({"status": "error", "message": "Account not found"}), 400

        user, error = verify_email_code(current_user.email, code)
        if error:
            return jsonify({"status": "error", "message": error}), 400

        return jsonify({"status": "success", "data": user.to_dict()}), 200
    except Exception as e:
        logger.error(f"Unexpected error in confirm_email_change_route: {str(e)}", exc_info=True)
        return jsonify({"status": "error", "message": "An internal error occurred"}), 500


@auth_bp.route("/change-password", methods=["POST"])
@api_login_required
def change_password_route():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"status": "error", "message": "Missing request body"}), 400

        current_password = data.get("current_password") or ""
        new_password = data.get("new_password") or ""

        user, error = change_password(session["user_id"], current_password, new_password)
        if error:
            return jsonify({"status": "error", "message": error}), 400

        return jsonify({"status": "success", "message": "Password updated"}), 200
    except Exception as e:
        logger.error(f"Unexpected error in change_password_route: {str(e)}", exc_info=True)
        return jsonify({"status": "error", "message": "An internal error occurred"}), 500


@auth_bp.route("/me", methods=["GET"])
def me():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"status": "error", "message": "Not logged in"}), 401

    user = User.query.get(user_id)
    if not user:
        # Stale session pointing at a deleted user — clear it rather
        # than keep reporting "logged in" for an account that's gone.
        session.pop("user_id", None)
        return jsonify({"status": "error", "message": "Not logged in"}), 401

    return jsonify({"status": "success", "data": user.to_dict()}), 200


