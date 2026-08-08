// ============================================================
// ATHENA — DYNAMIC PRODUCT SECTIONS
// Mirrors the fetch/render pattern from the Robin real-estate
// site's index.js (PRODUCT_API -> renderProductCards -> grid),
// adapted for candle fields instead of property fields.
//
// Fetches /api/products ONCE, then distributes the results into
// three places on the page:
//   1. #coastal-track   — horizontal row, only candles whose
//                          `collection` reads as shell/coastal
//   2. #jars-track       — horizontal row, only candles whose
//                          `collection` reads as jar
//   3. #product-grid     — the full "Everything, in one place"
//                          grid, every candle, uncategorized
//
// The two section INTRO images (the big story visual next to the
// copy in each section) are intentionally left as static, hand-
// picked images — those are never touched by this script.
//
// Expected backend contract (same shape as Robin's /api/products):
//   GET /api/products
//   -> { status: "success", data: [ {...candle}, {...candle} ] }
//
// Each candle object:
//   slug          string   URL identifier, e.g. "low-tide"
//   name          string   e.g. "Low Tide"
//   image         string   image URL
//   collection    string   e.g. "Coastal Line" / "Jar Candles" —
//                          this is what the shell/jar matching
//                          below reads. Any collection string
//                          containing "shell" or "coastal" lands
//                          in the coastal row; any containing
//                          "jar" lands in the jar row. Everything
//                          still appears in the full grid either way.
//   price         number   e.g. 46
//   wick          string   e.g. "Wooden" / "Cotton"
//   wax           string   e.g. "Soy" / "Soy-Paraffin Blend"
//   burn_hours    number   e.g. 45
//   category      string   drives the corner badge: "BESTSELLER" / "NEW" / other
// ============================================================

document.addEventListener('DOMContentLoaded', () => {

  const PRODUCT_API = '/api/products';

  const COASTAL_MATCH = /shell|coastal/i;
  const JAR_MATCH = /jar/i;

  async function fetchProducts(){
    const coastalTrack = document.getElementById('coastal-track');
    const jarsTrack = document.getElementById('jars-track');
    const grid = document.getElementById('product-grid');

    // if none of the three targets exist on this page, there's nothing to do
    if (!coastalTrack && !jarsTrack && !grid) return;

    try {
      const response = await fetch(PRODUCT_API);
      if (!response.ok){
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      if (result.status === 'success' && result.data){
        const products = result.data;

        if (coastalTrack){
          const coastalItems = products.filter(p => COASTAL_MATCH.test(p.collection || ''));
          renderCards(coastalItems, coastalTrack, { horizontal: true, empty: 'More coastal candles coming soon.' });
        }
        if (jarsTrack){
          const jarItems = products.filter(p => JAR_MATCH.test(p.collection || ''));
          renderCards(jarItems, jarsTrack, { horizontal: true, dark: true, empty: 'More jar candles coming soon.' });
        }
        if (grid){
          renderCards(products, grid, { horizontal: false, empty: 'No candles found.' });
        }

        if (window.ScrollTrigger) ScrollTrigger.refresh();
      } else {
        console.error('[API Error] Payload processing failed', result);
        showError(coastalTrack, jarsTrack, grid);
      }
    } catch (error) {
      console.error('[Fatal API Error]', error);
      showError(coastalTrack, jarsTrack, grid);
    }
  }

  function showError(coastalTrack, jarsTrack, grid){
    if (coastalTrack) coastalTrack.innerHTML = `<p class="track-error">Unable to load candles at this time.</p>`;
    if (jarsTrack) jarsTrack.innerHTML = `<p class="track-error">Unable to load candles at this time.</p>`;
    if (grid) grid.innerHTML = `<p class="grid-error">Unable to load candles at this time.</p>`;
  }

  function renderCards(products, container, opts){
    const { horizontal, dark, empty } = opts;

    if (!products || products.length === 0){
      container.innerHTML = `<p class="${horizontal ? 'track-empty' : 'grid-empty'}">${empty}</p>`;
      return;
    }

    container.innerHTML = products.map(product => {
      if (!product.slug) return ''; // no usable link target — skip rather than render a dead /candle/ URL

      let badgeHTML = '';
      if (product.category){
        const token = product.category.toUpperCase();
        if (token === 'BESTSELLER'){
          badgeHTML = `<div class="grid-badge grid-badge-dark">BESTSELLER</div>`;
        } else if (token === 'NEW'){
          badgeHTML = `<div class="grid-badge grid-badge-light">NEW</div>`;
        } else {
          badgeHTML = `<div class="grid-badge grid-badge-dark">${token}</div>`;
        }
      }

      const metaParts = [product.collection, product.wick, product.wax].filter(Boolean);
      const cardClass = horizontal ? `product-card${dark ? ' dark-card' : ''}` : 'grid-card';

      const cardInner = `
          <div class="product-card-media">
            ${badgeHTML}
            <img src="${product.image || 'img/shell-teal-unlit.webp'}" alt="${product.name || 'Athena candle'}" loading="lazy">
          </div>
          <h3>${product.name || 'Untitled Candle'}</h3>
          <p class="product-meta">${metaParts.join(' · ')}</p>
          <p class="product-price">$${Number(product.price || 0).toLocaleString()}</p>
      `;

      // horizontal rows keep the original <article class="product-card"> shape (no link wrapper,
      // matching how those rows already looked); the full grid wraps each card in a link.
      if (horizontal){
        return `<article class="${cardClass}">${cardInner}</article>`;
      }
      return `<a href="/candle/${product.slug}" class="grid-card-link"><article class="${cardClass}">${cardInner}</article></a>`;
    }).join('');

    // Reveal animation for horizontal rows fires HERE, not in script.js — script.js runs
    // before this fetch resolves, so animating there would target the loading placeholder,
    // not the real cards. gsap/ScrollTrigger are already registered by the time this runs
    // (script.js loads and executes before products.js, both non-deferred, document order).
    if (horizontal && window.gsap && container.children.length){
      gsap.from(container.children, {
        autoAlpha: 0, y: 28, duration: 0.9, stagger: 0.08, ease: 'power2.out',
        scrollTrigger: { trigger: container, start: 'top 88%' }
      });
    }
  }

  fetchProducts();
});

