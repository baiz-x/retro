/**
 * Kit Collective — Products Page
 *
 * Fetch/filter/render flow is patterned after Robin's products.js
 * (fetch -> render -> sync URL -> deep-link on load), re-targeted to
 * this store's actual filter fields (club, category, price range,
 * edition) and actual API contract (/api/products/filter,
 * /api/products/slug/<slug>, /api/products). No map, no
 * bedrooms/bathrooms/locations — none of that exists on this model.
 */

document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();

  // ================= ELEMENT REFERENCES =================
  const gridEl        = document.getElementById('productGrid');
  const loadingEl      = document.getElementById('loadingState');
  const emptyState     = document.getElementById('emptyState');
  const errorState     = document.getElementById('errorState');
  const countEl        = document.getElementById('productCount');
  const filtersDot     = document.getElementById('filtersActiveDot');

  // Two filter forms (desktop sidebar + mobile drawer) stay in sync —
  // whichever one the person used, both get updated so state never splits.
  const filterFormDesktop = document.getElementById('filterFormDesktop');
  const filterFormMobile  = document.getElementById('filterFormMobile');
  const applyBtnDesktop   = document.getElementById('applyFiltersDesktop');
  const applyBtnMobile    = document.getElementById('applyFiltersMobile');
  const clearBtnDesktop   = document.getElementById('clearFiltersDesktop');
  const clearBtnMobile    = document.getElementById('clearFiltersMobile');

  const searchInputEl  = document.getElementById('searchInput');

  // API base — the product Blueprint is registered under /api
  const API_BASE = '/api';

  let fetchedProductsCache = [];

  // ================= FORMATTING HELPERS =================
  const formatCurrency = (value) => {
    const num = Number(value);
    if (Number.isNaN(num)) return '৳—';
    return '৳' + num.toLocaleString('en-IN');
  };

  const getPhotos = (product) => {
    const fallback = 'https://images.unsplash.com/photo-1522778119026-d647f0596c20?q=80&w=900&auto=format&fit=crop';
    const photos = [];
    if (product.image) photos.push(product.image);
    if (Array.isArray(product.gallery)) {
      product.gallery.forEach(src => { if (src) photos.push(src); });
    }
    return photos.length > 0 ? photos : [fallback];
  };

  // ================= STATE MACHINE =================
  const showState = (state) => {
    loadingEl.classList.toggle('hidden', state !== 'loading');
    gridEl.classList.toggle('hidden', state !== 'grid');
    emptyState.classList.toggle('hidden', state !== 'empty');
    errorState.classList.toggle('hidden', state !== 'error');
  };

  // ================= CARD RENDERING =================
  const renderCard = (product, idx) => {
    const photos = getPhotos(product);

    const priceTag = formatCurrency(product.price);
    const outOfStock = !product.stock || product.stock <= 0;
    const clubTag = product.club ? `<p class="text-[11px] text-sage-600/70 font-medium mt-0.5">${product.club}</p>` : '';

    return `
      <div class="product-card shrink-0" data-product-slug="${product.slug ?? ''}">
        <a href="/product/${encodeURIComponent(product.slug ?? '')}" class="block" onclick="event.preventDefault();">
          <div class="product-media relative rounded-xl overflow-hidden bg-sand-100 aspect-[3/4]">
            <img src="${photos[0]}" alt="${product.name || 'Product'}" class="img-a w-full h-full object-cover" loading="lazy" />
            ${photos[1] ? `<img src="${photos[1]}" alt="" class="img-b w-full h-full object-cover" loading="lazy" />` : ''}
            ${outOfStock ? `<span class="absolute top-2 left-2 bg-slate-800/85 text-cream-50 text-[10px] font-bold px-2 py-0.5 rounded-full">Out of Stock</span>` : ''}
            ${!outOfStock ? `<button class="add-btn absolute bottom-2 right-2 bg-cream-50 text-slate-800 text-[10px] font-bold uppercase tracking-wide px-3 py-1.5 rounded-full hover:bg-sage-400 hover:text-cream-50 transition-colors" data-name="${product.name || ''}">Add</button>` : ''}
          </div>
          <div class="mt-2.5">
            <p class="text-sm text-slate-800 font-medium leading-snug line-clamp-2">${product.name || 'Untitled product'}</p>
            ${clubTag}
            <p class="text-sm mt-1 font-bold text-slate-800">${priceTag}</p>
          </div>
        </a>
      </div>`;
  };

  // ================= CARD INTERACTIONS =================
  const bindCardInteractions = () => {
    document.querySelectorAll('.add-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cartCount++;
        cartCountEl.textContent = cartCount;
        btn.textContent = 'Added';
        setTimeout(() => { btn.textContent = 'Add'; }, 900);
      });
    });

    document.querySelectorAll('.product-card[data-product-slug]').forEach(card => {
      card.addEventListener('click', () => {
        const slug = card.getAttribute('data-product-slug');
        if (slug) window.location.href = `/product/${encodeURIComponent(slug)}`;
      });
    });
  };

  // ================= FILTER FORM SYNC =================
  // Keeps desktop sidebar and mobile drawer forms mirrored, so applying
  // from either one carries the same filter state.
  const readFilterValues = (sourceForm) => {
    const values = {};
    Array.from(sourceForm.elements).forEach(el => {
      if (el.name) values[el.name] = el.value;
    });
    return values;
  };

  const writeFilterValues = (targetForm, values) => {
    Object.entries(values).forEach(([name, val]) => {
      const el = targetForm.elements[name];
      if (el) el.value = val;
    });
  };

  const syncForms = (sourceForm) => {
    const other = sourceForm === filterFormDesktop ? filterFormMobile : filterFormDesktop;
    if (other) writeFilterValues(other, readFilterValues(sourceForm));
  };

  const updateFilterIndicator = () => {
    const values = readFilterValues(filterFormDesktop);
    const hasActive = Object.values(values).some(v => v && v.trim() !== '');
    filtersDot.classList.toggle('hidden', !hasActive);
  };

  // ================= CATEGORY DROPDOWN (populated from DB) =================
  // Replaces the old free-text category input, which silently broke on any
  // typo/casing mismatch between the admin dashboard and this filter box —
  // both were free text, exact-match against each other. Sourced from the
  // DB itself so a customer can only pick a category that actually exists.
  // Fetched once on page load, not re-fetched on every filter change.
  const populateCategoryDropdowns = async () => {
    try {
      const response = await fetch(`${API_BASE}/products/categories`);
      const payload = await response.json();
      if (payload.status !== 'success' || !Array.isArray(payload.data)) return;

      const optionsHTML = payload.data
        .map(cat => `<option value="${cat}">${cat}</option>`)
        .join('');

      ['categorySelectDesktop', 'categorySelectMobile'].forEach(id => {
        const select = document.getElementById(id);
        if (select) select.insertAdjacentHTML('beforeend', optionsHTML);
      });
    } catch (error) {
      console.error('Failed to load categories:', error);
    }
  };

  // ================= FETCH + RENDER =================
  const fetchProducts = async () => {
    showState('loading');

    const params = new URLSearchParams();
    const values = readFilterValues(filterFormDesktop);
    Object.entries(values).forEach(([key, val]) => {
      if (val) params.append(key, val);
    });

    const searchTerm = searchInputEl ? searchInputEl.value.trim() : '';
    if (searchTerm) params.append('search', searchTerm);

    // Push filter state into the URL so a filtered view is shareable/bookmarkable
    const searchString = params.toString();
    const newBrowserURL = window.location.pathname + (searchString ? '?' + searchString : '');
    window.history.replaceState(null, '', newBrowserURL);

    const endpoint = searchString
      ? `${API_BASE}/products/filter?${searchString}`
      : `${API_BASE}/products`;

    try {
      const response = await fetch(endpoint);
      const payload = await response.json();

      if (payload.status === 'success' && Array.isArray(payload.data) && payload.data.length > 0) {
        fetchedProductsCache = payload.data;
        gridEl.innerHTML = payload.data.map((product, idx) => renderCard(product, idx)).join('');
        countEl.textContent = payload.count ?? payload.data.length;
        showState('grid');
        bindCardInteractions();
      } else if (payload.status === 'success') {
        fetchedProductsCache = [];
        countEl.textContent = '0';
        showState('empty');
      } else {
        throw new Error(payload.message || 'Unknown API error');
      }
    } catch (error) {
      console.error('Products fetch error:', error);
      showState('error');
    }

    updateFilterIndicator();
  };

  // ================= DEEP LINK ON LOAD =================
  // Reads ?club=...&category=...&min_price=...&edition=... etc back
  // into both filter forms so a shared/bookmarked filtered URL renders
  // the same view it was saved from.
  const syncInputsFromURL = () => {
    const urlParams = new URLSearchParams(window.location.search);

    if (searchInputEl && urlParams.has('search')) {
      searchInputEl.value = urlParams.get('search');
    }

    [filterFormDesktop, filterFormMobile].forEach(form => {
      if (!form) return;
      Array.from(form.elements).forEach(el => {
        if (el.name && urlParams.has(el.name)) {
          el.value = urlParams.get(el.name);
        }
      });
    });
  };

  // ================= FILTER DRAWER (mobile) =================
  const filterOverlay      = document.getElementById('filterOverlay');
  const filterDrawer       = document.getElementById('filterDrawer');
  const filtersBtn         = document.getElementById('filtersBtn');
  const filtersBtnMobile   = document.getElementById('filtersBtnMobile');
  const filterDrawerCloseBtn = document.getElementById('filterDrawerCloseBtn');

  function openFilters() {
    filterOverlay.classList.add('open');
    filterDrawer.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeFilters() {
    filterOverlay.classList.remove('open');
    filterDrawer.classList.remove('open');
    document.body.style.overflow = '';
  }
  if (filtersBtn) filtersBtn.addEventListener('click', openFilters);
  if (filtersBtnMobile) filtersBtnMobile.addEventListener('click', openFilters);
  if (filterDrawerCloseBtn) filterDrawerCloseBtn.addEventListener('click', closeFilters);
  filterOverlay.addEventListener('click', closeFilters);

  // ================= FILTER EVENT BINDINGS =================
  if (applyBtnDesktop) {
    applyBtnDesktop.addEventListener('click', (e) => {
      e.preventDefault();
      syncForms(filterFormDesktop);
      fetchProducts();
    });
  }
  if (applyBtnMobile) {
    applyBtnMobile.addEventListener('click', (e) => {
      e.preventDefault();
      syncForms(filterFormMobile);
      fetchProducts();
      closeFilters();
    });
  }

  const clearAll = () => {
    if (filterFormDesktop) filterFormDesktop.reset();
    if (filterFormMobile) filterFormMobile.reset();
    if (searchInputEl) searchInputEl.value = '';
    fetchProducts();
  };
  if (clearBtnDesktop) clearBtnDesktop.addEventListener('click', (e) => { e.preventDefault(); clearAll(); });
  if (clearBtnMobile) clearBtnMobile.addEventListener('click', (e) => { e.preventDefault(); clearAll(); closeFilters(); });

  // ================= SEARCH (debounced-while-typing, Enter submits+closes) =================
  let searchDebounce;
  if (searchInputEl) {
    searchInputEl.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(fetchProducts, 650);
    });

    // Enter runs the search immediately (skips the debounce wait) and
    // closes the overlay so the filtered grid is visible right away,
    // instead of sitting hidden behind the search panel.
    searchInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchDebounce);
        fetchProducts();
        closeSearch();
      }
    });
  }

  // ================= CART DRAWER =================
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
  cartOverlay.addEventListener('click', closeCart);
  document.getElementById('cartStartShoppingBtn').addEventListener('click', closeCart);

  // ================= SEARCH OVERLAY =================
  const searchOverlay = document.getElementById('searchOverlay');
  function openSearch() {
    searchOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => searchInputEl && searchInputEl.focus(), 100);
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
    if (e.key === 'Escape') { closeSearch(); closeCart(); closeFilters(); }
  });

  // ================= MOBILE MENU =================
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  const mobileMenu = document.getElementById('mobileMenu');
  mobileMenuBtn.addEventListener('click', () => {
    const isOpen = mobileMenu.classList.toggle('open');
    mobileMenuBtn.setAttribute('aria-expanded', isOpen);
    mobileMenuBtn.innerHTML = isOpen ? '<i data-lucide="x" class="w-5 h-5"></i>' : '<i data-lucide="menu" class="w-5 h-5"></i>';
    lucide.createIcons();
  });

  // ================= THEME TOGGLE (visual, capsule navbar) =================
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  let isDarkIcon = true;
  themeToggleBtn.addEventListener('click', () => {
    isDarkIcon = !isDarkIcon;
    themeToggleBtn.innerHTML = isDarkIcon
      ? '<i data-lucide="moon" class="w-[18px] h-[18px]"></i>'
      : '<i data-lucide="sun" class="w-[18px] h-[18px]"></i>';
    lucide.createIcons();
  });

  // ================= INIT =================
  // Category dropdown must be populated BEFORE syncInputsFromURL runs —
  // setting .value on a <select> with no matching <option> yet (e.g. a
  // deep link like ?category=World+Cup arriving before the fetch
  // resolves) silently selects nothing.
  populateCategoryDropdowns().then(() => {
    syncInputsFromURL();
    fetchProducts();
  });
});


