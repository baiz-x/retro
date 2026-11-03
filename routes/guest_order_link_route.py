from flask import Blueprint, request, jsonify, current_app, render_template
from sqlalchemy.exc import SQLAlchemyError

from services.admin_service import admin_required
from services.guest_order_link_service import (
    create_guest_link,
    get_all_guest_links,
    validate_link,
    get_available_sizes,
    preview_link,
    submit_guest_order,
    create_moderator_link,
    list_moderator_links,
    revoke_moderator_link,
    get_active_moderator_link,
    list_links_for_moderator,
    get_catalog,
)

guest_link_bp = Blueprint("guest_order_links", __name__)


# Moderator pages/APIs hold a credential in the URL, so keep it out of caches,
# search engines and Referer headers.
@guest_link_bp.after_request
def _moderator_privacy_headers(response):
    if request.path.startswith('/mod/') or request.path.startswith('/api/mod/'):
        response.headers['Cache-Control'] = 'no-store'
        # NOT 'no-referrer': Flask-WTF's strict CSRF check on HTTPS needs a Referer on
        # the page's own POSTs. 'same-origin' still keeps the token-in-URL out of any
        # request to another site.
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['X-Robots-Tag'] = 'noindex, nofollow'
    return response


def _create_link_from_request(moderator_link_id=None):
    """Shared by the admin route and the moderator route.
    Body: {"items": [{"product_id", "selected_variants", "quantity"}, ...],
           "payment_method", "shipping_zone", "payment_type", "promo_code"?}
    (a bare "product_id" still makes a legacy single-product link)."""
    data = request.get_json() or {}
    for field in ('payment_method', 'shipping_zone'):
        if not data.get(field):
            return jsonify({'status': 'error', 'message': f"Missing field: {field}"}), 400
    if not data.get('items') and not data.get('product_id'):
        return jsonify({'status': 'error', 'message': 'Add at least one product'}), 400

    link, error = create_guest_link(
        items=data.get('items'),
        product_id=data.get('product_id'),
        payment_method=data['payment_method'],
        shipping_zone=data['shipping_zone'],
        payment_type=data.get('payment_type', 'postpaid'),
        promo_code=data.get('promo_code'),
        moderator_link_id=moderator_link_id,
    )
    if error:
        return jsonify({'status': 'error', 'message': error}), 400
    return jsonify({'status': 'success', 'data': link.to_dict()}), 201


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
    try:
        return _create_link_from_request(moderator_link_id=None)
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in create_guest_link_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error occurred'}), 500
    except Exception as e:
        current_app.logger.error(f"Unexpected error in create_guest_link_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to create link'}), 500


# ---------------- ADMIN: moderator access links ----------------

@guest_link_bp.route('/api/admin/moderator-links', methods=['GET'])
@admin_required
def list_moderator_links_route():
    try:
        return jsonify({'status': 'success', 'data': list_moderator_links()}), 200
    except Exception as e:
        current_app.logger.error(f"Error in list_moderator_links_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to fetch moderator links'}), 500


@guest_link_bp.route('/api/admin/moderator-links', methods=['POST'])
@admin_required
def create_moderator_link_route():
    """Body: {"label": "Rahim", "days": 7}. The dashboard builds the URL as
    {origin}/mod/{token}."""
    try:
        data = request.get_json() or {}
        mod, error = create_moderator_link(data.get('label'), data.get('days'))
        if error:
            return jsonify({'status': 'error', 'message': error}), 400
        return jsonify({'status': 'success', 'data': mod.to_dict(links_created=0)}), 201
    except Exception as e:
        current_app.logger.error(f"Error in create_moderator_link_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to create moderator link'}), 500


@guest_link_bp.route('/api/admin/moderator-links/<int:link_id>/revoke', methods=['POST'])
@admin_required
def revoke_moderator_link_route(link_id):
    try:
        mod, error = revoke_moderator_link(link_id)
        if error:
            return jsonify({'status': 'error', 'message': error}), 404
        return jsonify({'status': 'success', 'data': mod.to_dict()}), 200
    except Exception as e:
        current_app.logger.error(f"Error in revoke_moderator_link_route: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to revoke moderator link'}), 500


# ---------------- MODERATOR: token is the only credential ----------------
# None of these use @admin_required and none can reach an admin route: the
# admin cookie/API key and a moderator token are separate mechanisms.

def _mod_or_error(token, touch=False):
    mod, error = get_active_moderator_link(token, touch=touch)
    if error:
        return None, (jsonify({'status': 'error', 'message': error}), 403)
    return mod, None


@guest_link_bp.route('/mod/<string:token>', methods=['GET'])
def moderator_console_page(token):
    mod, error = get_active_moderator_link(token, touch=True)
    if error:
        return render_template("moderator_console.html", mod=None, error=error, token=token)
    return render_template("moderator_console.html", mod=mod, error=None, token=token)


@guest_link_bp.route('/api/mod/<string:token>/catalog', methods=['GET'])
def moderator_catalog(token):
    mod, err = _mod_or_error(token)
    if err:
        return err
    try:
        return jsonify({'status': 'success', 'data': get_catalog()}), 200
    except Exception as e:
        current_app.logger.error(f"Error in moderator_catalog: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to load products'}), 500


@guest_link_bp.route('/api/mod/<string:token>/guest-links', methods=['GET'])
def moderator_list_links(token):
    mod, err = _mod_or_error(token)
    if err:
        return err
    try:
        return jsonify({'status': 'success', 'data': list_links_for_moderator(mod)}), 200
    except Exception as e:
        current_app.logger.error(f"Error in moderator_list_links: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to load links'}), 500


@guest_link_bp.route('/api/mod/<string:token>/guest-links', methods=['POST'])
def moderator_create_link(token):
    mod, err = _mod_or_error(token)
    if err:
        return err
    try:
        return _create_link_from_request(moderator_link_id=mod.id)
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in moderator_create_link: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error occurred'}), 500
    except Exception as e:
        current_app.logger.error(f"Unexpected error in moderator_create_link: {str(e)}")
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

    Multi-product links show their lines + discount + delivery + total
    (view); legacy single-product links keep the size dropdown (sizes).
    """
    link, error = validate_link(token)
    if error:
        return render_template("guest_order_form.html", link=None, error=error, sizes=[], view=None)

    view, view_error = preview_link(link)
    if view_error:
        return render_template("guest_order_form.html", link=None, error=view_error, sizes=[], view=None)

    sizes = get_available_sizes(link.product) if (not link.items and link.product) else []
    return render_template("guest_order_form.html", link=link, error=None, sizes=sizes, view=view)


@guest_link_bp.route('/api/guest-order-links/<string:token>/submit', methods=['POST'])
def submit_guest_order_route(token):
    """
    Public POST — the actual order-creation call from guest_order_form.js.
    Body: {"customer_name", "phone", "address", "thana", "contact_channel",
    "contact_handle", "size" (legacy single-product links only)}.
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

