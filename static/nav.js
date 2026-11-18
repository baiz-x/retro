// nav.js — shared navbar behaviour for pages whose own JS doesn't carry it
// (currently only /orders). Mirrors the logic that index.js / cart.js /
// product.js duplicate: hamburger, search overlay, logout, theme icon, cart badge.
// Load BEFORE the page script:  <script src="/static/nav.js"></script>
(function () {
  'use strict';

  function icon(name, cls) {
    return '<svg class="' + cls + '" aria-hidden="true"><use href="#icon-' + name + '"></use></svg>';
  }

  function csrfFetch(url, options) {
    options = options || {};
    var meta = document.querySelector('meta[name="csrf-token"]');
    options.headers = Object.assign({}, options.headers || {}, { 'X-CSRFToken': meta ? meta.content : '' });
    return fetch(url, options);
  }

  /* ---------- Mobile menu ---------- */
  var menuBtn = document.getElementById('mobileMenuBtn');
  var menu = document.getElementById('mobileMenu');
  if (menuBtn && menu) {
    menuBtn.addEventListener('click', function () {
      var isOpen = menu.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      menuBtn.innerHTML = icon(isOpen ? 'x' : 'menu', 'w-5 h-5');
    });
  }

  /* ---------- Search overlay (needs #searchOverlay markup on the page) ---------- */
  var overlay = document.getElementById('searchOverlay');
  var searchBtn = document.getElementById('searchBtn');
  var searchInput = document.getElementById('searchInput');
  var searchClose = document.getElementById('searchCloseBtn');
  function openSearch() {
    if (!overlay) return;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(function () { if (searchInput) searchInput.focus(); }, 100);
  }
  function closeSearch() {
    if (!overlay) return;
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }
  if (overlay) {
    if (searchBtn) searchBtn.addEventListener('click', openSearch);
    if (searchClose) searchClose.addEventListener('click', closeSearch);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSearch(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSearch(); });
    if (searchInput) {
      searchInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var term = searchInput.value.trim();
        if (term) window.location.href = '/products?search=' + encodeURIComponent(term);
      });
    }
  }

  /* ---------- Logout (button lives in _mobile_menu.html) ---------- */
  var logoutBtn = document.getElementById('logoutBtnMobile');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async function () {
      logoutBtn.disabled = true;
      try {
        var res = await csrfFetch('/auth/logout', { method: 'POST' });
        if (res.ok) { window.location.href = '/'; return; }
      } catch (e) {}
      logoutBtn.disabled = false;
    });
  }

  /* ---------- Theme toggle (visual only, same as other pages) ---------- */
  var themeBtn = document.getElementById('themeToggleBtn');
  if (themeBtn) {
    var isMoon = true;
    themeBtn.addEventListener('click', function () {
      isMoon = !isMoon;
      themeBtn.innerHTML = icon(isMoon ? 'moon' : 'sun', 'w-[18px] h-[18px]');
    });
  }

  /* ---------- Cart badge ---------- */
  fetch('/api/cart', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (p) {
      if (p.status !== 'success') return;
      document.querySelectorAll('.cart-count-badge').forEach(function (el) {
        el.textContent = p.data.total_items || 0;
      });
    })
    .catch(function () {});
})();
