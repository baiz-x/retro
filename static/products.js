/**
 * MARKAZUS SUNNAH | Official Collection Logic
 */

let allProducts = [];
let filteredProducts = [];
let currentPage = 1;
const itemsPerPage = 12;
let searchTimeout;
let currentSort = 'newest';

// DOM Selections
const grid = document.getElementById('products-grid');
const searchInput = document.getElementById('search-input');
const parentContainer = document.getElementById('parent-filter-container');
const subArea = document.getElementById('sub-filter-area');
const resetBtn = document.getElementById('reset-filters-btn');

// Sort Selections
const sortBtn = document.getElementById('sort-button');
const sortDropdown = document.getElementById('sort-dropdown');
const sortLabel = document.getElementById('sort-label');
const sortIcon = document.getElementById('sort-icon');

async function loadProducts() {
    try {
        const res = await fetch('/api/products');
        const result = await res.json();
        if (result.status === 'success') {
            allProducts = result.data;
            renderParents();
            handleUrlCategory();
            applyFilters();
        }
    } catch (err) {
        grid.innerHTML = `<p class="col-span-full text-center py-20 text-gray-400 uppercase text-[10px] font-bold tracking-widest">System Error: Unable to Load Collection</p>`;
    }
}

/**
 * Reset Everything
 */
function resetFilters() {
    searchInput.value = '';
    currentSort = 'newest';
    sortLabel.textContent = 'New Arrivals';
    document.querySelectorAll('.parent-btn, .sub-btn').forEach(b => b.classList.remove('active-filter'));
    subArea.classList.add('hidden');
    subArea.innerHTML = '';
    applyFilters();
}

/**
 * Premium Dropdown Logic
 */
function toggleSort(e) {
    if (e) e.stopPropagation();
    const isHidden = sortDropdown.classList.contains('hidden');
    if (isHidden) {
        sortDropdown.classList.remove('hidden');
        requestAnimationFrame(() => {
            sortDropdown.classList.remove('opacity-0', 'scale-95');
            sortDropdown.classList.add('opacity-100', 'scale-100');
            sortIcon?.classList.add('rotate-180');
        });
    } else {
        closeSort();
    }
}

function closeSort() {
    if (!sortDropdown) return;
    sortDropdown.classList.add('opacity-0', 'scale-95');
    sortDropdown.classList.remove('opacity-100', 'scale-100');
    sortIcon?.classList.remove('rotate-180');
    setTimeout(() => sortDropdown.classList.add('hidden'), 200);
}

/**
 * Rendering Logic
 */
function renderParents() {
    if (!parentContainer) return;
    const parents = [...new Set(allProducts
        .map(p => p.category ? p.category.split('-')[0].trim() : null)
        .filter(Boolean)
    )].sort();

    parentContainer.innerHTML = parents.map(cat => `
        <button class="parent-btn px-6 py-2 rounded-full border border-gray-200 text-[10px] font-bold uppercase tracking-widest transition hover:border-black" 
                data-parent="${cat.toLowerCase()}">
            ${cat}
        </button>
    `).join('');
}

function renderSubCategories(parentVal) {
    const subs = [...new Set(allProducts
        .filter(p => p.category?.toLowerCase().startsWith(parentVal.toLowerCase() + '-'))
        .map(p => p.category.split('-')[1]?.trim())
    )].filter(Boolean).sort();

    if (subs.length > 0) {
        subArea.classList.remove('hidden');
        subArea.classList.add('no-scrollbar', 'flex');
        subArea.innerHTML = subs.map(s => `
            <button class="sub-btn whitespace-nowrap px-4 py-1 rounded-full bg-gray-100 text-[10px] font-bold uppercase transition hover:bg-gray-200" 
                    data-sub="${parentVal.toLowerCase()}-${s.toLowerCase()}">
                ${s}
            </button>
        `).join('');
    } else {
        subArea.classList.add('hidden');
    }
}

function applyFilters() {
    const search = searchInput?.value.toLowerCase() || '';
    const activeParent = document.querySelector('.parent-btn.active-filter')?.dataset.parent;
    const activeSub = document.querySelector('.sub-btn.active-filter')?.dataset.sub;

    filteredProducts = allProducts.filter(p => {
        const pCat = p.category?.toLowerCase() || '';
        const matchesSearch = p.name.toLowerCase().includes(search);
        let matchesCategory = true;
        if (activeSub) matchesCategory = (pCat === activeSub);
        else if (activeParent) matchesCategory = (pCat === activeParent || pCat.startsWith(activeParent + '-'));
        return matchesSearch && matchesCategory;
    });

    if (currentSort === 'price-low') filteredProducts.sort((a, b) => a.price - b.price);
    else if (currentSort === 'price-high') filteredProducts.sort((a, b) => b.price - a.price);
    else filteredProducts.sort((a, b) => b.id - a.id);

    renderGrid();
}

function renderGrid() {
    if (!grid) return;
    const start = (currentPage - 1) * itemsPerPage;
    const items = filteredProducts.slice(start, start + itemsPerPage);

    if (items.length === 0) {
        grid.innerHTML = `<p class="col-span-full text-center py-20 text-gray-400 uppercase text-[10px] font-bold tracking-widest">No Products Found</p>`;
        return;
    }

    grid.innerHTML = items.map(p => `
        <a href="/product?id=${p.id}" class="group no-underline text-gray-900">
            <div class="overflow-hidden rounded-[30px] bg-gray-50 aspect-[4/5] mb-6 relative">
                <img src="${p.image}" class="w-full h-full object-cover product-card-img">
                <div class="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors"></div>
            </div>
            <h3 class="heading-font font-bold text-sm mb-1">${p.name}</h3>
            <p class="text-[9px] text-gray-400 uppercase tracking-widest font-bold">${p.category.replace('-', ' ')}</p>
            <p class="font-black text-sm">BDT ${p.price}</p>
        </a>
    `).join('');
    renderPagination();
}

function renderPagination() {
    const pages = Math.ceil(filteredProducts.length / itemsPerPage);
    const container = document.getElementById('pagination');
    if (!container || pages <= 1) { if(container) container.innerHTML = ''; return; }
    let html = '';
    for (let i = 1; i <= pages; i++) {
        html += `<button onclick="changePage(${i})" class="w-10 h-10 rounded-full border text-[10px] font-bold transition ${i === currentPage ? 'active-filter' : 'hover:bg-gray-100 text-gray-400'}">${i}</button>`;
    }
    container.innerHTML = html;
}

window.changePage = (p) => { currentPage = p; renderGrid(); window.scrollTo({ top: 0, behavior: 'smooth' }); };

// --- Event Listeners ---
resetBtn?.addEventListener('click', resetFilters);

parentContainer?.addEventListener('click', (e) => {
    const btn = e.target.closest('.parent-btn');
    if (!btn) return;
    const wasActive = btn.classList.contains('active-filter');
    document.querySelectorAll('.parent-btn').forEach(b => b.classList.remove('active-filter'));
    if (!wasActive) {
        btn.classList.add('active-filter');
        renderSubCategories(btn.dataset.parent);
    } else {
        subArea.classList.add('hidden');
    }
    applyFilters();
});

subArea?.addEventListener('click', (e) => {
    const btn = e.target.closest('.sub-btn');
    if (!btn) return;
    const wasActive = btn.classList.contains('active-filter');
    document.querySelectorAll('.sub-btn').forEach(b => b.classList.remove('active-filter'));
    if (!wasActive) btn.classList.add('active-filter');
    applyFilters();
});

searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(applyFilters, 300);
});

// Sorting Logic
sortBtn?.addEventListener('click', toggleSort);
document.querySelectorAll('.sort-opt').forEach(opt => {
    opt.addEventListener('click', (e) => {
        currentSort = e.target.dataset.value;
        if (sortLabel) sortLabel.textContent = e.target.textContent;
        closeSort();
        applyFilters();
    });
});

document.addEventListener('click', (e) => {
    if (!e.target.closest('#sort-wrapper')) closeSort();
});

function handleUrlCategory() {
    const cat = new URLSearchParams(window.location.search).get('category')?.toLowerCase();
    if (cat) {
        const btn = document.querySelector(`.parent-btn[data-parent="${cat}"]`);
        if (btn) { btn.classList.add('active-filter'); renderSubCategories(cat); }
    }
}

document.addEventListener('DOMContentLoaded', loadProducts);


