import os
import cloudinary
import cloudinary.uploader
from datetime import datetime
from flask import current_app
from sqlalchemy.exc import SQLAlchemyError

from models import db, Expense

# Reuses the same Cloudinary account already configured in
# product_service.py (same env vars) — configuring again here is
# redundant but harmless (cloudinary.config() just overwrites globals
# with the same values); kept explicit so this file has no hidden
# import-order dependency on product_service.py having run first.
cloudinary.config(
    cloud_name=os.environ.get("CLOUDINARY_NAME"),
    api_key=os.environ.get("CLOUDINARY_API_KEY"),
    api_secret=os.environ.get("CLOUDINARY_API_SECRET"),
    secure=True
)


def extract_public_id(image_url):
    """Same logic as product_service.py's extract_public_id — duplicated
    rather than imported to keep this file independent (no cross-service
    import cycle risk), it's a small pure function."""
    if not image_url:
        return None
    try:
        parts = image_url.split('/upload/')[-1]
        parts = parts.split('/', 1)[-1] if parts.split('/')[0].startswith('v') else parts
        public_id = parts.rsplit('.', 1)[0]
        return public_id
    except Exception:
        return None


def get_all_expenses():
    return Expense.query.order_by(Expense.date.desc(), Expense.created_at.desc()).all()


def create_expense(data, receipt_file=None):
    """
    data: dict with date (YYYY-MM-DD string), description, amount.
    receipt_file: optional Werkzeug FileStorage from request.files —
    uploaded to Cloudinary under an "expenses/" folder, same pattern
    as product image uploads.
    """
    try:
        for field in ("date", "description", "amount"):
            if not data.get(field):
                return None, f"Missing field: {field}"

        try:
            expense_date = datetime.strptime(data["date"], "%Y-%m-%d").date()
        except ValueError:
            return None, "date must be in YYYY-MM-DD format"

        try:
            amount = float(data["amount"])
        except (ValueError, TypeError):
            return None, "amount must be a number"

        receipt_url = None
        if receipt_file:
            upload_result = cloudinary.uploader.upload(receipt_file, folder="expenses")
            receipt_url = upload_result.get("secure_url")

        expense = Expense(
            date=expense_date,
            description=data["description"],
            amount=amount,
            receipt_image=receipt_url,
        )
        db.session.add(expense)
        db.session.commit()
        return expense, None
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Expense Create Error: {str(e)}")
        raise


def update_expense(expense_id, data, receipt_file=None):
    try:
        expense = Expense.query.get(expense_id)
        if not expense:
            return None, "Expense not found"

        if "date" in data and data["date"]:
            try:
                expense.date = datetime.strptime(data["date"], "%Y-%m-%d").date()
            except ValueError:
                return None, "date must be in YYYY-MM-DD format"
        if "description" in data and data["description"]:
            expense.description = data["description"]
        if "amount" in data and data["amount"] not in (None, ""):
            try:
                expense.amount = float(data["amount"])
            except (ValueError, TypeError):
                return None, "amount must be a number"

        if receipt_file:
            old_public_id = extract_public_id(expense.receipt_image)
            upload_result = cloudinary.uploader.upload(receipt_file, folder="expenses")
            expense.receipt_image = upload_result.get("secure_url")
            if old_public_id:
                try:
                    cloudinary.uploader.destroy(old_public_id)
                except Exception as e:
                    current_app.logger.warning(f"Failed to delete old receipt image: {str(e)}")

        db.session.commit()
        return expense, None
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Expense Update Error: {str(e)}")
        raise


def delete_expense(expense_id):
    try:
        expense = Expense.query.get(expense_id)
        if not expense:
            return False, "Expense not found"

        public_id = extract_public_id(expense.receipt_image)
        db.session.delete(expense)
        db.session.commit()

        if public_id:
            try:
                cloudinary.uploader.destroy(public_id)
            except Exception as e:
                current_app.logger.warning(f"Failed to delete receipt image from Cloudinary: {str(e)}")

        return True, None
    except SQLAlchemyError as e:
        db.session.rollback()
        current_app.logger.error(f"Expense Delete Error: {str(e)}")
        raise

