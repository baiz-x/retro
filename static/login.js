/* login.js — depends on auth.js (csrfFetch, showAuthError, setSubmitBusy)
   being loaded first. */

const loginForm = document.getElementById('loginForm');
const resendCodeBtn = document.getElementById('resendCodeBtn');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();
  resendCodeBtn.classList.add('hidden');

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email || !password) {
    showAuthError('Please enter both your email and password.');
    return;
  }

  setSubmitBusy(true, 'Logging in...', 'Log In');

  try {
    const res = await csrfFetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const payload = await res.json();

    if (payload.status !== 'success') {
      showAuthError(payload.message || 'Could not log in. Please try again.');
      setSubmitBusy(false, '', 'Log In');
      if (payload.error_code === 'unverified') {
        resendCodeBtn.classList.remove('hidden');
      }
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
    showAuthError('Connection error. Please check your internet and try again.');
    setSubmitBusy(false, '', 'Log In');
  }
});

resendCodeBtn.addEventListener('click', async () => {
  // The login form already collects an email address, so reuse
  // whatever's currently typed there rather than asking again.
  const email = document.getElementById('email').value.trim();
  if (!email) {
    showAuthError('Enter your email above first, then tap resend.');
    return;
  }

  hideAuthError();
  resendCodeBtn.disabled = true;
  const originalText = resendCodeBtn.textContent;
  resendCodeBtn.textContent = 'Sending...';

  try {
    const res = await csrfFetch('/auth/resend-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const payload = await res.json();
    if (payload.status === 'success') {
      showAuthError(payload.message || 'If that email needs verification, a new code has been sent.');
    } else {
      showAuthError(payload.message || 'Could not resend the code. Please try again.');
    }
  } catch (err) {
    console.error('Resend failed:', err);
    showAuthError('Connection error. Please check your internet and try again.');
  } finally {
    resendCodeBtn.disabled = false;
    resendCodeBtn.textContent = originalText;
  }
});

