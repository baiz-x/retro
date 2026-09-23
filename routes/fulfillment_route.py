from flask import Blueprint, request, jsonify, current_app
from sqlalchemy.exc import SQLAlchemyError

from services.admin_service import admin_required
from services.fulfillment_service import get_fulfillment_summary, checkoff_one

fulfillment_bp = Blueprint("fulfillment", __name__, url_prefix="/api")


@fulfillment_bp.route('/admin/fulfillment', methods=['GET'])
@admin_required
def get_fulfillment():
    try:
        summary = get_fulfillment_summary()
        return jsonify({'status': 'success', 'data': summary}), 200
    except Exception as e:
        current_app.logger.error(f"Error in get_fulfillment: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to fetch fulfillment summary'}), 500


@fulfillment_bp.route('/admin/fulfillment/checkoff', methods=['POST'])
@admin_required
def checkoff_fulfillment_item():
    """
    Body: {"product_id": 1, "size": "M"} (size omitted/null for
    non-sized products). Increments the tally by 1 — this is the ×
    click, purely a temporary manual count, never touches Order data.
    """
    try:
        data = request.get_json() or {}
        product_id = data.get('product_id')
        if not product_id:
            return jsonify({'status': 'error', 'message': "Missing field: product_id"}), 400

        row, error = checkoff_one(product_id, data.get('size'))
        if error:
            return jsonify({'status': 'error', 'message': error}), 400

        return jsonify({'status': 'success', 'data': {
            'product_id': row.product_id, 'size': row.size, 'checked_off_count': row.checked_off_count
        }}), 200
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in checkoff_fulfillment_item: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error occurred'}), 500
    except Exception as e:
        current_app.logger.error(f"Unexpected error in checkoff_fulfillment_item: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Checkoff failed'}), 500

