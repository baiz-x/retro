import os
import secrets
from functools import wraps
from flask import request, jsonify

ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")
ADMIN_API_KEY = os.environ.get("ADMIN_API_KEY")


def verify_admin_credentials(username, password):
    """
    Verifies the provided username and password against environment variables.
    Uses constant-time comparison to prevent timing attacks.

    Args:
        username (str): The username to verify.
        password (str): The password to verify.

    Returns:
        bool: True if credentials match, False otherwise.
    """
    if not (ADMIN_USERNAME and ADMIN_PASSWORD):
        return False

    valid_username = secrets.compare_digest(username, ADMIN_USERNAME)
    valid_password = secrets.compare_digest(password, ADMIN_PASSWORD)

    return valid_username and valid_password


def verify_admin_api_key(req):
    """
    Verifies the API key present in the request cookies.
    Checks for the 'admin_token' cookie against the ADMIN_API_KEY env var.

    Args:
        req (flask.Request): The incoming Flask request object.

    Returns:
        bool: True if the API key is valid, False otherwise.
    """
    if not ADMIN_API_KEY:
        return False

    admin_token = req.cookies.get("admin_token")

    if not admin_token:
        return False

    return secrets.compare_digest(admin_token, ADMIN_API_KEY)


def admin_required(f):
    """
    Decorator to protect routes that require admin authentication.
    Verifies the admin API key from the cookie before proceeding.
    Returns a 401 Unauthorized JSON response if verification fails.
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not verify_admin_api_key(request):
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)

    return decorated_function
