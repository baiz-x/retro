const API_BASE = '/api';

function csrfFetch(url, options = {}) {
  const token = document.querySelector('meta[name="csrf-token"]').content;
  options.headers = { ...(options.headers || {}), 'X-CSRFToken': token };
  return fetch(url, options);
}

const checkoutForm = document.getElementById('checkoutForm');
const submitBtn = document.getElementById('submitBtn');
const submitLabel = document.getElementById('submitLabel');
const statusContainer = document.getElementById('statusContainer');
const checkoutWrapper = document.getElementById('checkoutWrapper');
const guestBanner = document.getElementById('guestBanner');

const orderItemsList = document.getElementById('orderItemsList');
const orderSubtotalEl = document.getElementById('orderSubtotal');
const orderGrandTotalEl = document.getElementById('orderGrandTotal');
const paymentNumberLabel = document.getElementById('paymentNumberLabel');
const phoneInput = document.getElementById('phone');
const phoneError = document.getElementById('phoneError');

const SHIPPING_FEES = { inside_dhaka: 70, outside_dhaka: 140 };
let currentSubtotal = 0;

/* Single-line checkout: set when this page was reached via the PDP
   "Order" button (/checkout?item=<cart_item_id> — see product.js).
   When present, the summary and the eventual checkout submission are
   both scoped to just this one cart line instead of the whole cart. */
const singleItemId = new URLSearchParams(window.location.search).get('item');

function formatTaka(amount) {
  return `৳${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ---------------- Load cart summary ---------------- */
async function loadOrderSummary() {
  try {
    const res = await fetch(`${API_BASE}/cart`);
    const payload = await res.json();

    if (payload.status !== 'success' || !payload.data.items || payload.data.items.length === 0) {
      // Nothing to check out — send them back to the bag rather than
      // showing a checkout form for an empty order.
      window.location.href = '/cart';
      return;
    }

    // Single-line mode: narrow to just the requested line. If it's
    // gone (e.g. removed in another tab), fall back to the full cart
    // rather than showing a broken/empty checkout.
    let items = payload.data.items;
    let total_price = payload.data.total_price;
    if (singleItemId !== null) {
      const match = items.find(i => String(i.id) === String(singleItemId));
      if (match) {
        items = [match];
        total_price = match.subtotal;
      }
    }
    currentSubtotal = total_price;

    orderItemsList.innerHTML = items.map(item => {
      const custom = item.customization || {};
      let customLine = '';
      if (custom.name || custom.number) {
        const parts = [];
        if (custom.name) parts.push(`Name: ${escapeHtml(custom.name)}`);
        if (custom.number) parts.push(`No: ${escapeHtml(custom.number)}`);
        customLine = `<p class="text-xs text-sage-600 font-semibold">${parts.join(' · ')}</p>`;
      }
      const variantLine = Object.entries(item.selected_variants || {})
        .map(([axis, value]) => `${escapeHtml(axis)}: ${escapeHtml(value)}`)
        .join(' · ');

      return `
        <div class="flex items-start justify-between gap-3 text-sm">
          <div class="min-w-0">
            <p class="font-semibold text-slate-800 truncate">${escapeHtml(item.product_name || 'Product')} <span class="text-slate-500/70 font-normal">×${item.quantity}</span></p>
            ${variantLine ? `<p class="text-xs text-slate-500/70">${variantLine}</p>` : ''}
            ${customLine}
          </div>
          <span class="font-semibold text-slate-800 shrink-0">${formatTaka(item.subtotal)}</span>
        </div>
      `;
    }).join('');

    orderSubtotalEl.textContent = formatTaka(total_price);
    updateGrandTotal();
  } catch (err) {
    console.error('Failed to load cart summary:', err);
    window.location.href = '/cart';
  }
}

function updateGrandTotal() {
  const zone = document.querySelector('input[name="shipping_zone"]:checked').value;
  const shippingFee = SHIPPING_FEES[zone] || 0;
  orderGrandTotalEl.textContent = formatTaka(currentSubtotal + shippingFee);
  return shippingFee;
}

/* ---------------- Shipping zone selection ---------------- */
document.querySelectorAll('input[name="shipping_zone"]').forEach(input => {
  input.addEventListener('change', () => {
    document.querySelectorAll('[data-zone-card]').forEach(card => card.classList.remove('active'));
    input.closest('[data-zone-card]').classList.add('active');
    updateGrandTotal();
  });
});
document.querySelector('input[name="shipping_zone"]:checked').closest('[data-zone-card]').classList.add('active');

/* ---------------- Payment method selection ---------------- */
function setActivePaymentMethod(method) {
  document.querySelectorAll('[data-method-card]').forEach(card => card.classList.remove('active'));
  document.querySelector(`[data-method-card="${method}"]`).classList.add('active');

  document.querySelectorAll('[data-instructions]').forEach(panel => {
    panel.classList.toggle('open', panel.dataset.instructions === method);
  });

  // COD still requires a transaction id/number — for the shipping-fee
  // advance payment, not the full order total (see
  // order_service.validate_payment_details). Label reflects that.
  paymentNumberLabel.textContent = method === 'cod' ? 'Payment Number (for advance)' : 'Payment Number';
}

document.querySelectorAll('input[name="payment_method"]').forEach(input => {
  input.addEventListener('change', () => setActivePaymentMethod(input.value));
});
setActivePaymentMethod(document.querySelector('input[name="payment_method"]:checked').value);

/* ---------------- Phone validation ---------------- */
const BD_PHONE_RE = /^01[3-9]\d{8}$/;
phoneInput.addEventListener('blur', () => {
  const valid = BD_PHONE_RE.test(phoneInput.value.trim());
  phoneError.classList.toggle('hidden', valid || phoneInput.value.trim() === '');
});

/* ---------------- Guest banner ---------------- */
async function checkAuthState() {
  try {
    const res = await fetch('/auth/me');
    const payload = await res.json();
    if (payload.status !== 'success') {
      guestBanner.classList.remove('hidden');
    } else {
      // Pre-fill known details for a logged-in user, same intent as
      // plan.md's GET /auth/me "for frontend auto-fill" note.
      const user = payload.data;
      if (user.phone_number) phoneInput.value = user.phone_number;
    }
  } catch (err) {
    guestBanner.classList.remove('hidden');
  }
}
checkAuthState();

/* ---------------- Submit ---------------- */
function showStatus(html) {
  checkoutForm.classList.add('hidden');
  statusContainer.innerHTML = html;
  statusContainer.classList.remove('hidden');
}

function showSuccessMessage(order) {
  const itemsList = (order.items || []).map(item => {
    const variantStr = Object.entries(item.selected_variants || {})
      .map(([axis, value]) => `${value}`)
      .join(', ');
    return `<li>${escapeHtml(item.product_name)}${variantStr ? ` (${escapeHtml(variantStr)})` : ''} × ${item.quantity}</li>`;
  }).join('');

  showStatus(`
    <div class="checkout-status-panel checkout-status-success">
      <h3 class="font-display text-2xl uppercase tracking-wide mb-2">Order Confirmed</h3>
      <p class="mb-4 text-sm">Thank you, <strong>${escapeHtml(order.customer_name)}</strong>. Your order has been placed.</p>
      <div class="bg-cream-50/60 p-4 rounded-2xl text-left text-xs space-y-2 mb-6">
        <p><strong>Order ID:</strong> #${escapeHtml(order.order_id)}</p>
        <ul class="list-disc ml-4">${itemsList}</ul>
        <p class="border-t border-sage-300/40 pt-2 font-bold text-sm">Total: ${formatTaka(order.total)}</p>
      </div>
      <a href="/" class="inline-block bg-sage-500 text-cream-50 px-8 py-3 rounded-full text-[10px] font-bold uppercase tracking-widest">Back to Home</a>
    </div>
  `);
}

function showErrorMessage(message) {
  statusContainer.innerHTML = `
    <div class="checkout-status-panel checkout-status-error text-xs font-bold uppercase tracking-wider">
      ${escapeHtml(message)}
    </div>
  `;
  statusContainer.classList.remove('hidden');
}

checkoutForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!BD_PHONE_RE.test(phoneInput.value.trim())) {
    phoneError.classList.remove('hidden');
    phoneInput.focus();
    return;
  }

  const formData = new FormData(checkoutForm);
  const payload = Object.fromEntries(formData.entries());
  if (singleItemId !== null) payload.cart_item_id = singleItemId;

  submitBtn.disabled = true;
  submitLabel.textContent = 'Processing Order...';

  try {
    const res = await csrfFetch(`${API_BASE}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await res.json();

    if (result.status === 'success') {
      showSuccessMessage(result.data);
    } else {
      showErrorMessage(result.message || 'Something went wrong.');
      submitBtn.disabled = false;
      submitLabel.textContent = 'Place Order';
    }
  } catch (err) {
    showErrorMessage('Connection error. Please check your internet and try again.');
    submitBtn.disabled = false;
    submitLabel.textContent = 'Place Order';
  }
});

loadOrderSummary();
lucide.createIcons();

