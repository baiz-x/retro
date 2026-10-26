# wall.py
from flask import Flask, request, abort, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_compress import Compress
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_wtf import CSRFProtect
from flask_wtf.csrf import CSRFError
from whitenoise import WhiteNoise
from flask_talisman import Talisman
from werkzeug.middleware.proxy_fix import ProxyFix
import logging
from logging.handlers import RotatingFileHandler
import os
from datetime import timedelta
from models import db
# -------------------
# Logging
# -------------------
logger = logging.getLogger('my_logger')
logger.setLevel(logging.DEBUG)
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

# CHANGED: console level comes from LOG_LEVEL env (default INFO) so prod
# logs aren't flooded with DEBUG. Set LOG_LEVEL=DEBUG locally if you want it.
console_handler = logging.StreamHandler()
console_handler.setLevel(os.getenv('LOG_LEVEL', 'INFO').upper())
console_handler.setFormatter(formatter)
logger.addHandler(console_handler)

# CHANGED: file handler wrapped so a read-only / ephemeral filesystem
# can never crash app startup. Render's disk is wiped on every deploy,
# so stdout (console) is your real log on Render.
try:
    file_handler = RotatingFileHandler('app.log', maxBytes=10_000_000, backupCount=3)
    file_handler.setLevel(logging.INFO)
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
except OSError as e:
    logger.warning(f"File logging disabled: {e}")

# -------------------
# Extensions
# -------------------
compress = Compress()
# CHANGED: explicit storage URI. Defaults to in-memory (same as before, just
# without the warning). With >1 Gunicorn worker, limits are per-worker; set
# RATELIMIT_STORAGE_URI=redis://... on Render for shared limits.
limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=os.getenv('RATELIMIT_STORAGE_URI', 'memory://')
)
csrf = CSRFProtect()

# -------------------
# Config
# -------------------
ALLOWED_HOSTS = [
    'localhost',
    '127.0.0.1',
    'retro-7wxo.onrender.com',
    'markazussunnahbd.com',
    'www.markazussunnahbd.com'
]
TRUSTED_CRAWLERS = ["facebookexternalhit", "facebookcatalog", "googlebot", "bingbot"]
TARGET_URLS = [
    "https://fonts.googleapis.com",
    "https://fonts.gstatic.com",
    "https://cdn.jsdelivr.net",
    "https://unpkg.com",
    "https://assets9.lottiefiles.com",
    "https://cdn.tailwindcss.com",
    "https://cdnjs.cloudflare.com",
    "https://res.cloudinary.com"
]

# -------------------
# App Factory
# -------------------
def setup_security():
    app = Flask(__name__)

    # Config
    app.config['PREFERRED_URL_SCHEME'] = 'https'
    app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv('DATABASE_URI')
    app.config['SECRET_KEY'] = os.getenv('SECRET_KEY')
    app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
    app.config['SESSION_COOKIE_SECURE'] = True
    app.config['SESSION_COOKIE_HTTPONLY'] = True
    app.config['SESSION_COOKIE_SAMESITE'] = 'Strict'
    app.config['SESSION_REFRESH_EACH_REQUEST'] = False
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
    app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'pool_pre_ping': True}

    # WTF_CSRF_TIME_LIMIT unset (None) intentionally — a token tied to
    # the PERMANENT_SESSION_LIFETIME above (30 days) rather than
    # flask-wtf's default 1-hour expiry, since someone can legitimately
    # sit on a cart/checkout page (or stay logged in) far longer than
    # an hour before submitting. Every mutating route validates the
    # token via CSRFProtect below; the JS side re-fetches a fresh page
    # (and therefore a fresh token) on session expiry via the existing
    # /auth/me flow.
    app.config['WTF_CSRF_TIME_LIMIT'] = None

    if not app.config['SQLALCHEMY_DATABASE_URI'] or not app.config['SECRET_KEY']:
        raise ValueError("DATABASE_URI or SECRET_KEY not set in environment")

    # -------------------
    # Extensions init
    # -------------------
    db.init_app(app)
    compress.init_app(app)
    limiter.init_app(app)
    csrf.init_app(app)
    app.wsgi_app = WhiteNoise(app.wsgi_app, root='static/', max_age=31536000)

    # CHANGED: ProxyFix, applied last so it is the outermost wrapper.
    # Behind Render's proxy this makes request.scheme / remote_addr reflect
    # the real client (via X-Forwarded-Proto / X-Forwarded-For) instead of
    # the proxy. Without it the rate limiter sees one shared IP for every
    # visitor. If limiter IPs look wrong on your setup (e.g. Cloudflare in
    # front of Render adds a hop), set TRUSTED_PROXY_COUNT=2.
    proxy_hops = int(os.getenv('TRUSTED_PROXY_COUNT', '1'))
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=proxy_hops, x_proto=1)

    # -------------------
    # Talisman / CSP
    # -------------------
    csp = {
        'default-src': ["'self'"],
        'img-src': ["'self'"] + TARGET_URLS,
        'style-src': ["'self'", "'unsafe-inline'"] + TARGET_URLS,
        'script-src': ["'self'"] + TARGET_URLS,
        'connect-src': ["'self'", "wss://*.facebook.com"] + TARGET_URLS,
        'font-src': ["'self'"] + TARGET_URLS,
        'object-src': ["'none'"],
        'frame-src': ["https://www.facebook.com"],
        'base-uri': ["'self'"],
        'script-src-attr': ["'none'"],
        'form-action': ["'self'", "https://www.facebook.com"],
        'upgrade-insecure-requests': []
    }

    Talisman(
        app,
        content_security_policy=csp,
        force_https=True,
        strict_transport_security=True,
        strict_transport_security_max_age=31536000,
        frame_options="DENY",
        # CHANGED: was 'no-referrer'. Flask-WTF requires a Referer header on
        # HTTPS requests (WTF_CSRF_SSL_STRICT), so 'no-referrer' made every
        # CSRF-protected POST fail with 400 on Render. 'same-origin' sends
        # the Referer only to your own domain, nothing to third parties.
        referrer_policy='same-origin',
        x_xss_protection=True,
        x_content_type_options="nosniff"
    )

    # -------------------
    # Security Hooks
    # -------------------
    @app.after_request
    def add_corp_header(response):
        response.headers['Cross-Origin-Resource-Policy'] = 'same-origin'
        return response

    @app.before_request
    def block_unwanted_hosts():
        request_host = request.host.split(":")[0]
        ua = request.headers.get("User-Agent", "").lower()

        if request_host in ALLOWED_HOSTS:
            return
        if any(bot in ua for bot in TRUSTED_CRAWLERS):
            return

        logger.warning(f"Blocked request from {request.host} with UA: {ua}")
        abort(403)

    # CHANGED: CSRF failures on /api/ routes now return JSON instead of an
    # HTML page. Before, response.json() threw in your JS and the user just
    # saw "Connection failure". Now the real message reaches showMessage().
    @app.errorhandler(CSRFError)
    def handle_csrf_error(e):
        logger.warning(f"CSRF rejected on {request.path}: {e.description}")
        if request.path.startswith('/api/'):
            return jsonify({
                "status": "error",
                "message": "Security check failed. Refresh the page and try again."
            }), 400
        return e

    return app
