# app.py
from flask import Flask, render_template, Response, abort, request, session, redirect, url_for
from dotenv import load_dotenv
from datetime import datetime
import os

# use db from your models package
from models import db, Product
from wall import setup_security
from sqlalchemy import text

# Slug lookup reused from the existing products API service, per
# Hasan's instruction to pull needed functions from product_service.py
# rather than duplicate the query here.
from services.product_service import get_product_by_slug_service, build_product_json_ld, build_product_view_context, build_gallery_images, build_stock_note, build_color_pills, build_size_pills, build_identity_pills, is_out_of_stock, resolve_product_availability, request_base_url

# Load env
load_dotenv()

# Initialize Flask
app = setup_security()
app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv('DATABASE_URI')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'super-secret-key')

# ---------- Blueprints ----------
from routes.admin_route import admin_bp
from routes.product_route import product_bp
from routes.cart_route import cart_bp
from routes.order_route import order_bp
from routes.auth_routes import auth_bp

app.register_blueprint(admin_bp)
app.register_blueprint(product_bp)
app.register_blueprint(cart_bp)
app.register_blueprint(order_bp)
app.register_blueprint(auth_bp)

# ---------- Routes ----------
@app.route("/")
def home():
    return render_template("index.html")

@app.route("/test1")
def test1():
    return render_template("test_1.html")

@app.route("/test2")
def test2():
    return render_template("test_2.html")

@app.route("/test3")
def test3():
    return render_template("test_3.html")

@app.route("/products")
def products():
    return render_template("products.html")

@app.route("/product/<string:slug>", methods=['GET'])
def product_detail(slug):
    product_obj = get_product_by_slug_service(slug)
    if product_obj is None:
        abort(404)
    base_url = request_base_url()
    context = build_product_view_context(product_obj)
    return render_template(
        "product.html",
        product=product_obj,
        json_ld=build_product_json_ld(product_obj, base_url),
        canonical_url=f"{base_url}/product/{product_obj.slug}",
        **context,
    )


@app.route("/cart")
def cart():
    return render_template("cart.html")

@app.route("/checkout")
def checkout():
    return render_template("checkout.html")

@app.route("/login")
def login_page():
    if session.get("user_id"):
        return redirect(url_for("home"))
    return render_template("login.html")

@app.route("/signup")
def signup_page():
    if session.get("user_id"):
        return redirect(url_for("home"))
    return render_template("signup.html")

@app.route("/admin-form")
def admin_form():
    return render_template("admin_form.html")

@app.route("/admin-panel")
def admin_panel():
    return render_template("dashboard.html")

# --- SEO ROUTES BLOCK ----
@app.route('/robots.txt')
def robots():
    """
    Tells search engines which pages to ignore.
    Blocking /cart and /checkout prevents 'thin content' ranking drops.
    """
    lines = [
        "User-agent: *",
        "Disallow: /cart",
        "Disallow: /checkout",
        "Disallow: /login",
        "Disallow: /register",
        "Disallow: /api/",
        "",
        "Sitemap: http://127.0.0.1:5000/sitemap.xml"
    ]
    return Response("\n".join(lines), mimetype="text/plain")


@app.route('/sitemap.xml')
def sitemap():
    """
    The curated tour guide for Google.
    Matches the real /product/<slug> URL structure.
    """
    base_url = "http://127.0.0.1:5000"
    today = datetime.now().strftime('%Y-%m-%d')
    pages = []

    # 1. High-Value Static Pages
    # We give the Homepage 1.0 priority. We skip Cart/Checkout entirely.
    # lastmod added on these too — previously missing, which made the
    # XML-building loop below throw a KeyError on these exact two
    # entries every time (page["lastmod"] on a dict that never set it).
    pages.append({"loc": f"{base_url}/", "priority": "1.0", "changefreq": "daily", "lastmod": today})
    pages.append({"loc": f"{base_url}/products", "priority": "0.8", "changefreq": "daily", "lastmod": today})

    # 2. Dynamic Product Pages
    try:
        # Assuming 'Product' is your SQLAlchemy model
        products = Product.query.all()
        for p in products:
            if not p.slug:
                continue  # slug is nullable (pre-migration rows) — skip rather than link a broken URL
            pages.append({
                "loc": f"{base_url}/product/{p.slug}",
                "priority": "0.7",
                "changefreq": "weekly",
                "lastmod": p.updated_at.strftime('%Y-%m-%d') if p.updated_at else today
            })
    except Exception as e:
        app.logger.error(f"Sitemap generation error: {e}")

    # Build the XML structure manually to ensure UTF-8 and proper tags
    xml = '<?xml version="1.0" encoding="UTF-8"?>'
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    for page in pages:
        xml += '<url>'
        xml += f'<loc>{page["loc"]}</loc>'
        xml += f'<lastmod>{page["lastmod"]}</lastmod>'
        xml += f'<changefreq>{page["changefreq"]}</changefreq>'
        xml += f'<priority>{page["priority"]}</priority>'
        xml += '</url>'
    xml += '</urlset>'

    return Response(xml, mimetype='application/xml')


with app.app_context():
    try:
        # 1. Force the extension to enable FIRST
        db.session.execute(text('CREATE EXTENSION IF NOT EXISTS pg_trgm;'))
        db.session.commit()
        print("pg_trgm extension auto-enabled successfully!")
    except Exception as e:
        db.session.rollback()
        print(f"Warning: Could not enable pg_trgm extension: {e}")

    # 2. NOW it is safe to create your tables and search indexes
    db.create_all()
# ---------- Main ----------
if __name__ == "__main__":
    app.run(debug=True, port=5000)

