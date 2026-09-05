/* auth.js — shared between login.html and signup.html.
   Load this BEFORE login.js/signup.js (see script order in each HTML
   file) since both depend on csrfFetch(). */

/* Same pattern as product.js's csrfFetch — reads the per-page
   <meta name="csrf-token"> tag (rendered server-side via
   {{ csrf_token() }}) and attaches it as the X-CSRFToken header
   flask-wtf's CSRFProtect requires on POST. */
function csrfFetch(url, options = {}) {
  const token = document.querySelector('meta[name="csrf-token"]').content;
  options.headers = { ...(options.headers || {}), 'X-CSRFToken': token };
  return fetch(url, options);
}

/* Show/hide password toggle — present on both pages. */
const togglePasswordBtn = document.getElementById('togglePassword');
if (togglePasswordBtn) {
  togglePasswordBtn.addEventListener('click', () => {
    const input = document.getElementById('password');
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    togglePasswordBtn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    togglePasswordBtn.innerHTML = `<i data-lucide="${isHidden ? 'eye-off' : 'eye'}" class="w-4 h-4"></i>`;
    if (window.lucide) lucide.createIcons();
  });
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

if (window.lucide) lucide.createIcons();

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

