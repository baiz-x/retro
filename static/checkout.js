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

// Promo/wheel elements looked up here (alongside every other top-level
// element const) rather than down near their own section, so
// previewPromo() below can safely reference them however early it's
// first called — no reliance on the await-yield timing of
// loadOrderSummary() happening to run the rest of the script first.
const promoCodeInput = document.getElementById('promo_code_input');
const applyPromoBtn = document.getElementById('applyPromoBtn');
const promoMessageEl = document.getElementById('promoMessage');
const promoDiscountRow = document.getElementById('promoDiscountRow');
const promoDiscountAmountEl = document.getElementById('promoDiscountAmount');
const wheelPopupOverlay = document.getElementById('wheelPopupOverlay');
const wheelPopupCanvas = document.getElementById('wheelPopupCanvas');
const wheelPopupResult = document.getElementById('wheelPopupResult');
const wheelPopupSpinBtn = document.getElementById('wheelPopupSpinBtn');
const wheelPopupCloseBtn = document.getElementById('wheelPopupCloseBtn');

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

    // Tier discounts (if any apply to items in the cart) need no code
    // typed — check for one now that items are loaded. See "PROMO
    // CODE" section below for previewPromo's definition.
    previewPromo(null);
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



/* ================= PROMO CODE ================= */
// Talks to POST /api/promo/preview (routes/promo_route.py). Pure
// read — never writes anything, so it's safe to call as often as
// needed. The typed code is also carried in the hidden-by-name
// #promo_code_input (name="promo_code") that FormData already picks
// up on submit — see the "Card 1b" section of checkout.html — so no
// change was needed to the submit handler itself.
// (Element consts for this section live up top with the rest of the
// page's element lookups — see const promoCodeInput etc. near line 45.)

let appliedDiscountTotal = 0;

function showPromoMessage(text, isError) {
  promoMessageEl.textContent = text;
  promoMessageEl.className = `text-xs mt-2 ${isError ? 'text-red-600' : 'text-sage-600'} font-semibold`;
  promoMessageEl.classList.remove('hidden');
}

async function previewPromo(typedCode) {
  try {
    const res = await csrfFetch(`${API_BASE}/promo/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promo_code: typedCode || '' }),
    });
    const result = await res.json();

    if (result.status !== 'success') {
      appliedDiscountTotal = 0;
      promoDiscountRow.classList.add('hidden');
      if (typedCode) showPromoMessage(result.message || 'Invalid code.', true);
      else promoMessageEl.classList.add('hidden');
      // Even on error, refresh from the server's own subtotal (tier
      // pricing may still apply automatically with no code).
      currentSubtotal = result.data ? result.data.subtotal : currentSubtotal;
      orderSubtotalEl.textContent = formatTaka(currentSubtotal);
      updateGrandTotal();
      return;
    }

    const { subtotal, discount_total, reason } = result.data;
    currentSubtotal = subtotal;
    appliedDiscountTotal = discount_total;

    orderSubtotalEl.textContent = formatTaka(subtotal);
    if (discount_total > 0) {
      promoDiscountRow.classList.remove('hidden');
      promoDiscountAmountEl.textContent = `−${formatTaka(discount_total)}`;
    } else {
      promoDiscountRow.classList.add('hidden');
    }
    if (reason) showPromoMessage(reason, false);
    else promoMessageEl.classList.add('hidden');

    updateGrandTotal();
  } catch (err) {
    console.error('Promo preview failed:', err);
  }
}

if (applyPromoBtn) {
  applyPromoBtn.addEventListener('click', () => {
    const typed = promoCodeInput.value.trim();
    if (!typed) return;

    // A WHEEL code isn't a discount by itself — it opens the spin
    // popup instead (mirrors promo_service.price_cart_items rejecting
    // a wheel code as a direct discount).
    if (typed.toUpperCase().startsWith('WHEEL-') || typed.toUpperCase().startsWith('WHEEL')) {
      openWheelPopup(typed);
      return;
    }
    previewPromo(typed);
  });
}

// Re-check tier pricing (no code) once the cart summary has loaded —
// wired directly into loadOrderSummary() above (see its final lines),
// so it fires in the correct order relative to the page's own initial
// loadOrderSummary() call.


/* ================= WHEEL POPUP ================= */
// Talks to GET /api/wheel/info and POST /api/wheel/spin. Login is
// required server-side (api_login_required) — if the fetch comes back
// 401, we tell the customer to log in rather than silently failing.
// (Element consts live up top with the rest of the page's element
// lookups — see const wheelPopupOverlay etc. near line 50.)

let activeWheelCode = null;
let checkoutWheelRotation = 0; // tracked across spins so rotation always adds forward

/* Same palette as the standalone /wheel page (static/js/wheel.js) —
   alternating warm/cool tones with per-slice text color for contrast,
   rather than the old flat single-color-text-on-pastel look. */
const CHECKOUT_WHEEL_PALETTE = [
  { fill: '#8fae8b', text: '#f7f3ec' },
  { fill: '#f4e7c9', text: '#33302b' },
  { fill: '#6b8a86', text: '#f7f3ec' },
  { fill: '#e3b98f', text: '#33302b' },
  { fill: '#4f6b5c', text: '#f7f3ec' },
  { fill: '#d9c2a8', text: '#33302b' },
];

function drawWheelSegments(container, segments) {
  container.innerHTML = '';
  const size = 260;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.id = 'wheelPopupSvg';
  svg.style.transformOrigin = '50% 50%';
  svg.style.transition = 'none';
  svg.style.transform = `rotate(${checkoutWheelRotation}deg)`;

  const cx = size / 2, cy = size / 2, r = size / 2 - 6;
  const totalWeight = segments.reduce((s, seg) => s + Math.max(seg.weight, 0), 0) || 1;
  let angleStart = -90; // 12 o'clock, under the pointer

  segments.forEach((seg, i) => {
    const sliceAngle = (Math.max(seg.weight, 0) / totalWeight) * 360;
    const angleEnd = angleStart + sliceAngle;
    const large = sliceAngle > 180 ? 1 : 0;
    const colors = CHECKOUT_WHEEL_PALETTE[i % CHECKOUT_WHEEL_PALETTE.length];

    const x1 = cx + r * Math.cos((Math.PI * angleStart) / 180);
    const y1 = cy + r * Math.sin((Math.PI * angleStart) / 180);
    const x2 = cx + r * Math.cos((Math.PI * angleEnd) / 180);
    const y2 = cy + r * Math.sin((Math.PI * angleEnd) / 180);
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`);
    path.setAttribute('fill', colors.fill);
    path.setAttribute('stroke', '#f7f3ec');
    path.setAttribute('stroke-width', '3');
    svg.appendChild(path);

    const midAngle = (angleStart + angleEnd) / 2;
    const labelR = r * 0.62;
    const lx = cx + labelR * Math.cos((Math.PI * midAngle) / 180);
    const ly = cy + labelR * Math.sin((Math.PI * midAngle) / 180);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', lx);
    text.setAttribute('y', ly);
    text.setAttribute('font-size', sliceAngle < 35 ? '9' : '11');
    text.setAttribute('font-weight', '800');
    text.setAttribute('fill', colors.text);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('transform', `rotate(${midAngle + 90}, ${lx}, ${ly})`);
    text.textContent = seg.label;
    svg.appendChild(text);

    angleStart = angleEnd;
  });

  container.appendChild(svg);
}

async function openWheelPopup(rawCode) {
  activeWheelCode = rawCode;
  checkoutWheelRotation = 0;
  wheelPopupResult.classList.add('hidden');
  wheelPopupSpinBtn.disabled = false;
  wheelPopupSpinBtn.classList.remove('hidden');
  wheelPopupSpinBtn.textContent = 'Spin';
  wheelPopupOverlay.classList.remove('hidden');

  try {
    const res = await fetch(`${API_BASE}/wheel/info?code=${encodeURIComponent(rawCode)}`);
    if (res.status === 401) {
      wheelPopupCanvas.innerHTML = '';
      wheelPopupResult.textContent = 'Please log in to spin this wheel.';
      wheelPopupResult.classList.remove('hidden');
      wheelPopupSpinBtn.classList.add('hidden');
      return;
    }
    const result = await res.json();
    if (result.status !== 'success') {
      wheelPopupCanvas.innerHTML = '';
      wheelPopupResult.textContent = result.message || 'Invalid wheel code.';
      wheelPopupResult.classList.remove('hidden');
      wheelPopupSpinBtn.classList.add('hidden');
      return;
    }

    const { segments, is_live, error, already_spun } = result.data;
    if (!is_live) {
      wheelPopupCanvas.innerHTML = '';
      wheelPopupResult.textContent = error || 'This wheel is not available.';
      wheelPopupResult.classList.remove('hidden');
      wheelPopupSpinBtn.classList.add('hidden');
      return;
    }
    if (!segments || segments.length === 0) {
      wheelPopupCanvas.innerHTML = '';
      wheelPopupResult.textContent = 'This wheel has no prizes set up yet.';
      wheelPopupResult.classList.remove('hidden');
      wheelPopupSpinBtn.classList.add('hidden');
      return;
    }
    if (already_spun) {
      wheelPopupResult.textContent = "You've already spun this wheel.";
      wheelPopupResult.classList.remove('hidden');
      wheelPopupSpinBtn.classList.add('hidden');
    }
    drawWheelSegments(wheelPopupCanvas, segments);
  } catch (err) {
    console.error('Wheel info failed:', err);
  }
}

function closeWheelPopup() {
  wheelPopupOverlay.classList.add('hidden');
}

if (wheelPopupCloseBtn) wheelPopupCloseBtn.addEventListener('click', closeWheelPopup);

if (wheelPopupSpinBtn) {
  wheelPopupSpinBtn.addEventListener('click', async () => {
    if (!activeWheelCode) return;
    wheelPopupSpinBtn.disabled = true;
    wheelPopupSpinBtn.textContent = 'Spinning...';

    try {
      const res = await csrfFetch(`${API_BASE}/wheel/spin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: activeWheelCode }),
      });
      const result = await res.json();

      if (result.status !== 'success') {
        wheelPopupResult.textContent = result.message || 'Something went wrong.';
        wheelPopupResult.classList.remove('hidden');
        wheelPopupSpinBtn.classList.add('hidden');
        return;
      }

      const { label, prize_code } = result.data;
      // Real spin physics: several full rotations plus a random final
      // angle, eased with a curve that decelerates hard at the end —
      // the OUTCOME itself was already decided server-side before
      // this animation starts, this is purely visual feedback.
      const svg = document.getElementById('wheelPopupSvg');
      const spins = 5 + Math.random() * 2;
      const finalOffset = Math.random() * 360;
      checkoutWheelRotation += spins * 360 + finalOffset;
      if (svg) {
        svg.style.transition = 'transform 4.2s cubic-bezier(0.11, 0.79, 0.12, 1)';
        void svg.getBoundingClientRect();
        svg.style.transform = `rotate(${checkoutWheelRotation}deg)`;
      }

      setTimeout(() => {
        wheelPopupSpinBtn.classList.add('hidden');
        if (prize_code) {
          wheelPopupResult.innerHTML = `🎉 You won ${escapeHtml(label)}!<br>Code: <strong>${escapeHtml(prize_code)}</strong> (valid 24h)`;
          promoCodeInput.value = prize_code;
        } else {
          wheelPopupResult.textContent = `Result: ${label}. Better luck on the next drop!`;
        }
        wheelPopupResult.classList.remove('hidden');
      }, 4300);
    } catch (err) {
      wheelPopupResult.textContent = 'Connection error. Please try again.';
      wheelPopupResult.classList.remove('hidden');
      wheelPopupSpinBtn.disabled = false;
      wheelPopupSpinBtn.textContent = 'Spin';
    }
  });
}

