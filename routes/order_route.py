from flask import Blueprint, request, jsonify, current_app
from sqlalchemy.exc import SQLAlchemyError
from models import db, Order

from services.admin_service import admin_required
from services.cart_service import get_or_create_client_token, clear_cart 
from services.order_service import (
    fetch_cart_items, 
    validate_cart_not_empty,
    validate_stock_availability,
    create_order_from_cart,
    get_all_orders,
    update_order_status
)

order_bp = Blueprint("orders", __name__, url_prefix="/api")

@order_bp.route('/checkout', methods=['POST'])
def checkout():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'status': 'error', 'message': 'Request body is required'}), 400
        
        for field in ['customer_name', 'phone', 'address']:
            if not data.get(field):
                return jsonify({'status': 'error', 'message': f'Missing field: {field}'}), 400

        client_token = get_or_create_client_token()
        cart_items = fetch_cart_items(client_token)
        
        is_valid, error_message = validate_cart_not_empty(cart_items)
        if not is_valid:
            return jsonify({'status': 'error', 'message': error_message}), 400
            
        is_valid, error_message, out_of_stock = validate_stock_availability(cart_items)
        if not is_valid:
            return jsonify({'status': 'error', 'message': error_message, 'out_of_stock': out_of_stock}), 400

        # The service internally copies selected_variants from CartItem to OrderItem
        order = create_order_from_cart(client_token, data)
        clear_cart(client_token)
        
        return jsonify({
            'status': 'success',
            'message': 'Order placed successfully',
            # include_items=True ensures each line's selected_variants are included in the JSON
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
        # Logic: include_items=True returns selected_variants for each product line
        return jsonify({'status': 'success', 'data': [o.to_dict(True) for o in orders]}), 200
    except Exception as e:
        current_app.logger.error(f"Error fetching orders: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to fetch orders'}), 500

@order_bp.route('/admin/orders/<string:order_id>/status', methods=['PATCH'])
@admin_required
def update_order_status_route(order_id):
    """
    Moves an order through the 4-state pipeline: Pending -> Packaged
    -> Delivering -> Delivered. Body: {"status": "Packaged"}.

    order_id here is the PUBLIC order number (the UUID string shown
    in the dashboard) — not the internal database primary key.
    update_order_status() itself expects the primary key (it calls
    Order.query.get(), which only works by PK), so this route looks
    the order up by its public order_id first and passes the
    resolved integer id through, keeping that function's existing
    signature and behavior untouched.
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

