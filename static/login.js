/* login.js — depends on auth.js (csrfFetch, showAuthError, hideAuthError,
   setSubmitBusy) being loaded first. */

const loginForm = document.getElementById('loginForm');
const forgotForm = document.getElementById('forgotForm');
const forgotLink = document.getElementById('forgotLink');
const forgotBackBtn = document.getElementById('forgotBackBtn');
const forgotEmail = document.getElementById('forgotEmail');
const forgotSent = document.getElementById('forgotSent');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email || !password) {
    showAuthError(rfT('Please enter both your email and password.', 'ইমেইল আর পাসওয়ার্ড দুটোই দিন।'));
    return;
  }

  setSubmitBusy(true, rfT('Logging in...', 'লগইন হচ্ছে...'), rfT('Log In', 'লগইন'));

  try {
    const res = await csrfFetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const payload = await res.json();

    if (payload.status !== 'success') {
      // Correct password but unverified account: the server has already
      // sent a fresh code, so go straight to the code-entry step on the
      // signup page. The email travels via sessionStorage (not the URL)
      // so it doesn't end up in server logs or browser history.
      if (payload.error_code === 'unverified' && payload.data && payload.data.email) {
        try {
          sessionStorage.setItem('pendingVerifyEmail', payload.data.email);
        } catch (storageErr) {
          console.error('sessionStorage unavailable:', storageErr);
        }
        const params = new URLSearchParams(window.location.search);
        const next = params.get('next');
        window.location.href = '/signup?verify=1' + (next ? '&next=' + encodeURIComponent(next) : '');
        return;
      }

      showAuthError(payload.message || rfT('Could not log in. Please try again.', 'লগইন করা যায়নি। আবার চেষ্টা করুন।'));
      setSubmitBusy(false, '', rfT('Log In', 'লগইন'));
      return;
    }

    // Successful login also migrates any guest-cart items to the
    // account server-side (see auth_service.migrate_guest_cart_to_user),
    // so returning to wherever the person came from already reflects
    // their merged cart.
    const params = new URLSearchParams(window.location.search);
    const redirectTo = params.get('next') || '/';
    window.location.href = redirectTo;
  } catch (err) {
    console.error('Login failed:', err);
    showAuthError(rfT('Connection error. Please check your internet and try again.', 'কানেকশন সমস্যা। ইন্টারনেট চেক করে আবার চেষ্টা করুন।'));
    setSubmitBusy(false, '', rfT('Log In', 'লগইন'));
  }
});

/* ---------------- Forgot password (inline panel) ---------------- */
forgotLink.addEventListener('click', () => {
  hideAuthError();
  // Carry over whatever was already typed into the login email field.
  forgotEmail.value = document.getElementById('email').value.trim();
  forgotSent.classList.add('hidden');
  setSubmitBusy(false, '', rfT('Send Reset Link', 'রিসেট লিংক পাঠান'), 'forgotSubmitBtn', 'forgotSubmitLabel');
  loginForm.classList.add('hidden');
  forgotForm.classList.remove('hidden');
  forgotEmail.focus();
});

forgotBackBtn.addEventListener('click', () => {
  hideAuthError();
  forgotForm.classList.add('hidden');
  loginForm.classList.remove('hidden');
});

forgotForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();

  const email = forgotEmail.value.trim();
  if (!EMAIL_RE.test(email)) {
    showAuthError(rfT('Please enter a valid email address.', 'সঠিক একটা ইমেইল অ্যাড্রেস দিন।'));
    return;
  }

  setSubmitBusy(true, rfT('Sending...', 'পাঠানো হচ্ছে...'), rfT('Send Reset Link', 'রিসেট লিংক পাঠান'), 'forgotSubmitBtn', 'forgotSubmitLabel');

  try {
    const res = await csrfFetch('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const payload = await res.json();

    if (payload.status !== 'success') {
      showAuthError(payload.message || rfT('Could not send the reset link. Please try again.', 'রিসেট লিংক পাঠানো যায়নি। আবার চেষ্টা করুন।'));
      setSubmitBusy(false, '', rfT('Send Reset Link', 'রিসেট লিংক পাঠান'), 'forgotSubmitBtn', 'forgotSubmitLabel');
      return;
    }

    forgotSent.textContent = payload.message;
    forgotSent.classList.remove('hidden');
    // Stays disabled until the person leaves and re-opens this panel.
    setSubmitBusy(true, rfT('Link sent', 'লিংক পাঠানো হয়েছে'), rfT('Send Reset Link', 'রিসেট লিংক পাঠান'), 'forgotSubmitBtn', 'forgotSubmitLabel');
  } catch (err) {
    console.error('Forgot password failed:', err);
    showAuthError(rfT('Connection error. Please check your internet and try again.', 'কানেকশন সমস্যা। ইন্টারনেট চেক করে আবার চেষ্টা করুন।'));
    setSubmitBusy(false, '', rfT('Send Reset Link', 'রিসেট লিংক পাঠান'), 'forgotSubmitBtn', 'forgotSubmitLabel');
  }
});

