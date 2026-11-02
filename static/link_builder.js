/* link_builder.js — shared "build a guest order link" widget.
   Used by the admin dashboard (Orders tab) AND the moderator console (/mod/<token>),
   so both behave identically. addEventListener only — the site CSP blocks inline handlers.

   createLinkBuilder(mount, {
     getProducts: () => [...],        // {id,name,image,price,stock,variant_mode,variants:{axes,combinations}}
     createUrl:   '/api/admin/guest-links',
     headers:     () => ({ 'X-CSRFToken': '...' }),
     onCreated:   (link) => {}        // called with the created link dict
   })
*/
(function (global) {
  'use strict';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return '৳' + Math.round(Number(n) || 0).toLocaleString('en-US'); }

  function axesOf(p) {
    var axes = (p.variants && p.variants.axes) || {};
    var out = {};
    Object.keys(axes).forEach(function (k) { if (axes[k] && axes[k].length) out[k] = axes[k]; });
    return out;
  }
  function combosOf(p) { return (p.variants && p.variants.combinations) || []; }
  function isPerVariant(p) { return (p.variant_mode || 'unified') === 'per_variant'; }

  // Stock for a (possibly partial) selection: per-variant products sum the
  // matching combinations; unified products share one number.
  function stockFor(p, sel) {
    if (!isPerVariant(p)) return p.stock || 0;
    var keys = Object.keys(sel);
    return combosOf(p).reduce(function (sum, c) {
      var match = keys.every(function (k) { return c[k] === sel[k]; });
      return match ? sum + (c.stock || 0) : sum;
    }, 0);
  }
  function priceFor(p, sel) {
    if (!isPerVariant(p)) return p.price;
    var hit = combosOf(p).filter(function (c) {
      return Object.keys(sel).every(function (k) { return c[k] === sel[k]; });
    })[0];
    return hit && hit.price != null ? hit.price : p.price;
  }
  function label(sel) { return Object.keys(sel).map(function (k) { return sel[k]; }).join(' / '); }

  var ZONES = [['inside_dhaka', 'Inside Dhaka'], ['outside_dhaka', 'Outside Dhaka'], ['sub_city', 'Sub City']];
  var METHODS = [['bkash', 'bKash'], ['nagad', 'Nagad'], ['cod', 'Cash on delivery']];
  var TYPES = [['postpaid', 'Postpaid (customer pays delivery)'], ['prepaid', 'Prepaid'], ['included', 'Delivery included']];
  var INPUT = 'w-full border border-[#0a192f]/20 rounded-lg p-3 text-[16px] sm:text-sm outline-none focus:border-[#d4af37] bg-white';
  var LBL = 'block text-[9px] uppercase font-bold text-[#0a192f]/60 tracking-widest mb-1';

  function createLinkBuilder(mount, opts) {
    var state = { lines: [], product: null, sel: {}, qty: 1, query: '', busy: false };

    function products() { return (opts.getProducts && opts.getProducts()) || []; }
    function opt(list, value) {
      return list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === value ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('');
    }

    mount.innerHTML =
      '<div class="space-y-4">' +
        '<div><p class="' + LBL + '">Items on this link (<span data-r="count">0</span>)</p>' +
          '<div data-r="lines" class="space-y-2"></div></div>' +
        '<div class="border border-[#0a192f]/10 rounded-xl p-3 bg-[#0a192f]/[0.02]">' +
          '<p class="' + LBL + '">Add a product</p>' +
          '<input type="search" data-r="search" placeholder="Search products…" class="' + INPUT + '">' +
          '<div data-r="results" class="mt-2 space-y-1"></div>' +
          '<div data-r="picker" class="hidden mt-3"></div>' +
        '</div>' +
        '<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">' +
          '<div><label class="' + LBL + '">Payment method</label><select data-r="method" class="' + INPUT + '">' + opt(METHODS, 'bkash') + '</select></div>' +
          '<div><label class="' + LBL + '">Shipping zone</label><select data-r="zone" class="' + INPUT + '">' + opt(ZONES, 'inside_dhaka') + '</select></div>' +
          '<div><label class="' + LBL + '">Payment type</label><select data-r="ptype" class="' + INPUT + '">' + opt(TYPES, 'postpaid') + '</select></div>' +
        '</div>' +
        '<div><label class="' + LBL + '">Promo code (optional — the customer never sees a box for it)</label>' +
          '<input type="text" data-r="promo" autocapitalize="characters" placeholder="e.g. XXLE or SAVE10" class="' + INPUT + ' uppercase"></div>' +
        '<p data-r="error" class="hidden text-xs text-red-600"></p>' +
        '<button type="button" data-r="create" class="w-full bg-[#0a192f] text-[#d4af37] py-4 rounded-full text-[11px] uppercase font-bold tracking-widest">Generate link</button>' +
        '<div data-r="result" class="hidden space-y-2">' +
          '<p class="' + LBL + '">Send this link to the customer</p>' +
          '<input type="text" data-r="url" readonly class="' + INPUT + ' select-all">' +
          '<div class="flex gap-2">' +
            '<button type="button" data-r="copy" class="flex-1 border border-[#0a192f]/20 text-[#0a192f] py-3 rounded-full text-[10px] uppercase font-bold tracking-widest">Copy</button>' +
            '<button type="button" data-r="share" class="flex-1 border border-[#0a192f]/20 text-[#0a192f] py-3 rounded-full text-[10px] uppercase font-bold tracking-widest">Share</button>' +
            '<button type="button" data-r="another" class="flex-1 bg-[#0a192f] text-[#d4af37] py-3 rounded-full text-[10px] uppercase font-bold tracking-widest">New link</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    function r(name) { return mount.querySelector('[data-r="' + name + '"]'); }
    var els = {};
    ['count', 'lines', 'search', 'results', 'picker', 'method', 'zone', 'ptype', 'promo', 'error', 'create', 'result', 'url', 'copy', 'share', 'another']
      .forEach(function (n) { els[n] = r(n); });

    function showError(msg) {
      els.error.textContent = msg || '';
      els.error.classList.toggle('hidden', !msg);
    }

    function renderLines() {
      els.count.textContent = state.lines.length;
      if (!state.lines.length) {
        els.lines.innerHTML = '<p class="text-[11px] text-[#0a192f]/40">Nothing added yet. Search a product below.</p>';
        return;
      }
      els.lines.innerHTML = state.lines.map(function (l, i) {
        return '<div class="flex items-center gap-3 border border-[#0a192f]/10 rounded-xl p-2 bg-white">' +
          '<img src="' + esc(l.product.image || '') + '" alt="" class="w-11 h-11 rounded-lg object-cover bg-gray-100 shrink-0">' +
          '<div class="min-w-0 flex-1"><p class="text-xs font-bold text-[#0a192f] truncate">' + esc(l.product.name) + '</p>' +
          '<p class="text-[10px] text-[#0a192f]/50">' + esc(label(l.sel)) + (label(l.sel) ? ' · ' : '') + money(priceFor(l.product, l.sel)) + ' each</p></div>' +
          '<div class="flex items-center gap-1 shrink-0">' +
            '<button type="button" data-act="dec" data-i="' + i + '" class="w-9 h-9 rounded-full border border-[#0a192f]/20 text-lg leading-none">−</button>' +
            '<span class="w-6 text-center text-sm font-bold">' + l.qty + '</span>' +
            '<button type="button" data-act="inc" data-i="' + i + '" class="w-9 h-9 rounded-full border border-[#0a192f]/20 text-lg leading-none">+</button>' +
          '</div>' +
          '<button type="button" data-act="del" data-i="' + i + '" class="w-9 h-9 text-red-500 text-lg shrink-0" aria-label="Remove">✕</button>' +
        '</div>';
      }).join('');
    }

    els.lines.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var i = parseInt(btn.dataset.i, 10), l = state.lines[i];
      if (!l) return;
      if (btn.dataset.act === 'del') state.lines.splice(i, 1);
      if (btn.dataset.act === 'inc' && l.qty < 20) l.qty++;
      if (btn.dataset.act === 'dec' && l.qty > 1) l.qty--;
      renderLines();
    });

    function renderResults() {
      var q = state.query.trim().toLowerCase();
      if (!q) { els.results.innerHTML = ''; return; }
      var hits = products().filter(function (p) { return (p.name || '').toLowerCase().indexOf(q) !== -1; }).slice(0, 8);
      els.results.innerHTML = hits.map(function (p) {
        return '<button type="button" data-pid="' + p.id + '" class="w-full flex items-center gap-3 p-2 rounded-lg border border-[#0a192f]/10 text-left bg-white min-h-[52px]">' +
          '<img src="' + esc(p.image || '') + '" alt="" class="w-10 h-10 rounded-lg object-cover bg-gray-100 shrink-0">' +
          '<span class="flex-1 min-w-0"><span class="block text-xs font-bold text-[#0a192f] truncate">' + esc(p.name) + '</span>' +
          '<span class="block text-[10px] text-[#0a192f]/50">' + money(p.price) + ' · ' + (p.stock || 0) + ' in stock</span></span></button>';
      }).join('') || '<p class="text-[11px] text-[#0a192f]/40 text-center py-3">No matches</p>';
    }

    els.search.addEventListener('input', function () { state.query = els.search.value; renderResults(); });
    els.results.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-pid]');
      if (!btn) return;
      state.product = products().filter(function (p) { return String(p.id) === btn.dataset.pid; })[0] || null;
      state.sel = {}; state.qty = 1;
      els.results.innerHTML = ''; els.search.value = ''; state.query = '';
      renderPicker();
    });

    function renderPicker() {
      var p = state.product;
      if (!p) { els.picker.classList.add('hidden'); els.picker.innerHTML = ''; return; }
      var axes = axesOf(p);
      var html = '<div class="flex items-center justify-between mb-2"><p class="text-xs font-bold text-[#0a192f]">' + esc(p.name) + '</p>' +
        '<button type="button" data-act="close" class="text-[10px] uppercase font-bold tracking-widest text-[#0a192f]/50 py-2 px-2">Done</button></div>';
      Object.keys(axes).forEach(function (axis) {
        html += '<p class="' + LBL + '">' + esc(axis) + '</p><div class="flex flex-wrap gap-2 mb-3">';
        axes[axis].forEach(function (choice) {
          var probe = Object.assign({}, state.sel); probe[axis] = choice;
          var out = stockFor(p, probe) <= 0;
          var on = state.sel[axis] === choice;
          html += '<button type="button" data-axis="' + esc(axis) + '" data-choice="' + esc(choice) + '"' + (out ? ' disabled' : '') +
            ' class="min-w-[48px] px-3 py-2.5 rounded-lg border text-xs font-bold ' +
            (on ? 'bg-[#0a192f] text-[#d4af37] border-[#0a192f]' : out ? 'border-[#0a192f]/10 text-[#0a192f]/25 line-through' : 'border-[#0a192f]/25 text-[#0a192f]') + '">' + esc(choice) + '</button>';
        });
        html += '</div>';
      });
      var complete = Object.keys(axes).every(function (a) { return state.sel[a]; });
      var avail = complete ? stockFor(p, state.sel) : null;
      html += '<div class="flex items-center justify-between gap-3">' +
        '<div class="flex items-center gap-1">' +
          '<button type="button" data-act="qdec" class="w-10 h-10 rounded-full border border-[#0a192f]/20 text-lg leading-none">−</button>' +
          '<span class="w-8 text-center text-sm font-bold">' + state.qty + '</span>' +
          '<button type="button" data-act="qinc" class="w-10 h-10 rounded-full border border-[#0a192f]/20 text-lg leading-none">+</button>' +
        '</div>' +
        '<button type="button" data-act="add"' + (complete && avail > 0 ? '' : ' disabled') +
          ' class="flex-1 py-3 rounded-full text-[10px] uppercase font-bold tracking-widest ' +
          (complete && avail > 0 ? 'bg-[#0a192f] text-[#d4af37]' : 'bg-[#0a192f]/10 text-[#0a192f]/30') + '">' +
          (complete ? 'Add · ' + money(priceFor(p, state.sel) * state.qty) : 'Choose ' + Object.keys(axes).filter(function (a) { return !state.sel[a]; }).join(' & ')) + '</button>' +
        '</div>' +
        (complete && avail != null ? '<p class="text-[10px] text-[#0a192f]/40 mt-2">' + avail + ' in stock for this choice</p>' : '');
      els.picker.innerHTML = html;
      els.picker.classList.remove('hidden');
    }

    els.picker.addEventListener('click', function (e) {
      var p = state.product;
      if (!p) return;
      var chip = e.target.closest('[data-axis]');
      if (chip && !chip.disabled) {
        state.sel[chip.dataset.axis] = chip.dataset.choice;
        var max = stockFor(p, state.sel);
        if (state.qty > max && max > 0) state.qty = max;
        renderPicker();
        return;
      }
      var act = e.target.closest('[data-act]');
      if (!act || act.disabled) return;
      if (act.dataset.act === 'close') { state.product = null; renderPicker(); }
      if (act.dataset.act === 'qinc') { state.qty = Math.min(state.qty + 1, 20, Math.max(stockFor(p, state.sel) || 20, 1)); renderPicker(); }
      if (act.dataset.act === 'qdec') { state.qty = Math.max(1, state.qty - 1); renderPicker(); }
      if (act.dataset.act === 'add') {
        var sel = Object.assign({}, state.sel);
        // Same product + same variant again = bump the quantity, don't duplicate the line.
        var same = state.lines.filter(function (l) { return l.product.id === p.id && JSON.stringify(l.sel) === JSON.stringify(sel); })[0];
        if (same) same.qty = Math.min(20, same.qty + state.qty);
        else state.lines.push({ product: p, sel: sel, qty: state.qty });
        // Keep the product open so a second size of the SAME product is two taps away.
        state.sel = {}; state.qty = 1;
        showError('');
        renderLines(); renderPicker();
      }
    });

    function resetAll() {
      state.lines = []; state.product = null; state.sel = {}; state.qty = 1;
      els.result.classList.add('hidden'); els.create.classList.remove('hidden');
      els.promo.value = ''; showError('');
      renderLines(); renderPicker();
    }

    els.create.addEventListener('click', function () {
      if (state.busy) return;
      if (!state.lines.length) { showError('Add at least one product first.'); return; }
      state.busy = true; els.create.disabled = true; els.create.textContent = 'Generating…'; showError('');
      var payload = {
        items: state.lines.map(function (l) { return { product_id: l.product.id, selected_variants: l.sel, quantity: l.qty }; }),
        payment_method: els.method.value,
        shipping_zone: els.zone.value,
        payment_type: els.ptype.value,
        promo_code: els.promo.value.trim() || null
      };
      var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers ? opts.headers() : {});
      fetch(opts.createUrl, { method: 'POST', headers: headers, body: JSON.stringify(payload) })
        .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
        .then(function (out) {
          if (out.ok && out.body.status === 'success') {
            var link = out.body.data;
            els.url.value = global.location.origin + '/order-link/' + link.token;
            els.result.classList.remove('hidden');
            els.create.classList.add('hidden');
            els.share.classList.toggle('hidden', !navigator.share);
            if (opts.onCreated) opts.onCreated(link);
          } else {
            showError(out.body.message || 'Could not create the link.');
          }
        })
        .catch(function () { showError('Network problem — try again.'); })
        .then(function () { state.busy = false; els.create.disabled = false; els.create.textContent = 'Generate link'; });
    });

    els.copy.addEventListener('click', function () {
      els.url.select();
      var done = function () { els.copy.textContent = 'Copied'; setTimeout(function () { els.copy.textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(els.url.value).then(done, done);
      else { try { document.execCommand('copy'); } catch (e) { /* user can long-press */ } done(); }
    });
    els.share.addEventListener('click', function () {
      if (navigator.share) navigator.share({ title: 'Your order link', url: els.url.value }).catch(function () { /* cancelled */ });
    });
    els.another.addEventListener('click', resetAll);

    renderLines();
    return { reset: resetAll, refresh: function () { renderResults(); renderPicker(); } };
  }

  global.createLinkBuilder = createLinkBuilder;
})(window);

