from datetime import datetime
from . import db
from enum import Enum

class OrderStatus(str, Enum):
    PENDING = "Pending"
    PACKAGED = "Packaged"
    TRANSIT = "Transit"
    COMPLETE = "Complete"

    @classmethod
    def values(cls):
        return [s.value for s in cls]

class Order(db.Model):
    __tablename__ = "orders"

    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.String(40), unique=True, nullable=False)

    # Nullable — an order can be placed by a guest (no account) or a
    # logged-in user. Guest orders are still fully identified by the
    # customer_name/phone/address fields below regardless of user_id.
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)

    customer_name = db.Column(db.String(200), nullable=False)
    phone = db.Column(db.String(40), nullable=True)
    address = db.Column(db.Text, nullable=True)

    # Optional social contact info, e.g. for delivery coordination.
    social_platform = db.Column(db.String(40), nullable=True)  # WhatsApp, Instagram, Facebook, TikTok
    social_handle = db.Column(db.String(100), nullable=True)

    # Shipping zone drives shipping_fee — see order_service.py's
    # SHIPPING_FEES mapping for the authoritative fee-per-zone values.
    # Stored (not recomputed later) so a future fee change never alters
    # the amount actually charged on a historical order.
    shipping_zone = db.Column(db.String(40), nullable=False, default="inside_dhaka")
    shipping_fee = db.Column(db.Float, nullable=False, default=70.0)

    payment_method = db.Column(db.String(40), nullable=False, default="cod")  # "bkash" | "nagad" | "cod"
    transaction_id = db.Column(db.String(120), nullable=True)
    payment_number = db.Column(db.String(60), nullable=True)

    status = db.Column(db.String(20), nullable=False, default=OrderStatus.PENDING.value)

    # subtotal = sum of line items only, BEFORE shipping — kept alongside
    # `total` so the dashboard/receipt can show a shipping-fee breakdown
    # without recomputing it from items every time.
    subtotal = db.Column(db.Float, nullable=False, default=0.0)
    total = db.Column(db.Float, nullable=False, default=0.0)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    items = db.relationship("OrderItem", back_populates="order", cascade="all, delete-orphan")
    user = db.relationship("User", back_populates="orders")

    def to_dict(self, include_items=False):
        data = {
            "order_id": self.order_id,
            "customer_name": self.customer_name,
            "phone": self.phone,
            "address": self.address,
            "social_platform": self.social_platform,
            "social_handle": self.social_handle,
            "shipping_zone": self.shipping_zone,
            "shipping_fee": self.shipping_fee,
            "payment_method": self.payment_method,
            "transaction_id": self.transaction_id,
            "payment_number": self.payment_number,
            "status": self.status,
            "subtotal": self.subtotal,
            "total": self.total,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
        if include_items:
            data["items"] = [item.to_dict() for item in self.items]
        return data
