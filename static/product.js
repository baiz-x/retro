/**
 * Markazus Sunnah | Product Detail Logic (Production Ready)
 * Version: 2.3.2 (Fix: Dynamic Stock Display & Detailed Error Handling)
 */

let currentProduct = null;
let currentSelectedSize = "";

// DOM Elements
const elements = {
    name: document.getElementById('product-name'),
    price: document.getElementById('product-price'),
    description: document.getElementById('product-description'),
    image: document.getElementById('product-image'),
    gallery: document.getElementById('image-gallery'), 
    sizeContainer: document.getElementById('size-container'),
    stockPill: document.getElementById('stock-pill'),
    quantity: document.getElementById('quantity'),
    addToCartBtn: document.getElementById('addToCart'),
    buyNowBtn: document.getElementById('buyNow'),
    messageBox: document.getElementById('message-box'),
    accordionGroup: document.getElementById('accordion-group')
};

// 1. INITIALIZATION
document.addEventListener('DOMContentLoaded', () => {
    fetchProduct();
    setupEventListeners();
});

// 2. FETCH DATA
async function fetchProduct() {
    const urlParams = new URLSearchParams(window.location.search);
    const id = urlParams.get('id');
    if (!id) return;

    try {
        const response = await fetch(`/api/products/${id}`);
        const result = await response.json();
        if (result.status === 'success' && result.data) {
            currentProduct = result.data;
            renderProduct(currentProduct);
        }
    } catch (error) {
        console.error("Load Error:", error);
    }
}

// 3. EVENT LISTENERS
function setupEventListeners() {
    if (elements.accordionGroup) {
        elements.accordionGroup.addEventListener('click', (e) => {
            const header = e.target.closest('.accordion-header');
            if (!header) return;

            const item = header.parentElement;
            const isActive = item.classList.contains('active');

            document.querySelectorAll('.accordion-item').forEach(el => {
                el.classList.remove('active');
            });

            if (!isActive) item.classList.add('active');
        });
    }

    elements.sizeContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.size-option');
        if (!btn) return;

        document.querySelectorAll('.size-option').forEach(el => el.classList.remove('active', 'border-black'));
        btn.classList.add('active', 'border-black');

        const variant = {
            size: btn.getAttribute('data-size'),
            price: btn.getAttribute('data-price'),
            stock: btn.getAttribute('data-stock')
        };
        updateVariantDisplay(variant);
    });

    if (elements.gallery) {
        elements.gallery.addEventListener('click', (e) => {
            const thumb = e.target.closest('.gallery-thumb');
            if (!thumb) return;

            elements.image.src = thumb.getAttribute('data-src');
            document.querySelectorAll('.gallery-thumb').forEach(t => t.classList.remove('thumb-active'));
            thumb.classList.add('thumb-active');
        });
    }

    document.getElementById('increase').addEventListener('click', () => {
        elements.quantity.value = parseInt(elements.quantity.value) + 1;
    });

    document.getElementById('decrease').addEventListener('click', () => {
        const val = parseInt(elements.quantity.value);
        if (val > 1) elements.quantity.value = val - 1;
    });

    elements.addToCartBtn.addEventListener('click', () => addToBag(false));
    elements.buyNowBtn.addEventListener('click', () => addToBag(true));
}

// 4. RENDERING & UI UPDATES
function renderProduct(product) {
    elements.name.textContent = product.name;
    elements.description.textContent = product.description;
    elements.image.src = product.image || 'https://placehold.co/600x800?text=No+Image';

    renderGallery(product);

    let variants = [];

    if (product.variants && !Array.isArray(product.variants) && typeof product.variants === 'object') {
        variants = Object.values(product.variants); 
    } 
    else if (Array.isArray(product.variants)) {
        variants = product.variants;
    } 
    else if (typeof product.variants === 'string' && product.variants.trim() !== "") {
        variants = product.variants.split(',').map(s => ({ 
            size: s.trim(), 
            price: product.price, 
            stock: product.stock 
        }));
    }

    if (variants.length > 0) {
        elements.sizeContainer.innerHTML = variants.map((v, index) => `
            <button data-size="${v.size}" data-price="${v.price}" data-stock="${v.stock}"
                    class="size-option px-8 py-3 border-2 border-gray-100 rounded-full text-[10px] font-bold uppercase tracking-widest transition-all hover:border-black ${index === 0 ? 'active border-black' : ''}">
                ${v.size}
            </button>
        `).join('');
        // This ensures the first variant is correctly styled (red/green) on page load
        updateVariantDisplay(variants[0]);
    }
}

function renderGallery(product) {
    if (!elements.gallery) return;
    
    const images = [product.image, ...(product.gallery || [])].filter(src => src);

    if (images.length <= 1) {
        elements.gallery.innerHTML = "";
        return;
    }

    elements.gallery.innerHTML = images.map((src, i) => `
        <div class="gallery-thumb aspect-square rounded-xl overflow-hidden border-2 cursor-pointer transition-all opacity-60 hover:opacity-100 ${i === 0 ? 'thumb-active' : 'border-transparent'}" 
             data-src="${src}">
            <img src="${src}" class="w-full h-full object-cover">
        </div>
    `).join('');
}

function updateVariantDisplay(variant) {
    if (!variant) return;
    currentSelectedSize = variant.size;
    elements.price.textContent = `BDT ${parseFloat(variant.price).toLocaleString()}`;

    // Requirement 1: Show stock of each variant in the capsule
    const stockCount = parseInt(variant.stock);
    const isAvailable = stockCount > 0;

    if (isAvailable) {
        elements.stockPill.textContent = `${stockCount} Units In Stock`;
        elements.stockPill.className = `px-4 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest border border-emerald-500 text-emerald-600 bg-emerald-50`;
    } else {
        // Requirement 3: Show red pill "Out of Stock" if stock is 0
        elements.stockPill.textContent = "Out of Stock";
        elements.stockPill.className = `px-4 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest border border-red-500 text-red-600 bg-red-50`;
    }
    
    elements.addToCartBtn.disabled = !isAvailable;
    elements.buyNowBtn.disabled = !isAvailable;
    elements.addToCartBtn.textContent = isAvailable ? "Add to Cart" : "Sold Out";
}

// 5. API ACTIONS
async function addToBag(redirect) {
    if (!currentProduct) return;
    const btn = redirect ? elements.buyNowBtn : elements.addToCartBtn;
    const originalText = btn.textContent;
    
    btn.disabled = true;
    btn.textContent = "Processing...";

    try {
        const response = await fetch('/api/cart/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                product_id: currentProduct.id, 
                quantity: parseInt(elements.quantity.value),
                size: currentSelectedSize 
            })
        });

        const result = await response.json();
        
        // Requirement 2: Show specific stock error from backend if request fails
        if (response.ok && result.status === 'success') {
            showMessage("Added to Bag", "bg-black");
            if (redirect) window.location.href = '/cart';
        } else {
            // result.message will contain "Insufficient stock. Available: X" from cart_service.py
            showMessage(result.message || "Could not add to cart", "bg-red-600");
        }
    } catch (err) {
        showMessage("Connection Error", "bg-red-600");
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

function showMessage(text, bgColor) {
    elements.messageBox.textContent = text;
    elements.messageBox.className = `fixed top-6 right-6 z-[100] px-8 py-4 rounded-full shadow-2xl font-bold uppercase tracking-widest text-[10px] text-white transition-all duration-300 show ${bgColor}`;
    elements.messageBox.classList.remove('hidden');
    setTimeout(() => {
        elements.messageBox.classList.remove('show');
        setTimeout(() => elements.messageBox.classList.add('hidden'), 400);
    }, 3000);
}

