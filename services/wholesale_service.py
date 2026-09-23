from flask import current_app
from sqlalchemy.exc import SQLAlchemyError

from models import db, Wholesale, Product


def _recompute_profit(wholesale_price, retail_price):
    """
    profit = retail_price - wholesale_price, auto-calculated per
    Hasan's confirmed design — never admin-typed. Returns None (not 0)
    when either side is missing, so an incomplete row shows profit as
    "not yet known" rather than a misleading 0.
    """
    if wholesale_price is None or retail_price is None:
        return None
    return round(retail_price - wholesale_price, 2)


def get_all_wholesale_rows():
    """
    Powers the Wholesale tab's list view. Joins in the product name/
    image so the dashboard doesn't need a second round-trip per row —
    see to_dict_with_product below.
    """
    return Wholesale.query.order_by(Wholesale.updated_at.desc()).all()


def get_wholesale_by_product_id(product_id):
    return Wholesale.query.filter_by(product_id=product_id).first()


def to_dict_with_product(wholesale_row):
    """
    Wholesale.to_dict() plus just enough Product context (name/image)
    for the dashboard card to be readable without a second fetch.
    Still never includes anything from the public Product.to_dict()
    beyond these two display fields.
    """
    data = wholesale_row.to_dict()
    product = wholesale_row.product
    data["product_name"] = product.name if product else None
    data["product_image"] = product.image if product else None
    return data


def update_wholesale_row(product_id, data):
    """
    Updates the (already auto-created — see models/wholesale.py's
    after_insert event) Wholesale row for a product. This is an update
    only — there is no create path, since every product already has an
    empty row waiting from the moment it was created.

    data: dict with any of jersey_name, wholesale_price, retail_price,
    wholesaler. profit is never accepted from the client — always
    recomputed server-side from wholesale_price/retail_price.
    """
    try:
        row = get_wholesale_by_product_id(product_id)
        if not row:
            # Shouldn't happen (the event guarantees one exists for
            # every product), but guard against a product created
            # before this feature existed / any drift.
            return None, "No wholesale row found for this product"

        if "jersey_name" in data:
            row.jersey_name = data.get("jersey_name") or None
        if "wholesale_price" in data:
            raw = data.get("wholesale_price")
            row.wholesale_price = float(raw) if raw not in (None, "") else None
        if "retail_price" in data:
            raw = data.get("retail_price")
            row.retail_price = float(raw) if raw not in (None, "") else None
        if "wholesaler" in data:
            row.wholesaler = data.get("wholesaler") or None

        row.profit = _recompute_profit(row.wholesale_price, row.retail_price)

        db.session.commit()
        return row, None
    except (ValueError, TypeError) as e:
        db.session.rollback()
        return None, f"Invalid number format: {str(e)}"
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Wholesale Update Error: {str(e)}")
        raise

