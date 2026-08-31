import os
from flask import Blueprint, request, jsonify, current_app
from sqlalchemy.exc import SQLAlchemyError

from services.product_service import (
    get_all_products,
    get_product_by_id,
    get_product_by_slug_service,
    create_product,
    update_product,
    delete_product,
    reduce_variant_stock,
    filter_products_service,
    get_random_products_service,
    get_distinct_categories_service
)

from services.admin_service import admin_required

product_bp = Blueprint("products", __name__, url_prefix="/api")

@product_bp.route('/products', methods=['GET'])
def get_products():
    try:
        # limit is optional — omitted entirely, this is the exact same
        # unordered Product.query.all() the admin dashboard has always used.
        limit = request.args.get('limit', None)
        products = get_all_products(limit=limit)
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

@product_bp.route('/products/slug/<string:slug>', methods=['GET'])
def get_product_by_slug(slug):
    try:
        product = get_product_by_slug_service(slug)

        if not product:
            return jsonify({'status': 'error', 'message': 'Product not found'}), 404

        return jsonify({
            'status': 'success',
            'data': product.to_dict()
        }), 200

    except Exception as e:
        current_app.logger.error(f"Error in get_product_by_slug: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error'}), 500

@product_bp.route('/products/filter', methods=['GET'])
def filter_listings():
    """Public storefront filter endpoint — product_type/club/category/
    version/price ride real columns (edition too, as of the JSONB-to-
    column fix); brand/type/material/fabric/gsm are also real indexed
    columns (v4). All are exact-match except price and gsm (both
    ranges). product_type is the key scoping filter — pass jersey/
    boots/others to get results relevant to that type's own field set."""
    try:
        filters = {
            'product_type': request.args.get('product_type', None),
            'club': request.args.get('club', None),
            'category': request.args.get('category', None),
            'search': request.args.get('search', None),
            'min_price': request.args.get('min_price', None),
            'max_price': request.args.get('max_price', None),
            'edition': request.args.get('edition', None),
            'version': request.args.get('version', None),
            'brand': request.args.get('brand', None),
            'type': request.args.get('type', None),
            'material': request.args.get('material', None),
            'fabric': request.args.get('fabric', None),
            'min_gsm': request.args.get('min_gsm', None),
            'max_gsm': request.args.get('max_gsm', None),
        }

        # Clean empty filters out
        filters = {k: v for k, v in filters.items() if v not in [None, '']}

        filtered_data = filter_products_service(filters)
        return jsonify({
            'status': 'success',
            'data': filtered_data,
            'count': len(filtered_data)
        }), 200

    except Exception as e:
        current_app.logger.error(f"Error in filter_listings route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Filter operation failed'}), 500

@product_bp.route('/products/categories', methods=['GET'])
def get_product_categories():
    """Distinct category values currently in the DB — backs the
    products page's Category dropdown. See get_distinct_categories_service
    docstring for why this replaced the free-text filter."""
    try:
        categories = get_distinct_categories_service()
        return jsonify({
            'status': 'success',
            'data': categories
        }), 200
    except Exception as e:
        current_app.logger.error(f"Error in get_product_categories route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to retrieve categories'}), 500

@product_bp.route('/products/random', methods=['GET'])
def get_random_products():
    """Backs the homepage's Random Discovery rail. Excludes stock=0.
    Defaults to 5 to match the current rail's card count; pass ?limit=
    to override."""
    try:
        limit = request.args.get('limit', 5)
        products = get_random_products_service(limit=limit)
        return jsonify({
            'status': 'success',
            'data': products,
            'count': len(products)
        }), 200
    except Exception as e:
        current_app.logger.error(f"Error in get_random_products route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to retrieve random products'}), 500

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
    Body: {"selected_variants": {"jersey_size": "M", ...}}
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





