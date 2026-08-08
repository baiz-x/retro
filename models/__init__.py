# Import all your models here so they can be accessed as:
# from ecom.models import Product, Order, OrderItem, CartItem
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

from .product import Product
from .order import Order
from .orderitem import OrderItem
from .cartitem import CartItem

# Optional: create a list of all models (useful if you want to dynamically create tables)
__all__ = ["Product", "Order", "OrderItem", "CartItem"]
