"""
promo_service.py — the ONLY place discount logic lives.

Every surface (cart preview, checkout, the wheel, the admin dashboard)
calls into this module rather than computing a discount itself, so
prices can never drift between what the customer sees and what the
order actually charges.

--------------------------------------------------------------------
HOW A CART IS PRICED (see price_cart_items, the single entry point)
--------------------------------------------------------------------
1. TIER promos are auto-applied first, scanning the cart for products
   linked to a tier promo. This needs no code typed.
2. If the caller also passes a typed `code`, the typed promo REPLACES
   the tier discount entirely for the whole cart (Hasan's confirmed
   rule: "if he manually types any code then ditch the tiered offer
   and use his code"). Only one typed code may be active at a time.
3. Percent typed-codes discount the subtotal of whichever lines they
   apply to (applies_to_all, or only their linked products) BEFORE
   shipping/tax — shipping is never discounted.
4. WHEEL is never applied directly to a cart — typing a WHEEL-code
   only opens the spinner (see spin_wheel). The prize it mints is an
   ordinary single-use PERCENT promo.

Nothing here ever touches CartItem.price. It always returns a fresh
list of per-line discounted unit prices, computed from the product's
own stored price, so an expired/edited promo can never leave a stale
discount sitting in someone's cart.
--------------------------------------------------------------------
"""
import random
import string
from datetime import datetime, timedelta

from models import db
from models.promo import (
    Promo, PromoProduct, PromoRedemption, WheelSegment, WheelSpin,
    PROMO_TYPE_TIER, PROMO_TYPE_PERCENT, PROMO_TYPE_WHEEL, PROMO_TYPES,
    USAGE_REUSABLE, USAGE_SINGLE, USAGE_MODES,
)

WHEEL_PRIZE_VALID_HOURS = 24


# =====================================================================
# Normalization / lookup
# =====================================================================

def normalize_code(raw_code):
    """Codes are always matched case-insensitively, whitespace-trimmed."""
    return (raw_code or "").strip().upper()


def get_promo_by_code(raw_code):
    code = normalize_code(raw_code)
    if not code:
        return None
    return Promo.query.filter_by(code=code).first()


# =====================================================================
# Admin-side validation (used by routes/promo_route.py on create/update)
# =====================================================================

def validate_discount_amount(promo_type, discount_amount):
    """
    Enforces that discount_amount matches what promo_type expects, so
    an admin can never save a percent value on a tier promo or vice
    versa. Returns (is_valid, error_message_or_None).
    """
    if promo_type == PROMO_TYPE_WHEEL:
        # Wheel promos carry no discount_amount of their own — the
        # discount lives on their WheelSegment rows instead.
        return True, None

    if not discount_amount or not str(discount_amount).strip():
        return False, "discount_amount is required for this promo type"

    if promo_type == PROMO_TYPE_PERCENT:
        try:
            value = float(discount_amount)
        except (TypeError, ValueError):
            return False, "Percent promos require a single number, e.g. 11"
        if not (0 < value <= 100):
            return False, "Percent must be between 0 and 100"
        return True, None

    if promo_type == PROMO_TYPE_TIER:
        parts = [p.strip() for p in str(discount_amount).split(",") if p.strip()]
        if len(parts) < 2:
            return False, "Tier promos need at least 2 comma-separated prices, e.g. 599,499,399"
        try:
            values = [float(p) for p in parts]
        except ValueError:
            return False, "Tier prices must all be numbers, e.g. 599,499,399"
        if any(v < 0 for v in values):
            return False, "Tier prices cannot be negative"
        return True, None

    return False, f"Unknown promo_type '{promo_type}'"


def validate_ladder_string(value, min_len=1):
    """Used for a premium product's custom ladder, e.g. '699,599,499'.
    Returns (is_valid, error_message_or_None)."""
    parts = [x.strip() for x in str(value or "").split(",") if x.strip()]
    if len(parts) < min_len:
        return False, "Custom premium price needs at least one number, e.g. 699,599,499"
    try:
        values = [float(x) for x in parts]
    except ValueError:
        return False, "Custom premium prices must be numbers, e.g. 699,599,499"
    if any(v < 0 for v in values):
        return False, "Custom premium prices cannot be negative"
    return True, None


def parse_tier_ladder(discount_amount):
    """'599,499,399' -> [599.0, 499.0, 399.0]. Caller guarantees validity."""
    return [float(p.strip()) for p in discount_amount.split(",") if p.strip()]


def tier_unit_price(discount_amount, unit_count):
    """
    unit_count units of a tier-linked product in the cart -> unit price.
    Ladder index is (unit_count - 1), clamped to the last rung, so 5
    units of a 3-rung ladder still gets the 3rd-rung (best) price —
    confirmed: "3 or 3+ same price".
    """
    ladder = parse_tier_ladder(discount_amount)
    idx = min(unit_count, len(ladder)) - 1
    idx = max(idx, 0)
    return ladder[idx]


def _ladder_price(ladder, unit_count):
    """Rung for unit_count units, clamped to the last rung (3+ = best price)."""
    idx = max(min(unit_count, len(ladder)) - 1, 0)
    return ladder[idx]


def _tier_line_price(promo, row, base_ladder, unit_count):
    """
    Unit price one cart line pays under a tier promo. `row` is that
    product's PromoProduct link (None when the promo applies_to_all and
    the product isn't a premium override).

      standard product          -> base ladder rung
      premium + custom_ladder   -> that product's own ladder rung
      premium + premium_offset  -> base ladder rung + offset
      premium, neither set      -> base ladder rung

    unit_count is ALWAYS the combined units of every product in the
    campaign (standard + premium), so 2 standard + 1 premium on a
    599/499/399 (+50) ladder prices as 399 + 399 + 449.
    Returns (price, is_premium).
    """
    base = _ladder_price(base_ladder, unit_count)
    if row is not None and row.is_premium:
        if row.custom_ladder:
            return round(_ladder_price(parse_tier_ladder(row.custom_ladder), unit_count), 2), True
        if promo.premium_offset:
            return round(base + promo.premium_offset, 2), True
        return round(base, 2), True
    return round(base, 2), False


def generate_unique_code(prefix=""):
    """Random 8-char code for airdrop batches / wheel prizes, collision-checked."""
    alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I confusion
    while True:
        suffix = "".join(random.choices(alphabet, k=8))
        code = normalize_code(f"{prefix}{suffix}" if prefix else suffix)
        if not Promo.query.filter_by(code=code).first():
            return code


# =====================================================================
# Eligibility helpers
# =====================================================================

def _is_live(promo, now=None):
    now = now or datetime.utcnow()
    if not promo.is_active:
        return False, "This promo is no longer active."
    if promo.starts_at and now < promo.starts_at:
        return False, "This promo hasn't launched yet."
    if promo.expires_at and now >= promo.expires_at:
        return False, "This promo code has expired."
    if promo.usage_mode == USAGE_SINGLE and promo.redeemed_at is not None:
        return False, "This code has already been used."
    return True, None


def is_live(promo, now=None):
    """Public wrapper around _is_live for callers outside this module
    (e.g. routes/promo_route.py's wheel_info, which needs to show the
    wheel page whether it's live without spinning it)."""
    return _is_live(promo, now=now)


def _linked_product_ids(promo):
    return {pp.product_id for pp in promo.products}


# =====================================================================
# Cart pricing — THE single entry point every surface calls
# =====================================================================

def price_cart_items(cart_items, typed_code=None, user_id=None):
    """
    cart_items: objects with .product_id, .price (full unit price),
                .quantity — works for both CartItem and the narrowed
                single-line list order_service already builds.
    typed_code: raw string from the checkout promo field, or None.
    user_id:    required to validate a typed code (login-only codes);
                None is fine for the auto tier pass (guests included).

    Returns a dict:
      {
        "lines": [{"cart_item": <item>, "unit_price": float,
                    "original_unit_price": float}, ...],
        "applied_promo": Promo | None,
        "discount_total": float,
        "reason": str | None,   # e.g. "Buy 3+, pay ৳399 each"
        "error": str | None,    # set only if a typed_code was given and invalid
      }
    """
    lines = [
        {"cart_item": item, "unit_price": item.price, "original_unit_price": item.price}
        for item in cart_items
    ]
    result = {
        "lines": lines,
        "applied_promo": None,
        "discount_total": 0.0,
        "reason": None,
        "error": None,
    }

    if typed_code:
        result = _apply_typed_code(lines, typed_code, user_id, result)
        if result["error"]:
            # Bad / expired / wrong-account code: report the error, but keep
            # the customer's automatic tier price instead of silently
            # snapping the cart back to full price.
            err = result["error"]
            for l in lines:
                l["unit_price"] = l["original_unit_price"]
            result["applied_promo"] = None
            result["reason"] = None
            result["discount_total"] = 0.0
            result = _apply_best_tier(lines, result)
            result["error"] = err
        return result

    return _apply_best_tier(lines, result)


def _apply_best_tier(lines, result, typed_promo=None):
    """
    Tier pass. For every live TIER promo, count the units of every product
    it covers (applies_to_all = every line, otherwise only linked
    products), find the ladder rung for that combined count, and price
    each line: standard products on the base ladder, premium products on
    base + premium_offset or their own custom ladder.

    typed_promo: set when the customer TYPED a tier code. The discount is
    the same as the automatic one — typing the code just confirms it,
    records THAT code as the one applied (so it's counted as used on
    order), and errors if it does nothing for this cart.
    """
    now = datetime.utcnow()
    tier_promos = Promo.query.filter_by(promo_type=PROMO_TYPE_TIER, is_active=True).all()
    reasons = []
    touched_ids = set()
    last_touched = None

    for promo in tier_promos:
        live, _ = _is_live(promo, now)
        if not live:
            continue

        rows = {pp.product_id: pp for pp in promo.products}
        if promo.applies_to_all:
            matching = list(lines)
        else:
            matching = [l for l in lines if l["cart_item"].product_id in rows]
        if not matching:
            continue

        base_ladder = parse_tier_ladder(promo.discount_amount)
        unit_count = sum(l["cart_item"].quantity for l in matching)

        std_price = prem_price = None
        touched = False
        for l in matching:
            price, is_premium = _tier_line_price(
                promo, rows.get(l["cart_item"].product_id), base_ladder, unit_count
            )
            if l["unit_price"] > price:
                l["unit_price"] = price
                touched = True
                if is_premium:
                    prem_price = price
                else:
                    std_price = price

        if touched:
            touched_ids.add(promo.id)
            last_touched = promo
            parts = []
            if std_price is not None:
                parts.append(f"৳{std_price:.0f} each")
            if prem_price is not None:
                parts.append(f"premium ৳{prem_price:.0f} each")
            reasons.append(f"Buy {unit_count}: {', '.join(parts)} ({promo.code})")

    if typed_promo is not None:
        if typed_promo.id in touched_ids:
            result["applied_promo"] = typed_promo
        else:
            result["error"] = "This offer doesn't apply to anything in your cart."
    else:
        result["applied_promo"] = last_touched

    if reasons:
        result["reason"] = " · ".join(reasons)
    result["discount_total"] = sum(
        (l["original_unit_price"] - l["unit_price"]) * l["cart_item"].quantity for l in lines
    )
    return result


def _apply_typed_code(lines, typed_code, user_id, result):
    """
    Typed code REPLACES tier pricing entirely (confirmed rule) — lines
    stay at original_unit_price except where the typed promo applies.
    """
    promo = get_promo_by_code(typed_code)
    if not promo:
        result["error"] = "Invalid promo code."
        return result

    if promo.promo_type == PROMO_TYPE_WHEEL:
        result["error"] = "This code opens the spin wheel — it isn't a discount code itself."
        return result

    live, err = _is_live(promo)
    if not live:
        result["error"] = err
        return result

    # A typed TIER code confirms the automatic tier deal. Tier deals work
    # for guests, so this sits before the login check below.
    if promo.promo_type == PROMO_TYPE_TIER:
        return _apply_best_tier(lines, result, typed_promo=promo)

    if user_id is None:
        result["error"] = "Please log in to use a promo code."
        return result

    # A prize code is locked to whoever spun it.
    if promo.owner_user_id is not None and promo.owner_user_id != user_id:
        result["error"] = "This code isn't valid on your account."
        return result

    if promo.promo_type != PROMO_TYPE_PERCENT:
        result["error"] = "This code can't be applied here."
        return result

    try:
        pct = float(promo.discount_amount)
    except (TypeError, ValueError):
        result["error"] = "This promo is misconfigured. Please contact support."
        return result

    linked_ids = _linked_product_ids(promo)
    targets = lines if promo.applies_to_all else [
        l for l in lines if l["cart_item"].product_id in linked_ids
    ]

    if not targets:
        result["error"] = "This code doesn't apply to anything in your cart."
        return result

    for l in targets:
        l["unit_price"] = round(l["original_unit_price"] * (1 - pct / 100), 2)

    result["applied_promo"] = promo
    result["reason"] = f"{pct:.0f}% off applied ({promo.code})"
    result["discount_total"] = sum(
        (l["original_unit_price"] - l["unit_price"]) * l["cart_item"].quantity for l in lines
    )
    return result


# =====================================================================
# Checkout-time redemption — called ONLY from create_order_from_cart,
# inside the same DB transaction, BEFORE commit.
# =====================================================================

def redeem_promo_in_txn(promo_id, user_id, order_id, discount_applied):
    """
    Locks the promo row (SELECT ... FOR UPDATE) so two simultaneous
    checkouts racing for the same single-use code can't both succeed —
    "first click on order wins" (confirmed), the loser gets a clean
    error instead of a corrupted redemption count.

    Must be called after all other order rows are staged (flushed) but
    BEFORE db.session.commit() in create_order_from_cart, so a failure
    here rolls back the whole order along with it.

    Raises ValueError with a user-facing message on failure — caller
    is expected to catch it, rollback, and return it as the order
    error (mirrors every other validation in create_order_from_cart).
    """
    promo = Promo.query.filter_by(id=promo_id).with_for_update().first()
    if promo is None:
        raise ValueError("Promo code is no longer available.")

    live, err = _is_live(promo)
    if not live:
        raise ValueError(err)

    if promo.usage_mode == USAGE_SINGLE:
        promo.redeemed_at = datetime.utcnow()

    redemption = PromoRedemption(
        promo_id=promo.id,
        code=promo.code,
        user_id=user_id,
        order_id=order_id,
        discount_applied=discount_applied,
    )
    db.session.add(redemption)
    # Flush (not commit) so the UNIQUE(promo_id, order_id) constraint and
    # the row lock both take effect before the caller's final commit.
    db.session.flush()


# =====================================================================
# Wheel
# =====================================================================

def spin_wheel(raw_code, user_id):
    """
    Validates the WHEEL code, checks the once-per-user constraint,
    picks a weighted-random segment server-side (never trust a client
    result), records the spin, and — if the segment is a win — mints a
    single-use PERCENT prize code valid for WHEEL_PRIZE_VALID_HOURS,
    locked to this user.

    Returns (result_dict, error_message). result_dict looks like:
      {"label": "10% OFF", "discount_percent": 10.0,
       "prize_code": "WPRIZE7K2N" or None, "expires_at": iso_string or None}
    """
    promo = get_promo_by_code(raw_code)
    if promo is None or promo.promo_type != PROMO_TYPE_WHEEL:
        return None, "Invalid wheel code."

    live, err = _is_live(promo)
    if not live:
        return None, err

    if not promo.segments:
        return None, "This wheel has no prizes configured yet."

    existing = WheelSpin.query.filter_by(promo_id=promo.id, user_id=user_id).first()
    if existing:
        return None, "You've already spun this wheel."

    segments = promo.segments
    weights = [max(s.weight, 0) for s in segments]
    if sum(weights) <= 0:
        return None, "This wheel has no prizes configured yet."

    chosen = random.choices(segments, weights=weights, k=1)[0]

    prize_promo = None
    expires_at = None
    if chosen.discount_percent > 0:
        expires_at = datetime.utcnow() + timedelta(hours=WHEEL_PRIZE_VALID_HOURS)
        prize_promo = Promo(
            code=generate_unique_code(prefix="WIN"),
            promo_type=PROMO_TYPE_PERCENT,
            usage_mode=USAGE_SINGLE,
            discount_amount=str(chosen.discount_percent),
            # Prize inherits the WHEEL promo's own product scope (set
            # in the dashboard just like tier/percent promos) rather
            # than always being store-wide — a wheel scoped to jerseys
            # only should only discount jerseys.
            applies_to_all=promo.applies_to_all,
            is_active=True,
            expires_at=expires_at,
            wheel_parent_id=promo.id,
            owner_user_id=user_id,
        )
        db.session.add(prize_promo)
        db.session.flush()
        if not promo.applies_to_all:
            for pid in _linked_product_ids(promo):
                db.session.add(PromoProduct(promo_id=prize_promo.id, product_id=pid))
            db.session.flush()

    spin = WheelSpin(
        promo_id=promo.id,
        user_id=user_id,
        segment_id=chosen.id,
        result_label=chosen.label,
        discount_percent=chosen.discount_percent,
        prize_promo_id=prize_promo.id if prize_promo else None,
    )
    db.session.add(spin)
    db.session.commit()

    return {
        "segment_id": chosen.id,
        "label": chosen.label,
        "discount_percent": chosen.discount_percent,
        "prize_code": prize_promo.code if prize_promo else None,
        "expires_at": expires_at.isoformat() if expires_at else None,
    }, None

