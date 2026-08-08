import os
from flask import Blueprint, request, jsonify, current_app
from sqlalchemy.exc import SQLAlchemyError

from services.product_service import (
    get_all_products,
    get_product_by_id,
    create_product,
    update_product,
    delete_product,
    reduce_variant_stock
)

from services.admin_service import admin_required

product_bp = Blueprint("products", __name__, url_prefix="/api")

@product_bp.route('/products', methods=['GET'])
def get_products():
    try:
        products = get_all_products()
        return jsonify({
            'status': 'success',
            'data': products,
            'count': len(products)
        }), 200
    except Exception as e:
        current_app.logger.error(f"Error in get_products route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to retrieve products'}), 500

@product_bp.route('/products/<int:product_id>', methods=['GET'])
def get_product(product_id):
    try:
        product = get_product_by_id(product_id)
        if not product:
            return jsonify({'status': 'error', 'message': 'Product not found'}), 404
        return jsonify({
            'status': 'success',
            'data': product.to_dict()
        }), 200
    except Exception as e:
        current_app.logger.error(f"Error in get_product route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error'}), 500

@product_bp.route('/admin/products', methods=['GET','POST'])
@admin_required
def add_product():
    try:
        data = request.form.to_dict()
        image_file = request.files.get('image')
        # Support for N gallery images via getlist
        gallery_files = request.files.getlist('gallery')

        if not data:
            return jsonify({'status': 'error', 'message': 'No data provided'}), 400

        product, error = create_product(data, image_file, gallery_files)

        if error:
            return jsonify({'status': 'error', 'message': error}), 400

        return jsonify({
            'status': 'success',
            'message': 'Product created successfully',
            'data': product.to_dict()
        }), 201
    except Exception as e:
        current_app.logger.error(f"Error in add_product route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Internal server error'}), 500

@product_bp.route('/admin/products/<int:product_id>', methods=['DELETE'])
@admin_required
def delete_product_route(product_id):
    try:
        success, error = delete_product(product_id)
        if error:
            return jsonify({'status': 'error', 'message': error}), 404
        return jsonify({'status': 'success', 'message': 'Product deleted'}), 200
    except Exception as e:
        current_app.logger.error(f"Error in delete_product_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Deletion failed'}), 500

@product_bp.route('/admin/products/<int:product_id>', methods=['PUT', 'PATCH'])
@admin_required
def update_product_route(product_id):
    try:
        # Enhanced to support multipart updates for images
        if request.content_type and 'multipart/form-data' in request.content_type:
            data = request.form.to_dict()
            image_file = request.files.get('image')
            gallery_files = request.files.getlist('gallery')
            product, error = update_product(product_id, data, image_file, gallery_files)
        else:
            data = request.get_json()
            product, error = update_product(product_id, data)

        if error:
            return jsonify({'status': 'error', 'message': error}), 400
        return jsonify({
            'status': 'success',
            'data': product.to_dict()
        }), 200
    except Exception as e:
        current_app.logger.error(f"Error in update_product_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Update failed'}), 500

@product_bp.route('/admin/products/<int:product_id>/stock', methods=['PATCH'])
@admin_required
def adjust_stock_route(product_id):
    """
    Manual stock adjustment for the dashboard's Stock tab.
    Body: {"delta": <int>}  — positive to increase, negative to decrease.
    Body: {"set_out_of_stock": true} — zero out the relevant stock number.
    Body: {"selected_variants": {"jersey_size": "M", "jersey_kit_type": "Home", ...}}
      — REQUIRED for a per_variant-mode product, to target one specific
      combination's own stock (confirmed requirement). Omit entirely
      for a unified-mode product, where there's only the one shared pool.
    """
    try:
        data = request.get_json() or {}
        product = get_product_by_id(product_id)
        if not product:
            return jsonify({'status': 'error', 'message': 'Product not found'}), 404

        selected_variants = data.get('selected_variants')

        if data.get('set_out_of_stock'):
            # Zero out whichever number is authoritative for this
            # request: the matched combination's stock in per_variant
            # mode, or the top-level pool in unified mode.
            if product.variant_mode == 'per_variant':
                if not selected_variants:
                    return jsonify({'status': 'error', 'message': "per_variant product requires 'selected_variants' to set out of stock"}), 400
                combinations = (product.variants or {}).get('combinations', [])
                match = next((c for c in combinations if all(c.get(a) == v for a, v in selected_variants.items())), None)
                if match is None:
                    return jsonify({'status': 'error', 'message': f"No matching combination found for {selected_variants}"}), 404
                delta = int(match.get('stock', 0))
            else:
                delta = product.stock
        elif 'delta' in data:
            try:
                delta = int(data['delta'])
            except (TypeError, ValueError):
                return jsonify({'status': 'error', 'message': "'delta' must be an integer"}), 400
        else:
            return jsonify({'status': 'error', 'message': "Provide 'delta' or 'set_out_of_stock'"}), 400

        success, message = reduce_variant_stock(product, selected_variants, delta)

        if not success:
            return jsonify({'status': 'error', 'message': message}), 400

        return jsonify({
            'status': 'success',
            'message': message,
            'data': product.to_dict()
        }), 200
    except Exception as e:
        current_app.logger.error(f"Error in adjust_stock_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Stock adjustment failed'}), 500



