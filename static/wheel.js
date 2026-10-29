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
let wheelSegments = []; // last drawn segments, needed to land on the server-picked slice

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

/* Rotation (degrees, clockwise) that parks the pointer inside the slice the
   SERVER picked. Slices are equal-sized (odds live in the weights, not the
   artwork), slice 0 starts at 12 o'clock, so slice i is centred at
   -(i + 0.5) * slice degrees. A little jitter keeps it from always landing
   dead-centre, but never near a slice edge. */
function nextWheelRotation(current, segments, segmentId, label) {
  const n = segments.length;
  const slice = 360 / n;
  let idx = segments.findIndex(s => s.id === segmentId);
  if (idx < 0) idx = segments.findIndex(s => s.label === label);
  if (idx < 0) idx = Math.floor(Math.random() * n);
  const jitter = (Math.random() - 0.5) * slice * 0.6;
  const targetMod = (((360 - (idx + 0.5) * slice + jitter) % 360) + 360) % 360;
  const currentMod = ((current % 360) + 360) % 360;
  const delta = (targetMod - currentMod + 360) % 360;
  return current + (5 + Math.floor(Math.random() * 3)) * 360 + delta;
}

function drawWheelSegments(container, segments) {
  container.innerHTML = '';
  wheelSegments = segments;
  const size = 320;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.id = 'wheelSvg';
  svg.style.transformOrigin = '50% 50%';
  svg.style.transition = 'none';
  svg.style.transform = `rotate(${currentRotation}deg)`;

  const cx = size / 2, cy = size / 2, r = size / 2 - 8;
  const n = segments.length;
  // Equal slices: a 5%-chance prize drawn 5% wide is unreadable and looks
  // like a trap. The real odds are decided server-side by weight.
  const sliceAngle = 360 / n;
  const fontSize = n <= 6 ? 15 : n <= 10 ? 12 : 10;
  let angleStart = -90; // 12 o'clock, under the pointer

  segments.forEach((seg, i) => {
    const angleEnd = angleStart + sliceAngle;
    const large = sliceAngle > 180 ? 1 : 0;
    const colors = WHEEL_PALETTE[i % WHEEL_PALETTE.length];

    const x1 = cx + r * Math.cos((Math.PI * angleStart) / 180);
    const y1 = cy + r * Math.sin((Math.PI * angleStart) / 180);
    const x2 = cx + r * Math.cos((Math.PI * angleEnd) / 180);
    const y2 = cy + r * Math.sin((Math.PI * angleEnd) / 180);

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', n === 1
      ? `M${cx},${cy - r} A${r},${r} 0 1 1 ${cx - 0.01},${cy - r} Z`
      : `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`);
    path.setAttribute('fill', colors.fill);
    path.setAttribute('stroke', '#f7f3ec');
    path.setAttribute('stroke-width', '2');
    svg.appendChild(path);

    // Radial label: reads from the hub out to the rim, so long prize
    // names fit instead of being squeezed across a narrow slice.
    const midAngle = angleStart + sliceAngle / 2;
    const label = seg.label.length > 14 ? seg.label.slice(0, 13) + '…' : seg.label;
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', cx + r * 0.92);
    text.setAttribute('y', cy);
    text.setAttribute('font-size', fontSize);
    text.setAttribute('font-weight', '800');
    text.setAttribute('fill', colors.text);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('transform', `rotate(${midAngle}, ${cx}, ${cy})`);
    text.textContent = label;
    svg.appendChild(text);

    angleStart = angleEnd;
  });

  // Rim + studs so it reads as a wheel, not a pie chart.
  const rim = document.createElementNS(svgNS, 'circle');
  rim.setAttribute('cx', cx); rim.setAttribute('cy', cy); rim.setAttribute('r', r);
  rim.setAttribute('fill', 'none'); rim.setAttribute('stroke', '#33302b'); rim.setAttribute('stroke-width', '5');
  svg.appendChild(rim);
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const stud = document.createElementNS(svgNS, 'circle');
    stud.setAttribute('cx', cx + r * Math.cos(a)); stud.setAttribute('cy', cy + r * Math.sin(a));
    stud.setAttribute('r', 2.2); stud.setAttribute('fill', '#f7f3ec');
    svg.appendChild(stud);
  }

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

    const { label, prize_code, segment_id } = result.data;

    // The server already picked the winner; the animation's only job is
    // to land the pointer on THAT slice, so what the customer sees is
    // what they actually won.
    const svg = document.getElementById('wheelSvg');
    currentRotation = nextWheelRotation(currentRotation, wheelSegments, segment_id, label);

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
        wheelResultSub.innerHTML = `Code <strong class="text-slate-800">${escapeHtml(prize_code)}</strong> — valid 24 hours, use it at checkout. <button type="button" id="copyPrizeBtn" class="underline font-bold text-slate-800">Copy</button>`;
        const copyBtn = document.getElementById('copyPrizeBtn');
        if (copyBtn) {
          copyBtn.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(prize_code);
              copyBtn.textContent = 'Copied';
            } catch (e) {
              copyBtn.textContent = prize_code;
            }
          });
        }
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


