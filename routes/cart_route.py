import logging
from flask import Blueprint, request, jsonify
from services.cart_service import (
    get_or_create_client_token,
    add_item_to_cart,
    remove_item_from_cart,
    fetch_cart_contents,
    clear_cart
)

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

cart_bp = Blueprint('cart', __name__, url_prefix='/api/cart')

@cart_bp.route('', methods=['GET'])
def get_cart():
    try:
        token = get_or_create_client_token()
        logger.debug(f"Fetching cart for token: {token}")
        
        cart_contents = fetch_cart_contents(token)
        return jsonify({'status': 'success', 'data': cart_contents}), 200
    except Exception as e:
        logger.error(f"Failed to fetch cart: {str(e)}", exc_info=True)
        return jsonify({'status': 'error', 'message': 'Internal Server Error'}), 500

@cart_bp.route('/add', methods=['POST'])
def add_to_cart():
    try:
        # Step 1: Validate JSON presence
        data = request.get_json()
        if not data:
            logger.warning("Add to cart failed: No JSON payload provided")
            return jsonify({'status': 'error', 'message': 'Missing request body'}), 400
        
        logger.debug(f"Received add_to_cart payload: {data}")

        # Step 2: Extract and Validate Required Fields
        product_id = data.get('product_id')
        size = data.get('size')
        quantity = data.get('quantity', 1)

        if not product_id:
            logger.warning("Add to cart failed: product_id is missing")
            return jsonify({'status': 'error', 'message': 'product_id is required'}), 400

        if not size:
            logger.warning(f"Add to cart failed: size is missing for product {product_id}")
            return jsonify({'status': 'error', 'message': 'Size variant is required'}), 400

        # Step 3: Type conversion with error handling
        try:
            product_id = int(product_id)
            quantity = int(quantity)
        except (ValueError, TypeError):
            logger.warning(f"Add to cart failed: Invalid type for product_id ({product_id}) or quantity ({quantity})")
            return jsonify({'status': 'error', 'message': 'Invalid data format'}), 400

        # Step 4: Call Service Layer
        token = get_or_create_client_token()
        logger.debug(f"Processing add_to_cart for token: {token} | Product: {product_id} | Qty: {quantity}")
        
        success, message, cart_data = add_item_to_cart(token, product_id, quantity, size)

        if not success:
            logger.info(f"Service layer rejected add_to_cart: {message}")
            return jsonify({'status': 'error', 'message': message}), 400

        logger.info(f"Successfully added product {product_id} to cart {token}")
        return jsonify({'status': 'success', 'data': cart_data}), 201

    except Exception as e:
        logger.error(f"Unexpected error in add_to_cart: {str(e)}", exc_info=True)
        return jsonify({'status': 'error', 'message': 'An internal error occurred'}), 500

@cart_bp.route('/remove', methods=['POST'])
def remove_from_cart():
    try:
        data = request.get_json()
        logger.debug(f"Received remove_from_cart payload: {data}")

        product_id = data.get('product_id')
        size = data.get('size')

        if not product_id or not size:
            logger.warning("Remove from cart failed: product_id or size missing")
            return jsonify({'status': 'error', 'message': 'product_id and size are required'}), 400

        token = get_or_create_client_token()
        success, message, cart_data = remove_item_from_cart(token, product_id, size)

        if not success:
            logger.info(f"Service layer rejected remove_from_cart: {message}")
            return jsonify({'status': 'error', 'message': message}), 404

        return jsonify({'status': 'success', 'data': cart_data}), 200
    except Exception as e:
        logger.error(f"Unexpected error in remove_from_cart: {str(e)}", exc_info=True)
        return jsonify({'status': 'error', 'message': 'An internal error occurred'}), 500

@cart_bp.route('/clear', methods=['POST'])
def clear_cart_route():
    try:
        token = get_or_create_client_token()
        logger.debug(f"Clearing cart for token: {token}")
        
        success, message = clear_cart(token)
        
        if not success:
            return jsonify({'status': 'error', 'message': message}), 400
            
        return jsonify({'status': 'success', 'message': message}), 200
    except Exception as e:
        logger.error(f"Unexpected error in clear_cart: {str(e)}", exc_info=True)
        return jsonify({'status': 'error', 'message': 'An internal error occurred'}), 500

