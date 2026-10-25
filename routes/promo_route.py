from datetime import datetime
from functools import wraps

from flask import Blueprint, request, jsonify, session, current_app
from sqlalchemy.exc import SQLAlchemyError, IntegrityError

from models import db, Product
from models.promo import (
    Promo, PromoProduct, WheelSegment, WheelSpin,
    PROMO_TYPES, USAGE_MODES, USAGE_REUSABLE,
    PROMO_TYPE_TIER, PROMO_TYPE_PERCENT, PROMO_TYPE_WHEEL,
)
from services.admin_service import admin_required
from services.cart_service import get_cart_owner
from services.order_service import fetch_cart_items
from services import promo_service

promo_bp = Blueprint("promos", __name__, url_prefix="/api")


def api_login_required(view_func):
    """Same pattern as order_route.py's own local copy — kept local
    here too, to avoid a cross-blueprint import."""
    @wraps(view_func)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return jsonify({"status": "error", "message": "Login required"}), 401
        return view_func(*args, **kwargs)
    return wrapped


# =====================================================================
# ADMIN — Campaigns tab CRUD
# =====================================================================

@promo_bp.route("/admin/promos", methods=["GET"])
@admin_required
def list_promos():
    promos = Promo.query.filter(Promo.wheel_parent_id.is_(None)).order_by(Promo.created_at.desc()).all()
    return jsonify({"status": "success", "data": [p.to_dict() for p in promos]}), 200


def _parse_dt(value):
    if not value:
        return None
    try:
        # <input type="datetime-local"> gives "2026-10-01T13:00"
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _sync_products(promo, product_ids):
    PromoProduct.query.filter_by(promo_id=promo.id).delete()
    seen = set()
    for pid in product_ids or []:
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            continue
        if pid in seen:
            continue
        seen.add(pid)
        db.session.add(PromoProduct(promo_id=promo.id, product_id=pid))


def _sync_segments(promo, segments):
    WheelSegment.query.filter_by(promo_id=promo.id).delete()
    for seg in segments or []:
        label = (seg.get("label") or "").strip()
        if not label:
            continue
        try:
            pct = float(seg.get("discount_percent", 0))
            weight = float(seg.get("weight", 1))
        except (TypeError, ValueError):
            continue
        db.session.add(WheelSegment(
            promo_id=promo.id, label=label,
            discount_percent=max(pct, 0), weight=max(weight, 0),
        ))


@promo_bp.route("/admin/promos", methods=["POST"])
@admin_required
def create_promo():
    try:
        data = request.get_json() or {}
        code = promo_service.normalize_code(data.get("code"))
        promo_type = data.get("promo_type")
        usage_mode = data.get("usage_mode", USAGE_REUSABLE)
        discount_amount = data.get("discount_amount")
        applies_to_all = bool(data.get("applies_to_all", False))
        product_ids = data.get("product_ids", [])
        segments = data.get("segments", [])

        if not code:
            return jsonify({"status": "error", "message": "Code is required"}), 400
        if promo_type not in PROMO_TYPES:
            return jsonify({"status": "error", "message": f"promo_type must be one of {PROMO_TYPES}"}), 400
        if usage_mode not in USAGE_MODES:
            return jsonify({"status": "error", "message": f"usage_mode must be one of {USAGE_MODES}"}), 400

        is_valid, err = promo_service.validate_discount_amount(promo_type, discount_amount)
        if not is_valid:
            return jsonify({"status": "error", "message": err}), 400

        if Promo.query.filter_by(code=code).first():
            return jsonify({"status": "error", "message": "This code already exists"}), 400

        promo = Promo(
            code=code,
            promo_type=promo_type,
            usage_mode=usage_mode,
            discount_amount=discount_amount if promo_type != PROMO_TYPE_WHEEL else None,
            starts_at=_parse_dt(data.get("starts_at")),
            expires_at=_parse_dt(data.get("expires_at")),
            applies_to_all=applies_to_all,
            is_active=bool(data.get("is_active", True)),
        )
        db.session.add(promo)
        db.session.flush()

        if not applies_to_all:
            _sync_products(promo, product_ids)
        if promo_type == PROMO_TYPE_WHEEL:
            _sync_segments(promo, segments)

        db.session.commit()
        return jsonify({"status": "success", "data": promo.to_dict()}), 201

    except IntegrityError:
        db.session.rollback()
        return jsonify({"status": "error", "message": "This code already exists"}), 400
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"DB error creating promo: {e}")
        return jsonify({"status": "error", "message": "Database error occurred"}), 500


@promo_bp.route("/admin/promos/<int:promo_id>", methods=["PATCH"])
@admin_required
def update_promo(promo_id):
    try:
        promo = Promo.query.get(promo_id)
        if not promo:
            return jsonify({"status": "error", "message": "Promo not found"}), 404

        data = request.get_json() or {}

        if "discount_amount" in data or "promo_type" in data:
            new_type = data.get("promo_type", promo.promo_type)
            new_amount = data.get("discount_amount", promo.discount_amount)
            is_valid, err = promo_service.validate_discount_amount(new_type, new_amount)
            if not is_valid:
                return jsonify({"status": "error", "message": err}), 400
            promo.promo_type = new_type
            promo.discount_amount = new_amount if new_type != PROMO_TYPE_WHEEL else None

        if "usage_mode" in data:
            if data["usage_mode"] not in USAGE_MODES:
                return jsonify({"status": "error", "message": f"usage_mode must be one of {USAGE_MODES}"}), 400
            promo.usage_mode = data["usage_mode"]

        if "starts_at" in data:
            promo.starts_at = _parse_dt(data["starts_at"])
        if "expires_at" in data:
            promo.expires_at = _parse_dt(data["expires_at"])
        if "applies_to_all" in data:
            promo.applies_to_all = bool(data["applies_to_all"])
        if "is_active" in data:
            promo.is_active = bool(data["is_active"])

        if "product_ids" in data:
            _sync_products(promo, data["product_ids"])
        if "segments" in data and promo.promo_type == PROMO_TYPE_WHEEL:
            _sync_segments(promo, data["segments"])

        db.session.commit()
        return jsonify({"status": "success", "data": promo.to_dict()}), 200

    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"DB error updating promo: {e}")
        return jsonify({"status": "error", "message": "Database error occurred"}), 500


@promo_bp.route("/admin/promos/<int:promo_id>", methods=["DELETE"])
@admin_required
def delete_promo(promo_id):
    try:
        promo = Promo.query.get(promo_id)
        if not promo:
            return jsonify({"status": "error", "message": "Promo not found"}), 404
        # Cascades to PromoProduct, WheelSegment, and — critically —
        # every prize code this wheel minted (Promo.prize_codes
        # cascade="all, delete-orphan"), per Hasan's confirmed "they
        # die too" for wheel prize codes.
        db.session.delete(promo)
        db.session.commit()
        return jsonify({"status": "success", "message": "Promo deleted"}), 200
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"DB error deleting promo: {e}")
        return jsonify({"status": "error", "message": "Database error occurred"}), 500


@promo_bp.route("/admin/promos/bulk", methods=["POST"])
@admin_required
def bulk_create_airdrop():
    """
    Airdrop batch: generates `count` unique single-use PERCENT codes
    sharing one discount_amount/starts_at/expires_at/product scope —
    "I might upload 10 or 20 codes at once to people to race for it"
    (confirmed). Returns the generated codes so the admin can copy
    them out for the social-media post.
    """
    try:
        data = request.get_json() or {}
        count = int(data.get("count", 0))
        if not (1 <= count <= 200):
            return jsonify({"status": "error", "message": "count must be between 1 and 200"}), 400

        discount_amount = data.get("discount_amount")
        is_valid, err = promo_service.validate_discount_amount(PROMO_TYPE_PERCENT, discount_amount)
        if not is_valid:
            return jsonify({"status": "error", "message": err}), 400

        applies_to_all = bool(data.get("applies_to_all", False))
        product_ids = data.get("product_ids", [])
        prefix = promo_service.normalize_code(data.get("prefix", ""))[:10]
        starts_at = _parse_dt(data.get("starts_at"))
        expires_at = _parse_dt(data.get("expires_at"))

        created = []
        for _ in range(count):
            code = promo_service.generate_unique_code(prefix=prefix)
            promo = Promo(
                code=code, promo_type=PROMO_TYPE_PERCENT, usage_mode="single_use",
                discount_amount=discount_amount, applies_to_all=applies_to_all,
                starts_at=starts_at, expires_at=expires_at, is_active=True,
            )
            db.session.add(promo)
            db.session.flush()
            if not applies_to_all:
                _sync_products(promo, product_ids)
            created.append(promo)

        db.session.commit()
        return jsonify({
            "status": "success",
            "data": {"codes": [p.code for p in created], "count": len(created)},
        }), 201

    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"DB error bulk-creating airdrop: {e}")
        return jsonify({"status": "error", "message": "Database error occurred"}), 500


@promo_bp.route("/admin/products/minimal", methods=["GET"])
@admin_required
def products_minimal():
    """Lightweight id/name/price list for the Campaigns tab's product picker."""
    products = Product.query.order_by(Product.name.asc()).all()
    return jsonify({
        "status": "success",
        "data": [{"id": p.id, "name": p.name, "price": p.price} for p in products],
    }), 200


@promo_bp.route("/promo/check", methods=["POST"])
def check_promo_code():
    """
    Cart-free validity check for the /airdrop landing page — a
    customer with a code but nothing in their cart yet just wants to
    know "is this real and still live" before they go shop. Never
    redeems or reserves anything (redemption only ever happens inside
    create_order_from_cart's transaction, at checkout).
    """
    data = request.get_json() or {}
    raw_code = (data.get("code") or "").strip()
    if not raw_code:
        return jsonify({"status": "error", "message": "Enter a code."}), 400

    promo = promo_service.get_promo_by_code(raw_code)
    if not promo:
        return jsonify({"status": "error", "message": "That code doesn't exist."}), 404

    if promo.promo_type == PROMO_TYPE_WHEEL:
        return jsonify({
            "status": "success",
            "data": {"kind": "wheel", "message": "This is a wheel code — spin it on the /wheel page."},
        }), 200

    live, err = promo_service.is_live(promo)
    if not live:
        return jsonify({"status": "error", "message": err}), 400

    return jsonify({
        "status": "success",
        "data": {"kind": "discount", "message": "Valid! Use it at checkout."},
    }), 200


# =====================================================================
# STOREFRONT — cart preview + apply (used by checkout.js)
# =====================================================================

def _preview_response(cart_items, typed_code, user_id):
    pricing = promo_service.price_cart_items(cart_items, typed_code=typed_code, user_id=user_id)
    subtotal = sum(line["unit_price"] * line["cart_item"].quantity for line in pricing["lines"])
    original_subtotal = sum(
        line["original_unit_price"] * line["cart_item"].quantity for line in pricing["lines"]
    )
    return {
        "status": "error" if pricing["error"] else "success",
        "message": pricing["error"],
        "data": {
            "subtotal": round(subtotal, 2),
            "original_subtotal": round(original_subtotal, 2),
            "discount_total": round(pricing["discount_total"], 2),
            "reason": pricing["reason"],
            "applied_code": pricing["applied_promo"].code if pricing["applied_promo"] else None,
        },
    }


@promo_bp.route("/promo/preview", methods=["POST"])
def preview_promo():
    """
    Called by checkout.js on page load (no code — shows tier pricing if
    any applies) and again whenever the customer types a code into the
    promo box (debounced client-side). Never writes anything — pure
    read, safe to call as often as needed.
    """
    try:
        data = request.get_json() or {}
        typed_code = (data.get("promo_code") or "").strip() or None

        user_id, guest_id = get_cart_owner()
        cart_item_id = data.get("cart_item_id")
        all_items = fetch_cart_items(user_id=user_id, guest_id=guest_id)
        if cart_item_id is not None:
            try:
                cart_item_id = int(cart_item_id)
            except (TypeError, ValueError):
                return jsonify({"status": "error", "message": "Invalid cart_item_id"}), 400
            cart_items = [i for i in all_items if i.id == cart_item_id]
        else:
            cart_items = all_items

        if not cart_items:
            return jsonify({"status": "error", "message": "Your cart is empty"}), 400

        payload = _preview_response(cart_items, typed_code, user_id)
        status_code = 200 if payload["status"] == "success" or not typed_code else 400
        return jsonify(payload), status_code

    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"DB error previewing promo: {e}")
        return jsonify({"status": "error", "message": "Database error occurred"}), 500


# =====================================================================
# WHEEL
# =====================================================================

@promo_bp.route("/wheel/info", methods=["GET"])
@api_login_required
def wheel_info():
    """Returns segment labels/weights for rendering the wheel graphic
    BEFORE the user spins — the spin itself is a separate POST so the
    server-chosen result can't be inferred from render order."""
    raw_code = request.args.get("code", "")
    promo = promo_service.get_promo_by_code(raw_code)
    if not promo or promo.promo_type != PROMO_TYPE_WHEEL:
        return jsonify({"status": "error", "message": "Invalid wheel code."}), 404

    live, err = promo_service.is_live(promo)
    already_spun = False
    if live:
        already_spun = WheelSpin.query.filter_by(
            promo_id=promo.id, user_id=session.get("user_id")
        ).first() is not None

    return jsonify({
        "status": "success",
        "data": {
            "code": promo.code,
            "segments": [s.to_dict() for s in promo.segments],
            "is_live": live,
            "error": None if live else err,
            "already_spun": already_spun,
        },
    }), 200


@promo_bp.route("/wheel/spin", methods=["POST"])
@api_login_required
def wheel_spin_route():
    try:
        data = request.get_json() or {}
        raw_code = data.get("code", "")
        user_id = session.get("user_id")

        result, error = promo_service.spin_wheel(raw_code, user_id)
        if error:
            return jsonify({"status": "error", "message": error}), 400

        return jsonify({"status": "success", "data": result}), 200

    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"DB error spinning wheel: {e}")
        return jsonify({"status": "error", "message": "Database error occurred"}), 500
