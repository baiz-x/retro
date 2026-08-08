import uuid
from datetime import datetime
from flask import session, current_app
from sqlalchemy.exc import SQLAlchemyError
from models import db, CartItem, Product, Order, OrderItem

def fetch_cart_items(client_token):
    try:
        return CartItem.query.filter_by(client_token=client_token).all()
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

    SURGICAL CHANGE: cart items now carry `selected_variants` (a JSON
    dict, e.g. {"size": "200ml", "color": "Red"}) instead of a flat
    `size` string — required so a jar_candle line can record size AND
    scent AND color together, which a single string column can't hold.
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

def reduce_stock_logic(cart_items):
    """
    Deducts stock for each cart line via product_service.reduce_variant_stock,
    which already knows how to branch on variant_mode (unified vs
    per_variant) correctly. Delegating here instead of re-implementing
    the same branching a second time — two independent copies of this
    logic is exactly what caused it to fall out of sync with the schema
    once already in this codebase.

    SURGICAL CHANGE: reads item.selected_variants (JSON dict) instead
    of item.size (flat string) — see validate_stock_availability above
    for why.
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

def create_order_from_cart(client_token, customer_data):
    """
    Creates an order from cart items. 
    Strictly validates that bKash payment data is provided in the customer_data payload.
    """
    try:
        # 1. Validate Payment Details (Mandatory Refactor)
        payment_number = customer_data.get('payment_number')
        transaction_id = customer_data.get('transaction_id')

        # 2. Fetch and Validate Cart
        cart_items = fetch_cart_items(client_token)
        is_not_empty, empty_err = validate_cart_not_empty(cart_items)
        if not is_not_empty:
            current_app.logger.warning(f"Order failed: {empty_err}")
            return None

        # 3. Validate Stock
        is_available, message, details = validate_stock_availability(cart_items)
        if not is_available:
            current_app.logger.warning(f"Order failed stock check: {message}")
            return None

        # 4. Total calculation
        total_price = sum(item.price * item.quantity for item in cart_items)
        
        # 5. Create the Order (Mapping direct form fields)
        # BUG FIX: order_id was never set here despite `uuid` being
        # imported at the top of this file for exactly this purpose —
        # Order.order_id is NOT NULL, so this would have failed on save.
        new_order = Order(
            order_id=str(uuid.uuid4()),
            customer_name=customer_data['customer_name'],
            phone=customer_data['phone'],
            address=customer_data['address'],
            payment_number=payment_number,
            transaction_id=transaction_id,
            total=total_price,
            status='Pending'
        )
        db.session.add(new_order)
        db.session.flush()

        # 6. Transfer Cart items to Order items
        for item in cart_items:
            order_item = OrderItem(
                # BUG FIX: OrderItem.order_id is an Integer FK to
                # orders.id (the real database primary key). The
                # original code passed new_order.order_id, which is
                # the STRING public order number (Order.order_id) —
                # a type/reference mismatch that would either crash or
                # silently create a broken foreign key. new_order.id
                # is the correct value here.
                order_id=new_order.id,
                product_id=item.product_id,
                product_name=item.product.name,
                quantity=item.quantity,
                price=item.price,
                # SURGICAL CHANGE: selected_variants (JSON dict) instead
                # of size (flat string) — same reasoning as above.
                selected_variants=item.selected_variants
            )
            db.session.add(order_item)
        
        # 7. Handle Inventory
        reduce_stock_logic(cart_items)

        # 8. Clear Cart
        CartItem.query.filter_by(client_token=client_token).delete()

        # 9. COMMIT
        db.session.commit()
        return new_order

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
    the parameter name matching that field. Kept as-is since that's
    how the original code already called it and Query.get() only
    works by primary key.
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

