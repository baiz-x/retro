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

let currentStep = 1;
function setStep(stepNumber) {
  currentStep = stepNumber;
  stepLabel.textContent = rfT(`Step ${stepNumber} of 3`, `ধাপ ${stepNumber} / 3`);
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
    showAuthError(rfT('Please enter your name.', 'আপনার নাম দিন।'));
    return;
  }
  if (!EMAIL_RE.test(email)) {
    showAuthError(rfT('Please enter a valid email address.', 'সঠিক একটা ইমেইল অ্যাড্রেস দিন।'));
    return;
  }
  if (password.length < 8) {
    showAuthError(rfT('Password must be at least 8 characters.', 'পাসওয়ার্ড কমপক্ষে 8 অক্ষরের হতে হবে।'));
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
// Matches VERIFICATION_RESEND_COOLDOWN_SECONDS in services/auth_service.py.
const RESEND_COOLDOWN_SECONDS = 60;
let resendTimer = null;

function startResendCooldown(seconds) {
  clearInterval(resendTimer);
  let remaining = seconds;
  resendCodeBtn.disabled = true;

  const tick = () => {
    if (remaining <= 0) {
      clearInterval(resendTimer);
      resendCodeBtn.disabled = false;
      resendCodeBtn.textContent = rfT('Resend code', 'আবার কোড পাঠান');
      return;
    }
    resendCodeBtn.textContent = rfT(`Resend code in ${remaining}s`, `আবার কোড পাঠান (${remaining} সেকেন্ড)`);
    remaining -= 1;
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

function showVerifyStep(email) {
  pendingEmail = email;
  verifyEmailDisplay.textContent = email;
  // step1Form is hidden too: when arriving from the login page
  // (?verify=1) step 1 is still on screen, since no wizard step ran.
  step1Form.classList.add('hidden');
  step2Form.classList.add('hidden');
  loginLink.classList.add('hidden');
  verifyForm.classList.remove('hidden');
  setStep(3);
  startResendCooldown(RESEND_COOLDOWN_SECONDS);
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
    showAuthError(rfT('Phone number is required.', 'ফোন নম্বর দিতে হবে।'));
    return;
  }
  if (!address) {
    showAuthError(rfT('Address is required.', 'ঠিকানা দিতে হবে।'));
    return;
  }
  if (!socialPlatform) {
    showAuthError(rfT('Please select a social media platform.', 'একটা সোশ্যাল মিডিয়া প্ল্যাটফর্ম বেছে নিন।'));
    return;
  }
  if (!socialHandle) {
    showAuthError(rfT('Social media handle is required.', 'সোশ্যাল মিডিয়া হ্যান্ডেল দিতে হবে।'));
    return;
  }

  setSubmitBusy(true, rfT('Creating account...', 'অ্যাকাউন্ট খোলা হচ্ছে...'), rfT('Create Account', 'অ্যাকাউন্ট খুলুন'));

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
        social_platform: socialPlatform,
        social_handle: socialHandle,
      }),
    });
    const payload = await res.json();

    if (payload.status !== 'pending_verification') {
      showAuthError(payload.message || rfT('Could not create your account. Please try again.', 'অ্যাকাউন্ট খোলা যায়নি। আবার চেষ্টা করুন।'));
      setSubmitBusy(false, '', rfT('Create Account', 'অ্যাকাউন্ট খুলুন'));
      return;
    }

    // Account is created but unverified server-side. Swap to the
    // inline code-entry step instead of redirecting anywhere.
    setSubmitBusy(false, '', rfT('Create Account', 'অ্যাকাউন্ট খুলুন'));
    showVerifyStep(payload.data.email);
  } catch (err) {
    console.error('Signup failed:', err);
    showAuthError(rfT('Connection error. Please check your internet and try again.', 'কানেকশন সমস্যা। ইন্টারনেট চেক করে আবার চেষ্টা করুন।'));
    setSubmitBusy(false, '', rfT('Create Account', 'অ্যাকাউন্ট খুলুন'));
  }
});

/* ---------------- Step 3: Verify email ---------------- */
verifyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();

  const code = document.getElementById('verification_code').value.trim();
  if (!/^[0-9]{6}$/.test(code)) {
    showAuthError(rfT('Please enter the 6-digit code from your email.', 'ইমেইলে পাঠানো 6 ডিজিটের কোডটা দিন।'));
    return;
  }

  setSubmitBusy(true, rfT('Verifying...', 'ভেরিফাই হচ্ছে...'), rfT('Verify Email', 'ইমেইল ভেরিফাই করুন'), 'verifySubmitBtn', 'verifySubmitLabel');

  try {
    const res = await csrfFetch('/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail, code }),
    });
    const payload = await res.json();

    if (payload.status !== 'success') {
      showAuthError(payload.message || rfT('Could not verify your email. Please try again.', 'ইমেইল ভেরিফাই করা যায়নি। আবার চেষ্টা করুন।'));
      setSubmitBusy(false, '', rfT('Verify Email', 'ইমেইল ভেরিফাই করুন'), 'verifySubmitBtn', 'verifySubmitLabel');
      return;
    }

    // Verified and logged in server-side (session set, guest cart
    // migrated) — safe to redirect now.
    const params = new URLSearchParams(window.location.search);
    const redirectTo = params.get('next') || '/';
    window.location.href = redirectTo;
  } catch (err) {
    console.error('Verification failed:', err);
    showAuthError(rfT('Connection error. Please check your internet and try again.', 'কানেকশন সমস্যা। ইন্টারনেট চেক করে আবার চেষ্টা করুন।'));
    setSubmitBusy(false, '', rfT('Verify Email', 'ইমেইল ভেরিফাই করুন'), 'verifySubmitBtn', 'verifySubmitLabel');
  }
});

resendCodeBtn.addEventListener('click', async () => {
  hideAuthError();
  resendCodeBtn.disabled = true;
  resendCodeBtn.textContent = rfT('Sending...', 'পাঠানো হচ্ছে...');

  try {
    const res = await csrfFetch('/auth/resend-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail }),
    });
    const payload = await res.json();

    if (payload.status !== 'success') {
      showAuthError(payload.message || rfT('Could not resend the code. Please try again.', 'কোড আবার পাঠানো যায়নি। আবার চেষ্টা করুন।'));
      resendCodeBtn.disabled = false;
      resendCodeBtn.textContent = rfT('Resend code', 'আবার কোড পাঠান');
      return;
    }
    startResendCooldown(RESEND_COOLDOWN_SECONDS);
  } catch (err) {
    console.error('Resend failed:', err);
    showAuthError(rfT('Connection error. Please check your internet and try again.', 'কানেকশন সমস্যা। ইন্টারনেট চেক করে আবার চেষ্টা করুন।'));
    resendCodeBtn.disabled = false;
    resendCodeBtn.textContent = rfT('Resend code', 'আবার কোড পাঠান');
  }
});

setStep(1);
// Re-render the step label (JS-owned text) when the language flips.
document.addEventListener('rf:langchange', () => setStep(currentStep));

/* ---------------- Arriving from the login page ----------------
   login.js sends unverified users here as /signup?verify=1 after the
   server has already emailed them a fresh code, stashing the address in
   sessionStorage. Jump straight to the code-entry step. If the stash is
   missing (e.g. page refreshed) the normal signup form simply shows. */
(function resumeVerificationFromLogin() {
  const params = new URLSearchParams(window.location.search);
  if (!params.get('verify')) return;

  let email = null;
  try {
    email = sessionStorage.getItem('pendingVerifyEmail');
    sessionStorage.removeItem('pendingVerifyEmail');
  } catch (err) {
    console.error('sessionStorage unavailable:', err);
  }
  if (email) showVerifyStep(email);
})();

