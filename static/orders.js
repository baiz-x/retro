// orders.js — customer order history page (templates/orders.html).
// Fetches GET /api/account/orders (logged-in users only — see
// routes/order_route.py's api_login_required) and renders each order
// as a click-to-expand card: header always visible (ID, date, total,
// status), body reveals on click (status tracker, line items, money
// breakdown, tracking link).

// Status pipeline — mirrors models/order.py's OrderStatus. Keep this
// list in sync if that enum ever changes.
const STATUS_STEPS = ["Pending", "Packaged", "Picked", "Transit", "Delivered"];
const STATUS_CLASS = {
  Pending: "status-pending", Packaged: "status-packaged", Picked: "status-picked",
  Transit: "status-transit", Delivered: "status-delivered", Failed: "status-failed",
};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatMoney(n) {
  return "৳" + Number(n || 0).toLocaleString();
}

function renderTracker(order) {
  if (order.status === "Failed") {
    return `<div class="tracker-failed">
      <svg class="w-4 h-4" style="display:inline;vertical-align:-2px;margin-right:6px" aria-hidden="true"><use href="#icon-x"></use></svg>
      Delivery failed${order.tracking_link ? " — check the tracking link below for details." : "."}
    </div>`;
  }
  const currentIndex = STATUS_STEPS.indexOf(order.status);
  return `<div class="tracker">
    ${STATUS_STEPS.map((step, i) => {
      let cls = "";
      if (i < currentIndex) cls = "done";
      else if (i === currentIndex) cls = "current";
      return `<div class="tracker-step ${cls}">
        <span class="tracker-line"></span>
        <span class="tracker-dot">${i < currentIndex ? "✓" : i + 1}</span>
        <span class="tracker-label">${step}</span>
      </div>`;
    }).join("")}
  </div>`;
}

function renderItems(items) {
  if (!items || !items.length) return "";
  return `<div class="order-items">
    ${items.map(item => `
      <div class="order-item-row">
        <img class="order-item-img" src="${escapeHtml(item.product_image || item.image || '')}" alt="" onerror="this.style.visibility='hidden'">
        <div class="order-item-info">
          <div class="order-item-name">${escapeHtml(item.product_name || item.name || "Item")}</div>
          ${item.selected_variants ? `<div class="order-item-variant">${escapeHtml(Object.values(item.selected_variants).join(" / "))}</div>` : ""}
        </div>
        <div class="order-item-qty">Qty ${escapeHtml(item.quantity)} · ${formatMoney(item.price)}</div>
      </div>
    `).join("")}
  </div>`;
}

function renderMoneyBreakdown(order) {
  const paymentTypeLabel = {
    postpaid: "Pay on Delivery (added to total)",
    prepaid: "Prepaid (settled separately)",
    included: "Included (folded into total)",
  }[order.payment_type] || order.payment_type;

  return `<div class="order-money-breakdown">
    <div class="order-money-row"><span>Subtotal</span><span>${formatMoney(order.subtotal)}</span></div>
    <div class="order-money-row"><span>Delivery Charge</span><span>${formatMoney(order.shipping_fee)}</span></div>
    <div class="order-money-row"><span>${escapeHtml(paymentTypeLabel)}</span><span></span></div>
    <div class="order-money-row total">
      <span>Pay the Delivery Man<span class="cod-label">Collect on Delivery</span></span>
      <span>${formatMoney(order.collect_on_delivery ?? order.total)}</span>
    </div>
  </div>`;
}

function renderOrder(order) {
  const statusClass = STATUS_CLASS[order.status] || "status-pending";
  return `<div class="order-card" data-order-card="${escapeHtml(order.order_id)}">
    <button type="button" class="order-card-head" data-order-toggle="${escapeHtml(order.order_id)}" aria-expanded="false">
      <div class="order-meta">
        <span><strong>Order #${escapeHtml(order.order_id)}</strong>${formatDate(order.created_at)}</span>
        <span><strong>${formatMoney(order.total)}</strong>Total</span>
      </div>
      <div class="flex items-center gap-3">
        <span class="status-pill ${statusClass}">${escapeHtml(order.status)}</span>
        <svg class="order-chevron" aria-hidden="true"><use href="#icon-chevron-right"></use></svg>
      </div>
    </button>
    <div class="order-card-body">
      ${renderTracker(order)}
      ${renderItems(order.items)}
      ${renderMoneyBreakdown(order)}
      <div class="order-card-foot">
        <span class="text-xs text-slate-500/70">Ship to: ${escapeHtml(order.address || "—")}</span>
        ${order.tracking_link
          ? `<a class="track-link-btn" href="${escapeHtml(order.tracking_link)}" target="_blank" rel="noopener noreferrer">
              Track Parcel
              <svg class="w-3.5 h-3.5" aria-hidden="true"><use href="#icon-arrow-right"></use></svg>
            </a>`
          : `<span class="text-xs text-slate-500/50">Tracking link not added yet</span>`
        }
      </div>
    </div>
  </div>`;
}

function renderEmptyState() {
  return `<div class="empty-state">
    <svg aria-hidden="true"><use href="#icon-search"></use></svg>
    <p class="font-display text-xl uppercase tracking-wide mb-2">No orders yet</p>
    <p class="text-sm text-slate-500/70 mb-6">When you place an order, it'll show up here.</p>
    <a href="/products" class="inline-flex items-center gap-2 bg-sage-400 text-cream-50 font-bold uppercase tracking-wide text-sm px-6 py-3 rounded-full hover:bg-sage-500 transition-colors">
      Start Shopping
    </a>
  </div>`;
}

async function loadOrders() {
  const container = document.getElementById("ordersList");
  try {
    const res = await fetch("/api/account/orders", { credentials: "same-origin" });
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
  } catch (err) {
    container.innerHTML = `<div class="empty-state">
      <p class="text-sm text-slate-500/70">Something went wrong loading your orders. Please refresh the page.</p>
    </div>`;
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

loadOrders();

