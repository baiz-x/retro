import uuid
from datetime import datetime, timedelta
from flask import session
from sqlalchemy.exc import SQLAlchemyError
from models import db, Product, CartItem

GUEST_ID_COOKIE = "guest_id"
GUEST_ID_MAX_AGE_DAYS = 365


def get_current_user_id():
    return session.get("user_id")


def get_or_create_guest_id():
    """
    REPLACES the old get_or_create_client_token(). Only meaningful for
    anonymous visitors — a logged-in user's cart is owned by user_id
    instead, so this is never consulted once session['user_id'] is set
    (see get_cart_owner below). Kept as a Flask session value (signed,
    HttpOnly, Secure, SameSite=Strict per wall.py) rather than a raw
    cookie, so it inherits all of that existing cookie hardening for
    free instead of re-implementing it.
    """
    if "guest_id" not in session:
        session["guest_id"] = str(uuid.uuid4())
    session.permanent = True
    return session["guest_id"]


def get_cart_owner():
    """
    Resolves which cart a request should read/write.
    Returns (user_id, guest_id) — exactly one is non-None. Logged-in
    users always resolve to user_id, even if a stale guest_id is still
    sitting in their session, so a request never accidentally forks
    between the two.
    """
    user_id = get_current_user_id()
    if user_id:
        return user_id, None
    return None, get_or_create_guest_id()


def _owner_filter(user_id, guest_id):
    """CartItem.query.filter_by(**_owner_filter(...)) for either owner shape."""
    if user_id:
        return {"user_id": user_id}
    return {"guest_id": guest_id}


def validate_product_exists(product_id):
    try:
        product = Product.query.get(product_id)
        if not product:
            return None, f"Product with ID {product_id} not found"
        return product, None
    except SQLAlchemyError as e:
        return None, f"Database error: {str(e)}"


def _resolve_variant_price_and_stock(product, selected_variants):
    """
    Looks up price/available stock for a specific variant selection,
    branching on product.variant_mode exactly like
    product_service.reduce_variant_stock does (kept consistent with
    that function since both read the same product.variants shape).
    Returns (price, available_stock, error).
    """
    variants = product.variants or {}
    mode = product.variant_mode or "unified"
    selected = selected_variants or {}

    if mode == "per_variant":
        combinations = variants.get("combinations", [])
        if not selected:
            return None, None, "This product requires a variant selection"

        match = None
        for combo in combinations:
            if all(combo.get(axis) == value for axis, value in selected.items()):
                match = combo
                break

        if match is None:
            return None, None, f"No matching variant found for {selected}"

        return float(match.get("price", product.price)), int(match.get("stock", 0)), None

    # unified mode: validate the selection actually exists among this
    # product's axes (if any were sent), then use the product-level
    # price/stock for everything.
    if selected:
        all_choices = []
        for axis_choices in variants.get("axes", {}).values():
            all_choices.extend(axis_choices)
        for value in selected.values():
            if value not in all_choices:
                return None, None, f"Variant '{value}' not found"

    return float(product.price), int(product.stock or 0), None


def add_item_to_cart(product_id, quantity, selected_variants=None, customization=None):
    """
    Adds a line to the caller's cart (resolved via get_cart_owner —
    logged-in user or guest, never both). A line is matched for
    quantity-merging by product_id + selected_variants (customization
    is intentionally NOT part of the match key: two jerseys with
    different name/number prints are still "the same line" only when
    variants match too — but distinct customizations on an otherwise
    identical line are common enough that merging them would silently
    drop one person's print request. Each distinct customization gets
    its own row.)
    """
    try:
        product, error = validate_product_exists(product_id)
        if error:
            return False, error, None
        if quantity <= 0:
            return False, "Quantity must be > 0", None

        selected_variants = selected_variants or {}
        customization = customization or {}

        price, available_stock, error = _resolve_variant_price_and_stock(product, selected_variants)
        if error:
            return False, error, None

        user_id, guest_id = get_cart_owner()
        owner_filter = _owner_filter(user_id, guest_id)

        existing_item = CartItem.query.filter_by(
            product_id=product_id,
            selected_variants=selected_variants,
            customization=customization,
            **owner_filter
        ).first()

        if existing_item:
            new_qty = existing_item.quantity + quantity
            if available_stock < new_qty:
                return False, f"Insufficient stock. Available: {available_stock}", None
            existing_item.quantity = new_qty
            existing_item.price = price
            existing_item.updated_at = datetime.utcnow()
        else:
            if available_stock < quantity:
                return False, f"Insufficient stock. Available: {available_stock}", None
            new_item = CartItem(
                product_id=product_id,
                quantity=quantity,
                price=price,
                selected_variants=selected_variants,
                customization=customization,
                **owner_filter
            )
            db.session.add(new_item)

        db.session.commit()
        return True, "Cart updated", fetch_cart_contents()
    except SQLAlchemyError as e:
        db.session.rollback()
        return False, str(e), None


def remove_item_from_cart(cart_item_id):
    """
    Targets a specific cart line for removal by its own id — replaces
    the old (product_id, size) lookup, which can no longer uniquely
    identify a line now that the same product+variant combination can
    appear multiple times with different customizations. Scoped to the
    caller's own cart so one person can't remove another's line by id.
    """
    try:
        user_id, guest_id = get_cart_owner()
        owner_filter = _owner_filter(user_id, guest_id)

        item = CartItem.query.filter_by(id=cart_item_id, **owner_filter).first()
        if not item:
            return False, "Cart item not found", None

        db.session.delete(item)
        db.session.commit()
        return True, "Item removed", fetch_cart_contents()
    except SQLAlchemyError as e:
        db.session.rollback()
        return False, str(e), None


def update_item_quantity(cart_item_id, new_quantity):
    """
    Sets a specific line's quantity directly (not a delta — the caller
    sends the target quantity). Added because neither add_item_to_cart
    (which only ever increments, and re-resolves price/stock by
    product+variants rather than by a specific line) nor
    remove_item_from_cart (all-or-nothing) can express "decrement this
    exact line by one" once a product can have several cart lines that
    differ only by customization. new_quantity <= 0 removes the line
    entirely, same end state as remove_item_from_cart.
    """
    try:
        user_id, guest_id = get_cart_owner()
        owner_filter = _owner_filter(user_id, guest_id)

        item = CartItem.query.filter_by(id=cart_item_id, **owner_filter).first()
        if not item:
            return False, "Cart item not found", None

        if new_quantity <= 0:
            db.session.delete(item)
            db.session.commit()
            return True, "Item removed", fetch_cart_contents()

        _price, available_stock, error = _resolve_variant_price_and_stock(
            item.product, item.selected_variants
        )
        if error:
            return False, error, None
        if available_stock < new_quantity:
            return False, f"Insufficient stock. Available: {available_stock}", None

        item.quantity = new_quantity
        item.updated_at = datetime.utcnow()
        db.session.commit()
        return True, "Cart updated", fetch_cart_contents()
    except SQLAlchemyError as e:
        db.session.rollback()
        return False, str(e), None


def clear_cart(user_id=None, guest_id=None):
    """
    Removes all items for the caller's cart. Accepts explicit
    user_id/guest_id (rather than always resolving via get_cart_owner)
    so order_service.py can clear the exact cart it just checked out
    from, even after a subsequent login/session change.
    """
    try:
        if user_id is None and guest_id is None:
            user_id, guest_id = get_cart_owner()
        owner_filter = _owner_filter(user_id, guest_id)

        CartItem.query.filter_by(**owner_filter).delete()
        db.session.commit()
        return True, "Cart cleared"
    except SQLAlchemyError as e:
        db.session.rollback()
        return False, str(e)


def fetch_cart_contents():
    """Retrieves all cart items for the caller and calculates totals."""
    try:
        user_id, guest_id = get_cart_owner()
        owner_filter = _owner_filter(user_id, guest_id)

        cart_items = CartItem.query.filter_by(**owner_filter).all()
        items = [item.to_dict() for item in cart_items]

        # Attach display fields the frontend needs but the model doesn't
        # own (product name/image) — pulled from the relationship rather
        # than duplicated onto CartItem itself.
        for item, cart_item in zip(items, cart_items):
            item["product_name"] = cart_item.product.name if cart_item.product else None
            item["image"] = cart_item.product.image if cart_item.product else None

        total_price = sum(item["subtotal"] for item in items)

        return {
            "items": items,
            "total_items": sum(item["quantity"] for item in items),
            "total_price": round(total_price, 2)
        }
    except Exception as e:
        return {"items": [], "total_items": 0, "total_price": 0, "error": str(e)}
