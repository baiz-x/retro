/* moderator_console.js — the moderator's whole world: build a guest order link,
   see the links he made. The token in the URL is the only credential; every call
   goes to /api/mod/<token>/... and none of them can reach the admin panel.
   addEventListener only (the site CSP blocks inline handlers). */
(function () {
  'use strict';

  var token = document.body.dataset.token;
  var mount = document.getElementById('builderMount');
  if (!mount) return; // error state: nothing to run

  var products = [];
  var paneNew = document.getElementById('paneNew');
  var paneMine = document.getElementById('paneMine');
  var tabs = document.querySelectorAll('.mod-tab');
  var catalogError = document.getElementById('catalogError');
  var linksList = document.getElementById('linksList');

  function csrf() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute('content') : '';
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- expiry note ----
  var expires = document.body.dataset.expires ? new Date(document.body.dataset.expires) : null;
  if (expires && !isNaN(expires)) {
    var days = Math.ceil((expires - new Date()) / 86400000);
    document.getElementById('expiryNote').textContent =
      days > 1 ? 'access ends in ' + days + ' days' : days === 1 ? 'access ends tomorrow' : 'access ends today';
  }

  // ---- tabs ----
  function showTab(name) {
    paneNew.classList.toggle('hidden', name !== 'new');
    paneMine.classList.toggle('hidden', name !== 'mine');
    tabs.forEach(function (t) {
      var on = t.dataset.tab === name;
      t.className = 'mod-tab flex-1 py-3 rounded-full text-[10px] uppercase font-bold tracking-widest ' +
        (on ? 'bg-[#0a192f] text-[#d4af37] shadow' : 'text-[#0a192f]/50');
    });
    if (name === 'mine') loadLinks();
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { showTab(t.dataset.tab); }); });

  // ---- builder ----
  var builder = createLinkBuilder(mount, {
    getProducts: function () { return products; },
    createUrl: '/api/mod/' + encodeURIComponent(token) + '/guest-links',
    headers: function () { return { 'X-CSRFToken': csrf() }; },
    onCreated: function () { /* list refreshes when the tab opens */ }
  });

  function loadCatalog() {
    fetch('/api/mod/' + encodeURIComponent(token) + '/catalog')
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (body.status === 'success') { products = body.data || []; builder.refresh(); }
        else { catalogError.textContent = body.message || 'Could not load products.'; catalogError.classList.remove('hidden'); }
      })
      .catch(function () { catalogError.textContent = 'Could not load products — check your connection.'; catalogError.classList.remove('hidden'); });
  }

  // ---- my links ----
  var CHANNEL_LABEL = { whatsapp: 'WhatsApp', facebook: 'Facebook', instagram: 'Instagram' };

  function contactHtml(l) {
    if (!l.contact_handle) return '';
    var name = CHANNEL_LABEL[l.contact_channel] || l.contact_channel;
    var handle = esc(l.contact_handle);
    var open = '';
    if (l.contact_channel === 'whatsapp') {
      open = ' <a class="underline" target="_blank" rel="noopener noreferrer" href="https://wa.me/' + encodeURIComponent(l.contact_handle.replace(/^\+/, '')) + '">open</a>';
    }
    return '<p class="text-[11px] mt-1"><span class="text-[#0a192f]/50">' + name + ':</span> <strong>' + handle + '</strong>' + open + '</p>';
  }

  function renderLinks(list) {
    if (!list.length) {
      linksList.innerHTML = '<p class="text-sm text-[#0a192f]/40 text-center py-8">No links yet.</p>';
      return;
    }
    linksList.innerHTML = list.map(function (l) {
      var status, cls;
      if (l.is_used) { status = 'Ordered'; cls = 'bg-green-50 text-green-700'; }
      else if (l.is_expired) { status = 'Expired'; cls = 'bg-red-50 text-red-500'; }
      else { status = 'Waiting'; cls = 'bg-amber-50 text-amber-700'; }
      var canCopy = !l.is_used && !l.is_expired;
      var url = location.origin + '/order-link/' + l.token;
      return '<div class="border border-[#0a192f]/10 rounded-xl bg-white p-3">' +
        '<div class="flex items-start justify-between gap-2">' +
          '<p class="text-xs font-bold leading-snug">' + esc(l.items_summary) + '</p>' +
          '<span class="shrink-0 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest ' + cls + '">' + status + '</span>' +
        '</div>' +
        (l.promo_code ? '<p class="text-[10px] text-[#0a192f]/50 mt-1">Code: ' + esc(l.promo_code) + '</p>' : '') +
        (l.is_used ? '<p class="text-[11px] mt-1">' + esc(l.customer_name || '') + (l.order_code ? ' · order <strong>' + esc(l.order_code) + '</strong>' : '') + '</p>' + contactHtml(l) : '') +
        (canCopy ? '<button type="button" data-url="' + esc(url) + '" class="copy-link mt-2 w-full border border-[#0a192f]/20 py-3 rounded-full text-[10px] uppercase font-bold tracking-widest">Copy link</button>' : '') +
      '</div>';
    }).join('');
  }

  function loadLinks() {
    fetch('/api/mod/' + encodeURIComponent(token) + '/guest-links')
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (body.status === 'success') renderLinks(body.data || []);
        else linksList.innerHTML = '<p class="text-sm text-red-600">' + esc(body.message || 'Could not load links.') + '</p>';
      })
      .catch(function () { linksList.innerHTML = '<p class="text-sm text-red-600">Could not load links.</p>'; });
  }

  linksList.addEventListener('click', function (e) {
    var btn = e.target.closest('.copy-link');
    if (!btn) return;
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy link'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(btn.dataset.url).then(done, done);
    else done();
  });
  document.getElementById('refreshLinks').addEventListener('click', loadLinks);

  showTab('new');
  loadCatalog();
})();

