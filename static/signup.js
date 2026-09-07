/* signup.js — depends on auth.js (csrfFetch, showAuthError, setSubmitBusy)
   being loaded first.

   3-step wizard: Step 1 (name/email/password) -> Step 2 (phone/
   address/social) -> Step 3 (email verification). Steps 1-2 are
   plain client-side gated navigation (nothing is sent to the server
   until step 2 submits); step 3 only appears after the server has
   actually created the account. Going "Back" from step 2 to step 1
   keeps whatever was typed, since the inputs simply stay in the DOM
   (only visibility toggles, not their values). */

const step1Form = document.getElementById('step1Form');
const step2Form = document.getElementById('step2Form');
const verifyForm = document.getElementById('verifyForm');
const loginLink = document.getElementById('loginLink');
const verifyEmailDisplay = document.getElementById('verifyEmailDisplay');
const resendCodeBtn = document.getElementById('resendCodeBtn');
const stepLabel = document.getElementById('stepLabel');
const stepDots = document.querySelectorAll('[data-step-dot]');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Set once step 1 passes validation, so step 2's submit handler has
// everything needed to send the full signup payload in one request
// (the backend has no partial-signup endpoint — the account is only
// created once, on step 2's submit).
let step1Data = null;

// Set once signup succeeds, so verifyForm's submit handler and the
// resend button both know which address they're acting on.
let pendingEmail = null;

function setStep(stepNumber) {
  stepLabel.textContent = `Step ${stepNumber} of 3`;
  stepDots.forEach((dot) => {
    const n = Number(dot.dataset.stepDot);
    dot.classList.toggle('active', n === stepNumber);
    dot.classList.toggle('complete', n < stepNumber);
  });
}

/* ---------------- Step 1: Name / Email / Password ---------------- */
step1Form.addEventListener('submit', (e) => {
  e.preventDefault();
  hideAuthError();

  const name = document.getElementById('name').value.trim();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  // Client-side checks mirror services/auth_service.py's
  // validate_name/validate_email/validate_password_strength — real
  // enforcement still happens server-side, this is just to avoid a
  // round trip for obviously-invalid input.
  if (!name) {
    showAuthError('Please enter your name.');
    return;
  }
  if (!EMAIL_RE.test(email)) {
    showAuthError('Please enter a valid email address.');
    return;
  }
  if (password.length < 8) {
    showAuthError('Password must be at least 8 characters.');
    return;
  }

  step1Data = { name, email, password };
  step1Form.classList.add('hidden');
  step2Form.classList.remove('hidden');
  setStep(2);
  document.getElementById('phone_number').focus();
});

/* ---------------- Step 2 back button ---------------- */
document.getElementById('step2BackBtn').addEventListener('click', () => {
  hideAuthError();
  step2Form.classList.add('hidden');
  step1Form.classList.remove('hidden');
  setStep(1);
});

/* ---------------- Step 2: Phone / Address / Social -> submit ---------------- */
function showVerifyStep(email) {
  pendingEmail = email;
  verifyEmailDisplay.textContent = email;
  step2Form.classList.add('hidden');
  loginLink.classList.add('hidden');
  verifyForm.classList.remove('hidden');
  setStep(3);
  document.getElementById('verification_code').focus();
}

step2Form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();

  const phoneNumber = document.getElementById('phone_number').value.trim();
  const address = document.getElementById('address').value.trim();
  const socialPlatform = document.getElementById('social_platform').value;
  const socialHandle = document.getElementById('social_handle').value.trim();

  if (!phoneNumber) {
    showAuthError('Phone number is required.');
    return;
  }
  if (!address) {
    showAuthError('Address is required.');
    return;
  }

  setSubmitBusy(true, 'Creating account...', 'Create Account');

  try {
    const res = await csrfFetch('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: step1Data.name,
        email: step1Data.email,
        password: step1Data.password,
        phone_number: phoneNumber,
        address,
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

/* ---------------- Step 3: Verify email ---------------- */
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

setStep(1);

