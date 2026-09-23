import secrets
from datetime import datetime, timedelta
from . import db


class GuestOrderLink(db.Model):
    """
    A single-use, time-limited link the admin generates and sends to a
    customer (e.g. someone who messaged on Messenger) so THEY fill in
    their own name/number/location/thana/size and it creates a real
    Order — while product, payment_method, shipping_zone, and
    payment_type stay fixed by the admin at generation time (per
    Hasan's confirmed spec: those three are NOT customer-editable on
    the public form).

    Security model (confirmed): the token itself IS the security — a
    long, unguessable random string, no separate PIN. expires_at is a
    fixed 24-hour window from creation, checked regardless of use.
    used_at is set the instant the form is successfully submitted,
    which independently kills the link even if the 24h window hasn't
    run out — see services/guest_order_link_service.py's
    validate_link() for where both checks happen together.
    """
    __tablename__ = "guest_order_links"

    id = db.Column(db.Integer, primary_key=True)

    # 43-character URL-safe token (32 random bytes via
    # secrets.token_urlsafe(32)) — unguessable, no separate PIN per
    # Hasan's confirmed decision. Indexed since every public form load
    # looks a link up by this value.
    token = db.Column(db.String(64), unique=True, nullable=False, index=True)

    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False)

    # Fixed by the admin at generation time — the public form never
    # shows or lets the customer change these three (confirmed).
    payment_method = db.Column(db.String(40), nullable=False)   # "bkash" | "nagad" | "cod"
    shipping_zone = db.Column(db.String(40), nullable=False)    # "inside_dhaka" | "outside_dhaka" | "sub_city"
    payment_type = db.Column(db.String(20), nullable=False, default="postpaid")

    expires_at = db.Column(db.DateTime, nullable=False)
    used_at = db.Column(db.DateTime, nullable=True)

    # Set once the resulting Order exists, so the admin dashboard can
    # link straight from "this guest link" to "the order it created".
    created_order_id = db.Column(db.Integer, db.ForeignKey("orders.id"), nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    product = db.relationship("Product")
    order = db.relationship("Order")

    @staticmethod
    def generate_token():
        return secrets.token_urlsafe(32)

    @staticmethod
    def default_expiry():
        # 24 hours (confirmed) from generation time.
        return datetime.utcnow() + timedelta(hours=24)

    @property
    def is_expired(self):
        return datetime.utcnow() > self.expires_at

    @property
    def is_used(self):
        return self.used_at is not None

    def to_dict(self):
        return {
            "id": self.id,
            "token": self.token,
            "product_id": self.product_id,
            "product_name": self.product.name if self.product else None,
            "payment_method": self.payment_method,
            "shipping_zone": self.shipping_zone,
            "payment_type": self.payment_type,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "used_at": self.used_at.isoformat() if self.used_at else None,
            "is_expired": self.is_expired,
            "is_used": self.is_used,
            "created_order_id": self.created_order_id,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }

