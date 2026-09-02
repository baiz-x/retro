/* signup.js — depends on auth.js (csrfFetch, showAuthError, setSubmitBusy)
   being loaded first. */

const signupForm = document.getElementById('signupForm');
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,80}$/;

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();

  const username = document.getElementById('username').value.trim();
  const phoneNumber = document.getElementById('phone_number').value.trim();
  const password = document.getElementById('password').value;
  const socialPlatform = document.getElementById('social_platform').value;
  const socialHandle = document.getElementById('social_handle').value.trim();

  // Client-side checks mirror services/auth_service.py's
  // validate_username/validate_password_strength — real enforcement
  // still happens server-side, this is just to avoid a round trip for
  // obviously-invalid input.
  if (!USERNAME_RE.test(username)) {
    showAuthError('Username must be 3-80 characters (letters, numbers, underscore, period only).');
    return;
  }
  if (!phoneNumber) {
    showAuthError('Phone number is required.');
    return;
  }
  if (password.length < 8) {
    showAuthError('Password must be at least 8 characters.');
    return;
  }

  setSubmitBusy(true, 'Creating account...', 'Create Account');

  try {
    const res = await csrfFetch('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        phone_number: phoneNumber,
        password,
        social_platform: socialPlatform || null,
        social_handle: socialHandle || null,
      }),
    });
    const payload = await res.json();

    if (payload.status !== 'success') {
      showAuthError(payload.message || 'Could not create your account. Please try again.');
      setSubmitBusy(false, '', 'Create Account');
      return;
    }

    // Signup also logs the person in and migrates any guest-cart items
    // server-side (see auth_service.migrate_guest_cart_to_user).
    const params = new URLSearchParams(window.location.search);
    const redirectTo = params.get('next') || '/';
    window.location.href = redirectTo;
  } catch (err) {
    console.error('Signup failed:', err);
    showAuthError('Connection error. Please check your internet and try again.');
    setSubmitBusy(false, '', 'Create Account');
  }
});
