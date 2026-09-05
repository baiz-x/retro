from datetime import datetime
from . import db
from sqlalchemy.dialects.postgresql import JSONB

class CartItem(db.Model):
    __tablename__ = "cart_items"

    id = db.Column(db.Integer, primary_key=True)

    # REPLACES the old single `client_token` column. A cart line belongs
    # to EITHER a guest (guest_id set, user_id NULL) OR a logged-in user
    # (user_id set, guest_id NULL) — never both. Both are nullable so the
    # same row shape covers both cases; resolution logic lives in
    # cart_service.py (get_active_cart_owner / migrate_guest_cart_to_user).
    guest_id = db.Column(db.String(80), nullable=True, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)

    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False)

    quantity = db.Column(db.Integer, nullable=False, default=1)

    # Price AT THE TIME the item was added to cart — same snapshot
    # principle as OrderItem.price below, so a mid-cart price change
    # doesn't silently alter what's already in someone's cart.
    price = db.Column(db.Float, nullable=False)

    # JSON, not a flat `size` string column. Required because a
    # multi-axis product (e.g. size AND color) needs both together on
    # one cart row — a single flat column cannot hold that. e.g.
    # {"size": "200ml", "color": "Red", "scent": "Lavender"}
    # For a unified-mode product with no axes chosen, this can be {}.
    selected_variants = db.Column(JSONB, nullable=True, default=dict)

    # Jersey (or other) print customization, independent of variant
    # selection — e.g. {"name": "ARJUN", "number": "10"}. Only
    # meaningful for products where the storefront collects it (jerseys);
    # left as {} for everything else.
    customization = db.Column(JSONB, nullable=True, default=dict)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    product = db.relationship("Product", back_populates="cart_items")
    user = db.relationship("User", back_populates="cart_items")

    def to_dict(self):
        return {
            "id": self.id,
            "product_id": self.product_id,
            "quantity": self.quantity,
            "price": self.price,
            "subtotal": round(self.price * self.quantity, 2),
            "selected_variants": self.selected_variants or {},
            "customization": self.customization or {},
        }
