# app.py
from flask import Flask, render_template, Response
from dotenv import load_dotenv
import os

# use db from your models package
from models import db, Product
from wall import setup_security

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

app.register_blueprint(admin_bp)
app.register_blueprint(product_bp)
app.register_blueprint(cart_bp)
app.register_blueprint(order_bp)

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

@app.route("/product")
def product():
    return render_template("product.html")


@app.route("/cart")
def cart():
    return render_template("cart.html")

@app.route("/checkout")
def checkout():
    return render_template("checkout.html")

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
        "Sitemap: https://markazussunnahbd.com/sitemap.xml"
    ]
    return Response("\n".join(lines), mimetype="text/plain")


@app.route('/sitemap.xml')
def sitemap():
    """
    The curated tour guide for Google.
    Matches your exact 'product?id=' structure.
    """
    base_url = "https://markazussunnahbd.com"
    pages = []

    # 1. High-Value Static Pages
    # We give the Homepage 1.0 priority. We skip Cart/Checkout entirely.
    pages.append({"loc": f"{base_url}/", "priority": "1.0", "changefreq": "daily"})
    pages.append({"loc": f"{base_url}/products", "priority": "0.8", "changefreq": "daily"})

    # 2. Dynamic Product Pages
    try:
        # Assuming 'Product' is your SQLAlchemy model
        products = Product.query.all() 
        for p in products:
            pages.append({
                "loc": f"{base_url}/product?id={p.id}", 
                "priority": "0.7",
                "changefreq": "weekly",
                "lastmod": datetime.now().strftime('%Y-%m-%d')
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
        db.create_all()

# ---------- Main ----------
if __name__ == "__main__":
    app.run(debug=True, port=5000)
