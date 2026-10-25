from datetime import datetime
from . import db


# ---------------------------------------------------------------------
# PROMO TYPES — the admin dashboard dropdown is the ONLY way a type is
# ever set, so there is no free-typed logic anywhere. Each type maps to
# exactly one handler in services/promo_service.py.
#
#   TIER     auto-applied, no code typed. discount_amount holds the
#            per-unit price ladder, e.g. "599,499,399" (1 unit, 2 units,
#            3+ units of linked products). Reusable, any user/guest.
#   PERCENT  typed by the customer. discount_amount holds a number,
#            e.g. "11" = 11% off. Applies to linked products only, or
#            to every product when applies_to_all is True.
#   WHEEL    typed by the customer on /wheel or in the checkout popup.
#            Never discounts anything itself — it opens the wheel. The
#            spin result becomes a single-use PERCENT prize code.
#
# usage_mode (independent of type) controls how many times a code can
# be redeemed:
#   reusable    unlimited redemptions until expires_at
#   single_use  dies for EVERYONE after the first successful order
#
# Airdrops are not a type: an airdrop is a batch of single_use PERCENT
# codes that share one starts_at (dashboard bulk upload).
# ---------------------------------------------------------------------
PROMO_TYPE_TIER = "tier"
PROMO_TYPE_PERCENT = "percent"
PROMO_TYPE_WHEEL = "wheel"
PROMO_TYPES = (PROMO_TYPE_TIER, PROMO_TYPE_PERCENT, PROMO_TYPE_WHEEL)

USAGE_REUSABLE = "reusable"
USAGE_SINGLE = "single_use"
USAGE_MODES = (USAGE_REUSABLE, USAGE_SINGLE)


class Promo(db.Model):
    __tablename__ = "promos"

    id = db.Column(db.Integer, primary_key=True)

    # Always stored UPPERCASE and stripped (normalized in promo_service),
    # so lookup is a plain equality match and "wheel-abc" == "WHEEL-ABC".
    code = db.Column(db.String(60), unique=True, nullable=False, index=True)

    promo_type = db.Column(db.String(20), nullable=False)  # PROMO_TYPES
    usage_mode = db.Column(db.String(20), nullable=False, default=USAGE_REUSABLE)

    # Meaning depends on promo_type (see header). Validated against the
    # type at write time in promo_service.validate_discount_amount() —
    # a tier promo can never be saved with "11", a percent promo can
    # never be saved with "599,499,399".
    discount_amount = db.Column(db.String(120), nullable=True)

    # Airdrop / scheduled launch. NULL = live immediately.
    starts_at = db.Column(db.DateTime, nullable=True)
    # NULL = never expires.
    expires_at = db.Column(db.DateTime, nullable=True, index=True)

    # True = every product; False = only rows in promo_products.
    applies_to_all = db.Column(db.Boolean, nullable=False, default=False)

    # Manual kill switch. Off = dead instantly, everywhere.
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    # ---- single-use bookkeeping ----
    # Set inside the checkout transaction (under a row lock) when a
    # single_use code is redeemed. Once set, the code is dead for all.
    redeemed_at = db.Column(db.DateTime, nullable=True)

    # ---- wheel prize codes ----
    # A prize code minted by a spin points back at the WHEEL promo that
    # produced it (wheel_parent_id) and is locked to the spinner
    # (owner_user_id). Deleting the parent wheel promo cascades and
    # kills every prize code it issued (confirmed by Hasan).
    wheel_parent_id = db.Column(
        db.Integer, db.ForeignKey("promos.id", ondelete="CASCADE"), nullable=True, index=True
    )
    owner_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    products = db.relationship(
        "PromoProduct", back_populates="promo", cascade="all, delete-orphan", passive_deletes=True
    )
    segments = db.relationship(
        "WheelSegment", back_populates="promo", cascade="all, delete-orphan", passive_deletes=True,
        order_by="WheelSegment.id",
    )
    prize_codes = db.relationship(
        "Promo",
        backref=db.backref("wheel_parent", remote_side=[id]),
        cascade="all, delete-orphan",
        passive_deletes=True,
        foreign_keys=[wheel_parent_id],
    )

    def linked_product_ids(self):
        return [pp.product_id for pp in self.products]

    def to_dict(self, include_products=True):
        data = {
            "id": self.id,
            "code": self.code,
            "promo_type": self.promo_type,
            "usage_mode": self.usage_mode,
            "discount_amount": self.discount_amount,
            "starts_at": self.starts_at.isoformat() if self.starts_at else None,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "applies_to_all": self.applies_to_all,
            "is_active": self.is_active,
            "redeemed_at": self.redeemed_at.isoformat() if self.redeemed_at else None,
            "wheel_parent_id": self.wheel_parent_id,
            "owner_user_id": self.owner_user_id,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
        if include_products:
            data["product_ids"] = self.linked_product_ids()
        if self.promo_type == PROMO_TYPE_WHEEL:
            data["segments"] = [s.to_dict() for s in self.segments]
        return data


class PromoProduct(db.Model):
    """Link table: which products a promo covers (ignored when applies_to_all)."""
    __tablename__ = "promo_products"
    __table_args__ = (
        db.UniqueConstraint("promo_id", "product_id", name="uq_promo_product"),
    )

    id = db.Column(db.Integer, primary_key=True)
    promo_id = db.Column(db.Integer, db.ForeignKey("promos.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True)

    promo = db.relationship("Promo", back_populates="products")


class PromoRedemption(db.Model):
    """
    One row per successful order that used a promo. Powers reporting and
    the once-per-user rule.

    The unique constraint on (promo_id, order_id) is the belt-and-braces
    guard behind the row lock in promo_service.redeem_promo_in_txn():
    even if two checkouts somehow raced past the lock, the database
    itself refuses a duplicate redemption of the same promo by the same
    order.
    """
    __tablename__ = "promo_redemptions"
    __table_args__ = (
        db.UniqueConstraint("promo_id", "order_id", name="uq_redemption_promo_order"),
    )

    id = db.Column(db.Integer, primary_key=True)
    promo_id = db.Column(db.Integer, db.ForeignKey("promos.id", ondelete="SET NULL"), nullable=True, index=True)
    # Snapshot of the code text, so history survives the promo row being deleted.
    code = db.Column(db.String(60), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    order_id = db.Column(db.Integer, db.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True)
    discount_applied = db.Column(db.Float, nullable=False, default=0.0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class WheelSegment(db.Model):
    """
    One slice of a wheel. Weights are relative (a slice with weight 30
    among total 100 wins 30% of spins). discount_percent == 0 is a
    legitimate "no win" slice — the dashboard lets the admin add these
    so the odds are real.
    """
    __tablename__ = "wheel_segments"

    id = db.Column(db.Integer, primary_key=True)
    promo_id = db.Column(db.Integer, db.ForeignKey("promos.id", ondelete="CASCADE"), nullable=False, index=True)
    label = db.Column(db.String(60), nullable=False)
    discount_percent = db.Column(db.Float, nullable=False, default=0.0)
    weight = db.Column(db.Float, nullable=False, default=1.0)

    promo = db.relationship("Promo", back_populates="segments")

    def to_dict(self):
        return {
            "id": self.id,
            "label": self.label,
            "discount_percent": self.discount_percent,
            "weight": self.weight,
        }


class WheelSpin(db.Model):
    """
    One row per user per wheel code — the unique constraint IS the
    "once per code per user" rule, enforced by the database rather than
    trusting a check-then-insert that a double-click could beat.
    """
    __tablename__ = "wheel_spins"
    __table_args__ = (
        db.UniqueConstraint("promo_id", "user_id", name="uq_wheel_spin_promo_user"),
    )

    id = db.Column(db.Integer, primary_key=True)
    promo_id = db.Column(db.Integer, db.ForeignKey("promos.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    segment_id = db.Column(db.Integer, db.ForeignKey("wheel_segments.id", ondelete="SET NULL"), nullable=True)
    result_label = db.Column(db.String(60), nullable=False)
    discount_percent = db.Column(db.Float, nullable=False, default=0.0)
    # The minted prize code, if the result was a win (NULL for a no-win slice).
    prize_promo_id = db.Column(db.Integer, db.ForeignKey("promos.id", ondelete="SET NULL"), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
