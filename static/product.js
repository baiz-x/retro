lucide.createIcons();

const API_BASE = '/api';

/* Currency: ৳ (BDT) — the dashboard uses this everywhere (see
   dashboard.js/dashboard.html). index.js on the homepage currently
   prints ₹ instead — that's a pre-existing bug on that page, left
   untouched here since fixing it wasn't asked for and index.js wasn't
   part of this task. This page uses the correct currency throughout. */
const currency = n => '৳' + Number(n).toLocaleString('en-BD');

/* Below this stock number (inclusive) the "order fast" note shows.
   No such threshold exists anywhere in the current codebase (the
   homepage/dashboard only ever show a binary in-stock/out-of-stock
   state — see index.js's `oos` flag) — this is a new constant
   introduced for this page. Easy to change in one place later. */
const LOW_STOCK_THRESHOLD = 5;

/* ---------------------------------------------------------------------
   Slug resolution
   --------------------------------------------------------------------- */
function getSlugFromUrl() {
  // Supports both /product/<slug> (path-based, matching the product
  // card links already on the homepage — see index.js productCard())
  // and /product.html?slug=<slug> (query-based, for direct static
  // hosting without server-side routing). Path wins if both present.
  const pathMatch = window.location.pathname.match(/\/product\/([^/]+)\/?$/);
  if (pathMatch) return decodeURIComponent(pathMatch[1]);
  const params = new URLSearchParams(window.location.search);
  return params.get('slug');
}

/* ---------------------------------------------------------------------
   State
   --------------------------------------------------------------------- */
let product = null;
let selectedSize = null;
let selectedColor = null; // boots axis only
let quantity = 1;
let galleryImages = [];
let galleryIndex = 0;

/* ---------------------------------------------------------------------
   Fetch + boot
   --------------------------------------------------------------------- */
async function loadProduct() {
  const slug = getSlugFromUrl();
  const loadingEl = document.getElementById('pdpLoading');
  const notFoundEl = document.getElementById('pdpNotFound');
  const contentEl = document.getElementById('pdpContent');

  if (!slug) {
    loadingEl.classList.add('hidden');
    notFoundEl.classList.remove('hidden');
    lucide.createIcons();
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/products/slug/${encodeURIComponent(slug)}`);
    const payload = await res.json();

    if (!res.ok || payload.status !== 'success' || !payload.data) {
      loadingEl.classList.add('hidden');
      notFoundEl.classList.remove('hidden');
      lucide.createIcons();
      return;
    }

    product = payload.data;
    loadingEl.classList.add('hidden');
    contentEl.classList.remove('hidden');
    renderProduct(product);
    loadDiscovery(product);
  } catch (err) {
    console.error('Failed to load product:', err);
    loadingEl.classList.add('hidden');
    notFoundEl.classList.remove('hidden');
    lucide.createIcons();
  }
}

/* ---------------------------------------------------------------------
   Render — top level dispatcher
   --------------------------------------------------------------------- */
function renderProduct(p) {
  document.title = `${p.name || 'Product'} — Kit Collective`;

  renderBreadcrumb(p);
  renderGallery(p);
  renderInfoHeader(p);
  renderIdentityPills(p);
  renderPriceAndStock(p);
  renderSizeSection(p);
  renderColorSection(p);
  renderPersonalization(p);
  renderAccordionDescription(p);
  renderAccordionFaq(p);
  updateAddToCartState();

  lucide.createIcons();
}

/* ---------------------------------------------------------------------
   Breadcrumb
   --------------------------------------------------------------------- */
function renderBreadcrumb(p) {
  const typeLabel = { jersey: 'Jerseys', boots: 'Boots', others: 'Others' }[p.product_type] || 'Shop';
  const typeEl = document.getElementById('breadcrumbType');
  typeEl.innerHTML = `<a href="/products?product_type=${encodeURIComponent(p.product_type || '')}" class="hover:text-sage-600 transition-colors">${typeLabel}</a>`;
  document.getElementById('breadcrumbName').textContent = p.name || '';
}

/* ---------------------------------------------------------------------
   Gallery — main image + gallery[] array + axis_images (defensive:
   axis_images is currently always sent as {} by the dashboard — see
   dashboard.js handleProductUpload — so this reads it if populated in
   the future but never assumes it is).
   --------------------------------------------------------------------- */
function collectGalleryImages(p) {
  const images = [];
  if (p.image) images.push(p.image);
  if (Array.isArray(p.gallery)) {
    p.gallery.forEach(url => { if (url && !images.includes(url)) images.push(url); });
  }
  // axis_images: { axisName: { value: url } } — pull in any distinct
  // URLs not already covered, so a product with per-variant photos
  // (once the dashboard supports uploading them) shows them here too.
  const axisImages = (p.variants && p.variants.axis_images) || {};
  Object.values(axisImages).forEach(valueMap => {
    if (valueMap && typeof valueMap === 'object') {
      Object.values(valueMap).forEach(url => {
        if (url && !images.includes(url)) images.push(url);
      });
    }
  });
  if (images.length === 0) {
    images.push('https://images.unsplash.com/photo-1522778119026-d647f0596c20?q=80&w=1200&auto=format&fit=crop');
  }
  return images;
}

function renderGallery(p) {
  galleryImages = collectGalleryImages(p);
  galleryIndex = 0;
  showGalleryImage(0);

  const thumbsEl = document.getElementById('galleryThumbs');
  if (galleryImages.length <= 1) {
    thumbsEl.innerHTML = '';
  } else {
    thumbsEl.innerHTML = galleryImages.map((url, i) => `
      <button class="pdp-gallery-thumb${i === 0 ? ' active' : ''}" data-index="${i}" role="tab" aria-selected="${i === 0}" aria-label="View image ${i + 1}">
        <img src="${url}" alt="" loading="lazy" />
      </button>
    `).join('');
  }

  const oosBadge = document.getElementById('galleryOosBadge');
  oosBadge.classList.toggle('hidden', !isOutOfStock(p));

  const prevBtn = document.getElementById('galleryPrevBtn');
  const nextBtn = document.getElementById('galleryNextBtn');
  const showNav = galleryImages.length > 1;
  prevBtn.style.display = showNav ? 'flex' : 'none';
  nextBtn.style.display = showNav ? 'flex' : 'none';
}

function showGalleryImage(index) {
  if (galleryImages.length === 0) return;
  galleryIndex = ((index % galleryImages.length) + galleryImages.length) % galleryImages.length;
  const mainImg = document.getElementById('galleryMainImg');
  mainImg.src = galleryImages[galleryIndex];
  mainImg.alt = product ? product.name : '';
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
   Info header (club/name)
   --------------------------------------------------------------------- */
function renderInfoHeader(p) {
  const clubEl = document.getElementById('infoClub');
  if (p.club) {
    clubEl.textContent = p.club;
    clubEl.classList.remove('hidden');
  } else {
    clubEl.classList.add('hidden');
  }
  document.getElementById('infoName').textContent = p.name || 'Untitled product';
}

/* ---------------------------------------------------------------------
   Identity pills — LOCKED display of fixed-per-listing fields, per
   type. These are never clickable: jersey's edition/version/kit_type,
   boots' type, others' type — all identity columns (axis: false in
   dashboard.js's COLLECTION_FIELDS), meaning one value already fixed
   for this exact listing, not a per-SKU choice. Confirmed: shown so
   the buyer understands what they're buying, not to be changed.
   --------------------------------------------------------------------- */
function renderIdentityPills(p) {
  const pills = [];

  if (p.product_type === 'jersey') {
    if (p.edition) pills.push({ label: 'Edition', value: p.edition });
    if (p.version) pills.push({ label: 'Version', value: p.version });
    if (p.kit_type) pills.push({ label: 'Kit', value: p.kit_type });
  } else if (p.product_type === 'boots') {
    if (p.type) pills.push({ label: 'Type', value: p.type });
    if (p.brand) pills.push({ label: 'Brand', value: p.brand });
  } else if (p.product_type === 'others') {
    if (p.type) pills.push({ label: 'Type', value: p.type });
    if (p.color) pills.push({ label: 'Color', value: p.color });
  }

  const container = document.getElementById('infoIdentityPills');
  if (pills.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = pills.map(pill => `
    <span class="pdp-identity-pill" aria-disabled="true">
      <span class="pdp-identity-pill-label">${pill.label}:</span> ${pill.value}
    </span>
  `).join('');
}

/* ---------------------------------------------------------------------
   Stock resolution — mirrors the exact semantics of reduce_variant_stock
   in product_service.py:
     - "unified" mode: product.stock is the ONE authoritative number for
       every combination, regardless of which size/color is picked.
     - "per_variant" mode: each entry in variants.combinations has its
       own stock; product.stock is only "a rough overall total... not
       the authoritative number" (per that function's own comment).
       Once a size (and color, for boots) is selected, the matching
       combination's own stock is authoritative; before a size is
       picked, no single number is meaningful, so we show the sum
       across all combinations as a rough "in stock somewhere" signal.
   --------------------------------------------------------------------- */
function isOutOfStock(p) {
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
  // Try to find the combination matching current selection.
  const needsSize = sizeAxisExists(p);
  const needsColor = p.product_type === 'boots' && colorAxisExists(p);
  if (needsSize && !selectedSize) {
    // Nothing picked yet — rough total across all combinations, not
    // authoritative (matches reduce_variant_stock's own framing).
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
   Price + stock note
   --------------------------------------------------------------------- */
function renderPriceAndStock(p) {
  const price = p.price;
  document.getElementById('infoPrice').textContent = currency(price);
  document.getElementById('mobileCtaPrice').textContent = currency(price);
  updateStockNote();
}

function updateStockNote() {
  const { stock, resolved } = getResolvedStock(product);
  const noteEl = document.getElementById('infoStockNote');
  const mobileNoteEl = document.getElementById('mobileCtaStockNote');

  noteEl.className = 'pdp-stock-note';
  mobileNoteEl.className = 'pdp-stock-note text-[11px]';

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
    // Pre-order framing per the brief: quantity section only shows
    // when stock is genuinely low; otherwise this is a pre-order /
    // sourced-on-demand listing, so the note says that instead of a
    // reassuring-but-unverifiable "in stock" number.
    text = 'Pre-Order — all products will be sourced after order';
    noteEl.classList.add('pdp-stock-preorder');
    mobileNoteEl.classList.add('pdp-stock-preorder');
  }
  noteEl.textContent = text;
  mobileNoteEl.textContent = text;
}

/* ---------------------------------------------------------------------
   Size pills — the only variant axis for jersey/others; one of two
   axes (with color) for boots. Always sourced from variants.axes.size
   (per-SKU choices), never from a fixed identity column.
   --------------------------------------------------------------------- */
function renderSizeSection(p) {
  const section = document.getElementById('sizeSection');
  if (!sizeAxisExists(p)) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  const sizes = p.variants.axes.size;
  selectedSize = null;
  document.getElementById('sizeSelectedLabel').textContent = '';

  const pillsEl = document.getElementById('sizePills');
  pillsEl.innerHTML = sizes.map(size => {
    const available = isSizeAvailable(p, size);
    return `
      <button type="button" class="pdp-pill${available ? '' : ' pdp-pill-disabled'}" data-size="${size}" role="radio" aria-checked="false" ${available ? '' : 'disabled aria-label="' + size + ', out of stock"'}>
        ${size}
      </button>
    `;
  }).join('');
}

function isSizeAvailable(p, size) {
  if ((p.variant_mode || 'unified') !== 'per_variant') {
    return (p.stock || 0) > 0;
  }
  const combos = (p.variants && p.variants.combinations) || [];
  if (combos.length === 0) return (p.stock || 0) > 0;
  // For boots (size×color), a size is "available" if ANY color at
  // that size has stock — picking the size doesn't fully determine
  // stock until color is also picked.
  return combos.some(c => c.size === size && (Number(c.stock) || 0) > 0);
}

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
   Color pills — boots-only axis (size×color). Never rendered for
   jersey/others, where color (if present at all) is an identity field,
   not a variant.
   --------------------------------------------------------------------- */
function renderColorSection(p) {
  const section = document.getElementById('colorSection');
  if (p.product_type !== 'boots' || !colorAxisExists(p)) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  const colors = p.variants.axes.color;
  selectedColor = null;
  document.getElementById('colorSelectedLabel').textContent = '';

  const pillsEl = document.getElementById('colorPills');
  pillsEl.innerHTML = colors.map(color => `
    <button type="button" class="pdp-pill" data-color="${color}" role="radio" aria-checked="false">
      <span class="pdp-pill-swatch" style="background:${resolveSwatch(color)}"></span>${color}
    </button>
  `).join('');
  refreshColorAvailability();
}

// Best-effort mapping of common color names to a CSS value for the
// swatch dot. Falls back to a neutral gray dot (never blocks
// rendering) for anything not in this list — dashboard's color field
// is free-typed text, so this can never be exhaustive.
function resolveSwatch(name) {
  const known = {
    black: '#1a1a1a', white: '#f5f5f5', red: '#c0392b', blue: '#2c5f8a',
    green: '#3d6b4f', yellow: '#d4af37', navy: '#1b2a4a', grey: '#8a8a8a',
    gray: '#8a8a8a', orange: '#c9702a', purple: '#6c4a8a', pink: '#c97a9a',
    brown: '#6b4a35', beige: '#c9b896', gold: '#c9a227', silver: '#b0b0b0',
  };
  const key = String(name).trim().toLowerCase();
  return known[key] || '#a7bda2';
}

function refreshColorAvailability() {
  if (!product || product.product_type !== 'boots') return;
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
   Jersey personalization — jersey only. Captured in JS state only:
   there is no column for this on Product, CartItem, or OrderItem yet
   (confirmed — Hasan is adding it separately). Values are read at
   add-to-cart time and logged/attached to the (currently client-side
   only) cart payload; see addToCart() below and its comment.
   --------------------------------------------------------------------- */
function renderPersonalization(p) {
  const section = document.getElementById('personalizeSection');
  section.classList.toggle('hidden', p.product_type !== 'jersey');
}

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
   Add to cart state — disabled until required selections are made.
   No real cart/order-creation endpoint exists yet in product_route.py
   (only /admin/products/<id>/stock for manual admin adjustment), so
   this button currently opens the bag drawer with a locally-tracked
   count, matching exactly what index.js's Add button already does on
   the homepage — not a real persisted cart. Swap the TODO below for a
   real POST once that endpoint exists.
   --------------------------------------------------------------------- */
function updateAddToCartState() {
  const btn = document.getElementById('addToCartBtn');
  const mobileBtn = document.getElementById('mobileAddToCartBtn');
  const hint = document.getElementById('selectionHint');

  const oos = isOutOfStock(product);
  const needsSize = sizeAxisExists(product);
  const needsColor = product.product_type === 'boots' && colorAxisExists(product);
  const missingSelection = (needsSize && !selectedSize) || (needsColor && !selectedColor);

  [btn, mobileBtn].forEach(b => { b.disabled = oos; });

  const label = oos ? 'Out of Stock' : 'Reserve this item';
  document.getElementById('addToCartLabel').textContent = label;
  document.getElementById('mobileAddToCartLabel').textContent = oos ? 'Out of Stock' : 'Reserve';

  hint.classList.toggle('hidden', !missingSelection || oos);
  updateQtyDisplay();
}

function addToCart() {
  const needsSize = sizeAxisExists(product);
  const needsColor = product.product_type === 'boots' && colorAxisExists(product);
  if ((needsSize && !selectedSize) || (needsColor && !selectedColor)) {
    document.getElementById('selectionHint').classList.remove('hidden');
    document.getElementById('sizeSection').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  // TODO(Hasan): once CartItem/selected_variants + jersey personalization
  // columns exist and a real POST /api/cart (or similar) route is added,
  // replace this local counter with a real request carrying:
  //   { product_id: product.id, quantity, selected_variants: {size, color?},
  //     personalization: {name, number} }
  cartCount++;
  cartCountEl.textContent = cartCount;

  const btn = document.getElementById('addToCartBtn');
  const mobileBtn = document.getElementById('mobileAddToCartBtn');
  const originalLabel = document.getElementById('addToCartLabel').textContent;
  document.getElementById('addToCartLabel').textContent = 'Added';
  document.getElementById('mobileAddToCartLabel').textContent = 'Added';
  setTimeout(() => {
    document.getElementById('addToCartLabel').textContent = originalLabel;
    document.getElementById('mobileAddToCartLabel').textContent = 'Reserve';
  }, 900);
}

document.getElementById('addToCartBtn').addEventListener('click', addToCart);
document.getElementById('mobileAddToCartBtn').addEventListener('click', addToCart);

/* ---------------------------------------------------------------------
   Accordion — Description / Shipping / FAQ. Description is dynamic
   (from p.description); Shipping is static per the brief's exact
   copy/numbers (already in product.html); FAQ reuses the homepage's
   faqData content (see index.js) since no product-specific FAQ field
   exists on the Product model.
   --------------------------------------------------------------------- */
function renderAccordionDescription(p) {
  const el = document.getElementById('accordionDescription');
  el.textContent = p.description && p.description.trim()
    ? p.description
    : 'No description provided for this product yet.';
}

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
// Description starts open per the brief's stated order.
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
   Discovery rail — horizontally scrollable, same card markup/behavior
   as the homepage's rails (see index.js productCard()/mapProductToCard()).
   Scoped to the current product's product_type via /api/products/filter,
   excluding the current product itself.
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
    oos: !p.stock || p.stock <= 0,
    slug: p.slug,
  };
}

async function loadDiscovery(currentProduct) {
  const railEl = document.getElementById('pdpDiscoveryRail');
  try {
    const params = new URLSearchParams();
    if (currentProduct.product_type) params.set('product_type', currentProduct.product_type);
    const res = await fetch(`${API_BASE}/products/filter?${params.toString()}`);
    const payload = await res.json();
    if (payload.status === 'success' && Array.isArray(payload.data)) {
      const others = payload.data.filter(p => p.id !== currentProduct.id);
      if (others.length === 0) {
        // Fall back to random products so the rail is never empty,
        // e.g. when this is the only product of its type.
        const randomRes = await fetch(`${API_BASE}/products/random?limit=6`);
        const randomPayload = await randomRes.json();
        if (randomPayload.status === 'success' && Array.isArray(randomPayload.data)) {
          const filtered = randomPayload.data.filter(p => p.id !== currentProduct.id);
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
let cartCount = 0;
const cartCountEl = document.getElementById('cartCount');

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

/* ---------------- Reveal the mobile CTA strip once a product has
   loaded (kept separate from the always-visible bottom nav) ---------------- */
function revealMobileCta() {
  document.getElementById('mobileCtaStrip').classList.remove('hidden');
}

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
loadProduct().then(() => {
  if (product) revealMobileCta();
});

