from flask import Blueprint, request, jsonify, current_app, render_template
from sqlalchemy.exc import SQLAlchemyError

from services.admin_service import admin_required
from services.guest_order_link_service import (
    create_guest_link,
    get_all_guest_links,
    validate_link,
    get_available_sizes,
    submit_guest_order,
)

guest_link_bp = Blueprint("guest_order_links", __name__)


# ---------------- ADMIN: generate + list links ----------------

@guest_link_bp.route('/api/admin/guest-links', methods=['GET'])
@admin_required
def list_guest_links():
    try:
        links = get_all_guest_links()
        return jsonify({'status': 'success', 'data': [l.to_dict() for l in links]}), 200
    except Exception as e:
        current_app.logger.error(f"Error in list_guest_links: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to fetch guest links'}), 500


@guest_link_bp.route('/api/admin/guest-links', methods=['POST'])
@admin_required
def create_guest_link_route():
    """
    Body: {"product_id": 1, "payment_method": "bkash",
    "shipping_zone": "inside_dhaka", "payment_type": "postpaid"}.
    Returns the link's token — the dashboard builds the shareable URL
    as {origin}/order-link/{token}.
    """
    try:
        data = request.get_json() or {}
        for field in ('product_id', 'payment_method', 'shipping_zone'):
            if not data.get(field):
                return jsonify({'status': 'error', 'message': f"Missing field: {field}"}), 400

        link, error = create_guest_link(
            product_id=data['product_id'],
            payment_method=data['payment_method'],
            shipping_zone=data['shipping_zone'],
            payment_type=data.get('payment_type', 'postpaid'),
        )
        if error:
            return jsonify({'status': 'error', 'message': error}), 400

        return jsonify({'status': 'success', 'data': link.to_dict()}), 201
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in create_guest_link_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error occurred'}), 500
    except Exception as e:
        current_app.logger.error(f"Unexpected error in create_guest_link_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to create link'}), 500


# ---------------- PUBLIC: the guest fills this in ----------------

@guest_link_bp.route('/order-link/<string:token>', methods=['GET'])
def guest_order_form_page(token):
    """
    No @admin_required, no login_required — this is the whole point,
    a link a guest with no account opens directly. The token itself is
    the only gate (see validate_link). Renders an error state in the
    same template rather than a raw 404/500 if the link is dead, so a
    customer who opens an expired link sees a normal-looking page, not
    a broken one.
    """
    link, error = validate_link(token)
    if error:
        return render_template("guest_order_form.html", link=None, error=error, sizes=[])

    sizes = get_available_sizes(link.product)
    return render_template("guest_order_form.html", link=link, error=None, sizes=sizes)


@guest_link_bp.route('/api/guest-order-links/<string:token>/submit', methods=['POST'])
def submit_guest_order_route(token):
    """
    Public POST — the actual order-creation call from
    guest_order_form.html's JS. Body: {"customer_name", "phone",
    "address", "thana", "size"}.
    """
    try:
        data = request.get_json() or {}
        order, error = submit_guest_order(token, data)
        if error:
            return jsonify({'status': 'error', 'message': error}), 400

        return jsonify({'status': 'success', 'data': order.to_dict()}), 201
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in submit_guest_order_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error occurred'}), 500
    except Exception as e:
        current_app.logger.error(f"Unexpected error in submit_guest_order_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Something went wrong submitting your order'}), 500

