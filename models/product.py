"""
Athena — models.py (v3, Retro Studio pivot)

Retro Studio field-set update — replaces the v2 gypsum/jar_candle/
raw_materials collections with jersey/boots/others, per Hasan's
confirmed pivot from the mixed gypsum-art/candle/raw-material catalog
to a single-focus jerseys & clothing brand.

  - collection_tags still decides which extra fields a product shows
    (unchanged mechanism) — but jersey/boots/others are now confirmed
    MUTUALLY EXCLUSIVE (exactly one per product), not combinable. The
    dashboard now enforces this with native radio inputs; this file's
    get_extra_fields_for_collection() still returns the union of
    whatever tags are actually passed in, as a defensive fallback in
    case a raw API call ever sends more than one — it does not
    re-validate exclusivity server-side (matching the same
    client-side-only enforcement decision already made for the old
    raw_materials exclusivity, not re-litigated here).
  - variant_mode, variants (axes/combinations/axis_images), CartItem/
    OrderItem's selected_variants JSON field — all UNCHANGED from v2.
    None of that logic was collection-specific; it was already generic
    over axis names, so the jersey/boots/others pivot needed no
    changes there. Only the field-name constant below changes.
  - Fixed-option fields (jersey_edition, jersey_version,
    jersey_kit_type) are rendered as checkboxes in the dashboard
    instead of free text, per Hasan's confirmed choice — but that is
    a frontend-only distinction. This file only needs to know the
    field NAME, not which widget renders it, since the value still
    lands in variants.axes the same way either way.
"""

from datetime import datetime
from . import db
# ============================================================
# COLLECTION -> EXTRA FIELD SETS
# ============================================================
# jersey / boots / others are confirmed mutually exclusive (exactly
# one per product) — unlike the old v2 gypsum+jar_candle hybrid
# case, there is no longer a supported "combine two collections"
# product. get_extra_fields_for_collection() below still unions
# whatever tags it's given, purely as a defensive fallback (see
# docstring above) — the dashboard is what actually enforces
# exclusivity now, via radio inputs instead of checkboxes.
#
# Kept as a plain constant, not a DB table, matching the same
# not-yet-admin-editable decision already made for product types
# earlier in this build. Promote to a table later if you want
# collections/field-sets defined through the UI instead of code.
COLLECTION_EXTRA_FIELDS = {
    "jersey": ["jersey_fabric", "jersey_size", "jersey_edition", "jersey_version", "jersey_kit_type", "jersey_club"],
    "boots": ["boots_size", "boots_material", "boots_color", "boots_type"],
    "others": ["fabric_type", "gsm", "size", "color"],
}


def get_extra_fields_for_collection(collection_tags):
    """
    collection_tags: list of strings — expected to be a single tag,
    e.g. ["jersey"], since jersey/boots/others are confirmed mutually
    exclusive. Still accepts and unions multiple tags defensively (see
    module docstring) in case a raw API call ever sends more than one;
    this is not itself an endorsement of combining them.
    Returns the deduplicated union of every matching field-set, in a
    stable order. No universal fields are added — every field a
    product shows comes from its one collection tag.
    """
    fields = []
    for tag in collection_tags or []:
        for field in COLLECTION_EXTRA_FIELDS.get(tag, []):
            if field not in fields:
                fields.append(field)
    return fields

class Product(db.Model):
    __tablename__ = "products"

    id = db.Column(db.Integer, primary_key=True)

    # ---- PERMANENT FIELDS (every product has these) ----
    name = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text, nullable=True)
    image = db.Column(db.String(500), nullable=True)            # main thumbnail
    gallery = db.Column(db.JSON, nullable=True, default=list)    # list[str], detail-page images

    # collection_tags drives which extra fields apply (see
    # get_extra_fields_for_collection above). Confirmed mutually
    # exclusive as of the Retro Studio pivot — a product carries
    # exactly one tag, e.g. ["jersey"] or ["boots"] or ["others"].
    collection_tags = db.Column(db.JSON, nullable=False, default=list)

    # Kept as a separate human-readable label too (e.g. "Coastal Line")
    # since collection_tags is the machine-readable field-set key, and
    # a display name doesn't have to match it 1:1.
    collection_label = db.Column(db.String(120), nullable=True)

    # ---- BASE PRICE / STOCK ----
    # Meaning depends on variant_mode:
    #   "unified"     -> these ARE the price/stock for every combination
    #   "per_variant" -> these are fallback/display-only; the real
    #                    numbers live per-combination in variants.combinations
    price = db.Column(db.Float, nullable=False, default=0.0)
    stock = db.Column(db.Integer, nullable=False, default=0)

    variant_mode = db.Column(db.String(20), nullable=False, default="unified")  # "unified" | "per_variant"

    # ---- VARIANTS — one JSON blob, shape below ----
    # {
    #   "axes": {
    #     "jersey_size":       ["S", "M", "L", "XL"],
    #     "jersey_kit_type":   ["Home", "Away"],
    #     "jersey_edition":    ["Player", "Fan"]
    #   },
    #   "combinations": [
    #     {"jersey_size": "M", "jersey_kit_type": "Home", "jersey_edition": "Fan", "price": 1800, "stock": 12},
    #     {"jersey_size": "L", "jersey_kit_type": "Home", "jersey_edition": "Fan", "price": 1800, "stock": 5}
    #   ],
    #   "axis_images": {
    #     "jersey_kit_type": {"Home": "https://.../home.jpg", "Away": "https://.../away.jpg"}
    #   }
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

    def allowed_extra_fields(self):
        return get_extra_fields_for_collection(self.collection_tags)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "image": self.image,
            "gallery": self.gallery or [],
            "collection_tags": self.collection_tags or [],
            "collection_label": self.collection_label,
            "price": self.price,
            "stock": self.stock,
            "variant_mode": self.variant_mode,
            "variants": self.variants or {},
            "allowed_extra_fields": self.allowed_extra_fields(),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }

