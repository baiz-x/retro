from flask import Blueprint, request, jsonify, current_app
from sqlalchemy.exc import SQLAlchemyError

from services.admin_service import admin_required
from services.wholesale_service import (
    get_all_wholesale_rows,
    get_wholesale_by_product_id,
    to_dict_with_product,
    update_wholesale_row,
)

# Same /api url_prefix convention as order_bp/product_bp — every route
# here also sits under /admin, so @admin_required is the ONLY gate
# (per Hasan's confirmed decision: same auth as the rest of the
# dashboard, no stricter permission tier). Nothing in this blueprint
# is ever reachable from a public/storefront route.
wholesale_bp = Blueprint("wholesale", __name__, url_prefix="/api")


@wholesale_bp.route('/admin/wholesale', methods=['GET'])
@admin_required
def list_wholesale():
    """Backs the Wholesale tab's list view — every product's row, most recently updated first."""
    try:
        rows = get_all_wholesale_rows()
        return jsonify({'status': 'success', 'data': [to_dict_with_product(r) for r in rows]}), 200
    except Exception as e:
        current_app.logger.error(f"Error in list_wholesale: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to fetch wholesale data'}), 500


@wholesale_bp.route('/admin/wholesale/<int:product_id>', methods=['GET'])
@admin_required
def get_wholesale(product_id):
    try:
        row = get_wholesale_by_product_id(product_id)
        if not row:
            return jsonify({'status': 'error', 'message': 'No wholesale row for this product'}), 404
        return jsonify({'status': 'success', 'data': to_dict_with_product(row)}), 200
    except Exception as e:
        current_app.logger.error(f"Error in get_wholesale: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to fetch wholesale data'}), 500


@wholesale_bp.route('/admin/wholesale/<int:product_id>', methods=['PATCH'])
@admin_required
def update_wholesale(product_id):
    """
    Body (all optional, any subset): {"jersey_name": "...",
    "wholesale_price": 1200, "retail_price": 1800, "wholesaler": "..."}
    profit is never accepted here — always server-recomputed.
    """
    try:
        data = request.get_json() or {}
        row, error = update_wholesale_row(product_id, data)
        if error:
            return jsonify({'status': 'error', 'message': error}), 400
        return jsonify({'status': 'success', 'data': to_dict_with_product(row)}), 200
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in update_wholesale: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error occurred'}), 500
    except Exception as e:
        current_app.logger.error(f"Unexpected error in update_wholesale: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Update failed'}), 500

