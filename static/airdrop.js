const API_BASE = '/api';

function csrfFetch(url, options = {}) {
  const token = document.querySelector('meta[name="csrf-token"]').content;
  options.headers = { ...(options.headers || {}), 'X-CSRFToken': token };
  return fetch(url, options);
}

const airdropCodeInput = document.getElementById('airdropCodeInput');
const airdropCheckBtn = document.getElementById('airdropCheckBtn');
const airdropMessage = document.getElementById('airdropMessage');
const airdropShopLink = document.getElementById('airdropShopLink');

// Auto-fill from ?code=XXXX so a shared link goes straight to the check.
const urlParams = new URLSearchParams(window.location.search);
const prefillCode = urlParams.get('code');
if (prefillCode) {
  airdropCodeInput.value = prefillCode;
  checkCode(prefillCode);
}

function showMessage(text, isError) {
  airdropMessage.textContent = text;
  airdropMessage.className = `text-xs mt-3 ${isError ? 'text-red-600' : 'text-sage-600'} font-semibold`;
  airdropMessage.classList.remove('hidden');
}

async function checkCode(code) {
  airdropShopLink.classList.add('hidden');
  try {
    const res = await csrfFetch(`${API_BASE}/promo/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const result = await res.json();

    if (result.status !== 'success') {
      showMessage(result.message || 'Invalid code.', true);
      return;
    }

    showMessage(result.data.message, false);
    if (result.data.kind === 'discount') {
      airdropShopLink.classList.remove('hidden');
    } else if (result.data.kind === 'wheel') {
      airdropShopLink.href = `/wheel?code=${encodeURIComponent(code)}`;
      airdropShopLink.textContent = 'Go Spin The Wheel';
      airdropShopLink.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Promo check failed:', err);
    showMessage('Connection error. Please try again.', true);
  }
}

airdropCheckBtn.addEventListener('click', () => {
  const code = airdropCodeInput.value.trim();
  if (!code) return;
  checkCode(code);
});
