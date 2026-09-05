lucide.createIcons();

const API_BASE = '/api';

/* CSRF: every mutating request (POST/PATCH/DELETE) must carry the
   X-CSRFToken header for flask-wtf's CSRFProtect to accept it — see
   the <meta name="csrf-token"> tag in product.html's <head>. GET
   requests don't need this (CSRFProtect only checks state-changing
   methods), so plain fetch() is still used for those elsewhere in
   this file (loadDiscovery, cart count refresh). */
function csrfFetch(url, options = {}) {
  const token = document.querySelector('meta[name="csrf-token"]').content;
  options.headers = { ...(options.headers || {}), 'X-CSRFToken': token };
  return fetch(url, options);
}

/* Currency: ৳ (BDT), standard grouping (en-BD, not en-IN — avoids
   India's lakh/crore digit grouping). Same helper as index.js and
   products.js, kept identical across all three for consistency. Only
   used here for the discovery rail, which is still built client-side
   from a fetch — everything else on this page is server-rendered
   already, with the price/currency baked into the HTML by app.py's
   /product/<slug> route. */
const currency = n => '৳' + Number(n).toLocaleString('en-BD');

/* Must match LOW_STOCK_THRESHOLD in app.py exactly — kept in sync
   manually since the two run in different languages/processes. Used
   here only for the quantity stepper's live cap after a pill click;
   the initial stock note text itself is already server-rendered. */
const LOW_STOCK_THRESHOLD = 5;

/* ---------------------------------------------------------------------
   Product data — this page is server-rendered (see app.py's
   /product/<slug> route + product.html's Jinja template), so there is
   no fetch here. The full product (name, description, price display,
   pills, etc.) already arrived in the initial HTML. The only thing
   still needed client-side is enough raw data to do live stock math
   when a size/color pill is clicked — embedded once by the template
   as JSON rather than re-fetched. See the <script id="pdpProductData">
   tag in product.html.
   --------------------------------------------------------------------- */
const product = JSON.parse(document.getElementById('pdpProductData').textContent);

let selectedSize = null;
let selectedColor = null; // boots axis only
let quantity = 1;
let galleryImages = [];
let galleryIndex = 0;

/* ---------------------------------------------------------------------
   Stock resolution — identical semantics to app.py's is_out_of_stock()/
   build_size_pills()/build_color_pills() (and, before this page was
   server-rendered, to this same logic client-side). Kept here because
   pill clicks need to recompute availability/quantity caps live,
   without a re-fetch or re-render of the whole page.
   --------------------------------------------------------------------- */
function isOutOfStock(p) {
  // is_preorder products are never out of stock for messaging purposes
  // — the stock number is artificially kept high by design and doesn't
  // represent real inventory. Matches app.py's is_out_of_stock() (see
  // product_service.py).
  if (p.is_preorder) return false;
  if ((p.variant_mode || 'unified') === 'per_variant') {
    const combos = (p.variants && p.variants.combinations) || [];
    if (combos.length === 0) return (p.stock || 0) <= 0;
    return combos.every(c => (Number(c.stock) || 0) <= 0);
  }
  return !p.stock || p.stock <= 0;
}

function getResolvedStock(p) {
  const mode = p.variant_mode || 'unified';
  if (mode !== 'per_variant') {
    return { stock: p.stock || 0, resolved: true };
  }
  const combos = (p.variants && p.variants.combinations) || [];
  if (combos.length === 0) {
    return { stock: p.stock || 0, resolved: true };
  }
  const needsSize = sizeAxisExists(p);
  const needsColor = p.product_type === 'boots' && colorAxisExists(p);
  if (needsSize && !selectedSize) {
    const total = combos.reduce((sum, c) => sum + (Number(c.stock) || 0), 0);
    return { stock: total, resolved: false };
  }
  const match = combos.find(c => {
    const sizeOk = !needsSize || c.size === selectedSize;
    const colorOk = !needsColor || c.color === selectedColor;
    return sizeOk && colorOk;
  });
  if (!match) {
    return { stock: 0, resolved: false };
  }
  return { stock: Number(match.stock) || 0, resolved: true };
}

function sizeAxisExists(p) {
  return !!(p.variants && p.variants.axes && Array.isArray(p.variants.axes.size) && p.variants.axes.size.length > 0);
}
function colorAxisExists(p) {
  return !!(p.variants && p.variants.axes && Array.isArray(p.variants.axes.color) && p.variants.axes.color.length > 0);
}

/* ---------------------------------------------------------------------
   Gallery — thumbnails/main image are already server-rendered; JS only
   switches which one is visible.
   --------------------------------------------------------------------- */
function initGallery() {
  const thumbs = document.querySelectorAll('.pdp-gallery-thumb');
  galleryImages = Array.from(thumbs).map(btn => btn.querySelector('img').src);
  if (galleryImages.length === 0) {
    // No thumbnails rendered (single-image product) — fall back to
    // whatever's already showing in the main image.
    const mainImg = document.getElementById('galleryMainImg');
    if (mainImg && mainImg.src) galleryImages = [mainImg.src];
  }
  galleryIndex = 0;
}

function showGalleryImage(index) {
  if (galleryImages.length === 0) return;
  galleryIndex = ((index % galleryImages.length) + galleryImages.length) % galleryImages.length;
  const mainImg = document.getElementById('galleryMainImg');
  mainImg.src = galleryImages[galleryIndex];
  document.querySelectorAll('.pdp-gallery-thumb').forEach((btn, i) => {
    btn.classList.toggle('active', i === galleryIndex);
    btn.setAttribute('aria-selected', i === galleryIndex);
  });
}

document.getElementById('galleryPrevBtn').addEventListener('click', () => showGalleryImage(galleryIndex - 1));
document.getElementById('galleryNextBtn').addEventListener('click', () => showGalleryImage(galleryIndex + 1));
document.getElementById('galleryThumbs').addEventListener('click', e => {
  const btn = e.target.closest('.pdp-gallery-thumb');
  if (btn) showGalleryImage(Number(btn.dataset.index));
});

/* ---------------------------------------------------------------------
   Stock note — text/class are already server-rendered for the initial
   (no selection) state. This only re-renders it after a pill click,
   using the exact same logic as app.py's build_stock_note(): a
   pre-order product ALWAYS shows the disclaimer (stock is never
   inspected — see isOutOfStock's comment above); a store-owned
   product gets the real 3-state note, including a neutral-empty state
   once stock is comfortably above the low-stock threshold.
   --------------------------------------------------------------------- */
function updateStockNote() {
  const noteEl = document.getElementById('infoStockNote');
  const mobileNoteEl = document.getElementById('mobileCtaStockNote');

  noteEl.className = 'pdp-stock-note';
  mobileNoteEl.className = 'pdp-stock-note text-[11px]';

  if (product.is_preorder) {
    const text = 'Pre-Order — all products will be sourced after order';
    noteEl.classList.add('pdp-stock-preorder');
    mobileNoteEl.classList.add('pdp-stock-preorder');
    noteEl.textContent = text;
    mobileNoteEl.textContent = text;
    return;
  }

  const { stock, resolved } = getResolvedStock(product);
  let text = '';
  if (resolved && stock <= 0) {
    text = 'Out of stock';
    noteEl.classList.add('pdp-stock-low');
    mobileNoteEl.classList.add('pdp-stock-low');
  } else if (resolved && stock <= LOW_STOCK_THRESHOLD) {
    text = `Order fast, low quantity — ${stock} left`;
    noteEl.classList.add('pdp-stock-low');
    mobileNoteEl.classList.add('pdp-stock-low');
  } else {
    // Neutral-empty: store-owned, healthy stock — no disclaimer, no
    // extra text, per Hasan's confirmed design.
    text = '';
  }
  noteEl.textContent = text;
  mobileNoteEl.textContent = text;
}

/* ---------------------------------------------------------------------
   Size pills — already server-rendered (correct initial available/
   disabled state per pill). Click handling only manages selection.
   --------------------------------------------------------------------- */
document.getElementById('sizePills').addEventListener('click', e => {
  const btn = e.target.closest('.pdp-pill');
  if (!btn || btn.disabled) return;
  selectedSize = btn.dataset.size;
  document.querySelectorAll('#sizePills .pdp-pill').forEach(p => {
    const active = p.dataset.size === selectedSize;
    p.classList.toggle('pdp-pill-active', active);
    p.setAttribute('aria-checked', active);
  });
  document.getElementById('sizeSelectedLabel').textContent = `Selected: ${selectedSize}`;
  document.getElementById('selectionHint').classList.add('hidden');
  refreshColorAvailability();
  updateStockNote();
  updateAddToCartState();
});

/* ---------------------------------------------------------------------
   Color pills (boots only) — same idea: server-rendered, JS only
   handles selection + re-checking availability once a size is picked
   (the server-rendered initial state can't know the selection yet).
   --------------------------------------------------------------------- */
function refreshColorAvailability() {
  if (product.product_type !== 'boots') return;
  const combos = (product.variants && product.variants.combinations) || [];
  const perVariant = (product.variant_mode || 'unified') === 'per_variant';
  document.querySelectorAll('#colorPills .pdp-pill').forEach(btn => {
    const color = btn.dataset.color;
    let available = true;
    if (perVariant && combos.length > 0 && selectedSize) {
      available = combos.some(c => c.size === selectedSize && c.color === color && (Number(c.stock) || 0) > 0);
    }
    btn.classList.toggle('pdp-pill-disabled', !available);
    btn.disabled = !available;
  });
}

// Color swatch dots: server-rendered pills carry the color name in a
// data attribute (data-color-name) since Jinja can't reach this JS
// lookup table — the swatch background is filled in here on load.
function initColorSwatches() {
  const known = {
    black: '#1a1a1a', white: '#f5f5f5', red: '#c0392b', blue: '#2c5f8a',
    green: '#3d6b4f', yellow: '#d4af37', navy: '#1b2a4a', grey: '#8a8a8a',
    gray: '#8a8a8a', orange: '#c9702a', purple: '#6c4a8a', pink: '#c97a9a',
    brown: '#6b4a35', beige: '#c9b896', gold: '#c9a227', silver: '#b0b0b0',
  };
  document.querySelectorAll('.pdp-pill-swatch[data-color-name]').forEach(dot => {
    const key = dot.dataset.colorName.trim().toLowerCase();
    dot.style.background = known[key] || '#a7bda2';
  });
}

document.getElementById('colorPills').addEventListener('click', e => {
  const btn = e.target.closest('.pdp-pill');
  if (!btn || btn.disabled) return;
  selectedColor = btn.dataset.color;
  document.querySelectorAll('#colorPills .pdp-pill').forEach(p => {
    const active = p.dataset.color === selectedColor;
    p.classList.toggle('pdp-pill-active', active);
    p.setAttribute('aria-checked', active);
  });
  document.getElementById('colorSelectedLabel').textContent = `Selected: ${selectedColor}`;
  updateStockNote();
  updateAddToCartState();
});

/* ---------------------------------------------------------------------
   Jersey personalization — jersey only, section visibility already
   server-rendered. Captured in JS state only: there is no column for
   this on Product, CartItem, or OrderItem yet (Hasan is adding it
   separately). Values are read at add-to-cart time; see addToCart().
   --------------------------------------------------------------------- */
document.getElementById('personalizeToggle').addEventListener('click', () => {
  const fields = document.getElementById('personalizeFields');
  const chevron = document.querySelector('.pdp-personalize-chevron');
  const isOpen = fields.classList.toggle('open');
  chevron.classList.toggle('open', isOpen);
  document.getElementById('personalizeToggle').setAttribute('aria-expanded', isOpen);
});

const personalizeNameInput = document.getElementById('personalizeName');
personalizeNameInput.addEventListener('input', () => {
  personalizeNameInput.value = personalizeNameInput.value.toUpperCase().slice(0, 10);
});

const personalizeNumberInput = document.getElementById('personalizeNumber');
personalizeNumberInput.addEventListener('input', () => {
  personalizeNumberInput.value = personalizeNumberInput.value.replace(/\D/g, '').slice(0, 2);
});

/* ---------------------------------------------------------------------
   Quantity stepper
   --------------------------------------------------------------------- */
function updateQtyDisplay() {
  document.getElementById('qtyValue').textContent = quantity;
  document.getElementById('qtyMinusBtn').disabled = quantity <= 1;
  const { stock, resolved } = getResolvedStock(product);
  document.getElementById('qtyPlusBtn').disabled = resolved && stock > 0 && quantity >= stock;
}

document.getElementById('qtyMinusBtn').addEventListener('click', () => {
  if (quantity > 1) { quantity--; updateQtyDisplay(); }
});
document.getElementById('qtyPlusBtn').addEventListener('click', () => {
  const { stock, resolved } = getResolvedStock(product);
  if (!resolved || stock <= 0 || quantity < stock) { quantity++; updateQtyDisplay(); }
});

/* ---------------------------------------------------------------------
   Button label wording.
   - Cart button: always just "Cart" — it only ever adds a line, so its
     label doesn't need to change with preorder/stock state beyond
     disabling it.
   - Order button: mirrors app.py's build_add_to_cart_label() as
     before — "Reserve" for is_preorder products (a request, sourced
     afterward), "Order" for store-owned stock. Out of stock overrides
     both regardless of is_preorder.
   --------------------------------------------------------------------- */
function cartBtnLabel() {
  return isOutOfStock(product) ? 'Out of Stock' : 'Cart';
}
function orderBtnLabel(mobile) {
  if (isOutOfStock(product)) return 'Out of Stock';
  if (product.is_preorder) return mobile ? 'Reserve' : 'Reserve this item';
  return mobile ? 'Order' : 'Order this item';
}

/* ---------------------------------------------------------------------
   Add to cart — disabled/enabled state already server-rendered for
   the initial (no selection) view; this keeps it correct as
   selections change. Posts to POST /api/cart/add (see
   services/cart_service.py + routes/cart_route.py) with the selected
   variant axes and, for jerseys, the name/number customization.
   --------------------------------------------------------------------- */
function updateAddToCartState() {
  const btn = document.getElementById('addToCartBtn');
  const mobileBtn = document.getElementById('mobileAddToCartBtn');
  const orderBtn = document.getElementById('orderNowBtn');
  const mobileOrderBtn = document.getElementById('mobileOrderNowBtn');
  const hint = document.getElementById('selectionHint');

  const oos = isOutOfStock(product);
  const needsSize = sizeAxisExists(product);
  const needsColor = product.product_type === 'boots' && colorAxisExists(product);
  const missingSelection = (needsSize && !selectedSize) || (needsColor && !selectedColor);

  [btn, mobileBtn, orderBtn, mobileOrderBtn].forEach(b => { b.disabled = oos; });

  document.getElementById('addToCartLabel').textContent = cartBtnLabel();
  document.getElementById('orderNowLabel').textContent = orderBtnLabel(false);
  document.getElementById('mobileOrderNowLabel').textContent = orderBtnLabel(true);

  hint.classList.toggle('hidden', !missingSelection || oos);
  updateQtyDisplay();
}

/* Builds the selected_variants payload from current pill selections.
   Keys match the axis names in product.variants.axes (see
   models/product.py) — "size" always, "color" only for boots. */
function buildSelectedVariants() {
  const variants = {};
  if (sizeAxisExists(product) && selectedSize) variants.size = selectedSize;
  if (product.product_type === 'boots' && colorAxisExists(product) && selectedColor) {
    variants.color = selectedColor;
  }
  return variants;
}

/* Only meaningful for jerseys (personalizeSection is hidden otherwise —
   see show_personalization in product_service.py's
   build_product_view_context). Returns {} if the person left both
   fields blank, so an untouched customization panel doesn't create a
   pointless {"name": "", "number": ""} on the cart line. */
function buildCustomization() {
  if (product.product_type !== 'jersey') return {};
  const name = personalizeNameInput.value.trim();
  const number = personalizeNumberInput.value.trim();
  if (!name && !number) return {};
  const customization = {};
  if (name) customization.name = name;
  if (number) customization.number = number;
  return customization;
}

function setBtnLabel(el, text) {
  if (el) el.textContent = text;
}

// Restores a pair of (desktop, mobile) label elements to their normal
// resting text after a transient state (Adding.../Added/error).
function restoreCartLabels() {
  setBtnLabel(document.getElementById('addToCartLabel'), cartBtnLabel());
}
function restoreOrderLabels() {
  setBtnLabel(document.getElementById('orderNowLabel'), orderBtnLabel(false));
  setBtnLabel(document.getElementById('mobileOrderNowLabel'), orderBtnLabel(true));
}

/* ---------------------------------------------------------------------
   Shared add-to-cart call — posts to POST /api/cart/add and returns
   the parsed payload (or null on a thrown/network error) so both the
   Cart button and Order button can react to the same outcome
   differently (Cart: show "Added" and stay put; Order: redirect to
   checkout for just this line on success).
   --------------------------------------------------------------------- */
function selectionMissing() {
  const needsSize = sizeAxisExists(product);
  const needsColor = product.product_type === 'boots' && colorAxisExists(product);
  return (needsSize && !selectedSize) || (needsColor && !selectedColor);
}

function flagMissingSelection() {
  document.getElementById('selectionHint').classList.remove('hidden');
  document.getElementById('sizeSection').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function postAddToCart() {
  const res = await csrfFetch(`${API_BASE}/cart/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product_id: product.id,
      quantity,
      selected_variants: buildSelectedVariants(),
      customization: buildCustomization(),
    }),
  });
  return res.json();
}

/* ---------------- Cart button: add the line, stay on the page ---------------- */
async function addToCart() {
  if (selectionMissing()) { flagMissingSelection(); return; }

  const btn = document.getElementById('addToCartBtn');
  const mobileBtn = document.getElementById('mobileAddToCartBtn');
  const label = document.getElementById('addToCartLabel');

  [btn, mobileBtn].forEach(b => { b.disabled = true; });
  setBtnLabel(label, 'Adding...');

  try {
    const payload = await postAddToCart();

    if (payload.status !== 'success') {
      setBtnLabel(label, payload.message || 'Could not add');
      setTimeout(restoreCartLabels, 1800);
      [btn, mobileBtn].forEach(b => { b.disabled = isOutOfStock(product); });
      return;
    }

    cartCountEl.textContent = payload.data.total_items || 0;
    setBtnLabel(label, 'Added');
    setTimeout(() => {
      restoreCartLabels();
      [btn, mobileBtn].forEach(b => { b.disabled = isOutOfStock(product); });
    }, 900);
  } catch (err) {
    console.error('Add to cart failed:', err);
    setBtnLabel(label, 'Connection error');
    setTimeout(restoreCartLabels, 1800);
    [btn, mobileBtn].forEach(b => { b.disabled = isOutOfStock(product); });
  }
}

/* ---------------- Order button: add the line, then jump straight to
   checkout for just that line via ?item=<cart_item_id>. The added
   line's id comes back in the /api/cart/add response's cart data
   (fetch_cart_contents() includes each item's own id — see
   cart_service.py). On failure, stay on the page and show the error
   the same way the Cart button does, rather than navigating away from
   a failed add. --------------------------------------------------- */
async function orderNow() {
  if (selectionMissing()) { flagMissingSelection(); return; }

  const btn = document.getElementById('orderNowBtn');
  const mobileBtn = document.getElementById('mobileOrderNowBtn');

  [btn, mobileBtn].forEach(b => { if (b) b.disabled = true; });
  setBtnLabel(document.getElementById('orderNowLabel'), 'Adding...');
  setBtnLabel(document.getElementById('mobileOrderNowLabel'), 'Adding...');

  try {
    const payload = await postAddToCart();

    if (payload.status !== 'success') {
      setBtnLabel(document.getElementById('orderNowLabel'), payload.message || 'Could not add');
      setBtnLabel(document.getElementById('mobileOrderNowLabel'), payload.message || 'Could not add');
      setTimeout(restoreOrderLabels, 1800);
      [btn, mobileBtn].forEach(b => { if (b) b.disabled = isOutOfStock(product); });
      return;
    }

    cartCountEl.textContent = payload.data.total_items || 0;

    // Find the line we (or an existing matching line, since equal
    // product+variants+customization merge — see cart_service.py)
    // just added, so checkout can filter down to it specifically.
    const variants = buildSelectedVariants();
    const customization = buildCustomization();
    const items = (payload.data && payload.data.items) || [];
    const line = items.find(i =>
      i.product_id === product.id &&
      JSON.stringify(i.selected_variants || {}) === JSON.stringify(variants) &&
      JSON.stringify(i.customization || {}) === JSON.stringify(customization)
    );

    if (line) {
      window.location.href = `/checkout?item=${encodeURIComponent(line.id)}`;
    } else {
      // Shouldn't happen, but fail safe to the full cart rather than
      // a broken checkout link.
      window.location.href = '/checkout';
    }
  } catch (err) {
    console.error('Order failed:', err);
    setBtnLabel(document.getElementById('orderNowLabel'), 'Connection error');
    setBtnLabel(document.getElementById('mobileOrderNowLabel'), 'Connection error');
    setTimeout(restoreOrderLabels, 1800);
    [btn, mobileBtn].forEach(b => { if (b) b.disabled = isOutOfStock(product); });
  }
}

document.getElementById('addToCartBtn').addEventListener('click', addToCart);
document.getElementById('mobileAddToCartBtn').addEventListener('click', addToCart);
document.getElementById('orderNowBtn').addEventListener('click', orderNow);
document.getElementById('mobileOrderNowBtn').addEventListener('click', orderNow);

/* ---------------------------------------------------------------------
   Accordion — Description/Shipping panels are already server-rendered
   (Description) or static (Shipping); only the open/close behavior and
   the FAQ panel's content are still built here. FAQ reuses the
   homepage's faqData content (see index.js) since no product-specific
   FAQ field exists on the Product model — same as before SSR.
   --------------------------------------------------------------------- */
const faqData = [
  { q: 'How long does shipping take?', a: 'We offer free express shipping nationwide. Expected delivery is within 9–15 working days from the date of order.' },
  { q: 'Do you offer Cash on Delivery (COD)?', a: 'Yes, we support COD. To secure your order and prevent fraudulent requests, all COD deliveries require a small advance payment at checkout.' },
  { q: 'Can I track my order?', a: 'Absolutely. Once your order has been dispatched from our warehouse, you\'ll receive tracking information via email and SMS.' },
];

function renderAccordionFaq() {
  const faqList = document.getElementById('accordionFaq');
  faqList.innerHTML = faqData.map((item, i) => `
    <div class="faq-item">
      <button class="faq-toggle w-full flex items-center justify-between gap-4 py-4 text-left" data-index="pdp-${i}" aria-expanded="false">
        <span class="font-semibold text-slate-800 text-sm">${item.q}</span>
        <i data-lucide="chevron-down" class="faq-chevron w-4 h-4 text-sage-500 shrink-0"></i>
      </button>
      <div class="faq-answer" id="faq-answer-pdp-${i}">
        <p class="text-sm text-slate-500/80 leading-relaxed pb-4 pr-8">${item.a}</p>
      </div>
    </div>
  `).join('');
}

document.getElementById('accordionFaq').addEventListener('click', e => {
  const toggle = e.target.closest('.faq-toggle');
  if (!toggle) return;
  const answer = document.getElementById(`faq-answer-${toggle.dataset.index}`);
  const chevron = toggle.querySelector('.faq-chevron');
  const isOpen = answer.classList.contains('open');

  document.querySelectorAll('#accordionFaq .faq-answer.open').forEach(el => el.classList.remove('open'));
  document.querySelectorAll('#accordionFaq .faq-chevron.open').forEach(el => el.classList.remove('open'));
  document.querySelectorAll('#accordionFaq .faq-toggle').forEach(el => el.setAttribute('aria-expanded', 'false'));

  if (!isOpen) {
    answer.classList.add('open');
    chevron.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
  }
});

// Top-level accordion (Description/Shipping/FAQ) — single-open,
// Description starts open (server-rendered already open).
document.getElementById('pdpAccordion').addEventListener('click', e => {
  const toggle = e.target.closest('.pdp-accordion-toggle');
  if (!toggle) return;
  const panel = document.getElementById(`accordion-panel-${toggle.dataset.index}`);
  const chevron = toggle.querySelector('.pdp-accordion-chevron');
  const isOpen = panel.classList.contains('open');

  document.querySelectorAll('.pdp-accordion-panel.open').forEach(el => el.classList.remove('open'));
  document.querySelectorAll('.pdp-accordion-chevron.open').forEach(el => el.classList.remove('open'));
  document.querySelectorAll('.pdp-accordion-toggle').forEach(el => el.setAttribute('aria-expanded', 'false'));

  if (!isOpen) {
    panel.classList.add('open');
    chevron.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
  }
});

/* ---------------------------------------------------------------------
   Discovery rail — stays client-side per Hasan's decision (the rail's
   products get indexed via their own /product/<slug> pages regardless
   of whether this rail itself is in the initial HTML). Unchanged from
   before SSR: same card markup, same /api/products/filter fetch,
   scoped to this product's product_type, excluding this product.
   --------------------------------------------------------------------- */
function productCard(p) {
  return `
    <div class="product-card snap-card shrink-0 w-[168px] sm:w-[220px]">
      <a href="/product/${encodeURIComponent(p.slug ?? '')}" class="block">
        <div class="product-media relative rounded-xl overflow-hidden bg-sand-100 aspect-[3/4]">
          <img src="${p.img}" alt="${p.name}" class="img-a w-full h-full object-cover" loading="lazy" />
          ${p.img2 ? `<img src="${p.img2}" alt="" class="img-b w-full h-full object-cover" loading="lazy" />` : ''}
          ${p.oos ? `<span class="absolute top-2 left-2 bg-slate-800/85 text-cream-50 text-[10px] font-bold px-2 py-0.5 rounded-full">Out of Stock</span>` : ''}
        </div>
        <div class="mt-2.5">
          <p class="text-sm text-slate-800 font-medium leading-snug line-clamp-2">${p.name}</p>
          <p class="text-sm mt-1">
            <span class="font-bold text-slate-800">${currency(p.price)}</span>
          </p>
        </div>
      </a>
    </div>`;
}

function mapProductToCard(p) {
  return {
    name: p.name || 'Untitled product',
    price: p.price,
    img: p.image || 'https://images.unsplash.com/photo-1522778119026-d647f0596c20?q=80&w=600&auto=format&fit=crop',
    img2: (Array.isArray(p.gallery) && p.gallery[0]) ? p.gallery[0] : null,
    oos: isOutOfStock(p),
    slug: p.slug,
  };
}

async function loadDiscovery() {
  const railEl = document.getElementById('pdpDiscoveryRail');
  try {
    const params = new URLSearchParams();
    if (product.product_type) params.set('product_type', product.product_type);
    const res = await fetch(`${API_BASE}/products/filter?${params.toString()}`);
    const payload = await res.json();
    if (payload.status === 'success' && Array.isArray(payload.data)) {
      const others = payload.data.filter(p => p.id !== product.id);
      if (others.length === 0) {
        // Fall back to random products so the rail is never empty,
        // e.g. when this is the only product of its type.
        const randomRes = await fetch(`${API_BASE}/products/random?limit=6`);
        const randomPayload = await randomRes.json();
        if (randomPayload.status === 'success' && Array.isArray(randomPayload.data)) {
          const filtered = randomPayload.data.filter(p => p.id !== product.id);
          railEl.innerHTML = filtered.map(mapProductToCard).map(productCard).join('');
        }
      } else {
        railEl.innerHTML = others.map(mapProductToCard).map(productCard).join('');
      }
      lucide.createIcons();
    }
  } catch (err) {
    console.error('Failed to load discovery rail:', err);
  }
}

/* =======================================================================
   Below: cart drawer / search overlay / mobile menu / theme toggle —
   identical behavior to index.js, reused as-is since product.html
   ships the exact same markup for these (nav, overlays, footer).
   ======================================================================= */

/* ---------------- Cart ---------------- */
const cartCountEl = document.getElementById('cartCount');

/* Reflects the caller's real cart (guest or logged-in — resolved
   server-side, see cart_service.get_cart_owner) rather than a
   per-page-load local counter that reset to 0 on every navigation. */
async function refreshCartCount() {
  try {
    const res = await fetch(`${API_BASE}/cart`);
    const payload = await res.json();
    if (payload.status === 'success') {
      cartCountEl.textContent = payload.data.total_items || 0;
    }
  } catch (err) {
    console.error('Failed to load cart count:', err);
  }
}

const cartOverlay = document.getElementById('cartOverlay');
const cartDrawer = document.getElementById('cartDrawer');
function openCart() {
  cartOverlay.classList.add('open');
  cartDrawer.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeCart() {
  cartOverlay.classList.remove('open');
  cartDrawer.classList.remove('open');
  document.body.style.overflow = '';
}
document.getElementById('cartBtn').addEventListener('click', openCart);
document.getElementById('mobileCartBtn').addEventListener('click', openCart);
document.getElementById('cartCloseBtn').addEventListener('click', closeCart);
document.getElementById('cartOverlay').addEventListener('click', closeCart);
document.getElementById('cartStartShoppingBtn').addEventListener('click', () => {
  closeCart();
  window.location.href = '/products';
});

/* ---------------- Search ---------------- */
const searchOverlay = document.getElementById('searchOverlay');
function openSearch() {
  searchOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('searchInput').focus(), 100);
}
function closeSearch() {
  searchOverlay.classList.remove('open');
  document.body.style.overflow = '';
}
document.getElementById('searchBtn').addEventListener('click', openSearch);
document.getElementById('mobileSearchBtn').addEventListener('click', openSearch);
document.getElementById('searchCloseBtn').addEventListener('click', closeSearch);
searchOverlay.addEventListener('click', e => { if (e.target === searchOverlay) closeSearch(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeSearch(); closeCart(); }
});

const searchInputEl = document.getElementById('searchInput');
if (searchInputEl) {
  searchInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const term = searchInputEl.value.trim();
      if (term) {
        window.location.href = `/products?search=${encodeURIComponent(term)}`;
      }
    }
  });
}

/* ---------------- Mobile menu ---------------- */
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const mobileMenu = document.getElementById('mobileMenu');
mobileMenuBtn.addEventListener('click', () => {
  const isOpen = mobileMenu.classList.toggle('open');
  mobileMenuBtn.setAttribute('aria-expanded', isOpen);
  mobileMenuBtn.innerHTML = isOpen ? '<i data-lucide="x" class="w-6 h-6"></i>' : '<i data-lucide="menu" class="w-6 h-6"></i>';
  lucide.createIcons();
});

/* ---------------- Theme toggle (visual, capsule navbar) ---------------- */
const themeToggleBtn = document.getElementById('themeToggleBtn');
let isDarkIcon = true;
themeToggleBtn.addEventListener('click', () => {
  isDarkIcon = !isDarkIcon;
  themeToggleBtn.innerHTML = isDarkIcon
    ? '<i data-lucide="moon" class="w-[18px] h-[18px]"></i>'
    : '<i data-lucide="sun" class="w-[18px] h-[18px]"></i>';
  lucide.createIcons();
});

/* ---------------------------------------------------------------------
   Boot — no fetch, no wait. The page is already fully rendered; this
   only wires up interactivity and loads the (still client-side)
   discovery rail.
   --------------------------------------------------------------------- */
initGallery();
initColorSwatches();
refreshColorAvailability();
updateAddToCartState();
renderAccordionFaq();
loadDiscovery();
refreshCartCount();
lucide.createIcons();

