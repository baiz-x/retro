// orders.js — customer order history page (templates/orders.html).
// Fetches GET /api/account/orders (logged-in users only — see
// routes/order_route.py's api_login_required) and renders each order
// as a click-to-expand card: header always visible (ID, date, total,
// status), body reveals on click (status tracker, line items, money
// breakdown, tracking link).
//
// Navbar/search/menu behaviour comes from static/nav.js; English/Bangla
// swapping comes from static/i18n.js (data-bn attributes in the markup
// below are picked up automatically by its MutationObserver).

// Status pipeline — mirrors models/order.py's OrderStatus. Keep this
// list in sync if that enum ever changes.
const STATUS_STEPS = ["Pending", "Packaged", "Picked", "Transit", "Delivered"];
const STATUS_CLASS = {
  Pending: "status-pending", Packaged: "status-packaged", Picked: "status-picked",
  Transit: "status-transit", Delivered: "status-delivered", Failed: "status-failed",
};
const STATUS_BN = {
  Pending: "পেন্ডিং", Packaged: "প্যাকেজড", Picked: "পিকড আপ",
  Transit: "ট্রানজিটে", Delivered: "ডেলিভারড", Failed: "ফেইলড",
};
// The API should send the exact enum value, but match case/wording
// loosely so "transit" / "In Transit" / "shipped" can't silently break
// the tracker (indexOf would return -1 and light up nothing).
const STATUS_ALIASES = {
  pending: "Pending", packaged: "Packaged", packed: "Packaged",
  picked: "Picked", "picked up": "Picked", transit: "Transit",
  "in transit": "Transit", shipped: "Transit", delivered: "Delivered", failed: "Failed",
};
function normalizeStatus(raw) {
  const s = STATUS_ALIASES[String(raw ?? "").trim().toLowerCase()] || null;
  if (!s) console.warn("[orders] Unknown status from API:", raw);
  return s;
}

const PAYMENT_TYPE_LABEL = {
  postpaid: { en: "Pay on Delivery (added to total)", bn: "ডেলিভারির সময় দিতে হবে (টোটালে যোগ করা)" },
  prepaid:  { en: "Prepaid (settled separately)",     bn: "আগেই পেমেন্ট করা (আলাদাভাবে মেটানো)" },
  included: { en: "Included (folded into total)",     bn: "টোটালের ভেতরেই ধরা আছে" },
};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const locale = document.documentElement.lang === "bn" ? "bn-BD" : undefined;
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

function formatMoney(n) {
  return "৳" + Number(n || 0).toLocaleString();
}

// Order-item image: OrderItem.to_dict() wasn't visible when this was
// written, so try every key it plausibly uses. If none match, the console
// prints the item's real keys so the right one can be added here.
function itemImage(item) {
  const p = item.product || {};
  let src = item.product_image || item.image || item.image_url || item.img ||
            item.thumbnail || item.product_img || p.image || p.img || p.image_url ||
            (Array.isArray(item.images) ? item.images[0] : "") || "";
  if (!src) {
    console.warn("[orders] No image field on order item. Available keys:", Object.keys(item));
    return "";
  }
  if (!/^(https?:)?\/\//.test(src) && !src.startsWith("/") && !src.startsWith("data:")) src = "/" + src;
  return src;
}

function renderTracker(order, status) {
  if (status === "Failed") {
    const en = order.tracking_link ? "Delivery failed — check the tracking link below for details." : "Delivery failed.";
    const bn = order.tracking_link ? "ডেলিভারি ফেইল হয়েছে — বিস্তারিত জানতে নিচের ট্র্যাকিং লিংক দেখুন।" : "ডেলিভারি ফেইল হয়েছে।";
    return `<div class="tracker-failed">
      <svg class="w-4 h-4" style="display:inline;vertical-align:-2px;margin-right:6px" aria-hidden="true"><use href="#icon-x"></use></svg>
      <span data-bn="${bn}">${en}</span>
    </div>`;
  }
  const currentIndex = STATUS_STEPS.indexOf(status);
  return `<div class="tracker">
    ${STATUS_STEPS.map((step, i) => {
      let cls = "";
      if (i < currentIndex) cls = "done";
      else if (i === currentIndex) cls = "current";
      return `<div class="tracker-step ${cls}">
        <span class="tracker-line"></span>
        <span class="tracker-dot">${i < currentIndex ? "✓" : i + 1}</span>
        <span class="tracker-label" data-bn="${STATUS_BN[step]}">${step}</span>
      </div>`;
    }).join("")}
  </div>`;
}

function renderItems(items) {
  if (!items || !items.length) return "";
  return `<div class="order-items">
    ${items.map(item => {
      const img = itemImage(item);
      return `
      <div class="order-item-row">
        ${img
          ? `<img class="order-item-img" src="${escapeHtml(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
          : `<div class="order-item-img"></div>`}
        <div class="order-item-info">
          <div class="order-item-name">${item.product_name || item.name ? escapeHtml(item.product_name || item.name) : `<span data-bn="আইটেম">Item</span>`}</div>
          ${item.selected_variants ? `<div class="order-item-variant">${escapeHtml(Object.values(item.selected_variants).join(" / "))}</div>` : ""}
        </div>
        <div class="order-item-qty"><span data-bn="পরিমাণ">Qty</span> ${escapeHtml(item.quantity)} · ${formatMoney(item.price)}</div>
      </div>`;
    }).join("")}
  </div>`;
}

function renderMoneyBreakdown(order) {
  const pt = PAYMENT_TYPE_LABEL[order.payment_type];
  const paymentTypeHtml = pt
    ? `<span data-bn="${pt.bn}">${pt.en}</span>`
    : `<span>${escapeHtml(order.payment_type)}</span>`;

  return `<div class="order-money-breakdown">
    <div class="order-money-row"><span data-bn="সাবটোটাল">Subtotal</span><span>${formatMoney(order.subtotal)}</span></div>
    <div class="order-money-row"><span data-bn="ডেলিভারি চার্জ">Delivery Charge</span><span>${formatMoney(order.shipping_fee)}</span></div>
    <div class="order-money-row">${paymentTypeHtml}<span></span></div>
    <div class="order-money-row total">
      <span><span data-bn="ডেলিভারি ম্যানকে দিন">Pay the Delivery Man</span><span class="cod-label" data-bn="ক্যাশ অন ডেলিভারি">Collect on Delivery</span></span>
      <span>${formatMoney(order.collect_on_delivery ?? order.total)}</span>
    </div>
  </div>`;
}

function renderOrder(order) {
  const status = normalizeStatus(order.status);
  const statusClass = STATUS_CLASS[status] || "status-pending";
  const pillText = status || order.status;
  const pillBn = status ? ` data-bn="${STATUS_BN[status]}"` : "";
  return `<div class="order-card" data-order-card="${escapeHtml(order.order_id)}">
    <button type="button" class="order-card-head" data-order-toggle="${escapeHtml(order.order_id)}" aria-expanded="false">
      <div class="order-meta">
        <span><strong><span data-bn="অর্ডার #">Order #</span>${escapeHtml(order.order_id)}</strong><time data-iso="${escapeHtml(order.created_at || "")}">${formatDate(order.created_at)}</time></span>
        <span><strong>${formatMoney(order.total)}</strong><span data-bn="মোট">Total</span></span>
      </div>
      <div class="flex items-center gap-3">
        <span class="status-pill ${statusClass}"${pillBn}>${escapeHtml(pillText)}</span>
        <svg class="order-chevron" aria-hidden="true"><use href="#icon-chevron-right"></use></svg>
      </div>
    </button>
    <div class="order-card-body">
      ${renderTracker(order, status)}
      ${renderItems(order.items)}
      ${renderMoneyBreakdown(order)}
      <div class="order-card-foot">
        <span class="text-xs text-slate-500/70"><span data-bn="ডেলিভারি ঠিকানা:">Ship to:</span> ${escapeHtml(order.address || "—")}</span>
        ${order.tracking_link
          ? `<a class="track-link-btn" href="${escapeHtml(order.tracking_link)}" target="_blank" rel="noopener noreferrer">
              <span data-bn="পার্সেল ট্র্যাক করুন">Track Parcel</span>
              <svg class="w-3.5 h-3.5" aria-hidden="true"><use href="#icon-arrow-right"></use></svg>
            </a>`
          : `<span class="text-xs text-slate-500/50" data-bn="ট্র্যাকিং লিংক এখনো দেওয়া হয়নি">Tracking link not added yet</span>`
        }
      </div>
    </div>
  </div>`;
}

function renderEmptyState() {
  return `<div class="empty-state">
    <svg aria-hidden="true"><use href="#icon-search"></use></svg>
    <p class="font-display text-xl uppercase tracking-wide mb-2" data-bn="এখনো কোনো অর্ডার নেই">No orders yet</p>
    <p class="text-sm text-slate-500/70 mb-6" data-bn="অর্ডার দিলে সেটা এখানে দেখা যাবে।">When you place an order, it'll show up here.</p>
    <a href="/products" data-bn="শপিং শুরু করুন" class="inline-flex items-center gap-2 bg-sage-400 text-cream-50 font-bold uppercase tracking-wide text-sm px-6 py-3 rounded-full hover:bg-sage-500 transition-colors">
      Start Shopping
    </a>
  </div>`;
}

async function loadOrders() {
  const container = document.getElementById("ordersList");
  try {
    // no-store + cache-buster: a status/tracking change in admin must
    // show up on the next load, never a cached copy from browser/Cloudflare.
    const res = await fetch("/api/account/orders?_=" + Date.now(), {
      credentials: "same-origin",
      cache: "no-store",
    });
    const payload = await res.json();

    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = "/login?next=/orders";
        return;
      }
      throw new Error(payload.message || "Failed to load orders");
    }

    const orders = payload.data || [];
    container.innerHTML = orders.length
      ? orders.map(renderOrder).join("")
      : renderEmptyState();

    attachExpandHandlers();
    if (window.RFi18n) window.RFi18n.apply(container);
  } catch (err) {
    console.error("[orders] load failed:", err);
    container.innerHTML = `<div class="empty-state">
      <p class="text-sm text-slate-500/70" data-bn="অর্ডার লোড করতে সমস্যা হয়েছে। পেজটা রিফ্রেশ করুন।">Something went wrong loading your orders. Please refresh the page.</p>
    </div>`;
    if (window.RFi18n) window.RFi18n.apply(container);
  }
}

// Click-to-expand — one order open at a time is NOT enforced (each
// card toggles independently), matching how Daraz/Amazon let you open
// multiple order cards side by side rather than accordion-style.
function attachExpandHandlers() {
  document.querySelectorAll("[data-order-toggle]").forEach(btn => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".order-card");
      const isExpanded = card.classList.toggle("expanded");
      btn.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    });
  });
}

// Dates are formatted in JS, so they need re-formatting when the language flips.
document.addEventListener("rf:langchange", () => {
  document.querySelectorAll("time[data-iso]").forEach(t => {
    if (t.dataset.iso) t.textContent = formatDate(t.dataset.iso);
  });
});

loadOrders();
