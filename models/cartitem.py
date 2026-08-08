from datetime import datetime
from . import db

class CartItem(db.Model):
    __tablename__ = "cart_items"

    id = db.Column(db.Integer, primary_key=True)
    client_token = db.Column(db.String(80), nullable=False, index=True)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False)

    quantity = db.Column(db.Integer, nullable=False, default=1)

    # Price AT THE TIME the item was added to cart — same snapshot
    # principle as OrderItem.price below, so a mid-cart price change
    # doesn't silently alter what's already in someone's cart.
    price = db.Column(db.Float, nullable=False)

    # DEPARTURE FROM order_service.py's assumption: this is JSON, not
    # a flat `size` string column. Required because a jar_candle line
    # needs size AND scent AND color together on one cart row — a
    # single flat column cannot hold that. e.g.
    # {"size": "200ml", "color": "Red", "scent": "Lavender"}
    # For a unified-mode product with no axes chosen, this can be {}.
    selected_variants = db.Column(db.JSON, nullable=True, default=dict)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    product = db.relationship("Product", back_populates="cart_items")

    def to_dict(self):
        return {
            "id": self.id,
            "product_id": self.product_id,
            "quantity": self.quantity,
            "price": self.price,
            "selected_variants": self.selected_variants or {},
        }
