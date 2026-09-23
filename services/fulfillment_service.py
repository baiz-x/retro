from flask import current_app
from sqlalchemy.exc import SQLAlchemyError

from models import db, Order, OrderItem, Product, FulfillmentCheckoff


def get_fulfillment_summary():
    """
    Aggregates OrderItem rows across currently-PENDING orders only
    (confirmed: the moment an order moves past Pending — Packaged
    onward — it drops off this list automatically, since Hasan has
    already started acting on it by then).

    Groups by (product_id, size) — size read from
    OrderItem.selected_variants['size'] when present, else grouped
    under size=None (covers non-sized "others" products). Returns one
    entry per product with a nested per-size breakdown, e.g.:

      [{"product_id": 1, "product_name": "...", "product_image": "...",
        "sizes": [{"size": "M", "needed": 4, "checked_off": 1,
                    "remaining": 3}, ...],
        "total_remaining": 7}]

    A (product_id, size) line is OMITTED entirely once checked_off >=
    needed (confirmed: fully-accounted-for lines just disappear, no
    separate reset). A product with zero remaining lines across all
    its sizes is omitted from the top-level list too, so the tab
    naturally empties out as things get checked off.
    """
    pending_items = (
        db.session.query(OrderItem)
        .join(Order, OrderItem.order_id == Order.id)
        .filter(Order.status == "Pending")
        .all()
    )

    # (product_id, size) -> needed count
    needed_map = {}
    for item in pending_items:
        size = (item.selected_variants or {}).get("size")
        key = (item.product_id, size)
        needed_map[key] = needed_map.get(key, 0) + (item.quantity or 0)

    if not needed_map:
        return []

    product_ids = {pid for pid, _ in needed_map.keys()}
    checkoffs = FulfillmentCheckoff.query.filter(
        FulfillmentCheckoff.product_id.in_(product_ids)
    ).all()
    checkoff_map = {(c.product_id, c.size): c.checked_off_count for c in checkoffs}

    products = {p.id: p for p in Product.query.filter(Product.id.in_(product_ids)).all()}

    by_product = {}
    for (product_id, size), needed in needed_map.items():
        checked_off = checkoff_map.get((product_id, size), 0)
        remaining = needed - checked_off
        if remaining <= 0:
            continue  # fully accounted for — omit (confirmed)

        product = products.get(product_id)
        if not product:
            continue  # product was deleted since the order was placed

        entry = by_product.setdefault(product_id, {
            "product_id": product_id,
            "product_name": product.name,
            "product_image": product.image,
            "sizes": [],
        })
        entry["sizes"].append({
            "size": size,
            "needed": needed,
            "checked_off": checked_off,
            "remaining": remaining,
        })

    result = list(by_product.values())
    for entry in result:
        entry["sizes"].sort(key=lambda s: (s["size"] is None, s["size"] or ""))
        entry["total_remaining"] = sum(s["remaining"] for s in entry["sizes"])
    result.sort(key=lambda e: e["product_name"] or "")
    return result


def checkoff_one(product_id, size):
    """
    Increments the checked_off_count for one (product_id, size) line by
    1 — the × click. Creates the FulfillmentCheckoff row if it doesn't
    exist yet. Does NOT touch Order/OrderItem in any way (confirmed:
    this is a separate temporary tally, not a change to the real
    order data).

    size should be passed as the exact string from the summary (or
    None/'' for a non-sized line — normalized to None here so both
    match the same row).
    """
    size = size or None
    try:
        row = FulfillmentCheckoff.query.filter_by(product_id=product_id, size=size).first()
        if not row:
            row = FulfillmentCheckoff(product_id=product_id, size=size, checked_off_count=0)
            db.session.add(row)
        row.checked_off_count += 1
        db.session.commit()
        return row, None
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Fulfillment Checkoff Error: {str(e)}")
        raise

