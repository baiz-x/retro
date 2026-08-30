/**
 * Store Dashboard Engine
 * Decoupled script relying fully on event listeners (No inline onclick bindings)
 */

let allOrders = [];
let allProducts = [];
let activeOrderFilter = 'all';
let editingProductId = null;

// Each field is either type "text" (free-typed comma-separated values,
// same behavior as the old gypsum/candle axes) or type "checkbox-group"
// (fixed known options — prevents typo'd duplicate axis values like
// "Home" vs "home" silently becoming two different SKU rows). Either
// type ends up as a .variant-axis-input element with the same
// data-axis attribute, so renderDynamicFields' consumers (updateMatrixUI,
// generateCombinations, handleProductUpload) don't need to branch on it.
const COLLECTION_FIELDS = {
    "jersey": [
        { name: "jersey_fabric", label: "Fabric Type", type: "text" },
        { name: "jersey_size", label: "Size", type: "text" }
    ],
    "boots": [
        { name: "boots_size", label: "Size (EU)", type: "text" },
        { name: "boots_material", label: "Material", type: "text" },
        { name: "boots_color", label: "Color", type: "text" },
        { name: "boots_type", label: "Type", type: "text" }
    ],
    "others": [
        { name: "fabric_type", label: "Fabric Type", type: "text" },
        { name: "gsm", label: "GSM", type: "text" },
        { name: "size", label: "Size", type: "text" },
        { name: "color", label: "Color", type: "text" }
    ]
};

document.addEventListener("DOMContentLoaded", () => {
    initClock();
    initEventListeners();
    refreshData();
});

function initClock() {
    const clockEl = document.getElementById('clock');
    if (!clockEl) return;
    const update = () => {
        clockEl.innerText = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    update();
    setInterval(update, 1000);
}

function initEventListeners() {
    // Bottom Navigation Switcher Binding
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetBtn = e.currentTarget;
            const tabId = targetBtn.dataset.tab;
            if (tabId === 'upload' && editingProductId !== null) {
                exitEditMode();
                document.getElementById('uploadForm')?.reset();
                renderDynamicFields();
            }
            switchTab(tabId, targetBtn);
        });
    });

    // Product type radios — mutually exclusive by nature (native radio
    // behavior), so no manual uncheck-the-others logic is needed here
    // anymore (the old raw_materials-vs-others special case is gone).
    document.querySelectorAll('.collection-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            renderDynamicFields();
        });
    });

    // Cancel edit button
    const cancelEditBtn = document.getElementById('cancel-edit-btn');
    if (cancelEditBtn) {
        cancelEditBtn.addEventListener('click', () => {
            exitEditMode();
            switchTab('edit', document.querySelector('[data-tab="edit"]'));
        });
    }

    // Variant mode selector
    const variantModeSelect = document.getElementById('variant_mode');
    if (variantModeSelect) {
        variantModeSelect.addEventListener('change', updateMatrixUI);
    }

    document.querySelector('input[name="price"]')?.addEventListener('input', updateMatrixUI);
    document.querySelector('input[name="stock"]')?.addEventListener('input', updateMatrixUI);

    // Form submit
    const uploadForm = document.getElementById('uploadForm');
    if (uploadForm) {
        uploadForm.addEventListener('submit', handleProductUpload);
    }

    // Status filter buttons
    document.querySelectorAll('.status-filter').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.status-filter').forEach(b => {
                b.className = "status-filter px-5 py-2 rounded-full bg-white border border-navy/20 text-navy/60 text-[10px] tracking-widest uppercase font-bold whitespace-nowrap shadow-sm";
            });
            const target = e.currentTarget;
            target.className = "status-filter px-5 py-2 rounded-full bg-navy text-gold text-[10px] tracking-widest uppercase font-bold whitespace-nowrap shadow-sm";
            activeOrderFilter = target.dataset.status;
            renderOrders();
        });
    });
}

async function refreshData() {
    await Promise.all([fetchOrders(), fetchProducts()]);
    renderAnalytics();
    renderOrders();
    renderInventory();
}

function switchTab(tabId, btnElement) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('text-navy');
        btn.classList.add('text-gray-400');
    });

    const targetTab = document.getElementById(`tab-${tabId}`);
    if (targetTab) targetTab.classList.add('active');

    if (btnElement) {
        btnElement.classList.remove('text-gray-400');
        btnElement.classList.add('text-navy');
    }

    if (tabId === 'orders') fetchOrders();
    if (tabId === 'edit') fetchProducts();
    if (tabId === 'revenue') renderAnalytics();
}

/* ================= TOAST NOTIFICATIONS ================= */
// Independent of the active tab — used for async Deploy/Update results
// that resolve after the admin has already navigated away.

function showToast(message, isSuccess) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    const baseClasses = "pointer-events-auto rounded-lg px-4 py-3 shadow-lg text-xs font-bold uppercase tracking-widest text-center transition-all duration-300 opacity-0 -translate-y-2";
    toast.className = `${baseClasses} ${isSuccess ? 'bg-navy text-gold' : 'bg-red-600 text-white'}`;
    toast.innerText = message;
    container.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.remove('opacity-0', '-translate-y-2');
    });

    setTimeout(() => {
        toast.classList.add('opacity-0', '-translate-y-2');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

/* ================= API FETCHERS ================= */

async function fetchOrders() {
    try {
        const res = await fetch('/api/admin/orders');
        const result = await res.json();
        if (result.status === 'success') {
            allOrders = result.data || [];
            renderAnalytics();
            renderOrders();
        }
    } catch (err) {
        console.error("Failed to fetch orders:", err);
    }
}

async function fetchProducts() {
    try {
        const res = await fetch('/api/products');
        const result = await res.json();
        if (result.status === 'success') {
            allProducts = result.data || [];
            renderInventory();
        }
    } catch (err) {
        console.error("Failed to fetch products:", err);
    }
}

/* ================= TAB 1: ANALYTICS ================= */

function renderAnalytics() {
    const revEl = document.getElementById('rev-total');
    const cntEl = document.getElementById('rev-count');
    const tbody = document.getElementById('revenue-table-body');

    if (!tbody) return;

    let totalRevenue = 0;
    let totalProductsMoved = 0;
    const productSalesMap = {};

    allOrders.forEach(order => {
        if (order.status !== 'Pending') {
            totalRevenue += (order.total || 0);
            (order.items || []).forEach(item => {
                totalProductsMoved += item.quantity;
                if (!productSalesMap[item.product_name]) {
                    productSalesMap[item.product_name] = { qty: 0, revenue: 0 };
                }
                productSalesMap[item.product_name].qty += item.quantity;
                productSalesMap[item.product_name].revenue += (item.price * item.quantity);
            });
        }
    });

    if (revEl) revEl.innerText = `৳${totalRevenue.toFixed(2)}`;
    if (cntEl) cntEl.innerText = totalProductsMoved;

    tbody.innerHTML = '';
    const entries = Object.entries(productSalesMap);

    if (entries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-gray-400 text-xs">No completed sales recorded.</td></tr>`;
        return;
    }

    entries.forEach(([pName, stats]) => {
        const tr = document.createElement('tr');
        tr.className = "hover:bg-gray-50 transition-colors";
        tr.innerHTML = `
            <td class="p-4 font-bold text-xs uppercase tracking-wider">${pName}</td>
            <td class="p-4">${stats.qty}</td>
            <td class="p-4 text-gold font-black text-right">৳${stats.revenue.toFixed(2)}</td>
        `;
        tbody.appendChild(tr);
    });
}

/* ================= TAB 2: DYNAMIC FORM & MATRIX GENERATOR ================= */

function renderDynamicFields() {
    const checkedRadio = document.querySelector('.collection-cb:checked');
    // Backend/DB still expect collection_tags as a JSON array (see
    // models.py get_extra_fields_for_collection) — a single selection
    // is sent as a 1-element array so product_service.py's existing
    // parsing needs no changes.
    const activeTags = checkedRadio ? [checkedRadio.value] : [];

    const tagsInput = document.getElementById('collection_tags_input');
    if (tagsInput) tagsInput.value = JSON.stringify(activeTags);

    const container = document.getElementById('dynamic-fields-container');
    const target = document.getElementById('dynamic-inputs');

    if (!container || !target) return;

    if (activeTags.length === 0) {
        container.classList.add('hidden');
        target.innerHTML = '';
        updateMatrixUI();
        return;
    }

    const fields = COLLECTION_FIELDS[activeTags[0]] || [];

    container.classList.remove('hidden');
    target.innerHTML = fields.map(field => {
        if (field.type === 'checkbox-group') {
            const optionsHtml = field.options.map(opt => `
                <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" value="${opt}" data-axis="${field.name}" class="variant-axis-option w-4 h-4 accent-navy">
                    <span class="text-xs font-semibold text-navy/80">${opt}</span>
                </label>
            `).join('');
            return `
                <div>
                    <label class="block text-[9px] uppercase font-bold text-navy/70 mb-2 tracking-widest">${field.label}</label>
                    <div class="flex flex-wrap gap-3">${optionsHtml}</div>
                    <input type="hidden" data-axis="${field.name}" class="variant-axis-input variant-axis-checkbox-group">
                </div>
            `;
        }
        return `
            <div>
                <label class="block text-[9px] uppercase font-bold text-navy/70 mb-1 tracking-widest">${field.label}</label>
                <input type="text" data-axis="${field.name}" class="variant-axis-input input-field !mt-0 !text-xs" placeholder="e.g. Value1, Value2">
            </div>
        `;
    }).join('');

    // Free-text axis inputs feed the matrix directly on input.
    document.querySelectorAll('.variant-axis-input:not(.variant-axis-checkbox-group)').forEach(input => {
        input.addEventListener('input', updateMatrixUI);
    });

    // Checkbox-group options write their checked values into the
    // paired hidden .variant-axis-input so updateMatrixUI/handleProductUpload
    // can read every axis the same way regardless of which UI produced it.
    document.querySelectorAll('.variant-axis-option').forEach(opt => {
        opt.addEventListener('change', (e) => {
            const axis = e.currentTarget.dataset.axis;
            const checked = document.querySelectorAll(`.variant-axis-option[data-axis="${axis}"]:checked`);
            const values = Array.from(checked).map(c => c.value);
            const hiddenInput = document.querySelector(`.variant-axis-checkbox-group[data-axis="${axis}"]`);
            if (hiddenInput) hiddenInput.value = values.join(', ');
            updateMatrixUI();
        });
    });

    updateMatrixUI();
}

function generateCombinations(axes) {
    const keys = Object.keys(axes);
    if (keys.length === 0) return [];

    const result = [];
    const helper = (currentCombo, index) => {
        if (index === keys.length) {
            if (Object.keys(currentCombo).length > 0) result.push(currentCombo);
            return;
        }
        const key = keys[index];
        const values = axes[key];

        if (!values || values.length === 0) {
            helper(currentCombo, index + 1);
        } else {
            for (let i = 0; i < values.length; i++) {
                helper({ ...currentCombo, [key]: values[i] }, index + 1);
            }
        }
    };
    helper({}, 0);
    return result;
}

function updateMatrixUI() {
    const variantModeSelect = document.getElementById('variant_mode');
    const matrixContainer = document.getElementById('matrix-container');
    const matrixBody = document.getElementById('matrix-body');

    if (!variantModeSelect || !matrixContainer || !matrixBody) return;

    if (variantModeSelect.value !== 'per_variant') {
        matrixContainer.classList.add('hidden');
        return;
    }

    const axes = {};
    document.querySelectorAll('.variant-axis-input').forEach(input => {
        const vals = input.value.split(',').map(s => s.trim()).filter(Boolean);
        if (vals.length > 0) axes[input.dataset.axis] = vals;
    });

    const combos = generateCombinations(axes);

    if (combos.length === 0) {
        matrixContainer.classList.add('hidden');
        return;
    }

    matrixContainer.classList.remove('hidden');
    matrixBody.innerHTML = '';

    const basePrice = document.querySelector('input[name="price"]')?.value || 0;
    const baseStock = document.querySelector('input[name="stock"]')?.value || 0;

    combos.forEach(combo => {
        const label = Object.values(combo).join(' / ');
        const tr = document.createElement('tr');
        tr.className = "matrix-row border-b border-navy/5 hover:bg-gray-50";
        tr.setAttribute('data-combo', JSON.stringify(combo));
        tr.innerHTML = `
            <td class="p-2 text-[10px] font-bold text-navy/70">${label}</td>
            <td class="p-2"><input type="number" step="0.01" class="matrix-price w-full border-b border-navy/20 bg-transparent text-xs p-1 focus:outline-none focus:border-gold" value="${basePrice}"></td>
            <td class="p-2"><input type="number" class="matrix-stock w-full border-b border-navy/20 bg-transparent text-xs p-1 focus:outline-none focus:border-gold" value="${baseStock}"></td>
        `;
        matrixBody.appendChild(tr);
    });
}

function handleProductUpload(e) {
    e.preventDefault();

    const form = e.target;
    const formData = new FormData(form);

    const checkedTags = Array.from(document.querySelectorAll('.collection-cb:checked')).map(cb => cb.value);
    formData.set('collection_tags', JSON.stringify(checkedTags));

    const axes = {};
    document.querySelectorAll('.variant-axis-input').forEach(input => {
        const vals = input.value.split(',').map(s => s.trim()).filter(Boolean);
        if (vals.length > 0) axes[input.dataset.axis] = vals;
    });

    const combinations = [];
    const variantMode = document.getElementById('variant_mode')?.value;

    if (variantMode === 'per_variant') {
        document.querySelectorAll('.matrix-row').forEach(row => {
            const comboData = JSON.parse(row.getAttribute('data-combo'));
            comboData.price = parseFloat(row.querySelector('.matrix-price')?.value || 0);
            comboData.stock = parseInt(row.querySelector('.matrix-stock')?.value || 0, 10);
            combinations.push(comboData);
        });
    }

    const variantsJSON = {
        axes: axes,
        combinations: combinations,
        axis_images: {}
    };

    formData.set('variants', JSON.stringify(variantsJSON));

    // Capture what we need for the toast BEFORE the form is reset/left.
    const assetName = formData.get('name') || 'Asset';
    const isEditing = !!editingProductId;
    const targetId = editingProductId;

    // Fire-and-forget: reset UI and redirect immediately, do not wait on the network.
    form.reset();
    exitEditMode();
    renderDynamicFields();
    switchTab('edit', document.querySelector('[data-tab="edit"]'));

    const request = isEditing
        ? fetch(`/api/admin/products/${targetId}`, { method: 'PATCH', body: formData })
        : fetch('/api/admin/products', { method: 'POST', body: formData });

    request
        .then(async (res) => {
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                showToast(`"${assetName}" ${isEditing ? 'updated' : 'deployed to Ledger'}`, true);
                refreshData();
            } else {
                showToast(`"${assetName}" ${isEditing ? 'update' : 'deployment'} failed: ${data.message || 'Unknown error'}`, false);
            }
        })
        .catch((err) => {
            showToast(`"${assetName}" ${isEditing ? 'update' : 'deployment'} failed: ${err.message}`, false);
        });
}

function comboKey(combo) {
    // Canonical key so stored combinations can be matched to freshly-generated
    // matrix rows regardless of key ordering.
    return Object.entries(combo)
        .filter(([k]) => k !== 'price' && k !== 'stock')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v}`)
        .join('|');
}

function enterEditMode(productId) {
    const prod = allProducts.find(p => p.id === productId);
    if (!prod) {
        showToast('Could not find that asset to edit.', false);
        return;
    }

    editingProductId = productId;

    const form = document.getElementById('uploadForm');
    if (!form) return;

    form.querySelector('#edit_product_id').value = productId;
    form.querySelector('[name="name"]').value = prod.name || '';
    form.querySelector('[name="description"]').value = prod.description || '';
    form.querySelector('[name="price"]').value = prod.price ?? '';
    form.querySelector('[name="stock"]').value = prod.stock ?? '';
    form.querySelector('[name="club"]').value = prod.club || '';
    form.querySelector('[name="category"]').value = prod.category || '';
    form.querySelector('[name="edition"]').value = prod.edition || '';
    form.querySelector('[name="version"]').value = prod.version || '';
    form.querySelector('[name="kit_type"]').value = prod.kit_type || '';

    const tags = prod.collection_tags || [];
    document.querySelectorAll('.collection-cb').forEach(cb => {
        cb.checked = tags.includes(cb.value);
    });

    renderDynamicFields();

    const axes = (prod.variants && prod.variants.axes) || {};
    document.querySelectorAll('.variant-axis-input').forEach(input => {
        const vals = axes[input.dataset.axis];
        if (vals && vals.length) input.value = vals.join(', ');
    });

    // Checkbox-group fields also need their visible option checkboxes
    // re-checked to match — the loop above only fills the paired
    // hidden input, which drives the matrix but isn't itself visible.
    document.querySelectorAll('.variant-axis-option').forEach(opt => {
        const vals = axes[opt.dataset.axis] || [];
        opt.checked = vals.includes(opt.value);
    });

    const variantModeSelect = document.getElementById('variant_mode');
    if (variantModeSelect) variantModeSelect.value = prod.variant_mode || 'unified';

    updateMatrixUI();

    const storedCombos = (prod.variants && prod.variants.combinations) || [];
    if (storedCombos.length) {
        const byKey = {};
        storedCombos.forEach(c => { byKey[comboKey(c)] = c; });

        document.querySelectorAll('.matrix-row').forEach(row => {
            const rowCombo = JSON.parse(row.getAttribute('data-combo'));
            const match = byKey[comboKey(rowCombo)];
            if (match) {
                const priceInput = row.querySelector('.matrix-price');
                const stockInput = row.querySelector('.matrix-stock');
                if (priceInput && match.price != null) priceInput.value = match.price;
                if (stockInput && match.stock != null) stockInput.value = match.stock;
            }
        });
    }

    const label = document.getElementById('upload-btn-label');
    if (label) label.innerText = 'Update Asset';
    const cancelBtn = document.getElementById('cancel-edit-btn');
    if (cancelBtn) cancelBtn.classList.remove('hidden');

    switchTab('upload', document.querySelector('[data-tab="upload"]'));
}

function exitEditMode() {
    editingProductId = null;
    const idInput = document.getElementById('edit_product_id');
    if (idInput) idInput.value = '';
    const label = document.getElementById('upload-btn-label');
    if (label) label.innerText = 'Submit Asset to Ledger';
    const cancelBtn = document.getElementById('cancel-edit-btn');
    if (cancelBtn) cancelBtn.classList.add('hidden');
}

/* ================= TAB 3: ORDERS CRM ================= */

function renderOrders() {
    const container = document.getElementById('orders-container');
    if (!container) return;
    container.innerHTML = '';

    const filtered = activeOrderFilter === 'all'
        ? allOrders
        : allOrders.filter(o => o.status === activeOrderFilter);

    if (filtered.length === 0) {
        container.innerHTML = `<p class="text-[10px] uppercase font-bold text-gray-400 tracking-widest text-center mt-10">No Orders Found under "${activeOrderFilter}"</p>`;
        return;
    }

    filtered.forEach(order => {
        const itemsHtml = (order.items || []).map(item => {
            const varStr = item.selected_variants && Object.keys(item.selected_variants).length > 0
                ? ` - ${Object.values(item.selected_variants).join(', ')}`
                : '';
            return `
                <div class="flex justify-between text-xs font-semibold text-navy/70 mt-2">
                    <span>${item.quantity}x ${item.product_name} <span class="text-gold">${varStr}</span></span>
                    <span>৳${(item.price * item.quantity).toFixed(2)}</span>
                </div>
            `;
        }).join('');

        const card = document.createElement('div');
        card.className = "bg-white p-5 rounded-xl border border-navy/10 shadow-sm";
        card.innerHTML = `
            <div class="flex justify-between items-start mb-3">
                <div>
                    <h3 class="font-bold text-sm text-navy uppercase tracking-wider">${order.customer_name}</h3>
                    <p class="text-[10px] text-gray-500 font-bold uppercase tracking-widest">ID: ${order.order_id}</p>
                </div>
                <span class="px-3 py-1 bg-navy text-gold text-[9px] font-bold rounded uppercase tracking-widest">${order.status}</span>
            </div>
            <div class="border-y border-navy/10 py-3 mb-3">
                ${itemsHtml}
            </div>
            <div class="flex justify-between items-center">
                <span class="font-black text-sm text-navy">TOTAL: ৳${(order.total || 0).toFixed(2)}</span>
                <select data-order-id="${order.order_id}" class="status-select text-[10px] uppercase font-bold tracking-widest border border-navy/20 p-2 rounded bg-gray-50 text-navy cursor-pointer outline-none focus:border-gold">
                    <option value="" disabled selected>Update State</option>
                    ${['Pending', 'Packaged', 'Delivering', 'Delivered'].map(s =>
                        `<option value="${s}" ${order.status === s ? 'selected' : ''}>${s}</option>`
                    ).join('')}
                </select>
            </div>
        `;
        container.appendChild(card);
    });

    // Attach listeners to dynamic status dropdowns
    document.querySelectorAll('.status-select').forEach(select => {
        select.addEventListener('change', (e) => {
            updateOrderStatus(e.target.dataset.orderId, e.target.value);
        });
    });
}

async function updateOrderStatus(orderId, newStatus) {
    try {
        const res = await fetch(`/api/admin/orders/${orderId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            await refreshData();
        } else {
            alert(`Failed to update status: ${data.message}`);
        }
    } catch (err) {
        alert(`Error updating order status: ${err.message}`);
    }
}

/* ================= TAB 4: INVENTORY MANAGEMENT ================= */

function renderInventory() {
    const container = document.getElementById('products-container');
    if (!container) return;
    container.innerHTML = '';

    if (allProducts.length === 0) {
        container.innerHTML = `<p class="text-center text-gray-400 py-8 text-xs font-bold uppercase tracking-widest">No products available in inventory.</p>`;
        return;
    }

    allProducts.forEach(prod => {
        let actionBtns = prod.variant_mode === 'unified' ? `
            <div class="flex gap-2">
                <button data-product-id="${prod.id}" data-delta="1" class="stock-btn w-8 h-8 rounded bg-navy text-gold flex justify-center items-center hover:brightness-110 font-bold">+</button>
                <button data-product-id="${prod.id}" data-delta="-1" class="stock-btn w-8 h-8 rounded bg-gray-200 text-navy flex justify-center items-center hover:bg-gray-300 font-bold">-</button>
            </div>
        ` : `<span class="text-[9px] uppercase font-bold text-gold tracking-widest bg-navy px-2 py-1 rounded">Multi-Variant</span>`;

        const card = document.createElement('div');
        card.className = "bg-white p-5 rounded-xl border border-navy/10 shadow-sm flex justify-between items-center";
        card.innerHTML = `
            <div>
                <h3 class="font-bold text-sm text-navy uppercase tracking-wider">${prod.name}</h3>
                <p class="text-[10px] uppercase font-bold text-gray-500 tracking-widest mt-1">Aggregated Stock: <span class="text-navy font-black">${prod.stock}</span></p>
            </div>
            <div class="flex items-center gap-2">
                ${actionBtns}
                <button data-product-id="${prod.id}" class="edit-product-btn w-8 h-8 rounded border border-navy/20 text-navy flex justify-center items-center hover:bg-gray-100" title="Edit Asset">
                    <i class="fa-solid fa-pen text-xs"></i>
                </button>
            </div>
        `;
        container.appendChild(card);
    });

    // Attach listeners to stock increment/decrement buttons
    document.querySelectorAll('.stock-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.currentTarget;
            adjustStock(parseInt(target.dataset.productId, 10), parseInt(target.dataset.delta, 10));
        });
    });

    // Attach listeners to edit buttons
    document.querySelectorAll('.edit-product-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            enterEditMode(parseInt(e.currentTarget.dataset.productId, 10));
        });
    });
}

async function adjustStock(productId, delta) {
    try {
        const res = await fetch(`/api/admin/products/${productId}/stock`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ delta: delta })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            await refreshData();
        } else {
            alert(`Stock update failed: ${data.message}`);
        }
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}





