from datetime import datetime
from . import db


class FulfillmentCheckoff(db.Model):
    """
    Tracks how many units of a specific product+size Hasan has manually
    checked off (×'d) while at the wholesaler, per the confirmed
    "Orders to Fulfill" tab design. This is a TEMPORARY TALLY, not a
    record of anything about the order itself — it never touches
    Order.status or deletes any order/item.

    One row per (product_id, size) pair. checked_off_count increments
    each time the × is clicked for that line. The tab computes each
    line's "needed" count live from currently-Pending orders (see
    services/fulfillment_service.py's get_fulfillment_summary) and
    compares it against checked_off_count — once checked_off_count
    reaches the live needed count, the line is considered fully
    accounted for and stops showing (confirmed: no separate manual
    reset, no daily timer — it just naturally drops off).

    size is nullable to also support non-sized products ("others"
    catch-all items with no size axis) — grouped under size=None.
    """
    __tablename__ = "fulfillment_checkoffs"
    __table_args__ = (
        db.UniqueConstraint('product_id', 'size', name='uq_fulfillment_product_size'),
    )

    id = db.Column(db.Integer, primary_key=True)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False)
    size = db.Column(db.String(20), nullable=True)

    checked_off_count = db.Column(db.Integer, nullable=False, default=0)

    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    product = db.relationship("Product")

