from flask import Blueprint, request, jsonify, current_app, session
from functools import wraps
from sqlalchemy.exc import SQLAlchemyError
from models import db, Order

from services.admin_service import admin_required
from services.cart_service import get_cart_owner, clear_cart
from services.order_service import (
    fetch_cart_items,
    validate_cart_not_empty,
    validate_stock_availability,
    create_order_from_cart,
    get_all_orders,
    update_order_status,
    search_orders,
    update_order_tracking_link,
    update_order_delivery,
    get_orders_for_user,
)

order_bp = Blueprint("orders", __name__, url_prefix="/api")


def api_login_required(view_func):
    """
    JSON-response counterpart to app.py's login_required (that one
    redirects to /login, which is wrong for an API blueprint) —
    guards the customer-facing order-history endpoint below. Mirrors
    the session check auth_route.py's own api_login_required already
    uses elsewhere, kept local here to avoid a cross-blueprint import.
    """
    @wraps(view_func)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return jsonify({'status': 'error', 'message': 'Login required'}), 401
        return view_func(*args, **kwargs)
    return wrapped

@order_bp.route('/checkout', methods=['POST'])
def checkout():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'status': 'error', 'message': 'Request body is required'}), 400

        for field in ['customer_name', 'phone', 'address', 'shipping_zone', 'payment_method', 'payment_type']:
            if not data.get(field):
                return jsonify({'status': 'error', 'message': f'Missing field: {field}'}), 400

        # Optional: present when checkout was reached via the PDP
        # "Order" button (?item=<id> — see checkout.js), meaning only
        # this one cart line should become the order. Absent for the
        # normal cart "Checkout" button, which still checks out
        # everything, unchanged.
        cart_item_id = data.get('cart_item_id')
        if cart_item_id is not None:
            try:
                cart_item_id = int(cart_item_id)
            except (ValueError, TypeError):
                return jsonify({'status': 'error', 'message': 'Invalid cart_item_id'}), 400

        user_id, guest_id = get_cart_owner()
        all_cart_items = fetch_cart_items(user_id=user_id, guest_id=guest_id)
        cart_items = [i for i in all_cart_items if i.id == cart_item_id] if cart_item_id is not None else all_cart_items

        is_valid, error_message = validate_cart_not_empty(cart_items)
        if not is_valid:
            return jsonify({'status': 'error', 'message': error_message}), 400

        is_valid, error_message, out_of_stock = validate_stock_availability(cart_items)
        if not is_valid:
            return jsonify({'status': 'error', 'message': error_message, 'out_of_stock': out_of_stock}), 400

        # The service internally validates shipping zone + payment
        # method, copies selected_variants/customization from CartItem
        # to OrderItem, and clears either the whole cart or just the
        # one targeted line (when cart_item_id is given) as part of
        # the same transaction.
        order, error = create_order_from_cart(user_id, guest_id, data, cart_item_id=cart_item_id)
        if error:
            return jsonify({'status': 'error', 'message': error}), 400

        return jsonify({
            'status': 'success',
            'message': 'Order placed successfully',
            'data': order.to_dict(include_items=True)
        }), 201

    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Database error in checkout: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error occurred'}), 500
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Unexpected error in checkout: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Internal error'}), 500

@order_bp.route('/admin/orders', methods=['GET'])
@admin_required
def get_orders():
    """Fetches all orders for the admin, including item details and variants."""
    try:
        orders = get_all_orders()
        return jsonify({'status': 'success', 'data': [o.to_dict(True) for o in orders]}), 200
    except Exception as e:
        current_app.logger.error(f"Error fetching orders: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to fetch orders'}), 500

@order_bp.route('/admin/orders/search', methods=['GET'])
@admin_required
def search_orders_route():
    """
    Backs the Orders tab's single search box. Query params:
      ?q=<text>        — matched against order_id / customer_name /
                          phone (digit-sequence, suffix-prioritized —
                          see order_service.search_orders docstring)
      &status=<status> — optional, combines with q (AND, not OR) so
                          the two filters narrow together
    q='' (or omitted) with a status still applies just the status
    filter, matching the dashboard's "All" + a status button combo.
    """
    try:
        query = request.args.get('q', '')
        status = request.args.get('status') or None
        orders = search_orders(query, status=status)
        return jsonify({'status': 'success', 'data': [o.to_dict(True) for o in orders]}), 200
    except Exception as e:
        current_app.logger.error(f"Error in search_orders_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Search failed'}), 500

@order_bp.route('/admin/orders/<string:order_id>/delivery', methods=['PATCH'])
@admin_required
def update_order_delivery_route(order_id):
    """
    Admin edit of delivery_charge (shipping_fee) and/or payment_type on
    an existing order — recalculates total automatically. Body: any
    subset of {"shipping_fee": 70, "payment_type": "included"}.
    order_id here is the PUBLIC order number (the 4-char code), same
    convention as the tracking/status routes above.
    """
    try:
        data = request.get_json() or {}
        if 'shipping_fee' not in data and 'payment_type' not in data:
            return jsonify({'status': 'error', 'message': "Provide at least one of shipping_fee or payment_type"}), 400

        order = Order.query.filter_by(order_id=order_id).first()
        if not order:
            return jsonify({'status': 'error', 'message': 'Order not found'}), 404

        updated_order, error = update_order_delivery(
            order.id,
            shipping_fee=data.get('shipping_fee'),
            payment_type=data.get('payment_type'),
        )
        if error:
            return jsonify({'status': 'error', 'message': error}), 400

        return jsonify({'status': 'success', 'data': updated_order.to_dict()}), 200
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Database error in update_order_delivery_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error occurred'}), 500
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Unexpected error in update_order_delivery_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Internal error'}), 500

@order_bp.route('/admin/orders/<string:order_id>/tracking', methods=['PATCH'])
@admin_required
def update_order_tracking_route(order_id):
    """
    order_id here is the PUBLIC order number, same convention as
    update_order_status_route below — resolved to the internal PK
    before calling the service. Body: {"tracking_link": "https://..."}.
    """
    try:
        data = request.get_json() or {}
        if 'tracking_link' not in data:
            return jsonify({'status': 'error', 'message': "Missing field: tracking_link"}), 400

        order = Order.query.filter_by(order_id=order_id).first()
        if not order:
            return jsonify({'status': 'error', 'message': 'Order not found'}), 404

        updated_order, error = update_order_tracking_link(order.id, data.get('tracking_link'))
        if error:
            return jsonify({'status': 'error', 'message': error}), 400

        return jsonify({'status': 'success', 'data': updated_order.to_dict()}), 200
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Database error in update_order_tracking_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error occurred'}), 500
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Unexpected error in update_order_tracking_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Internal error'}), 500

@order_bp.route('/account/orders', methods=['GET'])
@api_login_required
def get_my_orders():
    """
    Customer-facing order history — logged-in users only (per Hasan's
    confirmed scope; guest checkouts have no account to look up
    against). Backs templates/orders.html.
    """
    try:
        orders = get_orders_for_user(session['user_id'])
        return jsonify({'status': 'success', 'data': [o.to_dict(True) for o in orders]}), 200
    except Exception as e:
        current_app.logger.error(f"Error in get_my_orders: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to fetch orders'}), 500

@order_bp.route('/admin/orders/<string:order_id>/status', methods=['PATCH'])
@admin_required
def update_order_status_route(order_id):
    """
    Moves an order through the pipeline: Pending -> Packaged -> Picked
    -> Transit -> Delivered, with Failed reachable from any state (see
    models/order.py's OrderStatus). Body: {"status": "Packaged"}.

    order_id here is the PUBLIC order number (the UUID string shown
    in the dashboard) — not the internal database primary key.
    update_order_status() itself expects the primary key (it calls
    Order.query.get(), which only works by PK), so this route looks
    the order up by its public order_id first and passes the
    resolved integer id through.
    """
    try:
        data = request.get_json() or {}
        new_status = data.get('status')
        if not new_status:
            return jsonify({'status': 'error', 'message': "Missing field: status"}), 400

        order = Order.query.filter_by(order_id=order_id).first()
        if not order:
            return jsonify({'status': 'error', 'message': 'Order not found'}), 404

        updated_order, error = update_order_status(order.id, new_status)
        if error:
            return jsonify({'status': 'error', 'message': error}), 400

        return jsonify({
            'status': 'success',
            'data': updated_order.to_dict()
        }), 200
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Database error in update_order_status_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error occurred'}), 500
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Unexpected error in update_order_status_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Internal error'}), 500


