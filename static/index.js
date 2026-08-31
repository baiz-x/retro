lucide.createIcons();

/* ---------------- Product rendering (card markup unchanged) ---------------- */
const API_BASE = '/api';

const currency = n => '₹' + Number(n).toLocaleString('en-IN');

function productCard(p) {
  return `
    <div class="product-card snap-card shrink-0 w-[168px] sm:w-[220px]">
      <a href="/product/${encodeURIComponent(p.slug ?? '')}" class="block">
        <div class="product-media relative rounded-xl overflow-hidden bg-sand-100 aspect-[3/4]">
          <img src="${p.img}" alt="${p.name}" class="img-a w-full h-full object-cover" loading="lazy" />
          ${p.img2 ? `<img src="${p.img2}" alt="" class="img-b w-full h-full object-cover" loading="lazy" />` : ''}
          ${p.badge ? `<span class="absolute top-2 left-2 bg-clay text-cream-50 text-[10px] font-bold px-2 py-0.5 rounded-full">${p.badge}</span>` : ''}
          ${p.oos ? `<span class="absolute top-2 left-2 bg-slate-800/85 text-cream-50 text-[10px] font-bold px-2 py-0.5 rounded-full">Out of Stock</span>` : ''}
          ${!p.oos ? `<button class="add-btn absolute bottom-2 right-2 bg-cream-50 text-slate-800 text-[10px] font-bold uppercase tracking-wide px-3 py-1.5 rounded-full hover:bg-sage-400 hover:text-cream-50 transition-colors" data-name="${p.name}">Add</button>` : ''}
        </div>
        <div class="mt-2.5">
          <p class="text-sm text-slate-800 font-medium leading-snug line-clamp-2">${p.name}</p>
          <p class="text-sm mt-1">
            <span class="font-bold text-slate-800">${currency(p.price)}</span>
            ${p.mrp ? `<span class="text-slate-500/50 line-through text-xs ml-1.5">${currency(p.mrp)}</span>` : ''}
          </p>
        </div>
      </a>
    </div>`;
}

// Maps a raw backend product (to_dict() shape) onto the fields productCard()
// expects. mrp/badge are left undefined on purpose — no discount/original-
// price field exists on the Product model, so no strike-through or badge
// renders for real products. That's a real gap versus the old mock data,
// not a silent fabrication of pricing that isn't there.
function mapProductToCard(product) {
  return {
    name: product.name || 'Untitled product',
    price: product.price,
    img: product.image || 'https://images.unsplash.com/photo-1522778119026-d647f0596c20?q=80&w=600&auto=format&fit=crop',
    img2: (Array.isArray(product.gallery) && product.gallery[0]) ? product.gallery[0] : null,
    oos: !product.stock || product.stock <= 0,
    slug: product.slug,
  };
}

const arrivalsRailEl = document.getElementById('arrivalsRail');
const discoveryRailEl = document.getElementById('discoveryRail');

async function loadArrivals() {
  try {
    const res = await fetch(`${API_BASE}/products?limit=7`);
    const payload = await res.json();
    if (payload.status === 'success' && Array.isArray(payload.data)) {
      arrivalsRailEl.innerHTML = payload.data.map(mapProductToCard).map(productCard).join('');
      lucide.createIcons();
    }
  } catch (err) {
    console.error('Failed to load new arrivals:', err);
  }
}

async function loadDiscovery() {
  try {
    const res = await fetch(`${API_BASE}/products/random?limit=5`);
    const payload = await res.json();
    if (payload.status === 'success' && Array.isArray(payload.data)) {
      // insertAdjacentHTML('beforeend') — same as before, so the hardcoded
      // promo tile stays first in the rail and cards are appended after it.
      discoveryRailEl.insertAdjacentHTML('beforeend', payload.data.map(mapProductToCard).map(productCard).join(''));
      lucide.createIcons();
    }
  } catch (err) {
    console.error('Failed to load random discovery:', err);
  }
}

loadArrivals();
loadDiscovery();

/* ---------------- Cart ---------------- */
let cartCount = 0;
const cartCountEl = document.getElementById('cartCount');
document.addEventListener('click', e => {
  const btn = e.target.closest('.add-btn');
  if (!btn) return;
  e.preventDefault();
  cartCount++;
  cartCountEl.textContent = cartCount;
  btn.textContent = 'Added';
  setTimeout(() => { btn.textContent = 'Add'; }, 900);
});

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
  document.getElementById('new-arrivals').scrollIntoView({ behavior: 'smooth' });
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

// The homepage has no product grid of its own to filter live — search
// here hands off to the products page, which already has real backend
// filtering wired (see products.js). Enter-to-submit, not live-as-you-
// type, since live search would navigate away mid-keystroke.
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

/* ---------------- Our Categories — scroll-filling timeline ---------------- */
(function () {
  const wrap = document.getElementById('timelineWrap');
  const fill = document.getElementById('timelineFill');
  const dots = document.querySelectorAll('.timeline-dot');
  if (!wrap || !fill) return;

  function updateTimeline() {
    const rect = wrap.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const viewportCenter = viewportH * 0.55;

    // Fill percentage: how far the viewport center has progressed through the wrap
    const progressPx = viewportCenter - rect.top;
    const pct = Math.min(100, Math.max(0, (progressPx / rect.height) * 100));
    fill.style.height = pct + '%';

    // Activate dots whose card has been passed
    dots.forEach(dot => {
      const dotRect = dot.getBoundingClientRect();
      const passed = dotRect.top < viewportCenter;
      dot.classList.toggle('bg-sage-400', passed);
      dot.classList.toggle('border-sage-400', passed);
      dot.classList.toggle('bg-cream-50', !passed);
      dot.classList.toggle('border-sand-300', !passed);
      dot.style.boxShadow = passed ? '0 0 0 4px rgba(124,144,130,0.18)' : 'none';
    });
  }

  window.addEventListener('scroll', updateTimeline, { passive: true });
  window.addEventListener('resize', updateTimeline);
  updateTimeline();
})();

/* ---------------- Hero slider ---------------- */
const heroSlides = document.querySelectorAll('.hero-slide');
const heroDots = document.querySelectorAll('.hero-dot');
let heroIndex = 0;
function showHero(i) {
  heroSlides.forEach((s, idx) => s.classList.toggle('active', idx === i));
  heroDots.forEach((d, idx) => {
    d.classList.toggle('w-6', idx === i);
    d.classList.toggle('bg-sage-300', idx === i);
    d.classList.toggle('w-1.5', idx !== i);
    d.classList.toggle('bg-cream-50/40', idx !== i);
    d.setAttribute('aria-selected', idx === i);
  });
  heroIndex = i;
}
heroDots.forEach(dot => dot.addEventListener('click', () => showHero(Number(dot.dataset.index))));
setInterval(() => showHero((heroIndex + 1) % heroSlides.length), 5000);

/* ---------------- FAQ accordion ---------------- */
const faqData = [
  { q: 'How long does shipping take?', a: 'We offer free express shipping nationwide. Expected delivery is within 9–15 working days from the date of order.' },
  { q: 'Do you offer Cash on Delivery (COD)?', a: 'Yes, we support COD. To secure your order and prevent fraudulent requests, all COD deliveries require a small advance payment at checkout.' },
  { q: 'Can I track my order?', a: 'Absolutely. Once your order has been dispatched from our warehouse, you\'ll receive tracking information via email and SMS.' },
];

const faqList = document.getElementById('faqList');
faqList.innerHTML = faqData.map((item, i) => `
  <div class="faq-item">
    <button class="faq-toggle w-full flex items-center justify-between gap-4 py-5 text-left" data-index="${i}" aria-expanded="false">
      <span class="font-semibold text-slate-800 text-sm sm:text-base">${item.q}</span>
      <i data-lucide="chevron-down" class="faq-chevron w-5 h-5 text-sage-500 shrink-0"></i>
    </button>
    <div class="faq-answer" id="faq-answer-${i}">
      <p class="text-sm text-slate-500/80 leading-relaxed pb-5 pr-8">${item.a}</p>
    </div>
  </div>
`).join('');
lucide.createIcons();

faqList.addEventListener('click', e => {
  const toggle = e.target.closest('.faq-toggle');
  if (!toggle) return;
  const answer = document.getElementById(`faq-answer-${toggle.dataset.index}`);
  const chevron = toggle.querySelector('.faq-chevron');
  const isOpen = answer.classList.contains('open');

  document.querySelectorAll('.faq-answer.open').forEach(el => el.classList.remove('open'));
  document.querySelectorAll('.faq-chevron.open').forEach(el => el.classList.remove('open'));
  document.querySelectorAll('.faq-toggle').forEach(el => el.setAttribute('aria-expanded', 'false'));

  if (!isOpen) {
    answer.classList.add('open');
    chevron.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
  }
});


