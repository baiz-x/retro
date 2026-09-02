const API_BASE = '/api';

/* Same CSRF pattern established in product.js/auth.js — reads the
   <meta name="csrf-token"> tag rendered by cart.html and attaches it
   to every mutating request. */
function csrfFetch(url, options = {}) {
  const token = document.querySelector('meta[name="csrf-token"]').content;
  options.headers = { ...(options.headers || {}), 'X-CSRFToken': token };
  return fetch(url, options);
}

const cartLoading = document.getElementById('cartLoading');
const emptyState = document.getElementById('emptyState');
const cartContents = document.getElementById('cartContents');
const cartLines = document.getElementById('cartLines');
const cartCountHeader = document.getElementById('cartCountHeader');
const summarySubtotal = document.getElementById('summarySubtotal');
const cartGrandTotal = document.getElementById('cartGrandTotal');
const clearBtn = document.getElementById('clearBtn');

function formatTaka(amount) {
  return `৳${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/* Builds the small pill row under a line item: variant selections
   (e.g. Size: M) as neutral tags, and jersey customization (name/
   number) as a distinct sage-tinted tag so it visually reads as
   "this line is personalized" at a glance. */
function renderLineMeta(item) {
  const variantTags = Object.entries(item.selected_variants || {})
    .map(([axis, value]) => `<span class="cart-line-tag">${escapeHtml(axis)}: ${escapeHtml(value)}</span>`)
    .join('');

  const customization = item.customization || {};
  let customTag = '';
  if (customization.name || customization.number) {
    const parts = [];
    if (customization.name) parts.push(`NAME: ${escapeHtml(customization.name)}`);
    if (customization.number) parts.push(`NO: ${escapeHtml(customization.number)}`);
    customTag = `<span class="cart-line-custom">${parts.join(' · ')}</span>`;
  }

  return `<div class="cart-line-meta">${variantTags}${customTag}</div>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderLine(item) {
  return `
    <div class="cart-line" data-cart-item-id="${item.id}">
      <div class="cart-line-media">
        ${item.image ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.product_name || '')}" />` : ''}
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="font-bold text-sm text-slate-800 truncate">${escapeHtml(item.product_name || 'Product')}</h3>
            ${renderLineMeta(item)}
          </div>
          <button class="cart-line-remove shrink-0" data-action="remove" data-cart-item-id="${item.id}" aria-label="Remove item">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>
        <div class="flex items-end justify-between mt-3">
          <div class="cart-line-qty-stepper">
            <button class="cart-line-qty-btn" data-action="decrement" data-cart-item-id="${item.id}" aria-label="Decrease quantity">
              <i data-lucide="minus" class="w-3.5 h-3.5"></i>
            </button>
            <span class="cart-line-qty-value">${item.quantity}</span>
            <button class="cart-line-qty-btn" data-action="increment" data-cart-item-id="${item.id}" aria-label="Increase quantity">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i>
            </button>
          </div>
          <span class="font-bold text-sm text-slate-800">${formatTaka(item.subtotal)}</span>
        </div>
      </div>
    </div>
  `;
}

function renderCart(data) {
  const items = data.items || [];
  cartLoading.classList.add('hidden');

  cartCountHeader.textContent = `${data.total_items || 0} Item${data.total_items === 1 ? '' : 's'}`;

  if (items.length === 0) {
    emptyState.classList.remove('hidden');
    cartContents.classList.add('hidden');
    lucide.createIcons();
    return;
  }

  emptyState.classList.add('hidden');
  cartContents.classList.remove('hidden');

  cartLines.innerHTML = items.map(renderLine).join('');
  summarySubtotal.textContent = formatTaka(data.total_price || 0);
  cartGrandTotal.textContent = formatTaka(data.total_price || 0);

  lucide.createIcons();
}

async function loadCart() {
  try {
    const res = await fetch(`${API_BASE}/cart`);
    const payload = await res.json();
    if (payload.status === 'success') {
      renderCart(payload.data);
    } else {
      renderCart({ items: [], total_items: 0, total_price: 0 });
    }
  } catch (err) {
    console.error('Failed to load cart:', err);
    renderCart({ items: [], total_items: 0, total_price: 0 });
  }
}

/* Every quantity/remove action re-renders from the response the
   server sends back (each cart mutation route returns the full
   updated cart — see services/cart_service.py) rather than
   optimistically guessing the new state client-side, so stock limits
   enforced server-side are always reflected accurately. */
async function changeQuantity(cartItemId, delta) {
  const line = cartLines.querySelector(`[data-cart-item-id="${cartItemId}"]`);
  const currentQty = parseInt(line.querySelector('.cart-line-qty-value').textContent, 10);
  const newQty = currentQty + delta;

  try {
    const res = await csrfFetch(`${API_BASE}/cart/update`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cart_item_id: cartItemId, quantity: newQty }),
    });
    const payload = await res.json();
    if (payload.status === 'success') {
      renderCart(payload.data);
    } else {
      // e.g. stock limit hit — reload to show the server's actual state
      // rather than leaving the stepper showing a quantity that wasn't
      // actually applied.
      await loadCart();
    }
  } catch (err) {
    console.error('Failed to update quantity:', err);
    await loadCart();
  }
}

async function removeItem(cartItemId) {
  try {
    const res = await csrfFetch(`${API_BASE}/cart/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cart_item_id: cartItemId }),
    });
    const payload = await res.json();
    if (payload.status === 'success') {
      renderCart(payload.data);
    } else {
      await loadCart();
    }
  } catch (err) {
    console.error('Failed to remove item:', err);
  }
}

async function clearCart() {
  try {
    await csrfFetch(`${API_BASE}/cart/clear`, { method: 'POST' });
    await loadCart();
  } catch (err) {
    console.error('Failed to clear cart:', err);
  }
}

cartLines.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const cartItemId = btn.dataset.cartItemId;
  const action = btn.dataset.action;

  if (action === 'remove') removeItem(cartItemId);
  if (action === 'increment') changeQuantity(cartItemId, 1);
  if (action === 'decrement') changeQuantity(cartItemId, -1);
});

clearBtn.addEventListener('click', () => {
  if (confirm('Remove everything from your bag?')) clearCart();
});

loadCart();
lucide.createIcons();
