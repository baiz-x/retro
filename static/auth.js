/* auth.js — shared between login.html and signup.html.
   Load this BEFORE login.js/signup.js (see script order in each HTML
   file) since both depend on csrfFetch(). */

/* Same pattern as product.js's csrfFetch — reads the per-page
   <meta name="csrf-token"> tag (rendered server-side via
   {{ csrf_token() }}) and attaches it as the X-CSRFToken header
   flask-wtf's CSRFProtect requires on POST. */
/* i18n: returns the Bangla string when the Bangla switch is on (see static/i18n.js). */
const rfT = (en, bn) => (window.RFi18n ? window.RFi18n.t(en, bn) : en);

function csrfFetch(url, options = {}) {
  const token = document.querySelector('meta[name="csrf-token"]').content;
  options.headers = { ...(options.headers || {}), 'X-CSRFToken': token };
  return fetch(url, options);
}

/* Show/hide password toggle — login, signup and reset pages.
   Icons come from the shared inline sprite (partials/_icon_sprite.html),
   same as the rest of the site — no lucide CDN script. */
const togglePasswordBtn = document.getElementById('togglePassword');
function syncPasswordToggle() {
  const input = document.getElementById('password');
  const hiddenNow = input.type === 'password';
  togglePasswordBtn.setAttribute('aria-label', hiddenNow ? rfT('Show password', 'পাসওয়ার্ড দেখান') : rfT('Hide password', 'পাসওয়ার্ড লুকান'));
  togglePasswordBtn.innerHTML = `<svg class="w-4 h-4" aria-hidden="true"><use href="#icon-${hiddenNow ? 'eye' : 'eye-off'}"></use></svg>`;
}
if (togglePasswordBtn) {
  togglePasswordBtn.addEventListener('click', () => {
    const input = document.getElementById('password');
    input.type = input.type === 'password' ? 'text' : 'password';
    syncPasswordToggle();
  });
  // The language switch rewrites aria-label from its data attributes; re-sync for the current state.
  document.addEventListener('rf:langchange', syncPasswordToggle);
}

/* Optional social-contact fields toggle — signup.html only (no-op if
   the elements aren't on the page, e.g. login.html). */
const socialToggle = document.getElementById('socialToggle');
if (socialToggle) {
  socialToggle.addEventListener('click', () => {
    const fields = document.getElementById('socialFields');
    const isOpen = fields.classList.toggle('open');
    socialToggle.setAttribute('aria-expanded', isOpen);
  });
}

/* Shared error-display + button-busy helpers for the two forms. */
function showAuthError(message) {
  const el = document.getElementById('formError');
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideAuthError() {
  document.getElementById('formError').classList.add('hidden');
}

function setSubmitBusy(isBusy, busyLabel, idleLabel, btnId = 'submitBtn', labelId = 'submitLabel') {
  const btn = document.getElementById(btnId);
  const label = document.getElementById(labelId);
  btn.disabled = isBusy;
  label.textContent = isBusy ? busyLabel : idleLabel;
}

