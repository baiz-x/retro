from datetime import datetime
from . import db
from enum import Enum

class OrderStatus(str, Enum):
    PENDING = "Pending"
    PACKAGED = "Packaged"
    DELIVERING = "Delivering"
    DELIVERED = "Delivered"

    @classmethod
    def values(cls):
        return [s.value for s in cls]

class Order(db.Model):
    __tablename__ = "orders"

    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.String(40), unique=True, nullable=False)

    customer_name = db.Column(db.String(200), nullable=False)
    phone = db.Column(db.String(40), nullable=True)
    address = db.Column(db.Text, nullable=True)

    transaction_id = db.Column(db.String(120), nullable=True)
    payment_number = db.Column(db.String(60), nullable=True)

    status = db.Column(db.String(20), nullable=False, default=OrderStatus.PENDING.value)

    total = db.Column(db.Float, nullable=False, default=0.0)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    items = db.relationship("OrderItem", back_populates="order", cascade="all, delete-orphan")

    def to_dict(self, include_items=False):
        data = {
            "order_id": self.order_id,
            "customer_name": self.customer_name,
            "phone": self.phone,
            "address": self.address,
            "transaction_id": self.transaction_id,
            "payment_number": self.payment_number,
            "status": self.status,
            "total": self.total,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
        if include_items:
            data["items"] = [item.to_dict() for item in self.items]
        return data