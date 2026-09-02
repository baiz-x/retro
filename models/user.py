from datetime import datetime
from werkzeug.security import generate_password_hash, check_password_hash
from . import db


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    phone_number = db.Column(db.String(40), nullable=False)

    # Never store or return the raw hash to a client — password_hash is
    # intentionally excluded from to_dict() below.
    password_hash = db.Column(db.String(255), nullable=False)

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
            "username": self.username,
            "phone_number": self.phone_number,
            "social_platform": self.social_platform,
            "social_handle": self.social_handle,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
