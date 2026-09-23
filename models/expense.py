from datetime import datetime
from . import db


class Expense(db.Model):
    """
    Business expenses tracked separately from products/orders — admin
    only, uploaded/listed from the dashboard's Expenses tab. receipt_image
    follows the same Cloudinary upload pattern as Product.image (see
    services/expense_service.py).
    """
    __tablename__ = "expenses"

    id = db.Column(db.Integer, primary_key=True)

    date = db.Column(db.Date, nullable=False)
    description = db.Column(db.String(300), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    receipt_image = db.Column(db.String(500), nullable=True)  # Cloudinary secure_url

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "date": self.date.isoformat() if self.date else None,
            "description": self.description,
            "amount": self.amount,
            "receipt_image": self.receipt_image,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }

