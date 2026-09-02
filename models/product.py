from datetime import datetime
from . import db


class Product(db.Model):
    __tablename__ = "products"

    # Composite index backing filter_products_service's product_type/
    # club/category/price query (product_service.py). product_type
    # leads the composite since "all boots under ৳X" / "all jerseys for
    # club Y" is the realistic storefront query shape — Postgres can
    # still use this index for club/category/price-only queries too
    # (leftmost-prefix rule), just less efficiently than a query that
    # also includes product_type.
    #
    # brand/type/material/fabric/gsm each get their own single-column
    # index below (index=True on the column itself, v4) per Hasan's
    # confirmed decision to index them ahead of the storefront filters
    # that will use them, rather than waiting until those filters exist.
    __table_args__ = (
        db.Index('idx_products_type_club_category_price', 'product_type', 'club', 'category', 'price'),
    )

    id = db.Column(db.Integer, primary_key=True)

    # URL-safe unique identifier, generated once at creation time from
    # name (see product_service.py create_slug/create_product) and never
    # regenerated on update — so a shared/bookmarked product URL never
    # breaks from a later name edit. Nullable for now so this migrates
    # cleanly onto existing rows without a backfill; new rows always get one.
    slug = db.Column(db.String(255), unique=True, nullable=True, index=True)

    # Real, indexed columns (not variants JSON) — both promoted from
    # free-text/no-field-at-all specifically so they're typo-safe and
    # filterable via a real composite index (see idx_products_club_category_price
    # below), per Hasan's confirmed decision. club used to be a free-text
    # variant axis (jersey_club); category didn't exist anywhere before.
    # Existing rows will have both as NULL after migration — nothing
    # back-fills automatically from the old variants.axes.jersey_club data.
    club = db.Column(db.String(120), nullable=True, index=True)
    category = db.Column(db.String(120), nullable=True, index=True)

    # Promoted out of variants.axes (was jersey_edition/jersey_version/
    # jersey_kit_type, checkbox-group axes) into real columns, per
    # Hasan's confirmed decision — one edition/version/kit_type per
    # product listing, not a variant. Same reasoning as club/category:
    # filterable dimensions need to be real columns, not JSON axes,
    # and it makes /products?edition=Player actually work instead of
    # relying on a JSONB path query. Jersey-only in practice (boots/
    # others never populate these) but kept ungated at the model level,
    # same as club/category, rather than adding collection-conditional
    # columns.
    edition = db.Column(db.String(60), nullable=True, index=True)
    version = db.Column(db.String(60), nullable=True)
    kit_type = db.Column(db.String(60), nullable=True)

    # ---- PER-TYPE IDENTITY FIELDS (v4) ----
    # Fixed per listing (not variant axes), real typed+indexed columns,
    # ungated at the model level (same pattern as club/edition above) —
    # every column exists regardless of collection_tags; the dashboard
    # only shows/sends the ones relevant to the selected product type.
    #
    # jersey: club (above), edition/version/kit_type (above), fabric
    fabric = db.Column(db.String(120), nullable=True, index=True)

    # boots + others share brand/type; boots adds material, others adds
    # gsm — both also use color, but as an identity field (one color per
    # listing), NOT a variant axis. Only boots varies by color per-SKU
    # (size×color); others' color is fixed per listing (size-only axis),
    # confirmed.
    brand = db.Column(db.String(120), nullable=True, index=True)
    type = db.Column(db.String(60), nullable=True, index=True)
    material = db.Column(db.String(120), nullable=True, index=True)
    color = db.Column(db.String(60), nullable=True)

    # others only
    gsm = db.Column(db.Integer, nullable=True, index=True)

    # ---- PERMANENT FIELDS (every product has these) ----
    name = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text, nullable=True)
    image = db.Column(db.String(500), nullable=True)            # main thumbnail
    gallery = db.Column(db.JSON, nullable=True, default=list)    # list[str], detail-page images

    # Machine-readable single-value mirror of collection_tags[0] — a
    # real, indexed String column so /products/filter?product_type=boots
    # can do a plain WHERE and ride an index, instead of scanning the
    # unindexed collection_tags JSON column with a per-row containment
    # check. collection_tags itself is left in place unchanged (still
    # the field the dashboard reads/writes, still JSON) since existing
    # code depends on its list shape — product_type is populated
    # alongside it in product_service.py, kept in sync at write time.
    product_type = db.Column(db.String(20), nullable=True, index=True)

    # collection_tags drives which identity/variant fields the dashboard
    # shows for this product (see COLLECTION_FIELDS in dashboard.js).
    # Confirmed mutually exclusive as of the Retro Studio pivot — a
    # product carries exactly one tag, e.g. ["jersey"] or ["boots"] or
    # ["others"].
    collection_tags = db.Column(db.JSON, nullable=False, default=list)

    # Kept as a separate human-readable label too (e.g. "Coastal Line")
    # since collection_tags is the machine-readable field-set key, and
    # a display name doesn't have to match it 1:1.
    collection_label = db.Column(db.String(120), nullable=True)

    # ---- BASE PRICE / STOCK ----
    # Meaning depends on variant_mode:
    #   "unified"     -> these ARE the price/stock for every combination,
    #                    exactly as typed in the dashboard — untouched.
    #   "per_variant" -> these are SERVER-COMPUTED, not admin-typed, as
    #                    of Hasan's confirmed fix: price = lowest variant
    #                    price ("From ৳X" display value), stock = sum of
    #                    every combination's stock. Recomputed on every
    #                    create AND update (see product_service.py's
    #                    recompute_base_price_and_stock()) — the admin
    #                    dashboard still POSTs whatever base price/stock
    #                    the form had, but for per_variant products that
    #                    value is discarded and overwritten server-side,
    #                    never trusted as-is. This is what every read
    #                    path (filter query's stock>0 gate, stock note,
    #                    JSON-LD availability, card price) actually
    #                    reads — so keeping it correct here means none
    #                    of those downstream paths need per_variant-aware
    #                    branching of their own.
    price = db.Column(db.Float, nullable=False, default=0.0)
    stock = db.Column(db.Integer, nullable=False, default=0)

    variant_mode = db.Column(db.String(20), nullable=False, default="unified")  # "unified" | "per_variant"

    # Store-owned vs pre-order/sourced-on-demand, per Hasan's confirmed
    # design. Defaults True (pre-order) so anything created before this
    # column existed — or any product where the admin hasn't touched
    # the toggle — keeps today's actual behavior (the disclaimer always
    # showed) rather than silently flipping to "in stock now" messaging.
    #
    # True  (pre-order): build_stock_note() always shows the pre-order
    #   disclaimer; stock is NEVER inspected for messaging, since Hasan
    #   keeps pre-order variant stock artificially high (e.g. 1000) so
    #   it never reads as low/out — real stock semantics don't apply.
    # False (store-owned): real 3-state stock note applies (out of
    #   stock / low quantity / neutral-empty), since the stock number
    #   means actual on-hand inventory here.
    is_preorder = db.Column(db.Boolean, nullable=False, default=True)

    # ---- VARIANTS — one JSON blob, shape below ----
    # Per-type variant axes (confirmed, v4) — everything else about a
    # product (fabric, edition, brand, material, gsm, etc.) is now an
    # identity column above, NOT an axis:
    #   jersey: size only
    #   boots:  size x color  (only type where color varies per-SKU)
    #   others: size only     (others' color is an identity field, fixed
    #                          per listing — see `color` column above)
    #
    # jersey example:
    # {
    #   "axes": { "size": ["S", "M", "L", "XL"] },
    #   "combinations": [
    #     {"size": "M", "price": 1800, "stock": 12},
    #     {"size": "L", "price": 1800, "stock": 5}
    #   ],
    #   "axis_images": { "size": {"M": "https://.../m.jpg"} }
    # }
    #
    # boots example (two axes):
    # {
    #   "axes": { "size": ["42", "43"], "color": ["Black", "White"] },
    #   "combinations": [
    #     {"size": "42", "color": "Black", "price": 4500, "stock": 3},
    #     {"size": "43", "color": "Black", "price": 4500, "stock": 2}
    #   ],
    #   "axis_images": { "color": {"Black": "https://.../black.jpg"} }
    # }
    #
    # In "unified" mode, combinations may be empty or hold a single
    # row with no price/stock (both come from the product's own
    # price/stock fields instead) — axis_images still applies; a
    # unified-price product can still swap photos on click, confirmed.
    variants = db.Column(db.JSON, nullable=True, default=dict)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    order_items = db.relationship("OrderItem", back_populates="product")
    cart_items = db.relationship("CartItem", back_populates="product")

    def to_dict(self):
        return {
            "id": self.id,
            "slug": self.slug,
            "name": self.name,
            "description": self.description,
            "image": self.image,
            "gallery": self.gallery or [],
            "collection_tags": self.collection_tags or [],
            "product_type": self.product_type,
            "collection_label": self.collection_label,
            "club": self.club,
            "category": self.category,
            "edition": self.edition,
            "version": self.version,
            "kit_type": self.kit_type,
            "fabric": self.fabric,
            "brand": self.brand,
            "type": self.type,
            "material": self.material,
            "color": self.color,
            "gsm": self.gsm,
            "price": self.price,
            "stock": self.stock,
            "variant_mode": self.variant_mode,
            "is_preorder": self.is_preorder,
            "variants": self.variants or {},
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }




