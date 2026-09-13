/* =====================================================================
   account.js — /account page
   ===================================================================== */

/* ---------------- Icon hydration ----------------
   Same as index.js's version — kept here too since index.js itself
   isn't included on this page (see account.html comment: index.js
   throws on pages without #arrivalsRail/#discoveryRail/#faqList,
   which would kill the listener registrations below it). */
function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-lucide]').forEach(el => {
    const name = el.getAttribute('data-lucide');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (el.className) svg.setAttribute('class', el.className);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.appendChild(use);
    el.replaceWith(svg);
  });
}
hydrateIcons();

/* ---------------- Mobile menu (shared navbar chrome) ---------------- */
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const mobileMenu = document.getElementById('mobileMenu');
if (mobileMenuBtn && mobileMenu) {
  mobileMenuBtn.addEventListener('click', () => {
    const isOpen = mobileMenu.classList.toggle('open');
    mobileMenuBtn.setAttribute('aria-expanded', isOpen);
    mobileMenuBtn.innerHTML = isOpen ? '<i data-lucide="x" class="w-6 h-6"></i>' : '<i data-lucide="menu" class="w-6 h-6"></i>';
    hydrateIcons();
  });
}

/* ---------------- Theme toggle (visual, shared navbar chrome) ---------------- */
const themeToggleBtn = document.getElementById('themeToggleBtn');
if (themeToggleBtn) {
  let isDarkIcon = true;
  themeToggleBtn.addEventListener('click', () => {
    isDarkIcon = !isDarkIcon;
    themeToggleBtn.innerHTML = isDarkIcon
      ? '<i data-lucide="moon" class="w-[18px] h-[18px]"></i>'
      : '<i data-lucide="sun" class="w-[18px] h-[18px]"></i>';
    hydrateIcons();
  });
}

/* ---------------- Search (shared navbar chrome) ----------------
   No search overlay markup on account.html (it's a settings page,
   not a browse page) — guarded so these just no-op if absent rather
   than throwing, in case a future edit adds it. */
const searchOverlay = document.getElementById('searchOverlay');
const searchBtn = document.getElementById('searchBtn');
const mobileSearchBtn = document.getElementById('mobileSearchBtn');
if (searchOverlay && (searchBtn || mobileSearchBtn)) {
  const openSearch = () => {
    searchOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('searchInput')?.focus(), 100);
  };
  const closeSearch = () => {
    searchOverlay.classList.remove('open');
    document.body.style.overflow = '';
  };
  searchBtn?.addEventListener('click', openSearch);
  mobileSearchBtn?.addEventListener('click', openSearch);
  document.getElementById('searchCloseBtn')?.addEventListener('click', closeSearch);
  searchOverlay.addEventListener('click', e => { if (e.target === searchOverlay) closeSearch(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSearch(); });
}

/* ---------------- CSRF-aware fetch wrapper ----------------
   Flask-WTF CSRF is enabled on this backend, so every POST needs the
   X-CSRFToken header. index.js never needed this (its POST-shaped
   calls don't actually exist yet — /api/cart there is a GET), so
   there's no existing convention to match; this is the first place
   it's needed. */
const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.content || '';

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': CSRF_TOKEN,
    },
    body: JSON.stringify(body),
  });
  let payload;
  try {
    payload = await res.json();
  } catch {
    payload = { status: 'error', message: 'Unexpected server response' };
  }
  return { ok: res.ok, payload };
}

/* ---------------- Status banner ---------------- */
const statusBanner = document.getElementById('statusBanner');
let bannerTimeout = null;

function showBanner(message, kind) {
  clearTimeout(bannerTimeout);
  statusBanner.textContent = message;
  statusBanner.classList.remove('hidden', 'success', 'error');
  statusBanner.classList.add(kind);
  statusBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  bannerTimeout = setTimeout(() => statusBanner.classList.add('hidden'), 6000);
}

/* ---------------- Helper: disable a form's submit button while a request is in flight ---------------- */
function withSubmitLock(form, fn) {
  return async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  };
}

/* ---------------- Profile form ---------------- */
const profileForm = document.getElementById('profileForm');
profileForm.addEventListener('submit', withSubmitLock(profileForm, async () => {
  const { ok, payload } = await postJSON('/auth/update-profile', {
    name: document.getElementById('nameInput').value,
    phone_number: document.getElementById('phoneInput').value,
    address: document.getElementById('addressInput').value,
    social_platform: document.getElementById('socialPlatformInput').value,
    social_handle: document.getElementById('socialHandleInput').value,
  });
  showBanner(ok ? 'Profile updated.' : (payload.message || 'Could not update profile.'), ok ? 'success' : 'error');
}));

/* ---------------- Email change: request / confirm ----------------
   The backend overwrites user.email immediately on request (not a
   separate pending field) and flips is_verified to False, reusing
   the same verification_code columns signup uses. So the UI state
   here keys off is_verified, not a "pending email" value. */
const requestEmailForm = document.getElementById('requestEmailForm');
const confirmEmailForm = document.getElementById('confirmEmailForm');
const unverifiedEmailBanner = document.getElementById('unverifiedEmailBanner');

function showUnverifiedState() {
  unverifiedEmailBanner.classList.remove('hidden');
  confirmEmailForm.classList.remove('hidden');
  confirmEmailForm.classList.add('flex');
}

function showVerifiedState() {
  unverifiedEmailBanner.classList.add('hidden');
  confirmEmailForm.classList.add('hidden');
  confirmEmailForm.classList.remove('flex');
  confirmEmailForm.reset();
}

// Page loaded already unverified (e.g. they changed email, then
// refreshed before entering the code) — user.is_verified was
// rendered server-side into a data attribute, no extra round trip.
if (document.body.dataset.isVerified === 'false') {
  showUnverifiedState();
}

requestEmailForm.addEventListener('submit', withSubmitLock(requestEmailForm, async () => {
  const { ok, payload } = await postJSON('/auth/request-email-change', {
    new_email: document.getElementById('newEmailInput').value,
    current_password: document.getElementById('emailChangePasswordInput').value,
  });
  if (ok) {
    showBanner(payload.message || 'Email changed — please verify it.', 'success');
    document.getElementById('currentEmailValue').textContent = payload.data.email;
    requestEmailForm.reset();
    showUnverifiedState();
  } else {
    showBanner(payload.message || 'Could not change email.', 'error');
  }
}));

confirmEmailForm.addEventListener('submit', withSubmitLock(confirmEmailForm, async () => {
  const { ok, payload } = await postJSON('/auth/confirm-email-change', {
    code: document.getElementById('emailCodeInput').value,
  });
  if (ok) {
    showBanner('Email address verified.', 'success');
    showVerifiedState();
  } else {
    showBanner(payload.message || 'Could not confirm email change.', 'error');
  }
}));

/* ---------------- Password form ---------------- */
const passwordForm = document.getElementById('passwordForm');
passwordForm.addEventListener('submit', withSubmitLock(passwordForm, async () => {
  const newPassword = document.getElementById('newPasswordInput').value;
  const confirmPassword = document.getElementById('confirmPasswordInput').value;

  if (newPassword !== confirmPassword) {
    showBanner('New password and confirmation do not match.', 'error');
    return;
  }

  const { ok, payload } = await postJSON('/auth/change-password', {
    current_password: document.getElementById('currentPasswordInput').value,
    new_password: newPassword,
  });
  showBanner(ok ? 'Password updated.' : (payload.message || 'Could not update password.'), ok ? 'success' : 'error');
  if (ok) passwordForm.reset();
}));

