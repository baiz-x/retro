/**
 * Store Dashboard Engine
 * Decoupled script relying fully on event listeners (No inline onclick bindings)
 */

let allOrders = [];
let allProducts = [];
let activeOrderFilter = 'all';
let activeOrderSearch = '';
let orderSearchDebounceTimer = null;
let editingProductId = null;

// v4 field split — per Hasan's confirmed spec, every field is now one
// of two kinds, distinguished by `axis: true`:
//   - IDENTITY fields (axis: false/absent): one value per product
//     listing. Rendered as plain named inputs (name="fabric", "brand",
//     etc.) that ride straight through FormData — these map 1:1 to
//     real Product columns (see models.py) and are read directly by
//     name in handleProductUpload/enterEditMode, NOT looped over as
//     .variant-axis-input like the old extra-fields system did.
//   - VARIANT AXIS fields (axis: true): per-SKU, drive the price/stock
//     matrix. Rendered as .variant-axis-input (same mechanism as v3) —
//     comma-separated text, feeds generateCombinations/updateMatrixUI.
// select_options presence means "render as a dropdown"; its absence
// means free-typed text input. Confirmed per-type axis split:
//   jersey: size only | boots: size x color | others: size only
//   (others' color is identity, fixed per listing — NOT an axis)
const COLLECTION_FIELDS = {
    "jersey": [
        { name: "club", label: "Club / Team", axis: false },
        { name: "edition", label: "Edition", axis: false, select_options: ["Player", "Fan"] },
        { name: "version", label: "Version", axis: false, select_options: ["BD", "BD Premium", "China", "Thai"] },
        { name: "kit_type", label: "Kit Type", axis: false, select_options: ["Home", "Away", "National"] },
        { name: "fabric", label: "Fabric", axis: false },
        { name: "size", label: "Size", axis: true }
    ],
    "boots": [
        { name: "brand", label: "Brand", axis: false },
        { name: "type", label: "Type", axis: false, select_options: ["Sports", "Running", "Casual", "Old Money"] },
        { name: "material", label: "Material", axis: false },
        { name: "size", label: "Size (EU)", axis: true },
        { name: "color", label: "Color", axis: true }
    ],
    "others": [
        { name: "brand", label: "Brand", axis: false },
        { name: "type", label: "Type", axis: false, select_options: ["Strip", "Old Money", "Casual", "Solid Color"] },
        { name: "fabric", label: "Fabric", axis: false },
        { name: "gsm", label: "GSM", axis: false },
        { name: "color", label: "Color", axis: false },
        { name: "size", label: "Size", axis: true }
    ]
};

document.addEventListener("DOMContentLoaded", () => {
    initClock();
    initEventListeners();
    setupExpenseListeners();
    setupGuestLinkListeners();
    setupExpenseFromProductListeners();
    refreshData();
});

// Reads the CSRF token from the hidden input rendered in the form
// (name="csrf_token"). Used for JSON fetch() calls, which — unlike
// the FormData submission in handleProductUpload — don't carry the
// token in the body, so Flask-WTF needs it via the X-CSRFToken header.
function getCsrfToken() {
    return document.querySelector('input[name="csrf_token"]')?.value || '';
}

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

    // Source Type toggle — off = store-owned, on = pre-order. Writes
    // "true"/"false" text into the hidden is_preorder input (read by
    // name in FormData, same pattern as every other identity field)
    // and updates the label so the admin sees which state is active
    // without having to infer it from the switch position alone.
    const preorderToggle = document.getElementById('is_preorder_toggle');
    const preorderInput = document.getElementById('is_preorder_input');
    const preorderLabel = document.getElementById('source-type-label');
    if (preorderToggle && preorderInput && preorderLabel) {
        preorderToggle.addEventListener('change', () => {
            const isPreorder = preorderToggle.checked;
            preorderInput.value = isPreorder ? 'true' : 'false';
            preorderLabel.textContent = isPreorder
                ? 'Pre-Order (sourced after order)'
                : 'Store Owned (in stock now)';
        });
    }

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
            fetchOrders();
        });
    });

    // Order search box — debounced so every keystroke doesn't fire a
    // request; combines with whichever status filter is active (server
    // applies status first, then the search, per Hasan's confirmed
    // "search 6389 within only Transit orders" example).
    const orderSearchInput = document.getElementById('order-search-input');
    if (orderSearchInput) {
        orderSearchInput.addEventListener('input', (e) => {
            clearTimeout(orderSearchDebounceTimer);
            const value = e.target.value;
            orderSearchDebounceTimer = setTimeout(() => {
                activeOrderSearch = value;
                fetchOrders();
            }, 300);
        });
    }
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
    if (tabId === 'wholesale') fetchWholesale();
    if (tabId === 'expenses') fetchExpenses();
    if (tabId === 'fulfill') fetchFulfillment();
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
        const params = new URLSearchParams();
        if (activeOrderSearch) params.set('q', activeOrderSearch);
        if (activeOrderFilter && activeOrderFilter !== 'all') params.set('status', activeOrderFilter);

        const res = await fetch(`/api/admin/orders/search?${params.toString()}`);
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
    // models.py) — a single selection is sent as a 1-element array so
    // product_service.py's existing parsing needs no changes.
    const activeTags = checkedRadio ? [checkedRadio.value] : [];

    const tagsInput = document.getElementById('collection_tags_input');
    if (tagsInput) tagsInput.value = JSON.stringify(activeTags);

    const identityContainer = document.getElementById('identity-fields-container');
    const identityTarget = document.getElementById('identity-inputs');
    const axisContainer = document.getElementById('dynamic-fields-container');
    const axisTarget = document.getElementById('dynamic-inputs');

    if (!identityContainer || !identityTarget || !axisContainer || !axisTarget) return;

    if (activeTags.length === 0) {
        identityContainer.classList.add('hidden');
        identityTarget.innerHTML = '';
        axisContainer.classList.add('hidden');
        axisTarget.innerHTML = '';
        updateMatrixUI();
        return;
    }

    const fields = COLLECTION_FIELDS[activeTags[0]] || [];
    const identityFields = fields.filter(f => !f.axis);
    const axisFields = fields.filter(f => f.axis);

    // Identity fields: plain named inputs (name="fabric", "brand", etc.)
    // — these ride straight through FormData as real column values, NOT
    // through the .variant-axis-input matrix mechanism. select_options
    // renders a dropdown (data-quality only, no server-side enum);
    // otherwise a free-text input.
    identityContainer.classList.remove('hidden');
    identityTarget.innerHTML = identityFields.map(field => {
        if (field.select_options) {
            const optionsHtml = field.select_options.map(opt =>
                `<option value="${opt}">${opt}</option>`
            ).join('');
            return `
                <div>
                    <label class="block text-[9px] uppercase font-bold text-navy/70 mb-1 tracking-widest">${field.label}</label>
                    <select name="${field.name}" class="identity-field input-field !mt-0 !text-xs">
                        <option value="">— Select —</option>
                        ${optionsHtml}
                    </select>
                </div>
            `;
        }
        return `
            <div>
                <label class="block text-[9px] uppercase font-bold text-navy/70 mb-1 tracking-widest">${field.label}</label>
                <input type="text" name="${field.name}" class="identity-field input-field !mt-0 !text-xs" placeholder="${field.label}">
            </div>
        `;
    }).join('');

    // Variant axis fields: unchanged mechanism from v3 — free-typed
    // comma-separated values feeding the SKU matrix generator.
    if (axisFields.length > 0) {
        axisContainer.classList.remove('hidden');
        axisTarget.innerHTML = axisFields.map(field => `
            <div>
                <label class="block text-[9px] uppercase font-bold text-navy/70 mb-1 tracking-widest">${field.label}</label>
                <input type="text" data-axis="${field.name}" class="variant-axis-input input-field !mt-0 !text-xs" placeholder="e.g. Value1, Value2">
            </div>
        `).join('');

        document.querySelectorAll('.variant-axis-input').forEach(input => {
            input.addEventListener('input', updateMatrixUI);
        });
    } else {
        axisContainer.classList.add('hidden');
        axisTarget.innerHTML = '';
    }

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
    // form.reset() correctly restores is_preorder_toggle/is_preorder_input
    // to their HTML defaults (checked / "true"), but the visible label
    // text is plain textContent, not a form value — reset() won't touch
    // it, so it's synced manually here.
    const preorderLabelReset = document.getElementById('source-type-label');
    if (preorderLabelReset) preorderLabelReset.textContent = 'Pre-Order (sourced after order)';
    exitEditMode();
    renderDynamicFields();
    switchTab('edit', document.querySelector('[data-tab="edit"]'));

    const request = isEditing
        ? fetch(`/api/admin/products/${targetId}`, { method: 'PATCH', headers: { 'X-CSRFToken': getCsrfToken() }, body: formData })
        : fetch('/api/admin/products', { method: 'POST', headers: { 'X-CSRFToken': getCsrfToken() }, body: formData });

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
    form.querySelector('[name="category"]').value = prod.category || '';

    // Source Type toggle — populate from the product's own value.
    // Falls back to true (pre-order) if the field is somehow missing,
    // matching Product.is_preorder's DB default.
    const preorderToggle = document.getElementById('is_preorder_toggle');
    const preorderInput = document.getElementById('is_preorder_input');
    const preorderLabel = document.getElementById('source-type-label');
    if (preorderToggle && preorderInput && preorderLabel) {
        const isPreorder = prod.is_preorder !== false;
        preorderToggle.checked = isPreorder;
        preorderInput.value = isPreorder ? 'true' : 'false';
        preorderLabel.textContent = isPreorder
            ? 'Pre-Order (sourced after order)'
            : 'Store Owned (in stock now)';
    }

    const tags = prod.collection_tags || [];
    document.querySelectorAll('.collection-cb').forEach(cb => {
        cb.checked = tags.includes(cb.value);
    });

    // renderDynamicFields() builds the per-type identity/axis inputs
    // fresh (they don't exist in the DOM before a type is selected) —
    // must run before we can populate identity-field values below.
    renderDynamicFields();

    // Identity fields (club, edition, fabric, brand, type, material,
    // color, gsm, etc.) — plain named inputs, populate directly from
    // the product's own columns. Guarded with `?.` since only the
    // fields for this product's type exist in the DOM right now.
    ['club', 'edition', 'version', 'kit_type', 'fabric', 'brand', 'type', 'material', 'color', 'gsm'].forEach(fieldName => {
        const input = form.querySelector(`[name="${fieldName}"]`);
        if (input) input.value = prod[fieldName] ?? '';
    });

    const axes = (prod.variants && prod.variants.axes) || {};
    document.querySelectorAll('.variant-axis-input').forEach(input => {
        const vals = axes[input.dataset.axis];
        if (vals && vals.length) input.value = vals.join(', ');
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
    if (label) label.innerText = 'Add Product';
    const cancelBtn = document.getElementById('cancel-edit-btn');
    if (cancelBtn) cancelBtn.classList.add('hidden');
}

/* ================= TAB 3: ORDERS CRM ================= */

/* Used only for the new customization badge below — name/number are
   free-text customer input reaching an innerHTML template, unlike the
   rest of this file's fields (order/product data, which are either
   server-controlled or constrained dropdown values). Not applied
   elsewhere in this file to keep this change narrowly scoped. */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function renderOrders() {
    const container = document.getElementById('orders-container');
    if (!container) return;
    container.innerHTML = '';

    // allOrders is already exactly what the server matched — fetchOrders()
    // sends activeOrderFilter/activeOrderSearch as query params to
    // /api/admin/orders/search, so no further client-side filtering
    // happens here (filtering twice would be redundant and, for the
    // search case, impossible to replicate correctly client-side since
    // the suffix-priority ranking lives server-side).
    const filtered = allOrders;

    if (filtered.length === 0) {
        const label = activeOrderSearch
            ? `matching "${escapeHtml(activeOrderSearch)}"${activeOrderFilter !== 'all' ? ` under "${activeOrderFilter}"` : ''}`
            : `under "${activeOrderFilter}"`;
        container.innerHTML = `<p class="text-[10px] uppercase font-bold text-gray-400 tracking-widest text-center mt-10">No Orders Found ${label}</p>`;
        return;
    }

    filtered.forEach(order => {
        const itemsHtml = (order.items || []).map(item => {
            const varStr = item.selected_variants && Object.keys(item.selected_variants).length > 0
                ? ` - ${Object.values(item.selected_variants).join(', ')}`
                : '';

            const custom = item.customization || {};
            const customBadge = (custom.name || custom.number) ? `
                <div class="customization-badge mt-1.5 inline-flex gap-2 bg-gold/10 border border-gold/30 rounded px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-navy">
                    ${custom.name ? `<span>NAME: ${escapeHtml(custom.name)}</span>` : ''}
                    ${custom.name && custom.number ? '<span class="text-gold">|</span>' : ''}
                    ${custom.number ? `<span>NUMBER: ${escapeHtml(custom.number)}</span>` : ''}
                </div>
            ` : '';

            return `
                <div class="text-xs font-semibold text-navy/70 mt-2">
                    <div class="flex justify-between">
                        <span>${item.quantity}x ${item.product_name} <span class="text-gold">${varStr}</span></span>
                        <span>৳${(item.price * item.quantity).toFixed(2)}</span>
                    </div>
                    ${customBadge}
                </div>
            `;
        }).join('');

        const card = document.createElement('div');
        card.className = "dash-order-card bg-white rounded-xl border border-navy/10 shadow-sm overflow-hidden";
        card.innerHTML = `
            <button type="button" class="dash-order-toggle w-full flex justify-between items-start p-5 text-left" data-order-id="${order.order_id}" aria-expanded="false">
                <div>
                    <h3 class="font-bold text-sm text-navy uppercase tracking-wider">${escapeHtml(order.customer_name)}</h3>
                    <p class="text-[10px] text-gray-500 font-bold uppercase tracking-widest">ID: ${order.order_id}</p>
                    <p class="text-[10px] text-gray-500 font-black mt-1">৳${(order.total || 0).toFixed(2)}</p>
                </div>
                <div class="flex items-center gap-2">
                    <span class="px-3 py-1 bg-navy text-gold text-[9px] font-bold rounded uppercase tracking-widest">${order.status}</span>
                    <svg class="dash-order-chevron w-3.5 h-3.5 text-navy/40 shrink-0 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>
                </div>
            </button>
            <div class="dash-order-body px-5 pb-5">
                <p class="text-[10px] text-gray-500 font-semibold">${escapeHtml(order.phone || 'No phone')}</p>
                <p class="text-[10px] text-gray-500 font-semibold mb-3">${escapeHtml(order.address || 'No address')}</p>
                <div class="border-y border-navy/10 py-3 mb-3">
                    ${itemsHtml}
                </div>
                <div class="text-[10px] text-gray-500 font-semibold mb-3 space-y-0.5">
                    <div class="flex justify-between"><span>Subtotal</span><span>৳${(order.subtotal || 0).toFixed(2)}</span></div>
                    <div class="flex justify-between"><span>Delivery Charge (${escapeHtml(order.shipping_zone || '')})</span><span>৳${(order.shipping_fee || 0).toFixed(2)}</span></div>
                </div>
                <div class="flex justify-between items-center mb-3">
                    <span class="font-black text-sm text-navy">TOTAL: ৳${(order.total || 0).toFixed(2)}</span>
                    <select data-order-id="${order.order_id}" class="status-select text-[10px] uppercase font-bold tracking-widest border border-navy/20 p-2 rounded bg-gray-50 text-navy cursor-pointer outline-none focus:border-gold">
                        <option value="" disabled selected>Update State</option>
                        ${['Pending', 'Packaged', 'Picked', 'Transit', 'Delivered', 'Failed'].map(s =>
                            `<option value="${s}" ${order.status === s ? 'selected' : ''}>${s}</option>`
                        ).join('')}
                    </select>
                </div>
                <div class="grid grid-cols-2 gap-2 mb-3">
                    <div>
                        <label class="text-[9px] uppercase font-bold text-navy/60 tracking-widest">Delivery Charge (৳)</label>
                        <input type="number" step="0.01" data-order-id="${order.order_id}" class="delivery-fee-input w-full border border-navy/20 rounded-lg p-2 text-xs outline-none focus:border-gold" value="${order.shipping_fee ?? ''}">
                    </div>
                    <div>
                        <label class="text-[9px] uppercase font-bold text-navy/60 tracking-widest">Payment Type</label>
                        <select data-order-id="${order.order_id}" class="delivery-ptype-select w-full border border-navy/20 rounded-lg p-2 text-xs bg-white outline-none focus:border-gold">
                            <option value="postpaid" ${order.payment_type === 'postpaid' ? 'selected' : ''}>Postpaid (+)</option>
                            <option value="prepaid" ${order.payment_type === 'prepaid' ? 'selected' : ''}>Prepaid</option>
                            <option value="included" ${order.payment_type === 'included' ? 'selected' : ''}>Included (-)</option>
                        </select>
                    </div>
                    <button data-order-id="${order.order_id}" class="delivery-save col-span-2 bg-navy text-gold text-[9px] font-bold uppercase tracking-widest px-3 py-2 rounded-lg">Save Delivery Charge</button>
                </div>
                <div class="flex gap-2 items-center">
                    <input type="text" data-order-id="${order.order_id}" class="tracking-link-input flex-1 text-[10px] border border-navy/20 rounded-lg p-2 outline-none focus:border-gold" placeholder="Tracking link (paste courier URL)" value="${escapeHtml(order.tracking_link || '')}">
                    <button data-order-id="${order.order_id}" class="tracking-link-save shrink-0 bg-navy text-gold text-[9px] font-bold uppercase tracking-widest px-3 py-2 rounded-lg">Save</button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });

    // Expand/collapse — collapsed by default, one click toggles this
    // card only (independent, not accordion-style), matching the
    // customer-facing orders.html pattern.
    document.querySelectorAll('.dash-order-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const card = e.currentTarget.closest('.dash-order-card');
            const isExpanded = card.classList.toggle('expanded');
            e.currentTarget.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        });
    });

    // Attach listeners to dynamic status dropdowns
    document.querySelectorAll('.status-select').forEach(select => {
        select.addEventListener('change', (e) => {
            updateOrderStatus(e.target.dataset.orderId, e.target.value);
        });
    });

    // Attach listeners to tracking-link save buttons
    document.querySelectorAll('.tracking-link-save').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const orderId = e.currentTarget.dataset.orderId;
            const input = document.querySelector(`.tracking-link-input[data-order-id="${orderId}"]`);
            updateOrderTrackingLink(orderId, input ? input.value : '');
        });
    });

    // Attach listeners to delivery-charge/payment-type save buttons
    document.querySelectorAll('.delivery-save').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const orderId = e.currentTarget.dataset.orderId;
            const feeInput = document.querySelector(`.delivery-fee-input[data-order-id="${orderId}"]`);
            const ptypeSelect = document.querySelector(`.delivery-ptype-select[data-order-id="${orderId}"]`);
            updateOrderDelivery(orderId, feeInput ? feeInput.value : null, ptypeSelect ? ptypeSelect.value : null);
        });
    });
}

async function updateOrderDelivery(orderId, shippingFee, paymentType) {
    try {
        const body = {};
        if (shippingFee !== null && shippingFee !== '') body.shipping_fee = shippingFee;
        if (paymentType !== null) body.payment_type = paymentType;

        const res = await fetch(`/api/admin/orders/${orderId}/delivery`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrfToken() },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            showToast('Delivery charge updated', true);
            // Server recalculates total — refetch this order's slice so
            // the card's TOTAL/subtotal breakdown reflects the new value
            // without a full page reload.
            const idx = allOrders.findIndex(o => o.order_id === orderId);
            if (idx !== -1) allOrders[idx] = data.data;
            renderOrders();
        } else {
            showToast(`Failed to update: ${data.message}`, false);
        }
    } catch (err) {
        showToast(`Error: ${err.message}`, false);
    }
}

async function updateOrderTrackingLink(orderId, trackingLink) {
    try {
        const res = await fetch(`/api/admin/orders/${orderId}/tracking`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrfToken() },
            body: JSON.stringify({ tracking_link: trackingLink })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            showToast('Tracking link saved', true);
            // Update in-memory copy so a re-render (e.g. switching tabs
            // and back) doesn't show stale data without a full refetch.
            const order = allOrders.find(o => o.order_id === orderId);
            if (order) order.tracking_link = trackingLink;
        } else {
            showToast(`Failed to save tracking link: ${data.message}`, false);
        }
    } catch (err) {
        showToast(`Error saving tracking link: ${err.message}`, false);
    }
}

async function updateOrderStatus(orderId, newStatus) {
    try {
        const res = await fetch(`/api/admin/orders/${orderId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrfToken() },
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
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrfToken() },
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

/* ================= TAB 5: WHOLESALE ================= */

let allWholesale = [];

async function fetchWholesale() {
    try {
        const res = await fetch('/api/admin/wholesale');
        const result = await res.json();
        if (result.status === 'success') {
            allWholesale = result.data || [];
            renderWholesale();
        }
    } catch (err) {
        console.error("Failed to fetch wholesale data:", err);
    }
}

function renderWholesale() {
    const container = document.getElementById('wholesale-container');
    if (!container) return;
    container.innerHTML = '';

    if (allWholesale.length === 0) {
        container.innerHTML = `<p class="text-[10px] uppercase font-bold text-gray-400 tracking-widest text-center mt-10">No Products Yet</p>`;
        return;
    }

    allWholesale.forEach(row => {
        const card = document.createElement('div');
        card.className = "wholesale-row-card bg-white rounded-xl border border-navy/10 shadow-sm overflow-hidden";
        card.innerHTML = `
            <button type="button" class="wholesale-row-toggle w-full flex items-center gap-3 p-4 text-left" data-product-id="${row.product_id}" aria-expanded="false">
                <img src="${escapeHtml(row.product_image || '')}" class="w-12 h-12 rounded-lg object-cover bg-gray-100 shrink-0" onerror="this.style.visibility='hidden'">
                <div class="min-w-0 flex-1">
                    <h3 class="font-bold text-sm text-navy uppercase tracking-wider truncate">${escapeHtml(row.product_name || 'Untitled Product')}</h3>
                    <p class="text-[10px] text-gray-400 font-bold uppercase tracking-widest">Product #${row.product_id} · Profit: <span class="text-navy">${row.profit != null ? '৳' + row.profit.toFixed(2) : '—'}</span></p>
                </div>
                <svg class="wholesale-row-chevron w-3.5 h-3.5 text-navy/40 shrink-0 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>
            </button>
            <div class="wholesale-row-body px-4 pb-4">
                <div class="grid grid-cols-2 gap-2">
                    <div>
                        <label class="text-[9px] uppercase font-bold text-navy/60 tracking-widest">Jersey Name</label>
                        <input type="text" data-field="jersey_name" data-product-id="${row.product_id}" class="wholesale-input w-full border border-navy/20 rounded-lg p-2 text-xs outline-none focus:border-gold" value="${escapeHtml(row.jersey_name || '')}">
                    </div>
                    <div>
                        <label class="text-[9px] uppercase font-bold text-navy/60 tracking-widest">Wholesaler</label>
                        <input type="text" data-field="wholesaler" data-product-id="${row.product_id}" class="wholesale-input w-full border border-navy/20 rounded-lg p-2 text-xs outline-none focus:border-gold" value="${escapeHtml(row.wholesaler || '')}">
                    </div>
                    <div>
                        <label class="text-[9px] uppercase font-bold text-navy/60 tracking-widest">Wholesale Price (৳)</label>
                        <input type="number" step="0.01" data-field="wholesale_price" data-product-id="${row.product_id}" class="wholesale-input w-full border border-navy/20 rounded-lg p-2 text-xs outline-none focus:border-gold" value="${row.wholesale_price ?? ''}">
                    </div>
                    <div>
                        <label class="text-[9px] uppercase font-bold text-navy/60 tracking-widest">Retail Price (৳)</label>
                        <input type="number" step="0.01" data-field="retail_price" data-product-id="${row.product_id}" class="wholesale-input w-full border border-navy/20 rounded-lg p-2 text-xs outline-none focus:border-gold" value="${row.retail_price ?? ''}">
                    </div>
                </div>
                <div class="flex justify-between items-center mt-3 pt-3 border-t border-navy/10">
                    <span class="text-[10px] uppercase font-bold text-navy/60 tracking-widest">Profit: <span class="text-navy font-black">${row.profit != null ? '৳' + row.profit.toFixed(2) : '—'}</span></span>
                    <button data-product-id="${row.product_id}" class="wholesale-save bg-navy text-gold text-[9px] font-bold uppercase tracking-widest px-4 py-2 rounded-full">Save</button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });

    // Expand/collapse — collapsed by default, one click toggles this
    // card only (independent, not accordion-style).
    document.querySelectorAll('.wholesale-row-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const card = e.currentTarget.closest('.wholesale-row-card');
            const isExpanded = card.classList.toggle('expanded');
            e.currentTarget.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        });
    });

    document.querySelectorAll('.wholesale-save').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const productId = e.currentTarget.dataset.productId;
            saveWholesaleRow(productId);
        });
    });
}

async function saveWholesaleRow(productId) {
    const inputs = document.querySelectorAll(`.wholesale-input[data-product-id="${productId}"]`);
    const payload = {};
    inputs.forEach(input => {
        payload[input.dataset.field] = input.value;
    });

    try {
        const res = await fetch(`/api/admin/wholesale/${productId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrfToken() },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            showToast('Wholesale data saved', true);
            const idx = allWholesale.findIndex(r => r.product_id == productId);
            if (idx !== -1) allWholesale[idx] = data.data;
            renderWholesale();
        } else {
            showToast(`Failed to save: ${data.message}`, false);
        }
    } catch (err) {
        showToast(`Error: ${err.message}`, false);
    }
}

/* ================= TAB 6: EXPENSES ================= */

let allExpenses = [];

async function fetchExpenses() {
    try {
        const res = await fetch('/api/admin/expenses');
        const result = await res.json();
        if (result.status === 'success') {
            allExpenses = result.data || [];
            renderExpenses();
        }
    } catch (err) {
        console.error("Failed to fetch expenses:", err);
    }
}

function renderExpenses() {
    const container = document.getElementById('expenses-container');
    const totalEl = document.getElementById('expense-total-amount');
    if (!container) return;
    container.innerHTML = '';

    const total = allExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);
    if (totalEl) totalEl.textContent = `৳${total.toFixed(2)}`;

    if (allExpenses.length === 0) {
        container.innerHTML = `<p class="text-[10px] uppercase font-bold text-gray-400 tracking-widest text-center mt-10">No Expenses Logged</p>`;
        return;
    }

    allExpenses.forEach(expense => {
        const card = document.createElement('div');
        card.className = "bg-white p-4 rounded-xl border border-navy/10 shadow-sm flex items-center gap-3";
        card.innerHTML = `
            ${expense.receipt_image
                ? `<img src="${escapeHtml(expense.receipt_image)}" class="w-12 h-12 rounded-lg object-cover bg-gray-100 shrink-0">`
                : `<div class="w-12 h-12 rounded-lg bg-gray-100 shrink-0 flex items-center justify-center text-gray-300"><i class="fa-solid fa-receipt"></i></div>`
            }
            <div class="flex-1 min-w-0">
                <p class="font-bold text-sm text-navy truncate">${escapeHtml(expense.description)}</p>
                <p class="text-[10px] text-gray-400 font-bold uppercase tracking-widest">${escapeHtml(expense.date)}</p>
            </div>
            <div class="text-right shrink-0">
                <p class="font-black text-sm text-navy">৳${(expense.amount || 0).toFixed(2)}</p>
                <div class="flex gap-2 mt-1">
                    <button data-expense-id="${expense.id}" class="expense-edit-btn text-[9px] uppercase font-bold text-navy/50 tracking-widest">Edit</button>
                    <button data-expense-id="${expense.id}" class="expense-delete-btn text-[9px] uppercase font-bold text-red-500 tracking-widest">Delete</button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });

    document.querySelectorAll('.expense-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => openExpenseModal(e.currentTarget.dataset.expenseId));
    });
    document.querySelectorAll('.expense-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => deleteExpense(e.currentTarget.dataset.expenseId));
    });
}

function openExpenseModal(expenseId) {
    const modal = document.getElementById('expense-modal');
    const idInput = document.getElementById('expense-id');
    const dateInput = document.getElementById('expense-date');
    const descInput = document.getElementById('expense-description');
    const amountInput = document.getElementById('expense-amount');
    const receiptInput = document.getElementById('expense-receipt');
    if (!modal) return;

    if (expenseId) {
        const expense = allExpenses.find(e => e.id == expenseId);
        if (expense) {
            idInput.value = expense.id;
            dateInput.value = expense.date;
            descInput.value = expense.description;
            amountInput.value = expense.amount;
        }
    } else {
        idInput.value = '';
        dateInput.value = new Date().toISOString().slice(0, 10);
        descInput.value = '';
        amountInput.value = '';
    }
    receiptInput.value = '';
    modal.classList.remove('hidden');
}

function closeExpenseModal() {
    const modal = document.getElementById('expense-modal');
    if (modal) modal.classList.add('hidden');
}

async function deleteExpense(expenseId) {
    if (!confirm('Delete this expense?')) return;
    try {
        const res = await fetch(`/api/admin/expenses/${expenseId}`, {
            method: 'DELETE',
            headers: { 'X-CSRFToken': getCsrfToken() }
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            showToast('Expense deleted', true);
            fetchExpenses();
        } else {
            showToast(`Failed to delete: ${data.message}`, false);
        }
    } catch (err) {
        showToast(`Error: ${err.message}`, false);
    }
}

function setupExpenseListeners() {
    const addBtn = document.getElementById('add-expense-btn');
    const cancelBtn = document.getElementById('expense-cancel-btn');
    const form = document.getElementById('expense-form');

    if (addBtn) addBtn.addEventListener('click', () => openExpenseModal(null));
    if (cancelBtn) cancelBtn.addEventListener('click', closeExpenseModal);

    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            const expenseId = document.getElementById('expense-id').value;
            const formData = new FormData();
            formData.append('date', document.getElementById('expense-date').value);
            formData.append('description', document.getElementById('expense-description').value);
            formData.append('amount', document.getElementById('expense-amount').value);
            const receiptFile = document.getElementById('expense-receipt').files[0];
            if (receiptFile) formData.append('receipt_image', receiptFile);

            const url = expenseId ? `/api/admin/expenses/${expenseId}` : '/api/admin/expenses';
            const method = expenseId ? 'PATCH' : 'POST';

            try {
                const res = await fetch(url, {
                    method,
                    headers: { 'X-CSRFToken': getCsrfToken() },
                    body: formData
                });
                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    showToast('Expense saved', true);
                    closeExpenseModal();
                    fetchExpenses();
                } else {
                    showToast(`Failed to save: ${data.message}`, false);
                }
            } catch (err) {
                showToast(`Error: ${err.message}`, false);
            }
        });
    }
}










/* ================= TAB 7: ORDERS TO FULFILL ================= */

let allFulfillment = [];

async function fetchFulfillment() {
    try {
        const res = await fetch('/api/admin/fulfillment');
        const result = await res.json();
        if (result.status === 'success') {
            allFulfillment = result.data || [];
            renderFulfillment();
        }
    } catch (err) {
        console.error("Failed to fetch fulfillment summary:", err);
    }
}

function renderFulfillment() {
    const container = document.getElementById('fulfill-container');
    if (!container) return;
    container.innerHTML = '';

    if (allFulfillment.length === 0) {
        container.innerHTML = `<p class="text-[10px] uppercase font-bold text-gray-400 tracking-widest text-center mt-10">Nothing to Fulfill</p>`;
        return;
    }

    allFulfillment.forEach(entry => {
        const card = document.createElement('div');
        card.className = "fulfill-product-card bg-white rounded-xl border border-navy/10 shadow-sm overflow-hidden";
        card.innerHTML = `
            <button type="button" class="fulfill-product-toggle w-full flex items-center gap-3 p-4 text-left" data-product-id="${entry.product_id}" aria-expanded="false">
                <img src="${escapeHtml(entry.product_image || '')}" class="w-12 h-12 rounded-lg object-cover bg-gray-100 shrink-0" onerror="this.style.visibility='hidden'">
                <div class="min-w-0 flex-1">
                    <h3 class="font-bold text-sm text-navy uppercase tracking-wider truncate">${escapeHtml(entry.product_name || 'Untitled Product')}</h3>
                    <p class="text-[10px] text-gray-400 font-bold uppercase tracking-widest">Sold ${entry.total_remaining}</p>
                </div>
                <svg class="fulfill-chevron w-3.5 h-3.5 text-navy/40 shrink-0 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>
            </button>
            <div class="fulfill-product-body px-4 pb-4 space-y-2">
                ${entry.sizes.map(s => `
                    <div class="flex justify-between items-center bg-gray-50 rounded-lg p-2.5" data-fulfill-size-row="${entry.product_id}:${escapeHtml(s.size || '')}">
                        <span class="text-xs font-bold text-navy">${s.size ? escapeHtml(s.size) : 'No Size'}</span>
                        <div class="flex items-center gap-3">
                            <span class="text-[10px] text-gray-500 font-semibold">${s.remaining} remaining (${s.checked_off}/${s.needed} checked)</span>
                            <button type="button" data-product-id="${entry.product_id}" data-size="${escapeHtml(s.size || '')}" class="fulfill-checkoff-btn w-6 h-6 shrink-0 flex items-center justify-center rounded-full bg-navy text-gold text-xs font-black">×</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
        container.appendChild(card);
    });

    document.querySelectorAll('.fulfill-product-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const card = e.currentTarget.closest('.fulfill-product-card');
            const isExpanded = card.classList.toggle('expanded');
            e.currentTarget.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        });
    });

    document.querySelectorAll('.fulfill-checkoff-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation(); // don't also toggle the parent card's expand state
            const productId = e.currentTarget.dataset.productId;
            const size = e.currentTarget.dataset.size;
            checkoffFulfillmentItem(productId, size);
        });
    });
}

async function checkoffFulfillmentItem(productId, size) {
    try {
        const res = await fetch('/api/admin/fulfillment/checkoff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrfToken() },
            body: JSON.stringify({ product_id: productId, size: size || null })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            // Re-fetch rather than patch in-memory — a line might now be
            // fully accounted for and needs to disappear entirely, which
            // the server (not this client) decides via get_fulfillment_summary.
            fetchFulfillment();
        } else {
            showToast(`Failed to check off: ${data.message}`, false);
        }
    } catch (err) {
        showToast(`Error: ${err.message}`, false);
    }
}

/* ================= GUEST ORDER LINKS (inside Orders tab) ================= */

let allGuestLinks = [];
let guestLinkSelectedProduct = null;

function setupGuestLinkListeners() {
    const openPanelBtn = document.getElementById('open-guest-link-modal-btn');
    const closePanelBtn = document.getElementById('close-guest-links-panel-btn');
    const panel = document.getElementById('guest-links-panel');

    const modal = document.getElementById('guest-link-modal');
    const searchStep = document.getElementById('guest-link-step-search');
    const searchInput = document.getElementById('guest-link-product-search-input');
    const resultsContainer = document.getElementById('guest-link-product-search-results');
    const cancelBtn = document.getElementById('guest-link-cancel-btn');
    const form = document.getElementById('guest-link-form');
    const backBtn = document.getElementById('guest-link-back-btn');
    const resultStep = document.getElementById('guest-link-result');
    const resultUrlInput = document.getElementById('guest-link-result-url');
    const copyBtn = document.getElementById('guest-link-copy-btn');
    const doneBtn = document.getElementById('guest-link-done-btn');

    if (!openPanelBtn) return;

    // "Guest Link" button opens the GENERATE modal directly — the panel
    // (list of past links) is a separate toggle, shown once at least
    // one link exists or the admin explicitly wants to see the list.
    openPanelBtn.addEventListener('click', () => {
        resetGuestLinkModal();
        modal.classList.remove('hidden');
        fetchGuestLinks(); // keep the panel's list fresh whenever the modal is opened
    });

    if (closePanelBtn) closePanelBtn.addEventListener('click', () => panel.classList.add('hidden'));

    function resetGuestLinkModal() {
        searchStep.classList.remove('hidden');
        form.classList.add('hidden');
        resultStep.classList.add('hidden');
        searchInput.value = '';
        resultsContainer.innerHTML = '';
        guestLinkSelectedProduct = null;
    }

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        if (!query) { resultsContainer.innerHTML = ''; return; }
        const matches = allProducts.filter(p => (p.name || '').toLowerCase().includes(query)).slice(0, 8);
        resultsContainer.innerHTML = matches.map(p => `
            <button type="button" data-product-id="${p.id}" class="guest-link-product-pick w-full flex items-center gap-3 p-2 rounded-lg border border-navy/10 hover:border-gold text-left">
                <img src="${escapeHtml(p.image || '')}" class="w-9 h-9 rounded-lg object-cover bg-gray-100 shrink-0" onerror="this.style.visibility='hidden'">
                <span class="text-xs font-bold text-navy truncate">${escapeHtml(p.name)}</span>
            </button>
        `).join('') || `<p class="text-[10px] text-gray-400 text-center py-4">No matches</p>`;

        resultsContainer.querySelectorAll('.guest-link-product-pick').forEach(btn => {
            btn.addEventListener('click', () => {
                const product = allProducts.find(p => p.id == btn.dataset.productId);
                if (!product) return;
                guestLinkSelectedProduct = product;
                document.getElementById('guest-link-product-id').value = product.id;
                document.getElementById('guest-link-product-image').src = product.image || '';
                document.getElementById('guest-link-product-name').textContent = product.name;
                searchStep.classList.add('hidden');
                form.classList.remove('hidden');
            });
        });
    });

    if (cancelBtn) cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));
    if (backBtn) backBtn.addEventListener('click', () => {
        form.classList.add('hidden');
        searchStep.classList.remove('hidden');
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = {
            product_id: document.getElementById('guest-link-product-id').value,
            payment_method: document.getElementById('guest-link-payment-method').value,
            shipping_zone: document.getElementById('guest-link-shipping-zone').value,
            payment_type: document.getElementById('guest-link-payment-type').value,
        };
        try {
            const res = await fetch('/api/admin/guest-links', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrfToken() },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                const url = `${window.location.origin}/order-link/${data.data.token}`;
                resultUrlInput.value = url;
                form.classList.add('hidden');
                resultStep.classList.remove('hidden');
                fetchGuestLinks();
            } else {
                showToast(`Failed to generate link: ${data.message}`, false);
            }
        } catch (err) {
            showToast(`Error: ${err.message}`, false);
        }
    });

    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            resultUrlInput.select();
            navigator.clipboard?.writeText(resultUrlInput.value);
            showToast('Link copied', true);
        });
    }

    if (doneBtn) doneBtn.addEventListener('click', () => modal.classList.add('hidden'));
}

async function fetchGuestLinks() {
    try {
        const res = await fetch('/api/admin/guest-links');
        const result = await res.json();
        if (result.status === 'success') {
            allGuestLinks = result.data || [];
            renderGuestLinks();
        }
    } catch (err) {
        console.error("Failed to fetch guest links:", err);
    }
}

function renderGuestLinks() {
    const panel = document.getElementById('guest-links-panel');
    const list = document.getElementById('guest-links-list');
    if (!panel || !list) return;

    if (allGuestLinks.length === 0) {
        panel.classList.add('hidden');
        return;
    }
    panel.classList.remove('hidden');

    list.innerHTML = allGuestLinks.map(link => {
        let statusLabel, statusClass;
        if (link.is_used) { statusLabel = 'Used'; statusClass = 'bg-gray-100 text-gray-500'; }
        else if (link.is_expired) { statusLabel = 'Expired'; statusClass = 'bg-red-50 text-red-500'; }
        else { statusLabel = 'Active'; statusClass = 'bg-green-50 text-green-600'; }

        const url = `${window.location.origin}/order-link/${link.token}`;
        const canCopy = !link.is_used && !link.is_expired;

        return `
            <div class="flex items-center justify-between p-3">
                <div class="min-w-0">
                    <p class="text-xs font-bold text-navy truncate">${escapeHtml(link.product_name || 'Unknown Product')}</p>
                    <span class="inline-block mt-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest ${statusClass}">${statusLabel}</span>
                </div>
                ${canCopy
                    ? `<button type="button" data-url="${escapeHtml(url)}" class="guest-link-list-copy shrink-0 bg-navy text-gold text-[9px] font-bold uppercase tracking-widest px-3 py-2 rounded-lg">Copy</button>`
                    : ''
                }
            </div>
        `;
    }).join('');

    list.querySelectorAll('.guest-link-list-copy').forEach(btn => {
        btn.addEventListener('click', (e) => {
            navigator.clipboard?.writeText(e.currentTarget.dataset.url);
            showToast('Link copied', true);
        });
    });
}

/* ================= EXPENSE FROM PRODUCT (inside Expenses tab) ================= */

function setupExpenseFromProductListeners() {
    const openBtn = document.getElementById('add-expense-from-product-btn');
    const modal = document.getElementById('expense-product-modal');
    const searchStep = document.getElementById('expense-product-step-search');
    const searchInput = document.getElementById('expense-product-search-input');
    const resultsContainer = document.getElementById('expense-product-search-results');
    const cancelBtn = document.getElementById('expense-product-cancel-btn');
    const form = document.getElementById('expense-product-form');
    const backBtn = document.getElementById('expense-product-back-btn');
    const quantityInput = document.getElementById('expense-product-quantity');
    const priceInput = document.getElementById('expense-product-price');
    const totalPreview = document.getElementById('expense-product-total-preview');

    if (!openBtn) return;

    function resetModal() {
        searchStep.classList.remove('hidden');
        form.classList.add('hidden');
        searchInput.value = '';
        resultsContainer.innerHTML = '';
    }

    function updateTotalPreview() {
        const qty = parseFloat(quantityInput.value) || 0;
        const price = parseFloat(priceInput.value) || 0;
        totalPreview.textContent = `৳${(qty * price).toFixed(2)}`;
    }

    openBtn.addEventListener('click', () => {
        resetModal();
        modal.classList.remove('hidden');
    });

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        if (!query) { resultsContainer.innerHTML = ''; return; }
        const matches = allProducts.filter(p => (p.name || '').toLowerCase().includes(query)).slice(0, 8);
        resultsContainer.innerHTML = matches.map(p => `
            <button type="button" data-product-id="${p.id}" class="expense-product-pick w-full flex items-center gap-3 p-2 rounded-lg border border-navy/10 hover:border-gold text-left">
                <img src="${escapeHtml(p.image || '')}" class="w-9 h-9 rounded-lg object-cover bg-gray-100 shrink-0" onerror="this.style.visibility='hidden'">
                <span class="text-xs font-bold text-navy truncate">${escapeHtml(p.name)}</span>
            </button>
        `).join('') || `<p class="text-[10px] text-gray-400 text-center py-4">No matches</p>`;

        resultsContainer.querySelectorAll('.expense-product-pick').forEach(btn => {
            btn.addEventListener('click', async () => {
                const product = allProducts.find(p => p.id == btn.dataset.productId);
                if (!product) return;

                document.getElementById('expense-product-id').value = product.id;
                document.getElementById('expense-product-image').src = product.image || '';
                document.getElementById('expense-product-name').textContent = product.name;
                document.getElementById('expense-product-date').value = new Date().toISOString().slice(0, 10);
                quantityInput.value = 1;

                // Prefill price from this product's wholesale_price —
                // fetched fresh (not from allProducts, which never
                // carries wholesale data — see models/product.py's
                // to_dict, which deliberately excludes it).
                try {
                    const res = await fetch(`/api/admin/wholesale/${product.id}`);
                    const data = await res.json();
                    priceInput.value = (data.status === 'success' && data.data.wholesale_price != null)
                        ? data.data.wholesale_price
                        : '';
                } catch (err) {
                    priceInput.value = '';
                }
                updateTotalPreview();

                searchStep.classList.add('hidden');
                form.classList.remove('hidden');
            });
        });
    });

    quantityInput.addEventListener('input', updateTotalPreview);
    priceInput.addEventListener('input', updateTotalPreview);

    if (cancelBtn) cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));
    if (backBtn) backBtn.addEventListener('click', () => {
        form.classList.add('hidden');
        searchStep.classList.remove('hidden');
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const product = allProducts.find(p => p.id == document.getElementById('expense-product-id').value);
        const qty = parseFloat(quantityInput.value) || 0;
        const price = parseFloat(priceInput.value) || 0;
        const totalAmount = qty * price;

        const formData = new FormData();
        formData.append('date', document.getElementById('expense-product-date').value);
        formData.append('description', `${product ? product.name : 'Product'} × ${qty}`);
        formData.append('amount', totalAmount);

        try {
            const res = await fetch('/api/admin/expenses', {
                method: 'POST',
                headers: { 'X-CSRFToken': getCsrfToken() },
                body: formData
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                showToast('Expense added', true);
                modal.classList.add('hidden');
                fetchExpenses();
            } else {
                showToast(`Failed to save: ${data.message}`, false);
            }
        } catch (err) {
            showToast(`Error: ${err.message}`, false);
        }
    });
}

