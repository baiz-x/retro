/* login.js — depends on auth.js (csrfFetch, showAuthError, setSubmitBusy)
   being loaded first. */

const loginForm = document.getElementById('loginForm');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  if (!username || !password) {
    showAuthError('Please enter both your username and password.');
    return;
  }

  setSubmitBusy(true, 'Logging in...', 'Log In');

  try {
    const res = await csrfFetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const payload = await res.json();

    if (payload.status !== 'success') {
      showAuthError(payload.message || 'Could not log in. Please try again.');
      setSubmitBusy(false, '', 'Log In');
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
