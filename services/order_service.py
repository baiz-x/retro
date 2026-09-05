import uuid
from datetime import datetime
from flask import current_app
from sqlalchemy.exc import SQLAlchemyError
from models import db, CartItem, Product, Order, OrderItem

# Authoritative shipping fee per zone. Stored on the Order row at
# creation time (Order.shipping_fee) rather than recomputed later, so
# a future change here never alters the amount already charged on a
# past order.
SHIPPING_FEES = {
    "inside_dhaka": 70.0,
    "outside_dhaka": 140.0,
}

VALID_PAYMENT_METHODS = {"bkash", "nagad", "cod"}


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

        is_valid_zone, zone_err = validate_shipping_zone(shipping_zone)
        if not is_valid_zone:
            current_app.logger.warning(f"Order failed: {zone_err}")
            return None, zone_err

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
        total_price = subtotal + shipping_fee

        new_order = Order(
            order_id=str(uuid.uuid4()),
            user_id=user_id,
            customer_name=customer_data['customer_name'],
            phone=customer_data['phone'],
            address=customer_data['address'],
            social_platform=customer_data.get('social_platform'),
            social_handle=customer_data.get('social_handle'),
            shipping_zone=shipping_zone,
            shipping_fee=shipping_fee,
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

def update_order_status(order_id, new_status):
    """
    order_id here is the database primary key (Order.query.get() looks
    up by PK) — not the public-facing Order.order_id string, despite
    the parameter name matching that field.
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

