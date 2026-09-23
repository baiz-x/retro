const API_BASE = '/api';

function csrfFetch(url, options = {}) {
  const token = document.querySelector('meta[name="csrf-token"]').content;
  options.headers = { ...(options.headers || {}), 'X-CSRFToken': token };
  return fetch(url, options);
}

/* ---------------- Icon hydration (local inline sprite, no external
   library) — matches index.js's approach now that this page no
   longer loads the lucide CDN script. Replaces any data-lucide
   markup with <use> refs into the inline sprite from
   partials/_icon_sprite.html. Safe to call repeatedly/idempotent. */
function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-lucide]').forEach(el => {
    const name = el.getAttribute('data-lucide');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (el.className) svg.setAttribute('class', el.className);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.appendChild(use);
    el.replaceWith(svg);
  });
}

const checkoutForm = document.getElementById('checkoutForm');
const submitBtn = document.getElementById('submitBtn');
const submitLabel = document.getElementById('submitLabel');
const statusContainer = document.getElementById('statusContainer');
const guestBanner = document.getElementById('guestBanner');

const orderItemsList = document.getElementById('orderItemsList');
const orderSubtotalEl = document.getElementById('orderSubtotal');
const orderGrandTotalEl = document.getElementById('orderGrandTotal');
const paymentNumberLabel = document.getElementById('paymentNumberLabel');
const phoneInput = document.getElementById('phone');
const phoneError = document.getElementById('phoneError');

const SHIPPING_FEES = { inside_dhaka: 70, outside_dhaka: 140, sub_city: 70 };
let currentSubtotal = 0;

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

    const { items, total_price } = payload.data;
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
        <div class="flex items-start justify-between gap-4 text-sm">
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
  const paymentType = document.querySelector('input[name="payment_type"]:checked').value;

  // Mirrors order_service.recompute_total() exactly — same 3 branches,
  // so the number shown here always matches what the server will
  // actually charge. Keep these two in sync if the formula ever
  // changes on either side.
  let total;
  if (paymentType === 'postpaid') {
    total = currentSubtotal + shippingFee;
  } else if (paymentType === 'included') {
    total = currentSubtotal - shippingFee;
  } else {
    total = currentSubtotal; // prepaid
  }

  orderGrandTotalEl.textContent = formatTaka(total);
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

/* ---------------- Delivery payment type selection ---------------- */
const paymentTypeHint = document.getElementById('paymentTypeHint');
const PAYMENT_TYPE_HINTS = {
  postpaid: 'Delivery fee is added to your total, payable on arrival.',
  prepaid: "Delivery fee isn't added — you've settled it separately.",
  included: 'Delivery fee is folded into your item total already.',
};
document.querySelectorAll('input[name="payment_type"]').forEach(input => {
  input.addEventListener('change', () => {
    document.querySelectorAll('[data-ptype-card]').forEach(card => card.classList.remove('active'));
    input.closest('[data-ptype-card]').classList.add('active');
    paymentTypeHint.textContent = PAYMENT_TYPE_HINTS[input.value] || '';
    updateGrandTotal();
  });
});
document.querySelector('input[name="payment_type"]:checked').closest('[data-ptype-card]').classList.add('active');

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

/* ---------------- Prefill for logged-in users ----------------
   Guest-banner visibility is now decided server-side by the
   /checkout route (is_loggedin, from app.py's session check) and
   rendered directly into checkout.html — guestBanner won't even
   exist in the DOM when the user is logged in, so no more toggling
   a hidden class here. This function now only handles prefill. */
async function prefillIfLoggedIn() {
  try {
    const res = await fetch('/auth/me');
    const payload = await res.json();
    if (payload.status === 'success') {
      // Pre-fill known details for a logged-in user — editable, not
      // locked: these are plain inputs, so the person can change any
      // of them before submitting, same as a guest typing from
      // scratch. Nothing here submits on its own; it only submits
      // when the existing form submit handler below fires.
      const user = payload.data;
      if (user.name) document.getElementById('customer_name').value = user.name;
      if (user.phone_number) phoneInput.value = user.phone_number;
      if (user.address) document.getElementById('address').value = user.address;
    }
  } catch (err) {
    console.error('Failed to load user details for prefill:', err);
  }
}
prefillIfLoggedIn();

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
      <div class="checkout-status-receipt text-left text-xs space-y-2 mb-6">
        <p><strong>Order ID:</strong> #${escapeHtml(order.order_id)}</p>
        <ul class="list-disc ml-4">${itemsList}</ul>
        <p class="checkout-status-receipt-total">Total: ${formatTaka(order.total)}</p>
      </div>
      <a href="/" class="checkout-status-home-btn">Back to Home</a>
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

/* ---------------- Mobile menu ----------------
   New on this page — checkout.html previously had no hamburger at
   all (bare "Secure Checkout" header, no nav). The shared navbar
   (partials/_navbar.html + partials/_mobile_menu.html) now includes
   one, same as every other page, so it needs the same open/close
   wiring index.js/product.js/cart.js already have. */
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const mobileMenu = document.getElementById('mobileMenu');
mobileMenuBtn.addEventListener('click', () => {
  const isOpen = mobileMenu.classList.toggle('open');
  mobileMenuBtn.setAttribute('aria-expanded', isOpen);
  mobileMenuBtn.innerHTML = isOpen ? '<i data-lucide="x" class="w-5 h-5"></i>' : '<i data-lucide="menu" class="w-5 h-5"></i>';
  hydrateIcons();
});

/* ---------------- Logout (shared mobile menu button) ----------------
   #logoutBtnMobile lives in _mobile_menu.html, included on every page.
   Route is POST /auth/logout — see auth_route.py. */
const logoutBtnMobile = document.getElementById('logoutBtnMobile');
if (logoutBtnMobile) {
  logoutBtnMobile.addEventListener('click', async () => {
    logoutBtnMobile.disabled = true;
    try {
      const res = await csrfFetch('/auth/logout', { method: 'POST' });
      if (res.ok) {
        window.location.href = '/';
        return;
      }
    } catch {}
    logoutBtnMobile.disabled = false;
  });
}

/* ---------------- Theme toggle (visual, capsule navbar) ----------------
   Also new on this page for the same reason as the mobile menu above. */
const themeToggleBtn = document.getElementById('themeToggleBtn');
let isDarkIcon = true;
themeToggleBtn.addEventListener('click', () => {
  isDarkIcon = !isDarkIcon;
  themeToggleBtn.innerHTML = isDarkIcon
    ? '<i data-lucide="moon" class="w-[18px] h-[18px]"></i>'
    : '<i data-lucide="sun" class="w-[18px] h-[18px]"></i>';
  hydrateIcons();
});

/* ---------------- Cart count badge (mobile bottom bar) ----------------
   New on this page too, for the same reason — the shared mobile bar
   shows the item count, so it needs to be kept in sync the same way
   index.js/product.js/cart.js already do. */
fetch(`${API_BASE}/cart`)
  .then(res => res.json())
  .then(payload => {
    if (payload.status === 'success') {
      document.querySelectorAll('.cart-count-badge').forEach(el => {
        el.textContent = payload.data.total_items || 0;
      });
    }
  })
  .catch(err => console.error('Failed to load cart count:', err));

loadOrderSummary();
hydrateIcons();

