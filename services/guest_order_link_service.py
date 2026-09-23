from datetime import datetime
from flask import current_app
from sqlalchemy.exc import SQLAlchemyError

from models import db, GuestOrderLink, Product, Order, OrderItem
from services.order_service import (
    generate_order_id,
    recompute_total,
    validate_payment_type,
    validate_shipping_zone,
    SHIPPING_FEES,
    VALID_PAYMENT_METHODS,
)


def create_guest_link(product_id, payment_method, shipping_zone, payment_type='postpaid'):
    """
    Admin-only — generates a new single-use, 24h guest order link tied
    to one specific product. payment_method/shipping_zone/payment_type
    are fixed here by the admin and never shown/editable on the public
    form (confirmed) — only name/number/location/thana/size are
    customer-filled.
    """
    if payment_method not in VALID_PAYMENT_METHODS:
        return None, f"Invalid payment method '{payment_method}'. Must be one of: {', '.join(VALID_PAYMENT_METHODS)}"

    is_valid_zone, zone_err = validate_shipping_zone(shipping_zone)
    if not is_valid_zone:
        return None, zone_err

    is_valid_ptype, ptype_err = validate_payment_type(payment_type)
    if not is_valid_ptype:
        return None, ptype_err

    product = Product.query.get(product_id)
    if not product:
        return None, "Product not found"

    try:
        link = GuestOrderLink(
            token=GuestOrderLink.generate_token(),
            product_id=product_id,
            payment_method=payment_method,
            shipping_zone=shipping_zone,
            payment_type=payment_type,
            expires_at=GuestOrderLink.default_expiry(),
        )
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
    """
    Single gate both the public GET (show the form) and POST (submit
    the form) routes call first. Returns (link, error) — error is a
    customer-facing message when the link is dead for any reason,
    checked in the order confirmed: not-found, then used, then
    expired, so the message always matches the actual first reason
    it's invalid rather than a generic catch-all.
    """
    link = GuestOrderLink.query.filter_by(token=token).first()
    if not link:
        return None, "This link is invalid."
    if link.is_used:
        return None, "This link has already been used."
    if link.is_expired:
        return None, "This link has expired."
    return link, None


def get_available_sizes(product):
    """
    Same source data as product_service.build_size_pills — duplicated
    narrowly here (just the size-list extraction, not the full
    availability-pill logic) rather than imported, since the guest
    form only needs "which sizes exist at all with stock", not the
    pill-rendering shape build_size_pills returns.
    Returns a plain list of size strings that currently have stock,
    or [] if this product has no size axis / no stock anywhere.
    """
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


def submit_guest_order(token, form_data):
    """
    Public, unauthenticated — the actual order-creation path for a
    guest link. Deliberately separate from order_service.create_order_
    from_cart (that one reads from CartItem rows via a session/guest_id,
    which doesn't exist in this flow at all — there's no cart, just one
    product fixed on the link plus a size the customer just picked).

    form_data: {"customer_name", "phone", "address", "thana", "size"}
    — location + thana are confirmed as two separate fields; combined
    into Order.address as "address, thana" since Order has no separate
    thana column and adding one would ripple into every other order
    path for a field only guest-links use.
    """
    link, error = validate_link(token)
    if error:
        return None, error

    for field in ("customer_name", "phone", "address", "thana", "size"):
        if not form_data.get(field):
            return None, f"Missing field: {field}"

    product = link.product
    if not product:
        return None, "The product for this link no longer exists"

    available_sizes = get_available_sizes(product)
    selected_size = form_data["size"]
    if available_sizes and selected_size not in available_sizes:
        return None, f"'{selected_size}' is no longer available for this product"

    selected_variants = {"size": selected_size} if available_sizes else {}

    try:
        # Stock check + deduction — same helper every other order path
        # uses, imported locally to match order_service.py's existing
        # avoid-circular-import convention for this same function.
        from services.product_service import reduce_variant_stock
        success, message = reduce_variant_stock(product, selected_variants, 1)
        if not success:
            return None, message

        shipping_fee = SHIPPING_FEES[link.shipping_zone]
        item_price = product.price
        subtotal = item_price * 1
        total = recompute_total(subtotal, shipping_fee, link.payment_type)

        combined_address = f"{form_data['address']}, {form_data['thana']}"

        order = Order(
            order_id=generate_order_id(),
            user_id=None,  # guest — no account, per Hasan's confirmed scope
            customer_name=form_data["customer_name"],
            phone=form_data["phone"],
            address=combined_address,
            shipping_zone=link.shipping_zone,
            shipping_fee=shipping_fee,
            payment_type=link.payment_type,
            payment_method=link.payment_method,
            subtotal=subtotal,
            total=total,
            status="Pending",
        )
        db.session.add(order)
        db.session.flush()  # populate order.id for the OrderItem FK below

        order_item = OrderItem(
            order_id=order.id,
            product_id=product.id,
            product_name=product.name,
            quantity=1,
            price=item_price,
            selected_variants=selected_variants,
        )
        db.session.add(order_item)

        link.used_at = datetime.utcnow()
        link.created_order_id = order.id

        db.session.commit()
        return order, None
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Guest Order Submit Error: {str(e)}")
        raise

