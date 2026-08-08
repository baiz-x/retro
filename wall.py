# wall.py
from flask import Flask, request, abort
from flask_sqlalchemy import SQLAlchemy
from flask_compress import Compress
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from whitenoise import WhiteNoise
from flask_talisman import Talisman
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
file_handler = RotatingFileHandler('app.log', maxBytes=10_000_000, backupCount=3)
file_handler.setLevel(logging.INFO)
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.DEBUG)
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
file_handler.setFormatter(formatter)
console_handler.setFormatter(formatter)
logger.addHandler(file_handler)
logger.addHandler(console_handler)

# -------------------
# Extensions
# -------------------
compress = Compress()
limiter = Limiter(key_func=get_remote_address)

# -------------------
# Config
# -------------------
ALLOWED_HOSTS = [
    'localhost',
    '127.0.0.1',
    'selly-ai.onrender.com',
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

    if not app.config['SQLALCHEMY_DATABASE_URI'] or not app.config['SECRET_KEY']:
        raise ValueError("DATABASE_URI or SECRET_KEY not set in environment")

    # -------------------
    # Extensions init
    # -------------------
    db.init_app(app)
    compress.init_app(app)
    limiter.init_app(app)
    app.wsgi_app = WhiteNoise(app.wsgi_app, root='static/', max_age=31536000)

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
        referrer_policy='no-referrer',
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

    return app
