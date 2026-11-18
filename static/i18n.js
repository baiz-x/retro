// i18n.js — English <-> Bangla switcher, loaded once from partials/_footer.html
// so it runs on every page. English stays in the HTML (what Google sees);
// Bangla lives in attributes on the same tag:
//
//   <a data-bn="সব প্রোডাক্ট">All Products</a>
//   <input placeholder="Search" data-bn-placeholder="সার্চ করুন">
//   <button aria-label="Close" data-bn-aria-label="বন্ধ করুন">
//   (also: data-bn-alt, data-bn-title)
//   <li data-bn-html="..<strong>x</strong>..">  — swaps innerHTML; only for static
//     markup where Bangla word order differs (no nested data-bn inside it,
//     and use single quotes for attributes inside the value).
//
// From other JS files: RFi18n.t('English', 'বাংলা') returns the string for the
// current language (for messages/labels that JS writes at runtime), and the
// 'rf:langchange' document event fires whenever the language flips.
//
// Rules for markup:
//  - data-bn goes on an element whose visible text is ONE text run. If an
//    element mixes text + children, wrap the text in <span data-bn="...">.
//    (An element with an icon + text is fine: the first text node is swapped.)
//  - Don't put data-bn on text that JS rewrites later (counters, totals).
//  - JS-rendered markup can carry data-bn too — a MutationObserver picks it up.
//
// Choice is stored in localStorage('rf_lang'). Default is always English.
(function () {
  'use strict';

  var KEY = 'rf_lang';
  var FONT_ID = 'rf-bn-font';
  var SEL = '[data-bn],[data-bn-html],[data-bn-placeholder],[data-bn-aria-label],[data-bn-alt],[data-bn-title]';
  var ATTRS = [
    ['data-bn-placeholder', 'placeholder'],
    ['data-bn-aria-label', 'aria-label'],
    ['data-bn-alt', 'alt'],
    ['data-bn-title', 'title']
  ];

  var orig = new WeakMap(); // element -> { text, attrs:{} } (original English)
  var lang = 'en';

  function readStored() {
    try { return localStorage.getItem(KEY) === 'bn' ? 'bn' : 'en'; } catch (e) { return 'en'; }
  }
  function store(l) {
    try { localStorage.setItem(KEY, l); } catch (e) {}
  }

  function loadFont() {
    if (document.getElementById(FONT_ID)) return;
    var link = document.createElement('link');
    link.id = FONT_ID;
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Bengali:wght@400;500;600;700;800&display=swap';
    document.head.appendChild(link);
  }

  // First non-blank text node of an element that also has child elements.
  function textNodeOf(el) {
    if (!el.children.length) return null;
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue.trim()) return n;
    }
    return null;
  }
  function readText(el) {
    var t = textNodeOf(el);
    if (t) return t.nodeValue.trim();
    return el.children.length ? null : el.textContent.trim();
  }
  function writeText(el, v) {
    var t = textNodeOf(el);
    if (t) {
      var m = t.nodeValue.match(/^(\s*)[\s\S]*?(\s*)$/);
      t.nodeValue = m[1] + v + m[2];
    } else if (!el.children.length) {
      el.textContent = v;
    }
  }

  function applyEl(el) {
    var rec = orig.get(el);
    if (!rec) {
      rec = { text: null, html: null, htmlLang: 'en', attrs: {} };
      if (el.hasAttribute('data-bn')) rec.text = readText(el);
      if (el.hasAttribute('data-bn-html')) rec.html = el.innerHTML;
      ATTRS.forEach(function (p) {
        if (el.hasAttribute(p[0])) rec.attrs[p[1]] = el.getAttribute(p[1]) || '';
      });
      orig.set(el, rec);
    }
    var useBn = lang === 'bn';
    if (rec.text !== null) {
      var v = useBn ? el.getAttribute('data-bn') : rec.text;
      if (v !== null && readText(el) !== v) writeText(el, v);
    }
    if (rec.html !== null && rec.htmlLang !== lang) {
      el.innerHTML = useBn ? el.getAttribute('data-bn-html') : rec.html;
      rec.htmlLang = lang;
    }
    ATTRS.forEach(function (p) {
      if (Object.prototype.hasOwnProperty.call(rec.attrs, p[1])) {
        el.setAttribute(p[1], useBn ? el.getAttribute(p[0]) : rec.attrs[p[1]]);
      }
    });
  }

  function apply(root) {
    root = root || document;
    if (root.nodeType === 1 && root.matches(SEL)) applyEl(root);
    if (!root.querySelectorAll) return;
    var list = root.querySelectorAll(SEL);
    for (var i = 0; i < list.length; i++) applyEl(list[i]);
  }

  function set(l, persist) {
    lang = l === 'bn' ? 'bn' : 'en';
    var h = document.documentElement;
    h.lang = lang;
    h.classList.toggle('lang-bn', lang === 'bn');
    if (lang === 'bn') loadFont();
    apply(document);
    var btns = document.querySelectorAll('[data-lang-toggle]');
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', lang === 'bn' ? 'true' : 'false');
    if (persist !== false) store(lang);
    document.dispatchEvent(new CustomEvent('rf:langchange', { detail: { lang: lang } }));
  }

  // Newly inserted nodes (JS-rendered cards, lists, parser-inserted tail of page).
  // Only element additions are inspected, so our own text writes never re-trigger it.
  new MutationObserver(function (muts) {
    if (lang !== 'bn') return;
    muts.forEach(function (m) {
      for (var i = 0; i < m.addedNodes.length; i++) {
        if (m.addedNodes[i].nodeType === 1) apply(m.addedNodes[i]);
      }
    });
  }).observe(document.body, { childList: true, subtree: true });

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-lang-toggle]');
    if (!b) return;
    e.preventDefault();
    set(lang === 'bn' ? 'en' : 'bn');
  });

  window.addEventListener('storage', function (e) {
    if (e.key === KEY) set(e.newValue === 'bn' ? 'bn' : 'en', false);
  });

  document.addEventListener('DOMContentLoaded', function () {
    if (lang === 'bn') apply(document);
  });

  function t(en, bn) { return lang === 'bn' ? bn : en; }

  window.RFi18n = { get: function () { return lang; }, set: set, apply: apply, t: t };

  lang = readStored();
  if (lang === 'bn') set('bn', false);
})();
