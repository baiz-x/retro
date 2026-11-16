/* reset_password.js — depends on auth.js (csrfFetch, showAuthError,
   hideAuthError, setSubmitBusy) being loaded first.

   The reset token arrives as ?token=... from the emailed link. It is
   read once and then stripped from the address bar so it doesn't linger
   in browser history, screenshots, or a copied URL. */

const resetForm = document.getElementById('resetForm');
const resetSuccess = document.getElementById('resetSuccess');
const backToLogin = document.getElementById('backToLogin');

const resetToken = new URLSearchParams(window.location.search).get('token');
if (resetToken) {
  window.history.replaceState({}, '', window.location.pathname);
} else {
  resetForm.classList.add('hidden');
  showAuthError('This reset link is invalid. Please request a new one from the log in page.');
}

resetForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();

  const newPassword = document.getElementById('password').value;
  if (newPassword.length < 8) {
    showAuthError('Password must be at least 8 characters.');
    return;
  }

  setSubmitBusy(true, 'Updating...', 'Update Password');

  try {
    const res = await csrfFetch('/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, new_password: newPassword }),
    });
    const payload = await res.json();

    if (payload.status !== 'success') {
      showAuthError(payload.message || 'Could not update your password. Please try again.');
      setSubmitBusy(false, '', 'Update Password');
      return;
    }

    resetForm.classList.add('hidden');
    backToLogin.classList.add('hidden');
    resetSuccess.classList.remove('hidden');
    setTimeout(() => { window.location.href = '/login'; }, 2500);
  } catch (err) {
    console.error('Password reset failed:', err);
    showAuthError('Connection error. Please check your internet and try again.');
    setSubmitBusy(false, '', 'Update Password');
  }
});

