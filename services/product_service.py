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

def create_slug(title):
    # Lowercase and strip common stop words before hyphenating
    slug = title.lower()
    slug = re.sub(r'\b(for|a|of|or|the|and|in|is)\b', '', slug)
    # Replace non-alphanumeric with a single hyphen
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    return slug.strip('-')

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
        base_price = float(data.get('price', 0))
        total_stock = int(data.get('stock', 0))

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
            variant_mode=data.get('variant_mode', 'unified')
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
        if 'price' in data: product.price = float(data['price'])
        if 'stock' in data: product.stock = int(data['stock'])
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

        if 'variant_mode' in data: product.variant_mode = data['variant_mode']
        if 'variants' in data:
            variants = data['variants']
            if isinstance(variants, str):
                variants = json.loads(variants) if variants else {}
            product.variants = variants

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





