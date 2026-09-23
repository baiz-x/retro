# Import all your models here so they can be accessed as:
# from ecom.models import Product, Order, OrderItem, CartItem
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import event

db = SQLAlchemy()

from .product import Product
from .order import Order, OrderStatus
from .order_item import OrderItem
from .cart_item import CartItem
from .user import User
from .wholesale import Wholesale, create_wholesale_row_for_new_product
from .expense import Expense
from .guest_order_link import GuestOrderLink
from .fulfillment_checkoff import FulfillmentCheckoff

# Registered here (not inside wholesale.py) so both Product and
# Wholesale are already fully imported above — avoids a circular
# import between the two model modules. Fires once, right after a
# Product row is actually inserted, giving it an empty Wholesale row
# with all fields None (jersey_name, wholesale_price, retail_price,
# profit, wholesaler) ready for the admin to fill in from the
# Wholesale tab.
event.listen(Product, "after_insert", create_wholesale_row_for_new_product)

# Optional: create a list of all models (useful if you want to dynamically create tables)
__all__ = ["Product", "Order", "OrderStatus", "OrderItem", "CartItem", "User", "Wholesale", "Expense", "GuestOrderLink", "FulfillmentCheckoff"]

