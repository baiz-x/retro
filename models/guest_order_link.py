import secrets
from datetime import datetime, timedelta
from . import db


def variants_label(selected_variants):
    """{"size": "M"} -> "M";  {"size": "42", "color": "Black"} -> "42 / Black"."""
    return " / ".join(str(v) for v in (selected_variants or {}).values())


class ModeratorLink(db.Model):
    """
    A time-limited access link the admin hands to a moderator. Opening
    /mod/<token> gives a small console where the moderator can build guest
    order links (products, sizes, payment, zone, optional promo code) and
    see the links HE made — nothing else. It is NOT an admin login: the
    admin cookie/API key is a separate mechanism (services/admin_service.py)
    and a moderator token never satisfies @admin_required.

    The token IS the credential (43-char unguessable string). Access ends
    when expires_at passes OR the admin revokes it (revoked_at), whichever
    comes first.
    """
    __tablename__ = "moderator_links"

    id = db.Column(db.Integer, primary_key=True)
    token = db.Column(db.String(64), unique=True, nullable=False, index=True)
    label = db.Column(db.String(60), nullable=False)          # e.g. "Rahim"
    expires_at = db.Column(db.DateTime, nullable=False)
    revoked_at = db.Column(db.DateTime, nullable=True)
    last_used_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    guest_links = db.relationship("GuestOrderLink", back_populates="moderator_link")

    @staticmethod
    def generate_token():
        return secrets.token_urlsafe(32)

    @property
    def is_expired(self):
        return datetime.utcnow() > self.expires_at

    @property
    def is_revoked(self):
        return self.revoked_at is not None

    @property
    def is_active(self):
        return not self.is_expired and not self.is_revoked

    def to_dict(self, links_created=None):
        return {
            "id": self.id,
            "token": self.token,
            "label": self.label,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "revoked_at": self.revoked_at.isoformat() if self.revoked_at else None,
            "last_used_at": self.last_used_at.isoformat() if self.last_used_at else None,
            "is_expired": self.is_expired,
            "is_revoked": self.is_revoked,
            "is_active": self.is_active,
            "links_created": links_created,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class GuestOrderLinkItem(db.Model):
    """One line of a multi-product guest link: a product, the exact variant
    (every axis, e.g. {"size": "M"} or {"size": "42", "color": "Black"})
    and a quantity. The same product can appear on several lines in
    different sizes."""
    __tablename__ = "guest_order_link_items"

    id = db.Column(db.Integer, primary_key=True)
    link_id = db.Column(db.Integer, db.ForeignKey("guest_order_links.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False, index=True)
    selected_variants = db.Column(db.JSON, nullable=True, default=dict)
    quantity = db.Column(db.Integer, nullable=False, default=1)

    link = db.relationship("GuestOrderLink", back_populates="items")
    product = db.relationship("Product")


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

    # LEGACY single-product links only (customer picks the size on the form).
    # NULL for multi-product links — those carry their lines in `items`.
    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=True)

    # Fixed by the admin at generation time — the public form never
    # shows or lets the customer change these three (confirmed).
    payment_method = db.Column(db.String(40), nullable=False)   # "bkash" | "nagad" | "cod"
    shipping_zone = db.Column(db.String(40), nullable=False)    # "inside_dhaka" | "outside_dhaka" | "sub_city"
    payment_type = db.Column(db.String(20), nullable=False, default="postpaid")

    # Optional promo code set by the admin/moderator when the link is made
    # (never typed by the customer). Applied to the order at submit time.
    promo_code = db.Column(db.String(40), nullable=True)

    # Which moderator link created this one (NULL = created by the admin).
    moderator_link_id = db.Column(db.Integer, db.ForeignKey("moderator_links.id"), nullable=True, index=True)

    # Mandatory on the public form so there is always a reliable way to
    # message the customer when the parcel arrives.
    contact_channel = db.Column(db.String(20), nullable=True)   # "whatsapp" | "facebook" | "instagram"
    contact_handle = db.Column(db.String(120), nullable=True)

    expires_at = db.Column(db.DateTime, nullable=False)
    used_at = db.Column(db.DateTime, nullable=True)

    # Set once the resulting Order exists, so the admin dashboard can
    # link straight from "this guest link" to "the order it created".
    created_order_id = db.Column(db.Integer, db.ForeignKey("orders.id"), nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    product = db.relationship("Product")
    order = db.relationship("Order")
    moderator_link = db.relationship("ModeratorLink", back_populates="guest_links")
    items = db.relationship(
        "GuestOrderLinkItem", back_populates="link",
        cascade="all, delete-orphan", order_by="GuestOrderLinkItem.id",
    )

    def items_summary(self):
        if self.items:
            return ", ".join(
                f"{it.product.name if it.product else 'Deleted product'}"
                + (f" ({variants_label(it.selected_variants)})" if it.selected_variants else "")
                + (f" x{it.quantity}" if it.quantity > 1 else "")
                for it in self.items
            )
        return self.product.name if self.product else "Unknown Product"

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
            "product_name": self.items_summary(),   # kept for the existing dashboard list
            "items": [
                {
                    "product_id": it.product_id,
                    "product_name": it.product.name if it.product else None,
                    "selected_variants": it.selected_variants or {},
                    "quantity": it.quantity,
                }
                for it in self.items
            ],
            "promo_code": self.promo_code,
            "created_by": self.moderator_link.label if self.moderator_link else "Admin",
            "moderator_link_id": self.moderator_link_id,
            "contact_channel": self.contact_channel,
            "contact_handle": self.contact_handle,
            "customer_name": self.order.customer_name if (self.order and self.is_used) else None,
            "order_code": self.order.order_id if self.order else None,
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


