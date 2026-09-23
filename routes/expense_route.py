from flask import Blueprint, request, jsonify, current_app
from sqlalchemy.exc import SQLAlchemyError

from services.admin_service import admin_required
from services.expense_service import (
    get_all_expenses,
    create_expense,
    update_expense,
    delete_expense,
)

expense_bp = Blueprint("expenses", __name__, url_prefix="/api")


@expense_bp.route('/admin/expenses', methods=['GET'])
@admin_required
def list_expenses():
    try:
        expenses = get_all_expenses()
        return jsonify({'status': 'success', 'data': [e.to_dict() for e in expenses]}), 200
    except Exception as e:
        current_app.logger.error(f"Error in list_expenses: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to fetch expenses'}), 500


@expense_bp.route('/admin/expenses', methods=['POST'])
@admin_required
def add_expense():
    """
    multipart/form-data: date, description, amount, and an optional
    receipt file field — same upload convention as
    /api/admin/products (product image uploads).
    """
    try:
        data = {
            "date": request.form.get("date"),
            "description": request.form.get("description"),
            "amount": request.form.get("amount"),
        }
        receipt_file = request.files.get("receipt_image")

        expense, error = create_expense(data, receipt_file=receipt_file)
        if error:
            return jsonify({'status': 'error', 'message': error}), 400

        return jsonify({'status': 'success', 'data': expense.to_dict()}), 201
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in add_expense: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error occurred'}), 500
    except Exception as e:
        current_app.logger.error(f"Unexpected error in add_expense: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to add expense'}), 500


@expense_bp.route('/admin/expenses/<int:expense_id>', methods=['PATCH'])
@admin_required
def edit_expense(expense_id):
    try:
        data = {
            "date": request.form.get("date"),
            "description": request.form.get("description"),
            "amount": request.form.get("amount"),
        }
        receipt_file = request.files.get("receipt_image")

        expense, error = update_expense(expense_id, data, receipt_file=receipt_file)
        if error:
            return jsonify({'status': 'error', 'message': error}), 400

        return jsonify({'status': 'success', 'data': expense.to_dict()}), 200
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in edit_expense: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error occurred'}), 500
    except Exception as e:
        current_app.logger.error(f"Unexpected error in edit_expense: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to update expense'}), 500


@expense_bp.route('/admin/expenses/<int:expense_id>', methods=['DELETE'])
@admin_required
def remove_expense(expense_id):
    try:
        success, error = delete_expense(expense_id)
        if error:
            return jsonify({'status': 'error', 'message': error}), 404
        return jsonify({'status': 'success', 'message': 'Expense deleted'}), 200
    except SQLAlchemyError as e:
        current_app.logger.error(f"Database error in remove_expense: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Database error occurred'}), 500
    except Exception as e:
        current_app.logger.error(f"Unexpected error in remove_expense: {str(e)}")
        return jsonify({'status': 'error', 'message': 'Failed to delete expense'}), 500

