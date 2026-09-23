from datetime import datetime
from . import db


class Wholesale(db.Model):
    """
    One row per Product, holding cost/profit data that must NEVER reach
    the public storefront — see product_service.py / product_route.py,
    neither of which reference this table at all. Only exposed via
    services/wholesale_service.py + routes/wholesale_route.py, both
    gated by the same @admin_required decorator used everywhere else.

    Auto-created empty (all nullable fields None) the moment a Product
    is inserted — see the after_insert event listener at the bottom of
    this file — so admin always finds a row waiting under the
    Wholesale tab and fills it in later, per Hasan's confirmed design.
    Wired via a SQLAlchemy event rather than a call inside
    create_product() so the row is created even if a Product is ever
    inserted from somewhere other than that one function (seed script,
    migration, future admin path) — it can't get out of sync.
    """
    __tablename__ = "wholesale"

    id = db.Column(db.Integer, primary_key=True)

    # unique=True enforces the 1:1 relationship with Product — exactly
    # one Wholesale row per product, ever.
    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), unique=True, nullable=False)

    jersey_name = db.Column(db.String(200), nullable=True)
    wholesale_price = db.Column(db.Float, nullable=True)
    retail_price = db.Column(db.Float, nullable=True)

    # Server-computed, never admin-typed — see wholesale_service.py's
    # recompute_profit(), called on every create/update of this row.
    # Kept as a stored column (not computed on read) so it's directly
    # sortable/filterable in the dashboard without a join-time calc.
    profit = db.Column(db.Float, nullable=True)

    wholesaler = db.Column(db.String(200), nullable=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    product = db.relationship("Product", back_populates="wholesale")

    def to_dict(self):
        return {
            "product_id": self.product_id,
            "jersey_name": self.jersey_name,
            "wholesale_price": self.wholesale_price,
            "retail_price": self.retail_price,
            "profit": self.profit,
            "wholesaler": self.wholesaler,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


def create_wholesale_row_for_new_product(mapper, connection, target):
    """
    after_insert listener on Product — target is the just-inserted
    Product instance (target.id is already populated at this point).
    Registered against Product in models/__init__.py (not here) to
    avoid a circular import: this module would otherwise need to import
    Product, while product.py loads before wholesale.py in __init__'s
    import order.

    Uses a raw connection.execute (not db.session.add) because we're
    inside SQLAlchemy's flush machinery here; adding to the session
    mid-flush is unsafe — a direct INSERT via the given connection is
    the documented-safe way to do this from an after_insert listener.
    """
    connection.execute(
        Wholesale.__table__.insert().values(
            product_id=target.id,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
    )

