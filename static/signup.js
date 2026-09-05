/* signup.js — depends on auth.js (csrfFetch, showAuthError, setSubmitBusy)
   being loaded first. */

const signupForm = document.getElementById('signupForm');
const verifyForm = document.getElementById('verifyForm');
const loginLink = document.getElementById('loginLink');
const verifyEmailDisplay = document.getElementById('verifyEmailDisplay');
const resendCodeBtn = document.getElementById('resendCodeBtn');
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,80}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Set once signup succeeds, so verifyForm's submit handler and the
// resend button both know which address they're acting on.
let pendingEmail = null;

function showVerifyStep(email) {
  pendingEmail = email;
  verifyEmailDisplay.textContent = email;
  signupForm.classList.add('hidden');
  loginLink.classList.add('hidden');
  verifyForm.classList.remove('hidden');
  document.getElementById('verification_code').focus();
}

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();

  const username = document.getElementById('username').value.trim();
  const email = document.getElementById('email').value.trim();
  const phoneNumber = document.getElementById('phone_number').value.trim();
  const password = document.getElementById('password').value;
  const socialPlatform = document.getElementById('social_platform').value;
  const socialHandle = document.getElementById('social_handle').value.trim();

  // Client-side checks mirror services/auth_service.py's
  // validate_username/validate_email/validate_password_strength — real
  // enforcement still happens server-side, this is just to avoid a
  // round trip for obviously-invalid input.
  if (!USERNAME_RE.test(username)) {
    showAuthError('Username must be 3-80 characters (letters, numbers, underscore, period only).');
    return;
  }
  if (!EMAIL_RE.test(email)) {
    showAuthError('Please enter a valid email address.');
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
        email,
        phone_number: phoneNumber,
        password,
        social_platform: socialPlatform || null,
        social_handle: socialHandle || null,
      }),
    });
    const payload = await res.json();

    if (payload.status !== 'pending_verification') {
      showAuthError(payload.message || 'Could not create your account. Please try again.');
      setSubmitBusy(false, '', 'Create Account');
      return;
    }

    // Account is created but unverified server-side. Swap to the
    // inline code-entry step instead of redirecting anywhere.
    setSubmitBusy(false, '', 'Create Account');
    showVerifyStep(payload.data.email);
  } catch (err) {
    console.error('Signup failed:', err);
    showAuthError('Connection error. Please check your internet and try again.');
    setSubmitBusy(false, '', 'Create Account');
  }
});

verifyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();

  const code = document.getElementById('verification_code').value.trim();
  if (!/^[0-9]{6}$/.test(code)) {
    showAuthError('Please enter the 6-digit code from your email.');
    return;
  }

  setSubmitBusy(true, 'Verifying...', 'Verify Email', 'verifySubmitBtn', 'verifySubmitLabel');

  try {
    const res = await csrfFetch('/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail, code }),
    });
    const payload = await res.json();

    if (payload.status !== 'success') {
      showAuthError(payload.message || 'Could not verify your email. Please try again.');
      setSubmitBusy(false, '', 'Verify Email', 'verifySubmitBtn', 'verifySubmitLabel');
      return;
    }

    // Verified and logged in server-side (session set, guest cart
    // migrated) — safe to redirect now.
    const params = new URLSearchParams(window.location.search);
    const redirectTo = params.get('next') || '/';
    window.location.href = redirectTo;
  } catch (err) {
    console.error('Verification failed:', err);
    showAuthError('Connection error. Please check your internet and try again.');
    setSubmitBusy(false, '', 'Verify Email', 'verifySubmitBtn', 'verifySubmitLabel');
  }
});

resendCodeBtn.addEventListener('click', async () => {
  hideAuthError();
  resendCodeBtn.disabled = true;
  const originalText = resendCodeBtn.textContent;
  resendCodeBtn.textContent = 'Sending...';

  try {
    const res = await csrfFetch('/auth/resend-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail }),
    });
    const payload = await res.json();
    if (payload.status !== 'success') {
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

