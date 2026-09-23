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
from models import User
from functools import wraps

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
from routes.auth_route import auth_bp
from routes.wholesale_route import wholesale_bp
from routes.expense_route import expense_bp
from routes.guest_order_link_route import guest_link_bp
from routes.fulfillment_route import fulfillment_bp

app.register_blueprint(admin_bp)
app.register_blueprint(product_bp)
app.register_blueprint(cart_bp)
app.register_blueprint(order_bp)
app.register_blueprint(auth_bp)
app.register_blueprint(wholesale_bp)
app.register_blueprint(expense_bp)
app.register_blueprint(guest_link_bp)
app.register_blueprint(fulfillment_bp)

# ---------- Routes ----------

def login_required(view_func):
    """
    Guards page routes that require a logged-in user (currently just
    /account below). Redirects to /login rather than returning JSON,
    since this decorates HTML page routes, not the API blueprint —
    auth_routes.py has its own separate api_login_required for that.
    """
    @wraps(view_func)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return redirect(url_for("login_page", next=request.path))
        return view_func(*args, **kwargs)
    return wrapped


@app.context_processor
def inject_is_logged_in():
    """
    Makes is_logged_in available in every template automatically —
    the navbar/mobile-menu partials (_navbar.html, _mobile_menu.html)
    check this on every page. Previously this was only passed manually
    on /checkout (and misspelled there as is_loggedin, one word), so
    every other route rendered with is_logged_in undefined -> falsy in
    Jinja -> navbar always showed Login/Signup even for signed-in users.
    """
    return {"is_logged_in": bool(session.get("user_id"))}


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

@app.route("/account")
@login_required
def account_page():
    # login_required already guarantees session["user_id"] is set, but
    # not that the row still exists (e.g. deleted between requests) —
    # same stale-session handling as auth_routes.py's /auth/me.
    user = User.query.get(session["user_id"])
    if not user:
        session.pop("user_id", None)
        return redirect(url_for("login_page"))
    return render_template("account.html", user=user)

@app.route("/orders")
@login_required
def orders_page():
    """
    Customer-facing order history/tracking page (Daraz/Amazon-style —
    per Hasan's request), themed to match index.css/index.html.
    Logged-in users only, same guard as /account, since guest orders
    have no account to look history up against (confirmed scope). The
    page itself fetches from GET /api/account/orders on load — see
    templates/orders.html + static/orders.js.
    """
    user = User.query.get(session["user_id"])
    if not user:
        session.pop("user_id", None)
        return redirect(url_for("login_page"))
    return render_template("orders.html", user=user)

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
