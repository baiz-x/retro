import uuid
from datetime import datetime
from flask import session
from sqlalchemy.exc import SQLAlchemyError
from models import db, Product, CartItem

def get_or_create_client_token():
    if 'client_token' not in session:
        session['client_token'] = str(uuid.uuid4())
    session.permanent = True
    return session['client_token']

def validate_product_exists(product_id):
    try:
        product = Product.query.get(product_id)
        if not product:
            return None, f"Product with ID {product_id} not found"
        return product, None
    except SQLAlchemyError as e:
        return None, f"Database error: {str(e)}"

def check_stock_availability(product, quantity, size):
    # Direct lookup from the variants dictionary
    variant = (product.variants or {}).get(size)
    
    if not variant:
        return False, f"Variant '{size}' not found"
    
    variant_stock = variant.get('stock', 0)
    if variant_stock < quantity:
        return False, f"Insufficient stock. Available: {variant_stock}"
    
    return True, None

def add_item_to_cart(client_token, product_id, quantity, size="Standard", price=None):
    """Adds a specific variant to the cart, persisting the correct variant price from Product.variants."""
    try:
        product, error = validate_product_exists(product_id)
        if error: return False, error, None
        if quantity <= 0: return False, "Quantity must be > 0", None

        # Variant Lookup
        variant = (product.variants or {}).get(size)
        
        if not variant:
            available = ", ".join(product.variants.keys()) if product.variants else "None"
            return False, f"Variant '{size}' is not available. Try: {available}", None
        
        variant_price = float(variant.get('price', 0))

        existing_item = CartItem.query.filter_by(
            client_token=client_token,
            product_id=product_id,
            size=size
        ).first()

        if existing_item:
            new_qty = existing_item.quantity + quantity
            available, stock_err = check_stock_availability(product, new_qty, size)
            if not available: return False, stock_err, None
            
            existing_item.quantity = new_qty
            existing_item.price = variant_price 
            existing_item.updated_at = datetime.utcnow()
        else:
            available, stock_err = check_stock_availability(product, quantity, size)
            if not available: return False, stock_err, None
            
            new_item = CartItem(
                client_token=client_token,
                product_id=product_id,
                quantity=quantity,
                size=size,
                price=variant_price
            )
            db.session.add(new_item)

        db.session.commit()
        return True, "Cart updated", fetch_cart_contents(client_token)
    except SQLAlchemyError as e:
        db.session.rollback()
        return False, str(e), None

def remove_item_from_cart(client_token, product_id, size):
    """Targets a specific variant for removal from the cart."""
    try:
        item = CartItem.query.filter_by(
            client_token=client_token,
            product_id=product_id,
            size=size
        ).first()
        if not item: return False, "Variant not found", None
        
        db.session.delete(item)
        db.session.commit()
        return True, "Item removed", fetch_cart_contents(client_token)
    except SQLAlchemyError as e:
        db.session.rollback()
        return False, str(e), None

def clear_cart(client_token):
    """Removes all items associated with a client token."""
    try:
        CartItem.query.filter_by(client_token=client_token).delete()
        db.session.commit()
        return True, "Cart cleared"
    except SQLAlchemyError as e:
        db.session.rollback()
        return False, str(e)

def fetch_cart_contents(client_token):
    """Retrieves all cart items and calculates totals."""
    try:
        cart_items = CartItem.query.filter_by(client_token=client_token).all()
        items = [item.to_dict() for item in cart_items]
        total_price = sum(item['subtotal'] for item in items)
        
        return {
            'items': items,
            'total_items': sum(item['quantity'] for item in items),
            'total_price': round(total_price, 2)
        }
    except Exception as e:
        return {'items': [], 'total_items': 0, 'total_price': 0, 'error': str(e)}

