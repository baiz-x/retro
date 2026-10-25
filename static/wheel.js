const API_BASE = '/api';

function csrfFetch(url, options = {}) {
  const token = document.querySelector('meta[name="csrf-token"]').content;
  options.headers = { ...(options.headers || {}), 'X-CSRFToken': token };
  return fetch(url, options);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const wheelCodeInput = document.getElementById('wheelCodeInput');
const wheelLoadBtn = document.getElementById('wheelLoadBtn');
const wheelEntryMessage = document.getElementById('wheelEntryMessage');
const wheelEntryCard = document.getElementById('wheelEntryCard');
const wheelCard = document.getElementById('wheelCard');
const wheelCanvas = document.getElementById('wheelCanvas');
const wheelResultCard = document.getElementById('wheelResultCard');
const wheelResultHeadline = document.getElementById('wheelResultHeadline');
const wheelResultSub = document.getElementById('wheelResultSub');
const wheelSpinBtn = document.getElementById('wheelSpinBtn');
const wheelLoginNotice = document.getElementById('wheelLoginNotice');

let activeWheelCode = null;
let currentRotation = 0; // tracked across spins so a rotate() always adds forward, never snaps back

const urlParams = new URLSearchParams(window.location.search);
const prefillCode = urlParams.get('code');
if (prefillCode) {
  wheelCodeInput.value = prefillCode;
  loadWheel(prefillCode);
}

function showEntryMessage(text, isError) {
  wheelEntryMessage.textContent = text;
  wheelEntryMessage.className = `text-xs mt-2 ${isError ? 'text-red-600' : 'text-sage-600'} font-semibold`;
  wheelEntryMessage.classList.remove('hidden');
}

/* A tasteful, high-contrast palette — alternating a warm and a cool
   tone so adjacent slices always read as distinct, with text color
   picked per-slice for contrast rather than one flat dark color that
   can wash out on the darker slices. */
const WHEEL_PALETTE = [
  { fill: '#8fae8b', text: '#f7f3ec' },
  { fill: '#f4e7c9', text: '#33302b' },
  { fill: '#6b8a86', text: '#f7f3ec' },
  { fill: '#e3b98f', text: '#33302b' },
  { fill: '#4f6b5c', text: '#f7f3ec' },
  { fill: '#d9c2a8', text: '#33302b' },
];

function drawWheelSegments(container, segments) {
  container.innerHTML = '';
  const size = 320;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.id = 'wheelSvg';
  svg.style.transformOrigin = '50% 50%';
  svg.style.transition = 'none';
  svg.style.transform = `rotate(${currentRotation}deg)`;

  const cx = size / 2, cy = size / 2, r = size / 2 - 6;
  const totalWeight = segments.reduce((s, seg) => s + Math.max(seg.weight, 0), 0) || 1;
  let angleStart = -90; // start at 12 o'clock so the first slice sits under the pointer

  segments.forEach((seg, i) => {
    const sliceAngle = (Math.max(seg.weight, 0) / totalWeight) * 360;
    const angleEnd = angleStart + sliceAngle;
    const large = sliceAngle > 180 ? 1 : 0;
    const colors = WHEEL_PALETTE[i % WHEEL_PALETTE.length];

    const x1 = cx + r * Math.cos((Math.PI * angleStart) / 180);
    const y1 = cy + r * Math.sin((Math.PI * angleStart) / 180);
    const x2 = cx + r * Math.cos((Math.PI * angleEnd) / 180);
    const y2 = cy + r * Math.sin((Math.PI * angleEnd) / 180);

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`);
    path.setAttribute('fill', colors.fill);
    path.setAttribute('stroke', '#f7f3ec');
    path.setAttribute('stroke-width', '3');
    svg.appendChild(path);

    const midAngle = (angleStart + angleEnd) / 2;
    const labelR = r * 0.62;
    const lx = cx + labelR * Math.cos((Math.PI * midAngle) / 180);
    const ly = cy + labelR * Math.sin((Math.PI * midAngle) / 180);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', lx);
    text.setAttribute('y', ly);
    text.setAttribute('font-size', sliceAngle < 35 ? '11' : '14');
    text.setAttribute('font-weight', '800');
    text.setAttribute('fill', colors.text);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('transform', `rotate(${midAngle + 90}, ${lx}, ${ly})`);
    text.textContent = seg.label;
    svg.appendChild(text);

    angleStart = angleEnd;
  });

  container.appendChild(svg);
}

async function loadWheel(rawCode) {
  activeWheelCode = rawCode;
  wheelEntryMessage.classList.add('hidden');
  wheelCard.classList.add('hidden');
  wheelResultCard.classList.add('hidden');
  wheelLoginNotice.classList.add('hidden');

  try {
    const res = await fetch(`${API_BASE}/wheel/info?code=${encodeURIComponent(rawCode)}`);
    if (res.status === 401) {
      wheelLoginNotice.classList.remove('hidden');
      return;
    }
    const result = await res.json();
    if (result.status !== 'success') {
      showEntryMessage(result.message || 'Invalid wheel code.', true);
      return;
    }

    const { segments, is_live, error, already_spun } = result.data;
    if (!is_live) {
      showEntryMessage(error || 'This wheel is not available.', true);
      return;
    }
    if (!segments || segments.length === 0) {
      showEntryMessage('This wheel has no prizes set up yet.', true);
      return;
    }

    currentRotation = 0;
    drawWheelSegments(wheelCanvas, segments);
    wheelCard.classList.remove('hidden');
    wheelEntryCard.classList.add('opacity-60');

    if (already_spun) {
      wheelSpinBtn.disabled = true;
      wheelSpinBtn.textContent = 'Already Spun';
      wheelResultHeadline.textContent = "You've Already Spun";
      wheelResultSub.textContent = 'This code only gets one spin per account.';
      wheelResultCard.classList.remove('hidden');
    } else {
      wheelSpinBtn.disabled = false;
      wheelSpinBtn.textContent = 'Spin The Wheel';
    }
  } catch (err) {
    console.error('Wheel info failed:', err);
    showEntryMessage('Connection error. Please try again.', true);
  }
}

wheelLoadBtn.addEventListener('click', () => {
  const code = wheelCodeInput.value.trim();
  if (!code) return;
  loadWheel(code);
});
wheelCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') wheelLoadBtn.click();
});

wheelSpinBtn.addEventListener('click', async () => {
  if (!activeWheelCode) return;
  wheelSpinBtn.disabled = true;
  wheelSpinBtn.textContent = 'Spinning...';
  wheelResultCard.classList.add('hidden');

  try {
    const res = await csrfFetch(`${API_BASE}/wheel/spin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: activeWheelCode }),
    });
    const result = await res.json();

    if (result.status !== 'success') {
      wheelResultHeadline.textContent = 'Something Went Wrong';
      wheelResultSub.textContent = result.message || 'Please try again.';
      wheelResultCard.classList.remove('hidden');
      wheelResultCard.classList.add('result-pop');
      wheelSpinBtn.textContent = 'Spin The Wheel';
      wheelSpinBtn.disabled = false;
      return;
    }

    const { label, prize_code } = result.data;

    // Real spin physics: several full rotations plus a fine-tuned
    // final angle, eased with a curve that front-loads speed and
    // decelerates hard at the end — closer to how a physical wheel
    // actually slows down than a flat ease-out.
    const svg = document.getElementById('wheelSvg');
    const spins = 5 + Math.random() * 2; // 5–7 full rotations
    const finalOffset = Math.random() * 360;
    currentRotation += spins * 360 + finalOffset;

    if (svg) {
      svg.style.transition = 'transform 4.2s cubic-bezier(0.11, 0.79, 0.12, 1)';
      // Force reflow so the transition applies even though we just set
      // transform:none-equivalent a moment ago in drawWheelSegments.
      void svg.getBoundingClientRect();
      svg.style.transform = `rotate(${currentRotation}deg)`;
    }

    setTimeout(() => {
      wheelSpinBtn.textContent = 'Already Spun';
      if (prize_code) {
        wheelResultHeadline.textContent = `You Won ${label}!`;
        wheelResultSub.innerHTML = `Code <strong class="text-slate-800">${escapeHtml(prize_code)}</strong> — valid 24 hours, use it at checkout.`;
      } else {
        wheelResultHeadline.textContent = label || 'No Prize This Time';
        wheelResultSub.textContent = 'Follow our page for the next drop.';
      }
      wheelResultCard.classList.remove('hidden');
      wheelResultCard.classList.add('result-pop');
    }, 4300);
  } catch (err) {
    wheelResultHeadline.textContent = 'Connection Error';
    wheelResultSub.textContent = 'Please try again.';
    wheelResultCard.classList.remove('hidden');
    wheelSpinBtn.disabled = false;
    wheelSpinBtn.textContent = 'Spin The Wheel';
  }
});

