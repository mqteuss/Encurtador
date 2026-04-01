// ============================
// STATE
// ============================
let lastResolvedData = null;

// ============================
// DOM REFERENCES
// ============================
const urlInput = document.getElementById('url-input');
const resolveBtn = document.getElementById('resolve-btn');
const clearBtn = document.getElementById('clear-btn');
const loadingSection = document.getElementById('loading-section');
const errorSection = document.getElementById('error-section');
const errorMessage = document.getElementById('error-message');
const resultSection = document.getElementById('result-section');
const finalUrlText = document.getElementById('final-url-text');
const finalUrlLink = document.getElementById('final-url-link');
const statusBadge = document.getElementById('status-badge');
const chainTimeline = document.getElementById('chain-timeline');
const chainCount = document.getElementById('chain-count');
const copyBtn = document.getElementById('copy-btn');

// ============================
// INPUT EVENTS
// ============================
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') resolveUrl();
});

urlInput.addEventListener('input', () => {
  clearBtn.classList.toggle('visible', urlInput.value.length > 0);
});

function clearInput() {
  urlInput.value = '';
  clearBtn.classList.remove('visible');
  urlInput.focus();
}

// ============================
// FILL EXAMPLE
// ============================
function fillExample(url) {
  urlInput.value = url;
  clearBtn.classList.add('visible');
  urlInput.focus();

  // Quick highlight
  const field = document.getElementById('input-field');
  field.style.borderColor = 'rgba(99, 102, 241, 0.4)';
  setTimeout(() => { field.style.borderColor = ''; }, 800);
}

// ============================
// SHOW/HIDE SECTIONS
// ============================
function showSection(section) {
  loadingSection.classList.remove('visible');
  errorSection.classList.remove('visible');
  resultSection.classList.remove('visible');
  if (section) section.classList.add('visible');
}

// ============================
// RESOLVE URL
// ============================
async function resolveUrl() {
  const url = urlInput.value.trim();

  if (!url) {
    urlInput.focus();
    shakeElement(document.querySelector('.resolver-inner'));
    return;
  }

  resolveBtn.disabled = true;
  showSection(loadingSection);

  try {
    const response = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Erro ao resolver o link');
    }

    lastResolvedData = data;
    displayResult(data);
  } catch (err) {
    showError(err.message);
  } finally {
    resolveBtn.disabled = false;
  }
}

// ============================
// DISPLAY RESULT
// ============================
function displayResult(data) {
  // Final URL
  finalUrlText.textContent = data.finalUrl;
  finalUrlLink.href = data.finalUrl;

  // Status badge
  statusBadge.textContent = data.statusCode;
  if (data.statusCode >= 200 && data.statusCode < 300) {
    statusBadge.style.cssText = 'background:rgba(16,185,129,0.1);border-color:rgba(16,185,129,0.2);color:#34d399';
  } else if (data.statusCode >= 400) {
    statusBadge.style.cssText = 'background:rgba(244,63,94,0.1);border-color:rgba(244,63,94,0.2);color:#fb7185';
  } else {
    statusBadge.style.cssText = 'background:rgba(251,191,36,0.1);border-color:rgba(251,191,36,0.2);color:#fbbf24';
  }

  // Chain count
  const redirects = data.chain.length - 1;
  chainCount.textContent = redirects === 0
    ? '0 hops'
    : `${redirects} hop${redirects > 1 ? 's' : ''}`;

  // Build chain timeline
  chainTimeline.innerHTML = '';
  data.chain.forEach((url, index) => {
    const step = document.createElement('div');
    step.classList.add('chain-step');
    step.style.animationDelay = `${index * 0.08}s`;

    let label = '';
    if (index === 0) label = 'Origem';
    else if (index === data.chain.length - 1) label = 'Destino Final';
    else label = `Hop ${index}`;

    step.innerHTML = `
      <div class="chain-node">
        <div class="chain-dot"></div>
        ${index < data.chain.length - 1 ? '<div class="chain-line"></div>' : ''}
      </div>
      <div class="chain-info">
        <div class="chain-step-label">${label}</div>
        <div class="chain-step-url">${escapeHtml(url)}</div>
      </div>
    `;

    chainTimeline.appendChild(step);
  });

  // Reset copy button
  copyBtn.classList.remove('copied');
  copyBtn.querySelector('span').textContent = 'Copiar URL';

  showSection(resultSection);

  // Scroll into view
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================
// SHOW ERROR
// ============================
function showError(message) {
  errorMessage.textContent = message;
  showSection(errorSection);
}

// ============================
// RETRY / NEW
// ============================
function retryResolve() {
  showSection(null);
  resolveUrl();
}

function resolveAnother() {
  showSection(null);
  urlInput.value = '';
  clearBtn.classList.remove('visible');
  urlInput.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================
// COPY FINAL URL
// ============================
async function copyFinalUrl() {
  if (!lastResolvedData) return;
  const text = lastResolvedData.finalUrl;

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }

  copyBtn.classList.add('copied');
  copyBtn.querySelector('span').textContent = 'Copiado!';
  setTimeout(() => {
    copyBtn.classList.remove('copied');
    copyBtn.querySelector('span').textContent = 'Copiar URL';
  }, 2000);
}

// ============================
// OPEN FINAL URL
// ============================
function openFinalUrl() {
  if (!lastResolvedData) return;
  window.open(lastResolvedData.finalUrl, '_blank', 'noopener,noreferrer');
}

// ============================
// UTILITIES
// ============================
function escapeHtml(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

function shakeElement(el) {
  el.style.animation = 'none';
  el.offsetHeight;
  el.style.animation = 'shake 0.4s ease-out';
  el.addEventListener('animationend', () => {
    el.style.animation = '';
  }, { once: true });
}

// Inject shake keyframes
const shakeCSS = document.createElement('style');
shakeCSS.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-6px); }
    40% { transform: translateX(6px); }
    60% { transform: translateX(-3px); }
    80% { transform: translateX(3px); }
  }
`;
document.head.appendChild(shakeCSS);

// ============================
// AUTO-FOCUS
// ============================
urlInput.focus();
