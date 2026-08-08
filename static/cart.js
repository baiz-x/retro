/**
 * Markazus Sunnah | Shopping Bag & Logic
 * Fixed: Language toggle integration and persistent state
 */

const API_BASE = '/api/cart';
const DOM = {
    container: document.getElementById('cart-container'),
    summary: document.getElementById('cart-summary'),
    emptyState: document.getElementById('empty-state'),
    subtotalEl: document.getElementById('subtotal-price'),
    shippingEl: document.getElementById('shipping-cost'),
    discountRow: document.getElementById('discount-row'),
    discountEl: document.getElementById('discount-amount'),
    grandTotalEl: document.getElementById('grand-total'),
    countHeader: document.getElementById('cart-count-header'),
    freeBadge: document.getElementById('free-delivery-badge'),
    options: document.getElementById('cart-options'),
    clearBtn: document.getElementById('clear-btn'),
    checkoutBtn: document.getElementById('checkout-btn'),
    langToggle: document.getElementById('lang-toggle')
};

let currentCartData = null;

document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

async function initApp() {
    // Initialize Language
    const savedLang = localStorage.getItem('site_lang') || 'en';
    applyLanguage(savedLang);

    if (DOM.langToggle) {
        DOM.langToggle.addEventListener('click', () => {
            const newLang = document.body.classList.contains('lang-bn') ? 'en' : 'bn';
            applyLanguage(newLang);
        });
    }

    await fetchCart();

    document.addEventListener('click', (e) => {
        const toggleBtn = e.target.closest('.drawer-toggle-btn');
        if (toggleBtn) {
            const item = toggleBtn.closest('.drawer-item');
            item.classList.toggle('active');
        }
    });

    if (DOM.container) {
        DOM.container.addEventListener('click', (e) => {
            const removeBtn = e.target.closest('.remove-item-btn');
            if (removeBtn) {
                const id = removeBtn.getAttribute('data-id');
                const size = removeBtn.getAttribute('data-size');
                removeItem(id, size);
            }
        });
    }

    document.querySelectorAll('.shipping-radio').forEach(radio => {
        radio.addEventListener('change', () => {
            if (currentCartData) calculateTotals(currentCartData);
        });
    });

    if (DOM.clearBtn) DOM.clearBtn.addEventListener('click', handleClearCart);
    if (DOM.checkoutBtn) DOM.checkoutBtn.addEventListener('click', navigateToCheckout);
}

async function fetchCart() {
    try {
        const response = await fetch(API_BASE);
        const result = await response.json();
        if (result.status === 'success') {
            currentCartData = result.data;
            renderCart(result.data);
            // Re-apply language after rendering dynamic items
            const currentLang = localStorage.getItem('site_lang') || 'en';
            applyLanguage(currentLang);
        }
    } catch (err) { console.error("Cart fetch failed:", err); }
}

function renderCart(cartData) {
    if (!cartData.items || cartData.items.length === 0) {
        DOM.container.innerHTML = '';
        DOM.emptyState.classList.remove('hidden');
        DOM.summary.classList.add('hidden');
        DOM.options.classList.add('hidden');
        DOM.countHeader.innerText = "0 Items";
        return;
    }

    DOM.emptyState.classList.add('hidden');
    DOM.summary.classList.remove('hidden');
    DOM.options.classList.remove('hidden');
    DOM.countHeader.innerText = `${cartData.total_items} Items`;

    DOM.container.innerHTML = cartData.items.map(item => `
        <div class="cart-card bg-white p-6 rounded-3xl border border-gray-100 flex items-center gap-6 shadow-sm">
            <div class="w-24 h-24 flex-shrink-0 rounded-2xl overflow-hidden bg-gray-50 border border-gray-50">
                <img src="${item.image || 'https://placehold.co/150'}" class="w-full h-full object-cover">
            </div>
            <div class="flex-1">
                <div class="flex justify-between items-start">
                    <div>
                        <h3 class="heading-font font-bold text-sm uppercase tracking-tight text-gray-900">${item.product_name}</h3>
                        <div class="mt-2 inline-flex items-center px-2.5 py-0.5 rounded-full bg-khaki/40 text-gray-700 text-[9px] font-bold uppercase tracking-wider border border-khaki/50">
                            <span data-bn="সাইজ:">Size:</span> ${item.size}
                        </div>
                    </div>
                    <button class="remove-item-btn text-gray-300 hover:text-red-500 transition-colors p-1"
                            data-id="${item.product_id}" data-size="${item.size}">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </div>
                <div class="flex justify-between items-end mt-4">
                    <div class="flex flex-col">
                        <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1" data-bn="পরিমাণ">Quantity</span>
                        <span class="text-sm font-bold text-gray-900">${item.quantity}</span>
                    </div>
                    <div class="text-right">
                        <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest block mb-1" data-bn="উপমোট">Subtotal</span>
                        <span class="font-black heading-font text-black text-lg">৳${item.subtotal.toLocaleString()}</span>
                    </div>
                </div>
            </div>
        </div>
    `).join('');

    calculateTotals(cartData);
}

function calculateTotals(cartData) {
    const subtotal = parseFloat(cartData.total_price);
    const shipping = getSelectedShippingValue();
    let finalTotal = subtotal + shipping;

    if (subtotal > 1500) {
        finalTotal = subtotal;
        DOM.freeBadge.classList.remove('hidden');
        DOM.discountRow.classList.remove('hidden');
        DOM.discountEl.innerText = `-৳${shipping.toFixed(2)}`;
        DOM.shippingEl.classList.add('text-gray-400', 'line-through');
    } else {
        DOM.freeBadge.classList.add('hidden');
        DOM.discountRow.classList.add('hidden');
        DOM.shippingEl.classList.remove('text-gray-400', 'line-through');
    }

    DOM.subtotalEl.innerText = `৳${subtotal.toLocaleString()}`;
    DOM.shippingEl.innerText = `৳${shipping.toFixed(2)}`;
    DOM.grandTotalEl.innerText = `৳${finalTotal.toLocaleString()}`;
}

function getSelectedShippingValue() {
    const selected = document.querySelector('input[name="shipping"]:checked');
    return selected ? parseFloat(selected.value) : 60;
}

async function removeItem(id, size) {
    const response = await fetch(`${API_BASE}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: id, size: size })
    });
    const result = await response.json();
    if (result.status === 'success') {
        currentCartData = result.data;
        renderCart(result.data);
        const currentLang = localStorage.getItem('site_lang') || 'en';
        applyLanguage(currentLang);
    }
}

async function handleClearCart() {
    const msg = document.body.classList.contains('lang-bn') ? "ব্যাগ খালি করবেন?" : "Clear bag?";
    if (!confirm(msg)) return;
    const response = await fetch(`${API_BASE}/clear`, { method: 'POST' });
    if (response.ok) fetchCart();
}

function navigateToCheckout() {
    if (!currentCartData || currentCartData.items.length === 0) return;
    window.location.href = '/checkout';
}

function applyLanguage(lang) {
    document.body.classList.toggle('lang-bn', lang === 'bn');
    document.querySelectorAll('[data-bn]').forEach(el => {
        if (!el.dataset.en) el.dataset.en = el.innerHTML;
        el.innerHTML = lang === 'bn' ? el.dataset.bn : el.dataset.en;
    });
    if (DOM.langToggle) DOM.langToggle.textContent = lang === 'bn' ? 'EN' : 'BN';
    localStorage.setItem('site_lang', lang);
}
