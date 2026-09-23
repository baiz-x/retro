import secrets
from datetime import datetime
from flask import current_app
from sqlalchemy.exc import SQLAlchemyError
from models import db, CartItem, Product, Order, OrderItem

# Authoritative shipping fee per zone. Stored on the Order row at
# creation time (Order.shipping_fee) rather than recomputed later, so
# a future change here never alters the amount already charged on a
# past order. Three zones (confirmed): inside_dhaka, outside_dhaka,
# sub_city — sub_city added alongside the original two, same ৳70 as
# inside_dhaka but kept as a distinct zone value (not merged into
# inside_dhaka) since they're conceptually different delivery areas
# that happen to share a price today.
SHIPPING_FEES = {
    "inside_dhaka": 70.0,
    "outside_dhaka": 140.0,
    "sub_city": 70.0,
}

VALID_PAYMENT_METHODS = {"bkash", "nagad", "cod"}

# See models/order.py's payment_type column docstring for the full
# meaning of each value — this set is just the validation gate.
VALID_PAYMENT_TYPES = {"prepaid", "postpaid", "included"}

# 33 characters: digits 1-9 (9) + A-Z minus I and O (24) — I/O excluded
# per Hasan's confirmed spec to avoid customer confusion with 1/0.
# 33 x 32 x 31 x 30 ≈ 982,080 possible 4-character codes with no
# repeated character within one code.
ORDER_ID_CHARSET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZ"
ORDER_ID_LENGTH = 4
ORDER_ID_MAX_ATTEMPTS = 10


def generate_order_id():
    """
    Generates a random 4-character order ID (e.g. "HU2G") from
    ORDER_ID_CHARSET with no repeated character within the code, and
    guarantees it doesn't already exist in the orders table.

    Uses `secrets.SystemRandom().sample` rather than `random` — not for
    security here (this isn't a secret/token), but because `sample`
    without replacement is exactly "no repeated character" for free,
    and secrets' CSPRNG-backed source means the sequence is truly
    unpredictable (confirmed requirement: competitors can't guess
    order volume from watching codes over time).

    Retries up to ORDER_ID_MAX_ATTEMPTS times on a collision (checked
    against the DB each time) before raising — with ~982,080 possible
    codes, a collision is already rare at low thousands of orders, so
    10 straight collisions in a row would indicate something is
    actually wrong (e.g. the charset/DB check is broken) rather than
    ordinary bad luck, which is exactly when Hasan confirmed he wants
    this to fail loudly instead of silently.
    """
    rng = secrets.SystemRandom()
    for _ in range(ORDER_ID_MAX_ATTEMPTS):
        candidate = "".join(rng.sample(ORDER_ID_CHARSET, ORDER_ID_LENGTH))
        exists = db.session.query(
            Order.query.filter_by(order_id=candidate).exists()
        ).scalar()
        if not exists:
            return candidate
    raise RuntimeError(
        f"Could not generate a unique order ID after {ORDER_ID_MAX_ATTEMPTS} attempts"
    )


def recompute_total(subtotal, shipping_fee, payment_type):
    """
    The single source of truth for Order.total — called both at
    checkout (create_order_from_cart) and whenever the admin edits
    shipping_fee/payment_type afterward (update_order_delivery), so
    the two paths can never compute total differently from each other.

    Formula (confirmed):
      postpaid  -> total = subtotal + shipping_fee
      prepaid   -> total = subtotal
      included  -> total = subtotal - shipping_fee
    """
    shipping_fee = shipping_fee or 0.0
    if payment_type == "postpaid":
        return subtotal + shipping_fee
    if payment_type == "included":
        return subtotal - shipping_fee
    # "prepaid" (and defensively, anything else post-validation)
    return subtotal


def validate_payment_type(payment_type):
    if payment_type not in VALID_PAYMENT_TYPES:
        return False, f"Invalid payment type '{payment_type}'. Must be one of: {', '.join(VALID_PAYMENT_TYPES)}"
    return True, None


def fetch_cart_items(user_id=None, guest_id=None):
    try:
        if user_id:
            return CartItem.query.filter_by(user_id=user_id).all()
        return CartItem.query.filter_by(guest_id=guest_id).all()
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in fetch_cart_items: {str(e)}")
        raise


def validate_cart_not_empty(cart_items):
    """Checks if there is actually anything to buy."""
    if not cart_items or len(cart_items) == 0:
        return False, "Your cart is empty"
    return True, None


def validate_stock_availability(cart_items):
    """
    Checks stock for each cart line against the product's variant_mode:
      - "unified": one shared product.stock number covers every combination
      - "per_variant": each combination in product.variants['combinations']
        has its own stock; item.selected_variants identifies which one
    """
    out_of_stock = []
    for item in cart_items:
        product = item.product
        selected = item.selected_variants or {}
        mode = product.variant_mode or "unified"

        if mode == "per_variant":
            combinations = (product.variants or {}).get('combinations', [])
            match = None
            for combo in combinations:
                if all(combo.get(axis) == value for axis, value in selected.items()):
                    match = combo
                    break

            label = f"{product.name} ({', '.join(f'{k}: {v}' for k, v in selected.items())})" if selected else product.name

            if match is None:
                out_of_stock.append({'name': label, 'error': "Selected combination no longer exists"})
                continue

            available_qty = int(match.get('stock', 0))
            if available_qty < item.quantity:
                out_of_stock.append({
                    'name': label,
                    'requested': item.quantity,
                    'available': available_qty
                })

        else:  # unified
            available_qty = int(product.stock or 0)
            if available_qty < item.quantity:
                out_of_stock.append({
                    'name': product.name,
                    'requested': item.quantity,
                    'available': available_qty
                })

    if out_of_stock:
        return False, "Insufficient stock for some items", out_of_stock
    return True, None, []


def validate_shipping_zone(shipping_zone):
    if shipping_zone not in SHIPPING_FEES:
        return False, f"Invalid shipping zone '{shipping_zone}'. Must be one of: {', '.join(SHIPPING_FEES.keys())}"
    return True, None


def validate_payment_details(payment_method, transaction_id, payment_number, shipping_fee):
    """
    Enforces payment-method-specific requirements:
      - bkash / nagad: a real transaction requires both a transaction_id
        and the payment_number it was sent from.
      - cod: the customer still pays the shipping fee upfront via
        mobile payment as an advance (common practice to deter no-shows
        on cash-on-delivery orders) — so transaction_id/payment_number
        are still required here too, representing that advance payment
        rather than the full order total.
    In every case the fields themselves are the same two columns;
    what differs is only whether they're required and what they
    represent, so this doesn't need branching logic beyond the
    "were they provided" check itself.
    """
    if payment_method not in VALID_PAYMENT_METHODS:
        return False, f"Invalid payment method '{payment_method}'. Must be one of: {', '.join(VALID_PAYMENT_METHODS)}"

    if not transaction_id or not payment_number:
        if payment_method == "cod":
            return False, f"Advance payment details required for Cash on Delivery (shipping fee: ৳{shipping_fee:.2f})"
        return False, f"Transaction ID and payment number are required for {payment_method}"

    return True, None


def reduce_stock_logic(cart_items):
    """
    Deducts stock for each cart line via product_service.reduce_variant_stock,
    which already knows how to branch on variant_mode (unified vs
    per_variant) correctly.
    """
    from services.product_service import reduce_variant_stock  # local import avoids a circular import at module load time

    for item in cart_items:
        product = item.product
        selected = item.selected_variants or {}
        success, message = reduce_variant_stock(product, selected, item.quantity)
        if not success:
            # validate_stock_availability should have caught this already,
            # so reaching here means a race condition (stock changed
            # between validation and this reduction) — raise rather than
            # silently continue, so create_order_from_cart's rollback fires.
            raise ValueError(f"Stock reduction failed for {product.name}: {message}")


def create_order_from_cart(user_id, guest_id, customer_data, cart_item_id=None):
    """
    Creates an order from the caller's cart (identified by user_id XOR
    guest_id — exactly one is non-None, same convention as
    cart_service.get_cart_owner). Validates shipping zone and
    payment-method-specific requirements before ever touching stock or
    creating rows, so a bad request fails cleanly with nothing
    half-created.

    cart_item_id: optional. When provided (the PDP "Order" button's
    flow — see routes/order_route.py), the order is built from ONLY
    that one cart line instead of the caller's whole cart, and only
    that line is removed afterward — the rest of the cart is left
    untouched. Used for /checkout?item=<id> single-line checkout.
    """
    try:
        shipping_zone = customer_data.get('shipping_zone')
        payment_method = customer_data.get('payment_method')
        payment_number = customer_data.get('payment_number')
        transaction_id = customer_data.get('transaction_id')
        payment_type = customer_data.get('payment_type', 'postpaid')

        is_valid_zone, zone_err = validate_shipping_zone(shipping_zone)
        if not is_valid_zone:
            current_app.logger.warning(f"Order failed: {zone_err}")
            return None, zone_err

        is_valid_ptype, ptype_err = validate_payment_type(payment_type)
        if not is_valid_ptype:
            current_app.logger.warning(f"Order failed: {ptype_err}")
            return None, ptype_err

        shipping_fee = SHIPPING_FEES[shipping_zone]

        is_valid_payment, payment_err = validate_payment_details(
            payment_method, transaction_id, payment_number, shipping_fee
        )
        if not is_valid_payment:
            current_app.logger.warning(f"Order failed: {payment_err}")
            return None, payment_err

        all_cart_items = fetch_cart_items(user_id=user_id, guest_id=guest_id)

        if cart_item_id is not None:
            # Single-line checkout: narrow to just the requested line,
            # but still scoped to this caller's own cart items (never
            # trust a cart_item_id to belong to the caller without
            # checking — same ownership guarantee cart_service's
            # remove/update routes already enforce).
            cart_items = [i for i in all_cart_items if i.id == cart_item_id]
            if not cart_items:
                current_app.logger.warning(f"Order failed: cart_item_id {cart_item_id} not found in caller's cart")
                return None, "Selected item was not found in your cart"
        else:
            cart_items = all_cart_items

        is_not_empty, empty_err = validate_cart_not_empty(cart_items)
        if not is_not_empty:
            current_app.logger.warning(f"Order failed: {empty_err}")
            return None, empty_err

        is_available, stock_err, _details = validate_stock_availability(cart_items)
        if not is_available:
            current_app.logger.warning(f"Order failed stock check: {stock_err}")
            return None, stock_err

        subtotal = sum(item.price * item.quantity for item in cart_items)
        total_price = recompute_total(subtotal, shipping_fee, payment_type)

        new_order = Order(
            order_id=generate_order_id(),
            user_id=user_id,
            customer_name=customer_data['customer_name'],
            phone=customer_data['phone'],
            address=customer_data['address'],
            social_platform=customer_data.get('social_platform'),
            social_handle=customer_data.get('social_handle'),
            shipping_zone=shipping_zone,
            shipping_fee=shipping_fee,
            payment_type=payment_type,
            payment_method=payment_method,
            payment_number=payment_number,
            transaction_id=transaction_id,
            subtotal=subtotal,
            total=total_price,
            status='Pending'
        )
        db.session.add(new_order)
        db.session.flush()

        for item in cart_items:
            order_item = OrderItem(
                order_id=new_order.id,
                product_id=item.product_id,
                product_name=item.product.name,
                quantity=item.quantity,
                price=item.price,
                selected_variants=item.selected_variants,
                # Jersey (or other) print request, copied as-is from the
                # cart line — see models/cart_item.py.
                customization=item.customization,
            )
            db.session.add(order_item)

        reduce_stock_logic(cart_items)

        if cart_item_id is not None:
            # Only remove the line(s) this order was built from — the
            # rest of the caller's cart stays exactly as it was.
            for item in cart_items:
                db.session.delete(item)
        elif user_id:
            CartItem.query.filter_by(user_id=user_id).delete()
        else:
            CartItem.query.filter_by(guest_id=guest_id).delete()

        db.session.commit()
        return new_order, None

    except ValueError as ve:
        db.session.rollback()
        current_app.logger.error(f"Validation Error: {str(ve)}")
        raise
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"CRITICAL: Order Creation Error: {str(e)}")
        raise

def get_all_orders():
    return Order.query.order_by(Order.created_at.desc()).all()


def _digits_only(s):
    """Strips everything but digits, e.g. '+880 1876-389827' -> '01876389827'."""
    return "".join(ch for ch in (s or "") if ch.isdigit())


def search_orders(query, status=None):
    """
    Powers the Orders tab's single search box (Hasan's confirmed spec):
      - order_id:      substring match (case-insensitive), e.g. typing
                        part of the UUID finds it
      - customer_name: substring match (case-insensitive) — NOT unique,
                        multiple customers can share a name
      - phone:         digit-sequence match anywhere in the stored
                        number, e.g. typing "6389" matches a phone that
                        CONTAINS 6389 anywhere ("01876389827"). Results
                        are ranked so a SUFFIX match (query is the
                        tail-end of the number, the realistic case when
                        someone reads the last few digits off a
                        delivery label) sorts above a match anywhere
                        else in the number — confirmed: simple two-tier
                        ranking, not a full position-weighted score.

    status: optional — when given, narrows to orders in that status
    BEFORE searching, so the two filters combine (per Hasan's confirmed
    "search 6389 within only Transit orders" example).

    query='' (empty/whitespace) returns get_all_orders()'s ordering
    under the given status, unchanged — this is what the dashboard
    calls when the search box is cleared.
    """
    base = Order.query
    if status:
        base = base.filter(Order.status == status)

    query = (query or "").strip()
    if not query:
        return base.order_by(Order.created_at.desc()).all()

    query_digits = _digits_only(query)
    like_pattern = f"%{query}%"

    if query_digits:
        # Phone matching needs Python-side digit comparison (stored
        # numbers may contain spaces/dashes/+880 formatting that a SQL
        # LIKE on the raw column would miss) — so for a digit query we
        # fetch order_id/name/phone candidates in one query, then rank
        # in Python. Order volume here is small (boutique store, not
        # call-center scale), so this is simpler and more predictable
        # than a DB-side trigram/regex approach.
        candidates = base.filter(
            db.or_(
                Order.order_id.ilike(like_pattern),
                Order.customer_name.ilike(like_pattern),
                Order.phone.isnot(None),
            )
        ).all()

        def rank(order):
            phone_digits = _digits_only(order.phone)
            order_id_hit = query.lower() in (order.order_id or "").lower()
            name_hit = query.lower() in (order.customer_name or "").lower()

            if phone_digits and phone_digits.endswith(query_digits):
                return 0  # suffix match — highest priority
            if phone_digits and query_digits in phone_digits:
                return 1  # matches somewhere inside the number
            if order_id_hit or name_hit:
                return 2  # fell back to order_id/name text match
            return 3  # only matched the OR'd isnot(None) clause — drop it

        ranked = [(rank(o), o) for o in candidates]
        ranked = [(t, o) for t, o in ranked if t < 3]
        ranked.sort(key=lambda pair: (pair[0], -(pair[1].created_at.timestamp() if pair[1].created_at else 0)))
        return [o for _, o in ranked]

    # Non-digit query (name or partial order_id, e.g. "Karim" or a UUID
    # fragment) — plain substring match, newest first.
    return base.filter(
        db.or_(
            Order.order_id.ilike(like_pattern),
            Order.customer_name.ilike(like_pattern),
        )
    ).order_by(Order.created_at.desc()).all()


def update_order_delivery(order_id, shipping_fee=None, payment_type=None):
    """
    Admin-only edit of delivery_charge (shipping_fee) and/or
    payment_type on an EXISTING order — e.g. correcting a fee, or
    switching to "included" after collecting extra advance. Always
    recomputes total via recompute_total() so it can never drift from
    the checkout-time formula.

    order_id here is the database primary key, same convention as
    update_order_status()/update_order_tracking_link(). Either
    argument can be omitted (None) to leave that field unchanged.
    """
    try:
        order = Order.query.get(order_id)
        if not order:
            return None, "Order not found"

        if shipping_fee is not None:
            try:
                order.shipping_fee = float(shipping_fee)
            except (ValueError, TypeError):
                return None, "shipping_fee must be a number"

        if payment_type is not None:
            is_valid, err = validate_payment_type(payment_type)
            if not is_valid:
                return None, err
            order.payment_type = payment_type

        order.total = recompute_total(order.subtotal, order.shipping_fee, order.payment_type)
        db.session.commit()
        return order, None
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Order Delivery Update Error: {str(e)}")
        raise


def update_order_tracking_link(order_id, tracking_link):
    """
    order_id here is the database primary key, same convention as
    update_order_status(). tracking_link may be '' / None to clear it
    (admin removing a mistaken/stale link) — no validation on shape,
    since Hasan confirmed this is a plain manual text field, not tied
    to any courier API.
    """
    try:
        order = Order.query.get(order_id)
        if not order:
            return None, "Order not found"
        order.tracking_link = tracking_link or None
        db.session.commit()
        return order, None
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Tracking Link Update Error: {str(e)}")
        raise


def get_orders_for_user(user_id):
    """
    Powers the customer-facing order history page (logged-in users
    only, per Hasan's confirmed scope — guest orders have no lookup).
    """
    return Order.query.filter_by(user_id=user_id).order_by(Order.created_at.desc()).all()

def update_order_status(order_id, new_status):
    """
    order_id here is the database primary key (Order.query.get() looks
    up by PK) — not the public-facing Order.order_id string, despite
    the parameter name matching that field.

    Pipeline (confirmed): Pending -> Packaged -> Picked -> Transit ->
    Delivered, with Failed reachable from any state — see
    models/order.py's OrderStatus enum. Not enforced as a strict state
    machine here (any value in OrderStatus.values() is accepted
    regardless of current status), same as the original 4-state design.
    """
    from models import OrderStatus  # local import avoids a circular import at module load time

    if new_status not in OrderStatus.values():
        return None, f"Invalid status '{new_status}'. Must be one of: {', '.join(OrderStatus.values())}"

    try:
        order = Order.query.get(order_id)
        if not order:
            return None, "Order not found"
        order.status = new_status
        db.session.commit()
        return order, None
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Status Update Error: {str(e)}")
        raise


