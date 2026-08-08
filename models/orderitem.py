from datetime import datetime
from . import db

class OrderItem(db.Model):
    __tablename__ = "order_items"

    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.Integer, db.ForeignKey("orders.id"), nullable=False)
    
    # Enforced foreign key reference to products.id
    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False)

    product_name = db.Column(db.String(200), nullable=False)  # snapshotted at purchase time
    quantity = db.Column(db.Integer, nullable=False, default=1)

    # Snapshot of price AT THE TIME OF PURCHASE
    price = db.Column(db.Float, nullable=False)

    # JSON shape for multi-axis configurations e.g. {"size": "200ml", "color": "Red", "scent": "Lavender"}
    selected_variants = db.Column(db.JSON, nullable=True, default=dict)

    order = db.relationship("Order", back_populates="items")
    product = db.relationship("Product", back_populates="order_items")

    def to_dict(self):
        return {
            "product_id": self.product_id,
            "product_name": self.product_name,
            "quantity": self.quantity,
            "price": self.price,
            "selected_variants": self.selected_variants or {},
        }
