/**
 * Markazus Sunnah Admin Dashboard Logic
 */

const API_BASE = '/api/admin';
const PRODUCT_API = '/api/admin/products';
const ORDER_API = '/api/admin/orders';

const DOM = {
    productsTable: document.getElementById('products-table-body'),
    ordersContainer: document.getElementById('orders-list'),
    addProductForm: document.getElementById('add-product-form'),
    logoutBtn: document.getElementById('logout-btn'),
    loadingSpinner: document.getElementById('loading-spinner'),
    parentCatInput: document.getElementById('parent-category-input'),
    subCatInput: document.getElementById('sub-category-input'),
    combinedCatHidden: document.getElementById('combined-category'),
    variantsInput: document.getElementById('variants-input'),
    submitBtn: document.querySelector('#add-product-form button[type="submit"]'),
    orderModal: document.getElementById('order-detail-modal')
};

let allOrders = [];

async function checkAuth() {
    toggleLoading(true);
    try {
        const response = await fetch(`${API_BASE}/dashboard`);
        if (response.status === 401) {
            window.location.href = 'admin_form.html';
            return;
        }
        initDashboard();
    } catch (error) {
        window.location.href = 'admin-form';
    } finally {
        toggleLoading(false);
    }
}

function initDashboard() {
    fetchProducts();
    fetchOrders();

    if (DOM.addProductForm) DOM.addProductForm.addEventListener('submit', handleAddProduct);
    if (DOM.logoutBtn) DOM.logoutBtn.addEventListener('click', handleLogout);

    // Global Modal Close Listeners
    document.querySelectorAll('.btn-close-modal').forEach(btn => {
        btn.addEventListener('click', closeModal);
    });

    // Event Delegation for Products Table (Delete Button)
    if (DOM.productsTable) {
        DOM.productsTable.addEventListener('click', (e) => {
            const deleteBtn = e.target.closest('.delete-product-btn');
            if (deleteBtn) {
                const productId = deleteBtn.getAttribute('data-id');
                deleteProduct(productId);
            }
        });
    }

    // Event Delegation for Orders List (Modal & Status)
    if (DOM.ordersContainer) {
        DOM.ordersContainer.addEventListener('click', (e) => {
            // If user clicks the select dropdown, don't open modal
            if (e.target.closest('.order-status-select')) return;

            const card = e.target.closest('.order-card');
            if (card) {
                const orderId = card.getAttribute('data-id');
                showOrderDetails(orderId);
            }
        });

        DOM.ordersContainer.addEventListener('change', (e) => {
            const select = e.target.closest('.order-status-select');
            if (select) {
                const orderId = select.getAttribute('data-order-id');
                updateOrderStatus(orderId, select.value);
            }
        });
    }
}

async function fetchOrders() {
    try {
        const response = await fetch(ORDER_API);
        const result = await response.json();
        if (result.status === 'success') {
            allOrders = result.data;
            renderOrders(allOrders);
        }
    } catch (error) {
        showToast("Failed to load orders", "error");
    }
}

function renderOrders(orders) {
    if (!DOM.ordersContainer) return;

    // Filter out delivered orders and sort: Pending first, then Shipped
    const displayOrders = orders
        .filter(order => order.status !== 'Delivered')
        .sort((a, b) => {
            if (a.status === b.status) return 0;
            return a.status === 'Pending' ? -1 : 1;
        });

    if (displayOrders.length === 0) {
        DOM.ordersContainer.innerHTML = `<div class="col-span-full text-center py-12 text-gray-400">No orders yet.</div>`;
        return;
    }

    DOM.ordersContainer.innerHTML = displayOrders.map(order => `
        <div class="order-card bg-white p-6 rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:border-black transition cursor-pointer" data-id="${order.order_id}">
            <div class="flex justify-between items-start mb-4">
                <div>
                    <span class="text-[10px] font-bold text-gray-400 uppercase tracking-tighter">Order #${order.order_id}</span>
                    <h4 class="font-bold text-gray-800">${order.customer_name}</h4>
                </div>
                <span class="px-2 py-1 rounded-full text-[9px] font-black uppercase tracking-widest
                    ${order.status === 'Pending' ? 'text-orange-600 bg-orange-50' : ''}
                    ${order.status === 'Shipped' ? 'text-blue-600 bg-blue-50' : ''}
                    ${order.status === 'Delivered' ? 'text-green-600 bg-green-50' : ''}">
                    ${order.status}
                </span>
            </div>
            <p class="text-xs text-gray-500 mb-4 h-8 overflow-hidden">${order.address}</p>
            <p class="text-[10px] font-mono text-blue-600">ID: ${order.transaction_id}</p>
            <p class="text-[10px] font-mono text-gray-600">Paid from: ${order.payment_number}</p>
            <div class="space-y-3 pt-3 border-t border-gray-50 flex justify-between items-center">
                <span class="text-sm font-bold">BDT ${parseFloat(order.total).toFixed(2)}</span>
                <select data-order-id="${order.order_id}"
                        class="order-status-select text-[10px] uppercase font-bold bg-gray-50 rounded-lg px-2 py-1 outline-none border-none cursor-pointer hover:bg-gray-100 transition">
                    <option value="Pending" ${order.status === 'Pending' ? 'selected' : ''}>Pending</option>
                    <option value="Shipped" ${order.status === 'Shipped' ? 'selected' : ''}>Shipped</option>
                    <option value="Delivered" ${order.status === 'Delivered' ? 'selected' : ''}>Delivered</option>
                </select>
            </div>
        </div>
    `).join('');
}

function showOrderDetails(orderId) {
    const order = allOrders.find(o => o.order_id == orderId);
    if (!order) return;

    const content = document.getElementById('modal-items-content');
    const totalEl = document.getElementById('modal-total-price');

    content.innerHTML = order.items.map(item => `
        <div class="flex justify-between items-center py-4 border-b border-gray-50 last:border-0">
            <div class="flex items-center gap-4">
                <div class="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center font-bold text-xs">x${item.quantity}</div>
                <div>
                    <p class="font-bold text-sm">${item.product_name}</p>
                    <p class="text-[10px] text-gray-400 uppercase">Size: ${item.size} | Unit: BDT ${parseFloat(item.price).toFixed(2)}</p>
                </div>
            </div>
            <p class="font-bold text-sm">BDT ${(item.price * item.quantity).toFixed(2)}</p>
        </div>
    `).join('');

    totalEl.innerText = `BDT ${parseFloat(order.total).toFixed(2)}`;
    DOM.orderModal.classList.remove('hidden');
}

function closeModal() {
    DOM.orderModal.classList.add('hidden');
}

async function fetchProducts() {
    try {
        const response = await fetch('/api/products');
        const result = await response.json();
        if (result.status === 'success') renderProducts(result.data);
    } catch (error) { showToast("Failed to load products", "error"); }
}

function renderProducts(products) {
    if (!DOM.productsTable) return;
    DOM.productsTable.innerHTML = products.map(p => `
        <tr class="hover:bg-gray-50 transition border-b border-gray-50">
            <td class="px-6 py-4 font-mono text-xs text-gray-400">#${p.id}</td>
            <td class="px-6 py-4">
                <div class="font-bold text-gray-800">${p.name}</div>
                <div class="text-[9px] uppercase tracking-widest text-emerald-600 font-semibold">
                    ${p.category ? p.category.replace('-', ' > ') : 'Uncategorized'}
                </div>
            </td>
            <td class="px-6 py-4 font-medium text-gray-600">BDT ${parseFloat(p.price).toFixed(2)}</td>
            <td class="px-6 py-4 text-right">
                <button type="button" data-id="${p.id}" class="delete-product-btn text-red-500 hover:text-red-700 transition">
                    <svg class="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
            </td>
        </tr>
    `).join('');
}

async function handleAddProduct(e) {
    e.preventDefault();
    const parent = DOM.parentCatInput.value.trim();
    const sub = DOM.subCatInput.value.trim();
    DOM.combinedCatHidden.value = `${parent.toLowerCase()}-${sub.toLowerCase()}`;
    
    const variantRaw = DOM.variantsInput.value.trim();
    let refinedVariants = [];
    if (variantRaw) {
        refinedVariants = variantRaw.split('/').map(pair => {
            const [size, price, stock] = pair.split(':');
            return { size: size.trim(), price: parseFloat(price), stock: parseInt(stock) };
        });
    }

    const formData = new FormData(e.target);
    formData.append('variants', JSON.stringify(refinedVariants));
    
    setSubmitting(true);
    try {
        const response = await fetch(PRODUCT_API, { method: 'POST', body: formData });
        if (response.ok) {
            showToast("Product created", "success");
            e.target.reset();
            fetchProducts();
        } else {
            const err = await response.json();
            showToast(err.message || "Failed to create", "error");
        }
    } catch (error) { showToast("Error connecting", "error"); } finally { setSubmitting(false); }
}

async function deleteProduct(id) {
    if (!confirm("Delete product?")) return;
    try {
        const response = await fetch(`${PRODUCT_API}/${id}`, { method: 'DELETE' });
        if (response.ok) { 
            showToast("Product deleted", "success"); 
            fetchProducts(); 
        }
    } catch (error) { showToast("Delete failed", "error"); }
}

async function updateOrderStatus(orderId, newStatus) {
    try {
        const response = await fetch(`${API_BASE}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_id: orderId, status: newStatus })
        });
        if (response.ok) {
            showToast(`Order #${orderId} Updated`, "success");
            fetchOrders();
        }
    } catch (error) { showToast("Update failed", "error"); }
}

function toggleLoading(isLoading) { if (DOM.loadingSpinner) DOM.loadingSpinner.classList.toggle('hidden', !isLoading); }
function setSubmitting(isSubmitting) { if (DOM.submitBtn) { DOM.submitBtn.disabled = isSubmitting; DOM.submitBtn.innerText = isSubmitting ? '...' : 'Create Product'; } }
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `px-6 py-3 rounded-xl text-white text-xs font-bold uppercase tracking-widest shadow-2xl transition-all duration-300 ${type === 'success' ? 'bg-emerald-600' : 'bg-red-500'}`;
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}
async function handleLogout() { await fetch('/api/admin/logout'); window.location.href = 'admin-form'; }

document.addEventListener('DOMContentLoaded', checkAuth);



