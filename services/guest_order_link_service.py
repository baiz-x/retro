import re
from datetime import datetime, timedelta
from types import SimpleNamespace

from flask import current_app
from sqlalchemy.exc import SQLAlchemyError

from models import db, GuestOrderLink, Product, Order, OrderItem
from models.guest_order_link import GuestOrderLinkItem, ModeratorLink, variants_label
from services import promo_service
from services.order_service import (
    generate_order_id,
    recompute_total,
    validate_payment_type,
    validate_shipping_zone,
    SHIPPING_FEES,
    VALID_PAYMENT_METHODS,
)

MAX_ITEMS_PER_LINK = 10
MAX_QTY_PER_LINE = 20
CONTACT_CHANNELS = {"whatsapp", "facebook", "instagram"}


class _StockError(Exception):
    pass


# =====================================================================
# Variant / stock / price helpers
# =====================================================================

def _axes(product):
    axes = (product.variants or {}).get("axes") or {}
    return {k: v for k, v in axes.items() if v}


def _resolve(product, selected):
    """(price, available_stock, error) — the SAME resolver the cart uses, so a
    guest-link order is priced and stock-checked exactly like a checkout."""
    from services.cart_service import _resolve_variant_price_and_stock
    return _resolve_variant_price_and_stock(product, selected)


def _clean_selection(product, selected):
    """Every axis the product has must be chosen (boots need size AND color).
    Returns (clean_dict, error)."""
    if selected is None:
        selected = {}
    if not isinstance(selected, dict):
        return None, "Invalid variant selection"
    clean = {}
    for axis, choices in _axes(product).items():
        value = selected.get(axis)
        if value in (None, ""):
            return None, f"Choose {axis} for {product.name}"
        if value not in choices:
            return None, f"'{value}' is not a valid {axis} for {product.name}"
        clean[axis] = value
    return clean, None


def _stock_key(product, clean):
    # unified products share ONE stock number across every variant;
    # per_variant products have one number per combination.
    if (product.variant_mode or "unified") == "per_variant":
        return (product.id, tuple(sorted(clean.items())))
    return (product.id,)


def build_lines(raw_items):
    """
    raw_items: [{"product_id", "selected_variants", "quantity"}, ...]
    Validates every line (product exists, full variant chosen, price from the
    variant, enough stock — summed across lines that draw on the same stock).
    Returns (lines, error); each line = {"product", "selected_variants",
    "quantity", "unit_price"}.
    """
    if not isinstance(raw_items, list) or not raw_items:
        return None, "Add at least one product"
    if len(raw_items) > MAX_ITEMS_PER_LINK:
        return None, f"A link can hold at most {MAX_ITEMS_PER_LINK} lines"

    lines = []
    demand = {}      # stock_key -> total quantity wanted
    for raw in raw_items:
        try:
            product_id = int(raw.get("product_id"))
            quantity = int(raw.get("quantity", 1))
        except (TypeError, ValueError, AttributeError):
            return None, "Invalid item"
        if not (1 <= quantity <= MAX_QTY_PER_LINE):
            return None, f"Quantity must be between 1 and {MAX_QTY_PER_LINE}"

        product = Product.query.get(product_id)
        if not product:
            return None, "A product on this link no longer exists"

        clean, err = _clean_selection(product, raw.get("selected_variants"))
        if err:
            return None, err
        price, stock, err = _resolve(product, clean)
        if err:
            return None, err

        key = _stock_key(product, clean)
        demand[key] = demand.get(key, 0) + quantity
        if demand[key] > stock:
            label = variants_label(clean)
            name = f"{product.name} ({label})" if label else product.name
            return None, f"Only {stock} left of {name}"

        lines.append({"product": product, "selected_variants": clean,
                      "quantity": quantity, "unit_price": float(price)})
    return lines, None


def price_lines(lines, promo_code=None):
    """
    Applies the staff-attached promo code (if any) with the shared promo
    engine. No code = full variant prices (guest links do NOT get the
    automatic tier price unless a tier code is attached).
    Returns {"lines": [{..., "unit_price", "original_unit_price"}],
             "subtotal", "discount_total", "applied_promo", "error"}.
    """
    pseudo = [
        SimpleNamespace(id=i, product_id=l["product"].id, quantity=l["quantity"], price=l["unit_price"])
        for i, l in enumerate(lines)
    ]
    applied, error, discount = None, None, 0.0
    unit_prices = [l["unit_price"] for l in lines]

    if promo_code:
        pricing = promo_service.price_cart_items(pseudo, typed_code=promo_code, user_id=None, trusted=True)
        error = pricing["error"]
        if not error:
            applied = pricing["applied_promo"]
            discount = pricing["discount_total"]
            unit_prices = [ln["unit_price"] for ln in pricing["lines"]]

    out_lines = []
    for l, unit in zip(lines, unit_prices):
        out_lines.append({**l, "original_unit_price": l["unit_price"], "unit_price": round(float(unit), 2)})
    subtotal = round(sum(l["unit_price"] * l["quantity"] for l in out_lines), 2)
    return {"lines": out_lines, "subtotal": subtotal, "discount_total": round(discount, 2),
            "applied_promo": applied, "error": error}


def _items_to_raw(link):
    return [{"product_id": it.product_id, "selected_variants": it.selected_variants or {}, "quantity": it.quantity}
            for it in link.items]


# =====================================================================
# Creating links (admin cookie OR moderator token — the route decides who)
# =====================================================================

def create_guest_link(payment_method, shipping_zone, payment_type='postpaid', items=None,
                      product_id=None, promo_code=None, moderator_link_id=None):
    """
    items: [{"product_id", "selected_variants", "quantity"}, ...] — the new
    multi-product way (same product on several lines in different sizes is
    fine). product_id alone still creates a LEGACY single-product link where
    the customer picks the size.
    payment_method/shipping_zone/payment_type are fixed here and never shown
    as editable on the public form; promo_code is applied at submit time and
    is never typed by the customer.
    """
    if payment_method not in VALID_PAYMENT_METHODS:
        return None, f"Invalid payment method '{payment_method}'. Must be one of: {', '.join(VALID_PAYMENT_METHODS)}"
    ok, zone_err = validate_shipping_zone(shipping_zone)
    if not ok:
        return None, zone_err
    ok, ptype_err = validate_payment_type(payment_type)
    if not ok:
        return None, ptype_err

    promo_code = (promo_code or "").strip().upper() or None
    lines = None
    if items:
        lines, err = build_lines(items)
        if err:
            return None, err
        if promo_code:
            pricing = price_lines(lines, promo_code)
            if pricing["error"]:
                return None, f"Promo code '{promo_code}': {pricing['error']}"
    elif product_id:
        if not Product.query.get(product_id):
            return None, "Product not found"
        if promo_code:
            return None, "Promo codes need the multi-product link form"
    else:
        return None, "Add at least one product"

    try:
        link = GuestOrderLink(
            token=GuestOrderLink.generate_token(),
            product_id=None if lines else product_id,
            payment_method=payment_method,
            shipping_zone=shipping_zone,
            payment_type=payment_type,
            promo_code=promo_code,
            moderator_link_id=moderator_link_id,
            expires_at=GuestOrderLink.default_expiry(),
        )
        if lines:
            for l in lines:
                link.items.append(GuestOrderLinkItem(
                    product_id=l["product"].id,
                    selected_variants=l["selected_variants"],
                    quantity=l["quantity"],
                ))
        db.session.add(link)
        db.session.commit()
        return link, None
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Guest Link Create Error: {str(e)}")
        raise


def get_all_guest_links():
    return GuestOrderLink.query.order_by(GuestOrderLink.created_at.desc()).all()


def validate_link(token):
    """Gate for the public GET and POST: not-found, then used, then expired."""
    link = GuestOrderLink.query.filter_by(token=token).first()
    if not link:
        return None, "This link is invalid."
    if link.is_used:
        return None, "This link has already been used."
    if link.is_expired:
        return None, "This link has expired."
    return link, None


def get_available_sizes(product):
    """LEGACY single-product links only: sizes with stock, for the customer's dropdown."""
    variants = product.variants or {}
    axes = variants.get("axes") or {}
    sizes = axes.get("size") or []
    if not sizes:
        return []

    mode = product.variant_mode or "unified"
    combos = variants.get("combinations") or []

    if mode != "per_variant" or not combos:
        return list(sizes) if (product.stock or 0) > 0 else []

    return [
        size for size in sizes
        if any(c.get("size") == size and (c.get("stock") or 0) > 0 for c in combos)
    ]


def preview_link(link):
    """What the public form shows for a multi-product link: the lines, the
    discount, delivery and total. Returns (view_dict, error). Legacy links
    return (None, None) — the form keeps its single-product layout."""
    if not link.items:
        return None, None
    lines, err = build_lines(_items_to_raw(link))
    if err:
        return None, err
    pricing = price_lines(lines, link.promo_code)
    if pricing["error"]:
        return None, "The discount on this link is no longer valid. Please contact us."
    shipping_fee = SHIPPING_FEES[link.shipping_zone]
    view = {
        "lines": [{
            "name": l["product"].name,
            "image": l["product"].image,
            "variant": variants_label(l["selected_variants"]),
            "quantity": l["quantity"],
            "unit_price": l["unit_price"],
            "original_unit_price": l["original_unit_price"],
            "line_total": round(l["unit_price"] * l["quantity"], 2),
        } for l in pricing["lines"]],
        "subtotal": pricing["subtotal"],
        "discount_total": pricing["discount_total"],
        "shipping_fee": shipping_fee,
        "payment_type": link.payment_type,
        "total": recompute_total(pricing["subtotal"], shipping_fee, link.payment_type),
    }
    return view, None


# =====================================================================
# Customer contact (mandatory)
# =====================================================================

def normalize_contact(channel, handle):
    """Returns (clean_handle, error). WhatsApp must look like a phone number;
    Facebook / Instagram take a username or profile name."""
    handle = (handle or "").strip()
    if channel == "whatsapp":
        digits = re.sub(r"[\s\-()]", "", handle)
        if not re.fullmatch(r"\+?\d{8,15}", digits):
            return None, "Enter a valid WhatsApp number, e.g. 01XXXXXXXXX"
        return digits, None
    handle = handle.lstrip("@").strip()
    if len(handle) < 2 or len(handle) > 100:
        return None, f"Enter your {channel.capitalize()} username"
    return handle, None


# =====================================================================
# Public submit
# =====================================================================

def _restore_stock(deducted):
    from services.product_service import reduce_variant_stock
    for l in deducted:
        try:
            reduce_variant_stock(l["product"], l["selected_variants"], -l["quantity"])
        except Exception as e:  # never mask the original failure
            current_app.logger.error(f"Guest Order stock restore failed for product {l['product'].id}: {e}")


def _release_claim(link_id):
    try:
        GuestOrderLink.query.filter_by(id=link_id).update({"used_at": None})
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Guest link claim release failed for {link_id}: {e}")


def submit_guest_order(token, form_data):
    """
    Public, unauthenticated. form_data: customer_name, phone, address, thana,
    contact_channel, contact_handle (+ size, legacy single-product links only).

    Order of operations (stock reduction commits internally, so it is made
    safe by compensation, not by one big transaction):
      1. validate everything + price it, changing nothing
      2. CLAIM the link atomically (UPDATE ... WHERE used_at IS NULL) so two
         simultaneous submits can't both create an order
      3. deduct stock line by line
      4. create Order + items + promo redemption, commit
    Any failure after 2 restores the stock and releases the claim.
    """
    link, error = validate_link(token)
    if error:
        return None, error

    labels = {"customer_name": "your name", "phone": "your phone number", "address": "your location",
              "thana": "your thana", "contact_channel": "how we can reach you", "contact_handle": "your contact"}
    for field, label in labels.items():
        if not str(form_data.get(field) or "").strip():
            return None, f"Please fill in {label}"

    channel = str(form_data["contact_channel"]).strip().lower()
    if channel not in CONTACT_CHANNELS:
        return None, "Choose WhatsApp, Facebook or Instagram"
    contact_handle, err = normalize_contact(channel, form_data["contact_handle"])
    if err:
        return None, err

    if link.items:
        raw_items = _items_to_raw(link)
    else:
        product = link.product
        if not product:
            return None, "The product for this link no longer exists"
        sizes = get_available_sizes(product)
        size = str(form_data.get("size") or "").strip()
        if sizes and size not in sizes:
            return None, (f"'{size}' is no longer available for this product" if size else "Please choose a size")
        raw_items = [{"product_id": product.id, "selected_variants": {"size": size} if sizes else {}, "quantity": 1}]

    lines, err = build_lines(raw_items)
    if err:
        return None, err
    pricing = price_lines(lines, link.promo_code)
    if pricing["error"]:
        return None, "The discount on this link is no longer valid. Please contact us."

    shipping_fee = SHIPPING_FEES[link.shipping_zone]
    subtotal = pricing["subtotal"]
    total = recompute_total(subtotal, shipping_fee, link.payment_type)

    claimed = GuestOrderLink.query.filter(
        GuestOrderLink.id == link.id, GuestOrderLink.used_at.is_(None)
    ).update({"used_at": datetime.utcnow()}, synchronize_session=False)
    db.session.commit()
    if not claimed:
        return None, "This link has already been used."

    link_id = link.id
    deducted = []
    try:
        from services.product_service import reduce_variant_stock
        for l in lines:
            ok, message = reduce_variant_stock(l["product"], l["selected_variants"], l["quantity"])
            if not ok:
                raise _StockError(message)
            deducted.append(l)

        link = GuestOrderLink.query.get(link_id)
        applied = pricing["applied_promo"]
        order = Order(
            order_id=generate_order_id(),
            user_id=None,  # guest — no account
            customer_name=form_data["customer_name"].strip(),
            phone=form_data["phone"].strip(),
            address=f"{form_data['address'].strip()}, {form_data['thana'].strip()}",
            shipping_zone=link.shipping_zone,
            shipping_fee=shipping_fee,
            payment_type=link.payment_type,
            payment_method=link.payment_method,
            subtotal=subtotal,
            total=total,
            promo_code=applied.code if applied else None,
            discount_amount=pricing["discount_total"],
            status="Pending",
        )
        db.session.add(order)
        db.session.flush()

        for l in pricing["lines"]:
            db.session.add(OrderItem(
                order_id=order.id,
                product_id=l["product"].id,
                product_name=l["product"].name,
                quantity=l["quantity"],
                price=l["unit_price"],            # the price actually charged (after promo)
                selected_variants=l["selected_variants"],
            ))

        if applied:
            promo_service.redeem_promo_in_txn(
                promo_id=applied.id, user_id=None, order_id=order.id,
                discount_applied=pricing["discount_total"],
            )

        link.created_order_id = order.id
        link.contact_channel = channel
        link.contact_handle = contact_handle
        db.session.commit()
        return order, None

    except (_StockError, ValueError) as e:
        db.session.rollback()
        _restore_stock(deducted)
        _release_claim(link_id)
        return None, str(e)
    except Exception as e:
        db.session.rollback()
        _restore_stock(deducted)
        _release_claim(link_id)
        current_app.logger.error(f"Guest Order Submit Error: {str(e)}")
        raise


# =====================================================================
# Moderator access links
# =====================================================================

def create_moderator_link(label, days):
    label = (label or "").strip()
    if not label:
        return None, "Give the moderator link a name"
    if len(label) > 60:
        return None, "Name is too long (max 60 characters)"
    try:
        days = int(days)
    except (TypeError, ValueError):
        return None, "Choose how many days the link works"
    if not (1 <= days <= 90):
        return None, "Days must be between 1 and 90"
    try:
        mod = ModeratorLink(
            token=ModeratorLink.generate_token(),
            label=label,
            expires_at=datetime.utcnow() + timedelta(days=days),
        )
        db.session.add(mod)
        db.session.commit()
        return mod, None
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Moderator Link Create Error: {str(e)}")
        raise


def list_moderator_links():
    rows = ModeratorLink.query.order_by(ModeratorLink.created_at.desc()).all()
    counts = dict(
        db.session.query(GuestOrderLink.moderator_link_id, db.func.count(GuestOrderLink.id))
        .filter(GuestOrderLink.moderator_link_id.isnot(None))
        .group_by(GuestOrderLink.moderator_link_id).all()
    )
    return [m.to_dict(links_created=counts.get(m.id, 0)) for m in rows]


def revoke_moderator_link(link_id):
    mod = ModeratorLink.query.get(link_id)
    if not mod:
        return None, "Moderator link not found"
    if mod.revoked_at is None:
        mod.revoked_at = datetime.utcnow()
        db.session.commit()
    return mod, None


def get_active_moderator_link(token, touch=False):
    """Single gate for every moderator page/API call. Returns (mod, error)."""
    mod = ModeratorLink.query.filter_by(token=token).first()
    if not mod:
        return None, "This moderator link is invalid."
    if mod.is_revoked:
        return None, "This moderator link has been revoked."
    if mod.is_expired:
        return None, "This moderator link has expired."
    if touch:
        mod.last_used_at = datetime.utcnow()
        db.session.commit()
    return mod, None


def list_links_for_moderator(mod):
    """ONLY the links this moderator made, with just what he needs to follow
    up: status, items, and — once ordered — the customer's name, how to reach
    them and the order code. No address, phone or totals."""
    rows = (GuestOrderLink.query.filter_by(moderator_link_id=mod.id)
            .order_by(GuestOrderLink.created_at.desc()).limit(100).all())
    out = []
    for l in rows:
        out.append({
            "token": l.token,
            "items_summary": l.items_summary(),
            "promo_code": l.promo_code,
            "is_used": l.is_used,
            "is_expired": l.is_expired,
            "expires_at": l.expires_at.isoformat() if l.expires_at else None,
            "created_at": l.created_at.isoformat() if l.created_at else None,
            "customer_name": l.order.customer_name if (l.order and l.is_used) else None,
            "contact_channel": l.contact_channel,
            "contact_handle": l.contact_handle,
            "order_code": l.order.order_id if l.order else None,
        })
    return out


def get_catalog():
    """Products a link can be built from. Variants trimmed to what the picker
    needs (axes + combinations); no costs, no images map, no admin fields."""
    products = Product.query.filter(Product.stock > 0).order_by(Product.name.asc()).all()
    out = []
    for p in products:
        v = p.variants or {}
        out.append({
            "id": p.id,
            "name": p.name,
            "image": p.image,
            "price": p.price,
            "stock": p.stock,
            "variant_mode": p.variant_mode or "unified",
            "variants": {"axes": v.get("axes") or {}, "combinations": v.get("combinations") or []},
        })
    return out


# =====================================================================
# Admin Orders tab: show the customer's contact on guest-link orders
# =====================================================================

def attach_guest_contacts(order_dicts):
    """Adds "guest_contact": {"channel", "handle", "via"} to each order dict
    that came from a guest link. via = "Admin" or the moderator's name."""
    codes = [d.get("order_id") for d in order_dicts if d.get("order_id")]
    if not codes:
        return order_dicts
    rows = (db.session.query(Order.order_id, GuestOrderLink)
            .join(GuestOrderLink, GuestOrderLink.created_order_id == Order.id)
            .filter(Order.order_id.in_(codes)).all())
    by_code = {code: link for code, link in rows}
    for d in order_dicts:
        link = by_code.get(d.get("order_id"))
        if link:
            d["guest_contact"] = {
                "channel": link.contact_channel,
                "handle": link.contact_handle,
                "via": link.moderator_link.label if link.moderator_link else "Admin",
            }
    return order_dicts

