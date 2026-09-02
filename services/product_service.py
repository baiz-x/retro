import os
import re
import uuid
import json
import cloudinary
import cloudinary.uploader
from datetime import datetime
from functools import wraps

from flask import request, jsonify, current_app
from sqlalchemy import func
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm.attributes import flag_modified

from models import db, Product

# Configure using environment variables
cloudinary.config( 
  cloud_name = os.environ.get("CLOUDINARY_NAME"), 
  api_key = os.environ.get("CLOUDINARY_API_KEY"), 
  api_secret = os.environ.get("CLOUDINARY_API_SECRET"),
  secure = True
)

def extract_public_id(image_url):
    """Extracts 'folder/filename' from the Cloudinary URL."""
    if not image_url or "cloudinary" not in image_url:
        return None
    try:
        parts = image_url.split('/')
        upload_index = parts.index('upload')
        public_id_with_ext = "/".join(parts[upload_index + 2:])
        return public_id_with_ext.rsplit('.', 1)[0]
    except (ValueError, IndexError):
        return None

def get_all_products(limit=None):
    try:
        query = Product.query
        if limit is not None:
            # Ordering only kicks in when a limit is requested — the plain,
            # unparinated call (used by the admin dashboard's product list)
            # stays exactly as it was: Product.query.all(), no ORDER BY.
            # No created_at column exists on this model, so "newest" is
            # approximated via highest id (auto-increment == insertion order).
            query = query.order_by(Product.id.desc()).limit(int(limit))
        products = query.all()
        return [product.to_dict() for product in products]
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in get_all_products: {str(e)}")
        raise

def get_product_by_id(product_id):
    try:
        return Product.query.get(product_id)
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in get_product_by_id: {str(e)}")
        raise

def get_product_by_slug_service(slug):
    try:
        return Product.query.filter_by(slug=slug).first()
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in get_product_by_slug_service: {str(e)}")
        raise

def _parse_bool(raw, default):
    """
    Form-data sends booleans as strings, not real booleans — a plain
    ``bool(raw)`` would treat the string "false" as truthy (non-empty
    string). Used for is_preorder from both create_product's form-data
    POST and update_product's PATCH. Missing/None keeps `default`
    rather than coercing to False, so a partial update that doesn't
    touch the toggle doesn't accidentally flip it.
    """
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() in ("true", "1", "on", "yes")

def create_slug(title):
    # Lowercase and strip common stop words before hyphenating
    slug = title.lower()
    slug = re.sub(r'\b(for|a|of|or|the|and|in|is)\b', '', slug)
    # Replace non-alphanumeric with a single hyphen
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    return slug.strip('-')

def recompute_base_price_and_stock(variant_mode, variants, fallback_price, fallback_stock):
    """
    Per Hasan's confirmed fix: for per_variant products, product.price/
    stock are SERVER-COMPUTED from variants.combinations, never trusted
    from whatever the dashboard form happened to send — this is the fix
    for the reported bug (base stock=0 with real per-variant stock made
    the product read as out-of-stock/excluded everywhere, since every
    downstream read path — filter's stock>0 gate, build_stock_note,
    resolve_product_availability, card price — reads product.stock/
    price directly and none of them re-walk variants.combinations
    themselves).

    variant_mode == "unified": returns (fallback_price, fallback_stock)
    unchanged — untouched, exactly as typed in the dashboard.

    variant_mode == "per_variant":
      stock = sum of every combination's stock (matches the rolling
        total reduce_variant_stock already maintains after an order —
        this just makes it correct from creation, not only after the
        first sale).
      price = MIN of every combination's price (the "From ৳X" display
        value), per Hasan's confirmed decision.
      If combinations is empty (e.g. axes entered but matrix not yet
      filled), falls back to (fallback_price, fallback_stock) rather
      than (0, 0) — an incomplete per_variant product shouldn't read
      as guaranteed-out-of-stock before the admin finishes the form.
    """
    if variant_mode != "per_variant":
        return fallback_price, fallback_stock

    combinations = (variants or {}).get("combinations") or []
    if not combinations:
        return fallback_price, fallback_stock

    total_stock = sum(int(c.get("stock") or 0) for c in combinations)
    variant_prices = [float(c["price"]) for c in combinations if c.get("price") not in (None, "")]
    computed_price = min(variant_prices) if variant_prices else fallback_price

    return computed_price, total_stock

def create_product(data, image_file, gallery_files=None):
    """
    Standardized creation for products with support for N gallery images.
    """
    try:
        # 1. Parse Variations
        variants_json = data.get('variants')
        parsed_variants = json.loads(variants_json) if variants_json else {}

        # 2. Upload Main Image
        image_url = None
        if image_file:
            upload_result = cloudinary.uploader.upload(image_file, folder="zenfox_products")
            image_url = upload_result.get('secure_url')

        # 3. Upload Gallery Images (N images support)
        gallery_urls = []
        if gallery_files:
            for file in gallery_files:
                if file.filename != '':
                    res = cloudinary.uploader.upload(file, folder="zenfox_products")
                    gallery_urls.append(res.get('secure_url'))

        # 4. Determine Price & Stock
        # variants are keyed by axis (e.g. jersey_size for jerseys,
        # boots_size for boots), e.g. {"axes": {"jersey_size": [...]},
        # "combinations": [...], "axis_images": {...}} — not by size
        # with per-variant price/stock baked into a flat {v['size']: v}
        # shape. See models.py for the
        # full shape. This part of the schema is unchanged by the Retro
        # Studio pivot — it was already generic over axis names.
        variant_mode = data.get('variant_mode', 'unified')
        form_price = float(data.get('price', 0))
        form_stock = int(data.get('stock', 0))

        # Server-computed for per_variant, per Hasan's confirmed fix —
        # see recompute_base_price_and_stock() docstring above.
        base_price, total_stock = recompute_base_price_and_stock(
            variant_mode, parsed_variants, form_price, form_stock
        )

        # category renamed to collection_tags (JSON list) + collection_label
        # (display name), matching models.py. As of the Retro Studio pivot,
        # collection_tags holds exactly one tag, e.g. ["jersey"] — jersey/
        # boots/others are confirmed mutually exclusive, though this list
        # is not re-validated for exclusivity here (see models.py). May
        # arrive as a JSON string (form-data) or already a list (JSON
        # body) — handle both.
        collection_tags = data.get('collection_tags', [])
        if isinstance(collection_tags, str):
            collection_tags = json.loads(collection_tags) if collection_tags else []

        # product_type mirrors collection_tags[0] into a real indexed
        # column (see models.py) — kept in sync here at write time since
        # collection_tags itself stays JSON/unindexed for the dashboard's
        # existing read/write shape.
        product_type = collection_tags[0] if collection_tags else None

        # Generate unique slug
        base_slug = create_slug(data.get('name'))
        unique_slug = base_slug

        # Conflict resolution: append 4 random characters if it already exists
        while Product.query.filter_by(slug=unique_slug).first() is not None:
            unique_slug = f"{base_slug}-{uuid.uuid4().hex[:4]}"

        # 5. Create Database Entry
        # gsm arrives as form-data text — cast to int when present,
        # matching price/stock's own float()/int() casts above.
        # collection_tags is a list of strings (or json string, already
        # normalized above); membership check below is enough since it's
        # confirmed a 1-element list. Fields outside a product's own type
        # are simply left as None if the client didn't send them.
        gsm_raw = data.get('gsm')
        gsm_value = int(gsm_raw) if gsm_raw not in (None, '') else None

        new_product = Product(
            slug=unique_slug,
            name=data.get('name'),
            collection_tags=collection_tags,
            product_type=product_type,
            collection_label=data.get('collection_label'),
            club=data.get('club'),
            category=data.get('category'),
            edition=data.get('edition'),
            version=data.get('version'),
            kit_type=data.get('kit_type'),
            fabric=data.get('fabric'),
            brand=data.get('brand'),
            type=data.get('type'),
            material=data.get('material'),
            color=data.get('color'),
            gsm=gsm_value,
            price=base_price,
            stock=total_stock,
            description=data.get('description'),
            image=image_url,
            gallery=gallery_urls,
            variants=parsed_variants,
            variant_mode=variant_mode,
            is_preorder=_parse_bool(data.get('is_preorder'), default=True)
        )

        db.session.add(new_product)
        db.session.commit()

        return new_product, None

    except Exception as e:
        db.session.rollback()
        return None, f"Database Error: {str(e)}"

def update_product(product_id, data, image_file=None, gallery_files=None):
    product = get_product_by_id(product_id)
    if not product:
        return None, "Product not found"

    try:
        if 'name' in data: product.name = data['name']
        if 'description' in data: product.description = data['description']
        if 'club' in data: product.club = data['club']
        if 'category' in data: product.category = data['category']
        if 'edition' in data: product.edition = data['edition']
        if 'version' in data: product.version = data['version']
        if 'kit_type' in data: product.kit_type = data['kit_type']
        if 'fabric' in data: product.fabric = data['fabric']
        if 'brand' in data: product.brand = data['brand']
        if 'type' in data: product.type = data['type']
        if 'material' in data: product.material = data['material']
        if 'color' in data: product.color = data['color']
        if 'gsm' in data:
            gsm_raw = data['gsm']
            product.gsm = int(gsm_raw) if gsm_raw not in (None, '') else None
        if 'is_preorder' in data:
            product.is_preorder = _parse_bool(data['is_preorder'], default=product.is_preorder)

        if 'collection_label' in data: product.collection_label = data['collection_label']
        if 'collection_tags' in data:
            tags = data['collection_tags']
            if isinstance(tags, str):
                tags = json.loads(tags) if tags else []
            product.collection_tags = tags
            # Keep product_type (real indexed column) in sync with
            # collection_tags[0] on every update — same mirroring done
            # in create_product.
            product.product_type = tags[0] if tags else None

        # variant_mode and variants applied BEFORE price/stock below —
        # recompute_base_price_and_stock() needs the final variant_mode
        # and variants state, not what was on the product before this
        # request. Same ordering concern as create_product, just more
        # visible here since update_product can change price/stock,
        # variant_mode, and variants all in a single request.
        if 'variant_mode' in data: product.variant_mode = data['variant_mode']
        if 'variants' in data:
            variants = data['variants']
            if isinstance(variants, str):
                variants = json.loads(variants) if variants else {}
            product.variants = variants

        # Price/stock: per Hasan's confirmed fix, recomputed from
        # variants on EVERY update when variant_mode is per_variant —
        # not just at creation — so editing a per_variant product's
        # matrix (or its price/stock fields, which get overridden
        # anyway) always leaves product.price/stock correct. Uses
        # whatever the form sent as the fallback (for unified mode, or
        # a per_variant product with no combinations yet) rather than
        # the product's prior value, matching create_product's shape.
        if 'price' in data or 'stock' in data or 'variant_mode' in data or 'variants' in data:
            form_price = float(data['price']) if 'price' in data else product.price
            form_stock = int(data['stock']) if 'stock' in data else product.stock
            product.price, product.stock = recompute_base_price_and_stock(
                product.variant_mode, product.variants, form_price, form_stock
            )

        # Handle Main Image Update
        if image_file and image_file.filename != '':
            old_public_id = extract_public_id(product.image)
            if old_public_id:
                cloudinary.uploader.destroy(old_public_id)
            upload_result = cloudinary.uploader.upload(image_file, folder="zenfox_products")
            product.image = upload_result.get('secure_url')

        # Handle Gallery Update (Replace if new ones provided)
        if gallery_files and any(f.filename != '' for f in gallery_files):
            # Delete old gallery images
            if product.gallery:
                for url in product.gallery:
                    pid = extract_public_id(url)
                    if pid: cloudinary.uploader.destroy(pid)

            # Upload new ones
            new_gallery = []
            for file in gallery_files:
                if file.filename != '':
                    res = cloudinary.uploader.upload(file, folder="zenfox_products")
                    new_gallery.append(res.get('secure_url'))
            product.gallery = new_gallery

        product.updated_at = datetime.utcnow()
        db.session.commit()
        return product, None

    except Exception as e:
        db.session.rollback()
        return None, f"Update failed: {str(e)}"

def delete_product(product_id):
    product = get_product_by_id(product_id)
    if not product:
        return False, "Product not found"

    try:
        # 1. Delete Main Image
        public_id = extract_public_id(product.image)
        if public_id:
            cloudinary.uploader.destroy(public_id)

        # 2. Delete Gallery Images
        if product.gallery:
            for url in product.gallery:
                gid = extract_public_id(url)
                if gid: cloudinary.uploader.destroy(gid)

        # 3. Delete from Database
        db.session.delete(product)
        db.session.commit()
        return True, None

    except Exception as e:
        db.session.rollback()
        return False, f"Deletion failed: {str(e)}"

def filter_products_service(filters):
    """
    Filters products for the storefront. product_type/club/category/price
    ride the real composite index (idx_products_type_club_category_price
    in models.py) since all four are plain typed columns — the fast
    path. edition/version/brand/type/material/fabric/gsm are each their
    own real, individually indexed column (v4) — single-column index
    lookups, not the composite, but still real columns rather than a
    JSONB path query.

    Excludes stock=0 products, per confirmed decision (no is_available
    column exists on this model — stock is the only availability signal).
    """
    try:
        # Enforce availability first, matching the index root layout —
        # same pattern as Robin's is_available gate, re-targeted to stock
        # since that's this model's actual availability signal.
        query = Product.query.filter(Product.stock > 0)

        # product_type: exact match on the real, indexed mirror column —
        # rides idx_products_type_club_category_price as its leading
        # column (see models.py). This is what actually scopes results
        # to one of jersey/boots/others; without it, brand/type/material/
        # fabric/gsm filters below only narrow within whatever mixed set
        # of types happens to match, which rarely makes sense since
        # those columns mean different things per type.
        if filters.get('product_type'):
            query = query.filter(Product.product_type == filters['product_type'])

        # club/category: exact match on real columns — ride the composite index
        if filters.get('club'):
            query = query.filter(Product.club == filters['club'])

        if filters.get('category'):
            query = query.filter(Product.category == filters['category'])

        # search: partial, case-insensitive match on name only — not club or
        # category, since club is already its own filter field and matching
        # category risks unrelated partial-word overlaps. ILIKE, not the
        # composite index (that's exact-match only) — a plain scan/trigram
        # lookup depending on whether pg_trgm + a GIN index on name exists.
        if filters.get('search'):
            query = query.filter(Product.name.ilike(f"%{filters['search']}%"))

        # price: range match — third column in the composite index
        if filters.get('min_price'):
            query = query.filter(Product.price >= float(filters['min_price']))
        if filters.get('max_price'):
            query = query.filter(Product.price <= float(filters['max_price']))

        # edition: exact match on real column, same as club/category —
        # previously a JSONB path query against variants.axes.jersey_edition,
        # replaced per Hasan's confirmed decision to promote edition/
        # version/kit_type out of variants JSON entirely (one value per
        # product listing, not a variant axis). This also fixes the
        # reported bug: the JSONB query was unverified and returned zero
        # results even on freshly-typed test data.
        if filters.get('edition'):
            query = query.filter(Product.edition == filters['edition'])

        # version: exact match on real column, same pattern as edition
        if filters.get('version'):
            query = query.filter(Product.version == filters['version'])

        # brand/type/material/fabric: exact match on real, individually
        # indexed columns (v4) — same pattern as club/edition/version.
        if filters.get('brand'):
            query = query.filter(Product.brand == filters['brand'])
        if filters.get('type'):
            query = query.filter(Product.type == filters['type'])
        if filters.get('material'):
            query = query.filter(Product.material == filters['material'])
        if filters.get('fabric'):
            query = query.filter(Product.fabric == filters['fabric'])

        # gsm: range match (like price), not exact — a real Integer
        # column, so min_gsm/max_gsm ride its index the same way
        # min_price/max_price do.
        if filters.get('min_gsm'):
            query = query.filter(Product.gsm >= int(filters['min_gsm']))
        if filters.get('max_gsm'):
            query = query.filter(Product.gsm <= int(filters['max_gsm']))

        products = query.all()
        return [product.to_dict() for product in products]
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in filter_products_service: {str(e)}")
        raise

def get_distinct_categories_service():
    """
    Backs the products page's Category filter dropdown. Returns every
    distinct, non-null, non-empty category value currently in the DB —
    replaces the free-text Category filter input, which silently broke
    on any typo/casing mismatch between what was typed in the admin
    dashboard and what a customer typed here (both were free text,
    exact-match against each other). A dropdown sourced from the DB
    itself makes a mismatch impossible: a customer can only pick a
    value that's guaranteed to already exist. Same mechanism as Robin's
    get_distinct_locations, re-targeted to category. Sorted alphabetically
    for a stable, predictable dropdown order.
    """
    try:
        rows = (
            db.session.query(Product.category)
            .filter(Product.category.isnot(None), Product.category != '')
            .distinct()
            .order_by(Product.category.asc())
            .all()
        )
        return [row[0] for row in rows]
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in get_distinct_categories_service: {str(e)}")
        raise

def get_random_products_service(limit=5):
    """
    Backs the homepage's Random Discovery rail. Excludes stock=0, same
    availability rule as filter_products_service — every public-facing
    read endpoint on this model treats stock as the availability signal.
    Uses PostgreSQL's RANDOM() for true per-request shuffling (not a
    stable/cacheable order — each call can return a different set).
    """
    try:
        products = (
            Product.query
            .filter(Product.stock > 0)
            .order_by(func.random())
            .limit(int(limit))
            .all()
        )
        return [product.to_dict() for product in products]
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in get_random_products_service: {str(e)}")
        raise

def reduce_variant_stock(product, selected_variants, quantity):
    """
    Adjusts stock by `quantity` (positive = reduce, negative = increase —
    same signed convention as before).

    selected_variants: dict of axis->choice, e.g. {"jersey_size": "M"}
    or {"boots_size": "42", "boots_color": "Black"}, or None/{} for a
    manual top-level adjustment that doesn't target one specific
    combination.

    Branches on product.variant_mode, per the confirmed design:
      - "unified" (default): every combination shares ONE stock number
        (product.stock). selected_variants, if given, is only used to
        confirm the choice(s) actually exist on this product — it does
        NOT select a separate stock bucket.
      - "per_variant": each entry in product.variants['combinations']
        has its own 'stock'. selected_variants must match a specific
        combination for anything other than a manual top-level check;
        if selected_variants is empty/None in per_variant mode, this
        cannot identify which combination to adjust and returns an error
        rather than guessing.
    """
    variants = product.variants or {}
    mode = product.variant_mode or "unified"

    if mode == "per_variant":
        combinations = variants.get('combinations', [])

        if not selected_variants:
            return False, "per_variant product requires selected_variants to identify which combination to adjust"

        match = None
        for combo in combinations:
            # match on every axis key present in selected_variants —
            # combo may have extra keys (price/stock) which we ignore here
            if all(combo.get(axis) == value for axis, value in selected_variants.items()):
                match = combo
                break

        if match is None:
            return False, f"No matching combination found for {selected_variants}"

        current_stock = int(match.get('stock', 0))
        new_stock = current_stock - quantity
        if new_stock < 0:
            return False, f"Insufficient stock. Have {current_stock}, need {quantity}"

        match['stock'] = new_stock
        flag_modified(product, "variants")  # in-place nested mutation — required for JSON columns

        # Keep product.stock as a rough overall total for display/sort
        # purposes (e.g. the storefront grid's "in stock" badge) — not
        # the authoritative number in per_variant mode, but useful to
        # not leave stale.
        product.stock = sum(int(c.get('stock', 0)) for c in combinations)

    else:  # unified
        if selected_variants:
            all_choices = []
            for axis_choices in variants.get('axes', {}).values():
                all_choices.extend(axis_choices)
            for value in selected_variants.values():
                if value not in all_choices:
                    return False, f"Variant '{value}' not found"

        if product.stock < quantity:
            return False, f"Insufficient stock. Have {product.stock}, need {quantity}"

        product.stock -= quantity

    try:
        db.session.commit()
        return True, "Stock reduced successfully"
    except Exception as e:
        db.session.rollback()
        current_app.logger.error(f"Stock update failed: {str(e)}")
        return False, str(e)
# ---------- SEO / structured data helpers (Product SSR) ----------
# Inline in app.py per Hasan's instruction — no server-rendering code
# added to routes/product_route.py, which stays API-only. Only the
# slug lookup itself is imported from services/product_service.py.

def request_base_url():
    """
    Scheme+host of the current request (e.g. "https://kitcollective.com"),
    no trailing slash. Used for the product page's canonical URL and
    JSON-LD, derived from the live request rather than hardcoded — unlike
    /sitemap.xml below, which pins a fixed base_url; that's left as-is
    since changing it wasn't asked for and may be intentional (e.g. a
    fixed production domain regardless of which host actually served
    the request).
    """
    return request.host_url.rstrip('/')


def resolve_product_availability(product):
    """
    Maps this product's stock onto a schema.org/ItemAvailability value.
    Per Hasan's confirmed source_type design:
      is_preorder=True  -> always PreOrder, regardless of stock number
        (which is artificially high by design and not real inventory —
        see is_out_of_stock's docstring).
      is_preorder=False -> real stock rules: InStock / LimitedAvailability
        / OutOfStock based on the actual on-hand count.
    """
    if product.is_preorder:
        return "https://schema.org/PreOrder"

    stock = product.stock or 0
    if stock <= 0:
        return "https://schema.org/OutOfStock"
    if stock <= LOW_STOCK_THRESHOLD:
        return "https://schema.org/LimitedAvailability"
    return "https://schema.org/InStock"


LOW_STOCK_THRESHOLD = 5  # same constant/value as product.js — kept in
                          # sync manually since the two run in different
                          # languages; change both if this ever moves.


def is_out_of_stock(product):
    """
    Same semantics as isOutOfStock() in product.js, with Hasan's
    confirmed pre-order rule layered on top: a pre-order product is
    never considered out of stock for messaging/availability purposes,
    since its stock number is intentionally kept artificially high
    (e.g. 1000) and doesn't represent real inventory — only a
    store-owned (is_preorder=False) product's stock is meaningful
    enough to ever read as "out of stock".
    """
    if product.is_preorder:
        return False

    variants = product.variants or {}
    if (product.variant_mode or "unified") == "per_variant":
        combos = variants.get("combinations") or []
        if not combos:
            return (product.stock or 0) <= 0
        return all((c.get("stock") or 0) <= 0 for c in combos)
    return (product.stock or 0) <= 0


def build_identity_pills(product):
    """
    Locked, non-interactive identity pills — same per-type mapping as
    renderIdentityPills() in product.js: jersey shows edition/version/
    kit_type; boots shows type/brand; others shows type/color. These
    are fixed-per-listing columns (see product.py's identity-field
    comments), never variant axes, so they're never clickable here
    either.
    """
    pills = []
    ptype = product.product_type
    if ptype == "jersey":
        if product.edition:
            pills.append(("Edition", product.edition))
        if product.version:
            pills.append(("Version", product.version))
        if product.kit_type:
            pills.append(("Kit", product.kit_type))
    elif ptype == "boots":
        if product.type:
            pills.append(("Type", product.type))
        if product.brand:
            pills.append(("Brand", product.brand))
    elif ptype == "others":
        if product.type:
            pills.append(("Type", product.type))
        if product.color:
            pills.append(("Color", product.color))
    return pills


def build_size_pills(product):
    """
    Same per-size availability logic as isSizeAvailable() in product.js:
    unified mode has no per-size stock concept (every size available
    together, or none if product.stock is 0); per_variant mode marks a
    size available if ANY color at that size (or just that size, for
    jersey/others' size-only axis) has stock > 0.
    Returns a list of {"value": size, "available": bool} dicts, or []
    if this product has no size axis at all.
    """
    variants = product.variants or {}
    axes = variants.get("axes") or {}
    sizes = axes.get("size") or []
    if not sizes:
        return []

    mode = product.variant_mode or "unified"
    combos = variants.get("combinations") or []

    result = []
    for size in sizes:
        if mode != "per_variant" or not combos:
            available = (product.stock or 0) > 0
        else:
            available = any(
                c.get("size") == size and (c.get("stock") or 0) > 0
                for c in combos
            )
        result.append({"value": size, "available": available})
    return result


def build_color_pills(product):
    """
    Boots-only axis (size×color) — same as renderColorSection() in
    product.js. Availability here can't depend on a selected size
    (that only happens client-side after a pill click), so at render
    time a color is shown available if it has stock in ANY size —
    the JS layer refines this further once the person picks a size.
    """
    if product.product_type != "boots":
        return []
    variants = product.variants or {}
    axes = variants.get("axes") or {}
    colors = axes.get("color") or []
    if not colors:
        return []

    mode = product.variant_mode or "unified"
    combos = variants.get("combinations") or []

    result = []
    for color in colors:
        if mode != "per_variant" or not combos:
            available = (product.stock or 0) > 0
        else:
            available = any(
                c.get("color") == color and (c.get("stock") or 0) > 0
                for c in combos
            )
        result.append({"value": color, "available": available})
    return result


def build_stock_note(product):
    """
    Per Hasan's confirmed source_type design:
      is_preorder=True  -> ALWAYS the pre-order disclaimer. Stock is
        never inspected for messaging here — Hasan keeps pre-order
        variant stock artificially high by design specifically so it
        never reads as low/out, so real stock semantics don't apply to
        this product's messaging at all.
      is_preorder=False -> real 3-state note: out of stock / low
        quantity (with live count) / neutral-empty (no extra text —
        "nothing existed", per Hasan's own phrasing) once stock is 6+.
    Returns (text, css_class) — a neutral-empty state returns ("", "")
    so product.html can render nothing rather than an empty <p> with a
    stray class.
    """
    if product.is_preorder:
        return "Pre-Order — all products will be sourced after order", "pdp-stock-preorder"

    stock = product.stock or 0
    if is_out_of_stock(product):
        return "Out of stock", "pdp-stock-low"
    if stock <= LOW_STOCK_THRESHOLD:
        return f"Order fast, low quantity — {stock} left", "pdp-stock-low"
    return "", ""


def build_gallery_images(product):
    """
    Same source order as collectGalleryImages() in product.js: main
    image first, then gallery[], de-duplicated, falling back to a
    stock photo if the product has no images at all yet. axis_images
    (per-variant photos) is intentionally NOT read here — the
    dashboard always sends it empty today (see dashboard.js), so
    there's nothing real to add server-side yet either; product.js
    keeps its own client-side axis_images handling for when that
    changes.
    """
    images = []
    if product.image:
        images.append(product.image)
    for url in (product.gallery or []):
        if url and url not in images:
            images.append(url)
    if not images:
        images.append("https://images.unsplash.com/photo-1522778119026-d647f0596c20?q=80&w=1200&auto=format&fit=crop")
    return images


def build_add_to_cart_label(product, mobile=False):
    """
    Per Hasan's confirmed wording rule: is_preorder products say
    "Reserve" (this is a request/reservation, sourced afterward — the
    on-page pre-order banner explains this explicitly). Store-owned
    (is_preorder=False) products say "Order" instead, since the item is
    actually in hand and nothing is being reserved for later sourcing —
    the wording should match what's really happening.
    Out-of-stock always overrides both, regardless of is_preorder.
    """
    if is_out_of_stock(product):
        return "Out of Stock"
    if product.is_preorder:
        return "Reserve" if mobile else "Reserve this item"
    return "Order" if mobile else "Order this item"


def build_product_view_context(product):
    """
    Single place that computes every derived value product.html needs
    beyond the raw `product` object itself — keeps the template mostly
    declarative instead of embedding this logic inline in Jinja.
    """
    stock_note_text, stock_note_class = build_stock_note(product)
    return {
        "gallery_images": build_gallery_images(product),
        "out_of_stock": is_out_of_stock(product),
        "identity_pills": build_identity_pills(product),
        "size_pills": build_size_pills(product),
        "color_pills": build_color_pills(product),
        "stock_note_text": stock_note_text,
        "stock_note_class": stock_note_class,
        "show_personalization": product.product_type == "jersey",
        "add_to_cart_label": build_add_to_cart_label(product, mobile=False),
        "add_to_cart_label_mobile": build_add_to_cart_label(product, mobile=True),
    }


def build_product_json_ld(product, base_url):
    """
    Builds the Product + Offer JSON-LD dict for this product, per
    Google's current Merchant listing requirements (Product: name,
    image, offers required; Offer: price + priceCurrency required,
    price must be a plain number > 0). priceCurrency is the ISO 4217
    code "BDT" — distinct from the ৳ symbol shown elsewhere on the
    page, which JSON-LD doesn't use.

    Only includes optional properties (brand, color, material, size,
    sku) when the underlying column is actually populated, rather than
    emitting empty/null values Google would just ignore or flag.
    """
    images = []
    if product.image:
        images.append(product.image)
    if isinstance(product.gallery, list):
        images.extend(g for g in product.gallery if g)

    offer = {
        "@type": "Offer",
        "url": f"{base_url}/product/{product.slug}",
        "priceCurrency": "BDT",
        "price": float(product.price or 0),
        "availability": resolve_product_availability(product),
    }

    data = {
        "@context": "https://schema.org/",
        "@type": "Product",
        "name": product.name,
        "image": images or None,
        "description": product.description or None,
        "sku": product.slug,
        "offers": offer,
    }

    # brand: real column on boots/others, absent on jerseys (see
    # product.py's per-type identity field comments) — include only
    # when populated rather than sending an empty Brand object.
    if product.brand:
        data["brand"] = {"@type": "Brand", "name": product.brand}

    if product.color:
        data["color"] = product.color
    if product.material:
        data["material"] = product.material

    # size: schema.org allows at most one value here, but this product
    # can have several (variants.axes.size) — omitted rather than
    # picking one arbitrarily, since a single size on a multi-size
    # listing would misrepresent the product; the actual sizes are
    # already visible as pills in the rendered HTML itself, which
    # Google can read regardless of this field.

    # Drop any top-level key left as None (image/description can be
    # missing on a real product) — Google's parser is stricter about
    # explicit nulls than about an absent key.
    return {k: v for k, v in data.items() if v is not None}





