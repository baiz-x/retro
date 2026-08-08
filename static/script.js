gsap.registerPlugin(ScrollTrigger);

/* ============ LOADER SEQUENCE ============ */
window.addEventListener('load', () => {
  const tl = gsap.timeline();
  tl.to('#flame-glow', { autoAlpha: 0.55, duration: 0.5, ease: 'power1.out' }, 0.2)
    .to('#wick-flame', { autoAlpha: 1, duration: 0.4, ease: 'power1.out' }, 0.2)
    .to('#wick-flame', {
        keyframes: [
          { scaleY: 1.08, scaleX: 0.95, duration: 0.18 },
          { scaleY: 0.94, scaleX: 1.05, duration: 0.18 },
          { scaleY: 1, scaleX: 1, duration: 0.18 }
        ],
        transformOrigin: 'center bottom', repeat: 2
      }, 0.6)
    .to('#wick-flame', { autoAlpha: 0, duration: 0.25, ease: 'power1.in' }, 1.7)
    .to('#flame-glow', { autoAlpha: 0, duration: 0.35, ease: 'power1.in' }, 1.7)
    .to('.loader-label', { autoAlpha: 0, duration: 0.3 }, 1.8)
    .to('#loader-candle', { autoAlpha: 0, duration: 0.3 }, 1.85)
    .to('.panel-left', { xPercent: -100, duration: 1.1, ease: 'power4.inOut' }, 2.1)
    .to('.panel-right', { xPercent: 100, duration: 1.1, ease: 'power4.inOut' }, 2.1)
    .set('#loader', { display: 'none' }, 3.25)
    .call(() => { playHeroReveal(); }, null, 2.5);
});

function playHeroReveal(){
  gsap.timeline()
    .from('.hero-eyebrow', { y: 20, autoAlpha: 0, duration: 0.7, ease: 'power3.out' }, 0)
    .from('.hero-title', { y: 50, autoAlpha: 0, duration: 0.9, ease: 'power4.out' }, 0.1)
    .from('.hero-sub', { y: 20, autoAlpha: 0, duration: 0.7, ease: 'power3.out' }, 0.45)
    .from('.hero-scroll-cue', { autoAlpha: 0, duration: 0.6 }, 0.75);
}

/* ============ NAV STATE ============ */
ScrollTrigger.create({
  start: 100,
  onUpdate: (self) => document.getElementById('site-nav').classList.toggle('scrolled', self.scroll() > 100)
});

/* ============================================================
   HERO — REAL VIDEO
   img/hero-poster.png shows instantly on load (native <video poster>).
   img/hero.mp4 autoplays + loops once it's ready. Some mobile
   browsers block autoplay even when muted until first touch —
   this retries play() on first interaction as a safety net.
   ============================================================ */
(function heroVideo(){
  const video = document.getElementById('hero-video');
  if (!video) return;

  const tryPlay = () => { video.play().catch(() => {}); };
  tryPlay();

  const resumeOnInteract = () => {
    tryPlay();
    window.removeEventListener('touchstart', resumeOnInteract);
    window.removeEventListener('click', resumeOnInteract);
  };
  window.addEventListener('touchstart', resumeOnInteract, { once: true });
  window.addEventListener('click', resumeOnInteract, { once: true });
})();

/* ============ CREDIBILITY COUNTERS ============ */
document.querySelectorAll('.counter').forEach(el => {
  const target = parseFloat(el.dataset.target);
  const isDecimal = target % 1 !== 0;
  ScrollTrigger.create({
    trigger: el, start: 'top 85%', once: true,
    onEnter: () => {
      const obj = { val: 0 };
      gsap.to(obj, {
        val: target, duration: 1.8, ease: 'power2.out',
        onUpdate: () => { el.textContent = isDecimal ? obj.val.toFixed(1) : Math.round(obj.val); }
      });
    }
  });
});

/* ============ MAKE-YOUR-OWN — DOORS PART ON SCROLL ============ */
gsap.timeline({
  scrollTrigger: { trigger: '#custom', start: 'top 75%', end: 'top 25%', scrub: 1 }
})
.to('.cdoor-left', { xPercent: -100, ease: 'none' }, 0)
.to('.cdoor-right', { xPercent: 100, ease: 'none' }, 0);

gsap.from('.custom-copy > *', {
  scrollTrigger: { trigger: '#custom', start: 'top 55%' },
  y: 26, autoAlpha: 0, duration: 0.8, stagger: 0.1, ease: 'power3.out'
});
gsap.from('.custom-step', {
  scrollTrigger: { trigger: '#custom', start: 'top 50%' },
  x: 24, autoAlpha: 0, duration: 0.7, stagger: 0.12, ease: 'power3.out'
});

/* ============ COASTAL SECTION — DOORS PART ON SCROLL ============ */
gsap.timeline({
  scrollTrigger: { trigger: '#coastal', start: 'top 70%', end: 'top 20%', scrub: 1 }
})
.to('.coastal-doors .gyp-door-left', { xPercent: -100, ease: 'none' }, 0)
.to('.coastal-doors .gyp-door-right', { xPercent: 100, ease: 'none' }, 0);

gsap.from('.coastal-visual', {
  scrollTrigger: { trigger: '#coastal', start: 'top 55%' }, y: 36, autoAlpha: 0, duration: 1, ease: 'power3.out'
});
gsap.from('.coastal-copy > *', {
  scrollTrigger: { trigger: '#coastal', start: 'top 55%' }, y: 26, autoAlpha: 0, duration: 0.8, stagger: 0.1, ease: 'power3.out'
});

/* ============ JAR SECTION REVEALS ============ */
gsap.from('.jars-copy > *', {
  scrollTrigger: { trigger: '#jars', start: 'top 65%' }, y: 26, autoAlpha: 0, duration: 0.8, stagger: 0.1, ease: 'power3.out'
});
gsap.from('.jars-visual', {
  scrollTrigger: { trigger: '#jars', start: 'top 65%' }, y: 36, autoAlpha: 0, duration: 1, ease: 'power3.out'
});

/* ============ HORIZONTAL PRODUCT ROW REVEALS ============ */
document.querySelectorAll('.hscroll-track').forEach(track => {
  gsap.from(track.children, {
    autoAlpha: 0, y: 28, duration: 0.9, stagger: 0.08, ease: 'power2.out',
    scrollTrigger: { trigger: track, start: 'top 88%' }
  });
});

/* ============ DRAG-TO-SCROLL (product rows + testimonials) ============ */
document.querySelectorAll('.hscroll-track, .testi-track').forEach(track => {
  let isDown = false, startX, scrollLeft;
  track.addEventListener('mousedown', (e) => {
    isDown = true; track.classList.add('dragging');
    startX = e.pageX - track.offsetLeft; scrollLeft = track.scrollLeft;
  });
  ['mouseleave','mouseup'].forEach(evt =>
    track.addEventListener(evt, () => { isDown = false; track.classList.remove('dragging'); })
  );
  track.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - track.offsetLeft;
    track.scrollLeft = scrollLeft - (x - startX) * 1.3;
  });
});

/* ============ ALL PRODUCTS GRID REVEAL ============ */
gsap.from('.grid-card', {
  scrollTrigger: { trigger: '#all-products', start: 'top 75%' },
  autoAlpha: 0, y: 28, duration: 0.7, stagger: { each: 0.06, grid: 'auto', from: 'start' }, ease: 'power2.out'
});

/* ============ TESTIMONIALS REVEAL ============ */
gsap.from('.testi-headline', {
  scrollTrigger: { trigger: '#testimonials', start: 'top 75%' }, y: 24, autoAlpha: 0, duration: 0.8, ease: 'power3.out'
});
gsap.from('.testi-card', {
  scrollTrigger: { trigger: '.testi-track', start: 'top 85%' },
  y: 28, autoAlpha: 0, duration: 0.8, stagger: 0.1, ease: 'power2.out'
});

/* ============ FOOTER REVEAL ============ */
gsap.from('#site-footer .footer-top > *', {
  scrollTrigger: { trigger: '#site-footer', start: 'top 90%' },
  autoAlpha: 0, y: 22, duration: 0.7, stagger: 0.1, ease: 'power2.out'
});

