from datetime import datetime
from werkzeug.security import generate_password_hash, check_password_hash
from . import db


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)

    # Display name only — deliberately NOT unique. Login is by email
    # (see authenticate_user in auth_service.py), so two people can
    # share the same name without any ambiguity at login time.
    name = db.Column(db.String(120), nullable=False)

    phone_number = db.Column(db.String(40), nullable=False)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    address = db.Column(db.Text, nullable=False)

    # Never store or return the raw hash to a client — password_hash is
    # intentionally excluded from to_dict() below.
    password_hash = db.Column(db.String(255), nullable=False)

    # Email verification. The row is created immediately at signup with
    # is_verified=False; login is blocked (see auth_service.authenticate_user)
    # until verify_email_code() clears these and flips is_verified to True.
    is_verified = db.Column(db.Boolean, nullable=False, default=False)
    verification_code = db.Column(db.String(6), nullable=True)
    verification_code_expires_at = db.Column(db.DateTime, nullable=True)

    # Optional social contact info, e.g. for order-related outreach.
    social_platform = db.Column(db.String(40), nullable=True)  # WhatsApp, Instagram, Facebook, TikTok
    social_handle = db.Column(db.String(100), nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    orders = db.relationship("Order", back_populates="user")
    cart_items = db.relationship("CartItem", back_populates="user")

    def set_password(self, password):
        """Hashes and stores `password`. Never call with an already-hashed value."""
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    def to_dict(self):
        """Safe for direct JSON serialization — password_hash is deliberately omitted."""
        return {
            "id": self.id,
            "name": self.name,
            "phone_number": self.phone_number,
            "email": self.email,
            "address": self.address,
            "is_verified": self.is_verified,
            "social_platform": self.social_platform,
            "social_handle": self.social_handle,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }

