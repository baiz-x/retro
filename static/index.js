/**
 * MARKAZUS SUNNAH | Full Enterprise Production Logic
 * Optimized for: Render, Vercel, and slow-loading cloud assets
 */

// --- CONFIGURATION & GLOBAL VARIABLES ---
const PRODUCT_API = '/api/products';
let currentSlide = 0;
let isAnimating = false;

// --- 1. CORE INITIALIZATION ENGINE ---
window.addEventListener('load', () => {
    gsap.registerPlugin(ScrollTrigger, Draggable);

    setupHeroSlider();
    setupCollectionScroll();
    initStatsCounter();
    
    fetchProducts().then(() => {
        setTimeout(() => {
            initScrollAnimations();
            ScrollTrigger.refresh();
        }, 800);
    });

    const langBtn = document.getElementById('lang-toggle');
    if (langBtn) {
        const savedLang = localStorage.getItem('site_lang') || 'en';
        applyLanguage(savedLang);
        langBtn.addEventListener('click', () => {
            const newLang = localStorage.getItem('site_lang') === 'en' ? 'bn' : 'en';
            applyLanguage(newLang);
        });
    }

    setTimeout(() => { ScrollTrigger.refresh(); }, 2500);
});

// --- 2. API & RENDERING ---
async function fetchProducts() {
    const grid = document.getElementById('product-grid');
    if (!grid) return;

    try {
        const response = await fetch(PRODUCT_API);
        const result = await response.json();
        if (result.status === 'success') {
            renderProductCards(result.data, grid);
        }
    } catch (error) {
        console.error("Critical API Failure:", error);
    }
}

function renderProductCards(products, container) {
    container.innerHTML = products.map(product => `
        <div class="product-card bg-white group shadow-sm reveal-item rounded-2xl opacity-0 translate-y-8 scale-95 transition-all">
            <a href="/product?id=${product.id}" class="block">
                <div class="relative overflow-hidden bg-gray-400 aspect-square mb-4 rounded-2xl">
                    <img src="${product.image || '/static/img/placeholder.webp'}" 
                         alt="${product.name}" 
                         class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110">
                </div>
                <div class="p-4">
                    <p class="text-sm text-gray-500 mb-1" data-bn="মারকাযুস সুন্নাহ">Markazus Sunnah</p>
                    <h3 class="heading-font text-xl font-semibold mb-2" data-bn="${product.name_bn || product.name}">${product.name}</h3>
                    <p class="text-lg font-semibold" data-bn="৳${product.price}">${product.price} taka</p>
                </div>
            </a>
        </div>
    `).join('');
    applyLanguage(localStorage.getItem('site_lang') || 'en');
}

// --- 3. ANIMATION MODULES ---
function initScrollAnimations() {
    ScrollTrigger.create({
        start: "top -50",
        onEnter: () => gsap.to("#navbar", { height: 65, backgroundColor: "rgba(255,255,255,0.95)", backdropFilter: "blur(10px)", duration: 0.4 }),
        onLeaveBack: () => gsap.to("#navbar", { height: 80, backgroundColor: "rgba(255,255,255,1)", backdropFilter: "blur(0px)", duration: 0.4 })
    });

    gsap.utils.toArray('.reveal-item').forEach(item => {
        gsap.to(item, {
            opacity: 1, y: 0, scale: 1,
            duration: 1.1, ease: "power4.out",
            scrollTrigger: { trigger: item, start: "top 90%" }
        });
    });

    gsap.set(".item-left", { xPercent: -150, y: 100, rotation: -30, autoAlpha: 0 });
    gsap.set(".item-right", { xPercent: 150, y: -100, rotation: 30, autoAlpha: 0 });
    gsap.set(".hero-title", { xPercent: -100, autoAlpha: 0 });

    const sceneTl = gsap.timeline({
        scrollTrigger: {
            trigger: ".scene-container",
            start: "top top",
            end: "+=200%",
            scrub: 1.5,
            pin: true,
            anticipatePin: 1,
            invalidateOnRefresh: true
        }
    });

    sceneTl
        .to(".bg-layer", { scale: 1.1, autoAlpha: 0.8, duration: 2 })
        .to(".hero-title", { xPercent: 0, autoAlpha: 1, duration: 2 }, "-=1.5")
        .to(".item-left", { xPercent: 0, y: 0, rotation: 0, autoAlpha: 1, duration: 3, ease: "power2.out" }, "-=1.8")
        .to(".item-right", { xPercent: 0, y: 0, rotation: 0, autoAlpha: 1, duration: 3, ease: "power2.out" }, "-=3");
}

function setupHeroSlider() {
    const slides = document.querySelectorAll('.hero-slide');
    const dots = document.querySelectorAll('.hero-dot');
    if (!slides.length) return;

    gsap.set(slides, { autoAlpha: 0 });
    gsap.set(slides[0], { autoAlpha: 1 });
    gsap.set(dots[0], { width: 48, backgroundColor: "white" });

    gsap.fromTo(slides[0].querySelector('.hero-img'), { scale: 1.15 }, { scale: 1, duration: 8, ease: "power2.out" });

    function changeSlide(index) {
        if (isAnimating || index === currentSlide) return;
        isAnimating = true;
        const oldSlide = slides[currentSlide];
        const newSlide = slides[index];
        dots.forEach((dot, i) => gsap.to(dot, { width: i === index ? 48 : 12, backgroundColor: i === index ? "white" : "rgba(255,255,255,0.2)", duration: 0.5 }));
        const tl = gsap.timeline({ onComplete: () => { currentSlide = index; isAnimating = false; }});
        tl.to(oldSlide, { autoAlpha: 0, scale: 0.98, duration: 1.2, ease: "expo.inOut" }, 0);
        tl.fromTo(newSlide, { autoAlpha: 0, scale: 1.02 }, { autoAlpha: 1, scale: 1, duration: 1.2, ease: "expo.inOut" }, 0);
        tl.fromTo(newSlide.querySelector('.hero-img'), { scale: 1.15 }, { scale: 1, duration: 6, ease: "power2.out" }, 0);
    }
    dots.forEach((dot, i) => dot.addEventListener('click', () => changeSlide(i)));
    setInterval(() => changeSlide((currentSlide + 1) % slides.length), 8000);
}

function setupCollectionScroll() {
    const wrapper = document.getElementById('collectionsWrapper');
    if (!wrapper) return;

    const cards = wrapper.querySelectorAll('.collection-card');
    const gap = 24; 
    let autoTimer, draggable;

    function getBounds() {
        // Correctly calculates the 'Right Wall' by subtracting the viewport width from total content width
        return {
            minX: -(wrapper.scrollWidth - wrapper.parentElement.offsetWidth),
            maxX: 0
        };
    }

    draggable = Draggable.create(wrapper, {
        type: "x",
        inertia: true,
        bounds: getBounds(),
        edgeResistance: 0.7, // Adds a tactile feel when hitting the right boundary
        onPress() {
            gsap.killTweensOf(wrapper);
            clearInterval(autoTimer);
            this.update(); // Recalculate bounds in case screen size changed
        },
        onRelease() {
            const step = cards[0].offsetWidth + gap;
            // Snap the card to the nearest place in the wall
            let target = Math.round(this.x / step) * step;
            
            // Safety Clamp to ensure we don't snap past the wall
            const bounds = getBounds();
            target = Math.max(bounds.minX, Math.min(bounds.maxX, target));

            gsap.to(wrapper, {
                x: target,
                duration: 0.6,
                ease: "power3.out",
                onComplete: startAuto
            });
        }
    })[0];

    function moveNext() {
        const step = cards[0].offsetWidth + gap;
        const bounds = getBounds();
        const currentX = gsap.getProperty(wrapper, "x");
        let target = currentX - step;
        if (target < bounds.minX - 10) target = 0;
        gsap.to(wrapper, { x: target, duration: 0.9, ease: "power3.inOut" });
    }

    function startAuto() {
        clearInterval(autoTimer);
        autoTimer = setInterval(moveNext, 4000);
    }

    startAuto();
    wrapper.addEventListener('mouseenter', () => { clearInterval(autoTimer); gsap.killTweensOf(wrapper); });
    wrapper.addEventListener('mouseleave', startAuto);

    window.addEventListener('resize', () => {
        draggable.applyBounds(getBounds());
    });
}

function initStatsCounter() {
    gsap.utils.toArray('.count-up').forEach(el => {
        const target = parseInt(el.dataset.target);
        gsap.to(el, {
            innerText: target, duration: 4, snap: { innerText: 1 },
            scrollTrigger: { trigger: el, start: "top 90%" }
        });
    });
}

// --- 4. LANGUAGE SYSTEM ---
function applyLanguage(lang) {
    document.body.classList.toggle('lang-bn', lang === 'bn');
    document.querySelectorAll('[data-bn]').forEach(el => {
        if (!el.dataset.en) el.dataset.en = el.innerHTML;
        el.innerHTML = lang === 'bn' ? el.dataset.bn : el.dataset.en;
    });
    const lb = document.getElementById('lang-toggle');
    if (lb) lb.textContent = lang === 'bn' ? 'EN' : 'BN';
    localStorage.setItem('site_lang', lang);
}


