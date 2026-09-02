import logging
from flask import Blueprint, request, jsonify
from services.cart_service import (
    add_item_to_cart,
    remove_item_from_cart,
    update_item_quantity,
    fetch_cart_contents,
    clear_cart
)

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

cart_bp = Blueprint('cart', __name__, url_prefix='/api/cart')

@cart_bp.route('', methods=['GET'])
def get_cart():
    try:
        cart_contents = fetch_cart_contents()
        return jsonify({'status': 'success', 'data': cart_contents}), 200
    except Exception as e:
        logger.error(f"Failed to fetch cart: {str(e)}", exc_info=True)
        return jsonify({'status': 'error', 'message': 'Internal Server Error'}), 500

@cart_bp.route('/add', methods=['POST'])
def add_to_cart():
    try:
        data = request.get_json()
        if not data:
            logger.warning("Add to cart failed: No JSON payload provided")
            return jsonify({'status': 'error', 'message': 'Missing request body'}), 400

        logger.debug(f"Received add_to_cart payload: {data}")

        product_id = data.get('product_id')
        quantity = data.get('quantity', 1)
        # selected_variants: dict of axis->choice, e.g. {"size": "M"} or
        # {"size": "42", "color": "Black"}. customization: e.g.
        # {"name": "ARJUN", "number": "10"} for jersey print requests.
        selected_variants = data.get('selected_variants') or {}
        customization = data.get('customization') or {}

        if not product_id:
            logger.warning("Add to cart failed: product_id is missing")
            return jsonify({'status': 'error', 'message': 'product_id is required'}), 400

        if not isinstance(selected_variants, dict):
            return jsonify({'status': 'error', 'message': 'selected_variants must be an object'}), 400
        if not isinstance(customization, dict):
            return jsonify({'status': 'error', 'message': 'customization must be an object'}), 400

        try:
            product_id = int(product_id)
            quantity = int(quantity)
        except (ValueError, TypeError):
            logger.warning(f"Add to cart failed: Invalid type for product_id ({product_id}) or quantity ({quantity})")
            return jsonify({'status': 'error', 'message': 'Invalid data format'}), 400

        success, message, cart_data = add_item_to_cart(product_id, quantity, selected_variants, customization)

        if not success:
            logger.info(f"Service layer rejected add_to_cart: {message}")
            return jsonify({'status': 'error', 'message': message}), 400

        logger.info(f"Successfully added product {product_id} to cart")
        return jsonify({'status': 'success', 'data': cart_data}), 201

    except Exception as e:
        logger.error(f"Unexpected error in add_to_cart: {str(e)}", exc_info=True)
        return jsonify({'status': 'error', 'message': 'An internal error occurred'}), 500

@cart_bp.route('/remove', methods=['POST'])
def remove_from_cart():
    try:
        data = request.get_json()
        logger.debug(f"Received remove_from_cart payload: {data}")

        # Cart lines are now identified by their own id (not
        # product_id+size) since the same product+variant combination
        # can appear multiple times with different customizations.
        cart_item_id = data.get('cart_item_id')

        if not cart_item_id:
            logger.warning("Remove from cart failed: cart_item_id missing")
            return jsonify({'status': 'error', 'message': 'cart_item_id is required'}), 400

        try:
            cart_item_id = int(cart_item_id)
        except (ValueError, TypeError):
            return jsonify({'status': 'error', 'message': 'Invalid cart_item_id'}), 400

        success, message, cart_data = remove_item_from_cart(cart_item_id)

        if not success:
            logger.info(f"Service layer rejected remove_from_cart: {message}")
            return jsonify({'status': 'error', 'message': message}), 404

        return jsonify({'status': 'success', 'data': cart_data}), 200
    except Exception as e:
        logger.error(f"Unexpected error in remove_from_cart: {str(e)}", exc_info=True)
        return jsonify({'status': 'error', 'message': 'An internal error occurred'}), 500

@cart_bp.route('/update', methods=['PATCH'])
def update_cart_item():
    """
    Sets a specific line's quantity directly — used by the quantity
    stepper on cart.html (both + and -, since neither /add nor
    /remove alone can express "decrement this exact line by one").
    """
    try:
        data = request.get_json()
        if not data:
            return jsonify({'status': 'error', 'message': 'Missing request body'}), 400

        cart_item_id = data.get('cart_item_id')
        quantity = data.get('quantity')

        if cart_item_id is None or quantity is None:
            return jsonify({'status': 'error', 'message': 'cart_item_id and quantity are required'}), 400

        try:
            cart_item_id = int(cart_item_id)
            quantity = int(quantity)
        except (ValueError, TypeError):
            return jsonify({'status': 'error', 'message': 'Invalid data format'}), 400

        success, message, cart_data = update_item_quantity(cart_item_id, quantity)

        if not success:
            logger.info(f"Service layer rejected update_cart_item: {message}")
            return jsonify({'status': 'error', 'message': message}), 400

        return jsonify({'status': 'success', 'data': cart_data}), 200
    except Exception as e:
        logger.error(f"Unexpected error in update_cart_item: {str(e)}", exc_info=True)
        return jsonify({'status': 'error', 'message': 'An internal error occurred'}), 500

@cart_bp.route('/clear', methods=['POST'])
def clear_cart_route():
    try:
        success, message = clear_cart()

        if not success:
            return jsonify({'status': 'error', 'message': message}), 400

        return jsonify({'status': 'success', 'message': message}), 200
    except Exception as e:
        logger.error(f"Unexpected error in clear_cart: {str(e)}", exc_info=True)
        return jsonify({'status': 'error', 'message': 'An internal error occurred'}), 500
