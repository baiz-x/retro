import logging
from flask import Blueprint, request, jsonify, session
from models import User
from services.auth_service import register_user, authenticate_user, migrate_guest_cart_to_user

logger = logging.getLogger(__name__)

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")


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

        username = (data.get("username") or "").strip()
        phone_number = (data.get("phone_number") or "").strip()
        password = data.get("password") or ""
        social_platform = data.get("social_platform")
        social_handle = data.get("social_handle")

        user, error = register_user(username, phone_number, password, social_platform, social_handle)
        if error:
            return jsonify({"status": "error", "message": error}), 400

        guest_id = session.get("guest_id")
        _log_user_in(user)

        if guest_id:
            migrate_guest_cart_to_user(guest_id, user.id)

        return jsonify({"status": "success", "data": user.to_dict()}), 201
    except Exception as e:
        logger.error(f"Unexpected error in signup: {str(e)}", exc_info=True)
        return jsonify({"status": "error", "message": "An internal error occurred"}), 500


@auth_bp.route("/login", methods=["POST"])
def login():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"status": "error", "message": "Missing request body"}), 400

        username = (data.get("username") or "").strip()
        password = data.get("password") or ""

        user, error = authenticate_user(username, password)
        if error:
            return jsonify({"status": "error", "message": error}), 401

        guest_id = session.get("guest_id")
        _log_user_in(user)

        if guest_id:
            migrate_guest_cart_to_user(guest_id, user.id)

        return jsonify({"status": "success", "data": user.to_dict()}), 200
    except Exception as e:
        logger.error(f"Unexpected error in login: {str(e)}", exc_info=True)
        return jsonify({"status": "error", "message": "An internal error occurred"}), 500


@auth_bp.route("/logout", methods=["POST"])
def logout():
    session.pop("user_id", None)
    return jsonify({"status": "success", "message": "Logged out"}), 200


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
