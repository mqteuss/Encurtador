// ============================
// BACKGROUND PARTICLES
// ============================
function createParticles() {
  const container = document.getElementById('bg-particles');
  const colors = [
    'rgba(99, 102, 241, 0.08)',
    'rgba(168, 85, 247, 0.06)',
    'rgba(236, 72, 153, 0.05)',
    'rgba(34, 211, 238, 0.04)',
  ];

  for (let i = 0; i < 20; i++) {
    const particle = document.createElement('div');
    particle.classList.add('particle');
    const size = Math.random() * 200 + 50;
    particle.style.width = `${size}px`;
    particle.style.height = `${size}px`;
    particle.style.left = `${Math.random() * 100}%`;
    particle.style.background = colors[Math.floor(Math.random() * colors.length)];
    particle.style.animationDuration = `${Math.random() * 15 + 10}s`;
    particle.style.animationDelay = `${Math.random() * 10}s`;
    container.appendChild(particle);
  }
}

createParticles();

// ============================
// STATE
// ============================
let lastResolvedData = null;

// ============================
// DOM REFERENCES
// ============================
const urlInput = document.getElementById('url-input');
const resolveBtn = document.getElementById('resolve-btn');
const loadingSection = document.getElementById('loading-section');
const errorSection = document.getElementById('error-section');
const errorMessage = document.getElementById('error-message');
const resultSection = document.getElementById('result-section');
const finalUrlLink = document.getElementById('final-url-link');
const statusBadge = document.getElementById('status-badge');
const chainTimeline = document.getElementById('chain-timeline');
const chainCount = document.getElementById('chain-count');
const copyBtn = document.getElementById('copy-btn');

// ============================
// ENTER KEY SUPPORT
// ============================
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    resolveUrl();
  }
});

// ============================
// FILL EXAMPLE
// ============================
function fillExample(url) {
  urlInput.value = url;
  urlInput.focus();

  // Subtle flash animation
  const wrapper = document.getElementById('input-wrapper');
  wrapper.style.background = 'var(--gradient-border)';
  setTimeout(() => {
    wrapper.style.background = '';
  }, 600);
}

// ============================
// SHOW/HIDE SECTIONS
// ============================
function showSection(section) {
  loadingSection.classList.remove('visible');
  errorSection.classList.remove('visible');
  resultSection.classList.remove('visible');

  if (section) {
    section.classList.add('visible');
  }
}

// ============================
// RESOLVE URL
// ============================
async function resolveUrl() {
  const url = urlInput.value.trim();

  if (!url) {
    urlInput.focus();
    shakeElement(document.getElementById('input-wrapper'));
    return;
  }

  // Disable button and show loading
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
  finalUrlLink.textContent = data.finalUrl;
  finalUrlLink.href = data.finalUrl;

  // Status badge
  statusBadge.textContent = data.statusCode;
  if (data.statusCode >= 200 && data.statusCode < 300) {
    statusBadge.style.background = 'rgba(52, 211, 153, 0.1)';
    statusBadge.style.borderColor = 'rgba(52, 211, 153, 0.2)';
    statusBadge.style.color = '#34d399';
  } else if (data.statusCode >= 400) {
    statusBadge.style.background = 'rgba(239, 68, 68, 0.1)';
    statusBadge.style.borderColor = 'rgba(239, 68, 68, 0.2)';
    statusBadge.style.color = '#ef4444';
  }

  // Chain count
  const redirects = data.chain.length - 1;
  chainCount.textContent = redirects === 0
    ? 'Sem redirecionamentos'
    : `${redirects} redirecionamento${redirects > 1 ? 's' : ''}`;

  // Build chain timeline
  chainTimeline.innerHTML = '';
  data.chain.forEach((url, index) => {
    const step = document.createElement('div');
    step.classList.add('chain-step');
    step.style.animationDelay = `${index * 0.1}s`;

    let label = '';
    if (index === 0) label = 'Origem';
    else if (index === data.chain.length - 1) label = 'Destino Final';
    else label = `Redirecionamento ${index}`;

    step.innerHTML = `
      <div class="chain-node">
        <div class="chain-dot"></div>
        ${index < data.chain.length - 1 ? '<div class="chain-line"></div>' : ''}
      </div>
      <div class="chain-info">
        <div class="chain-label">${label}</div>
        <div class="chain-url">${url}</div>
      </div>
    `;

    chainTimeline.appendChild(step);
  });

  // Reset copy button
  copyBtn.classList.remove('copied');
  copyBtn.querySelector('span').textContent = 'Copiar';

  showSection(resultSection);
}

// ============================
// SHOW ERROR
// ============================
function showError(message) {
  errorMessage.textContent = message;
  showSection(errorSection);
}

// ============================
// RETRY
// ============================
function retryResolve() {
  showSection(null);
  resolveUrl();
}

// ============================
// COPY FINAL URL
// ============================
async function copyFinalUrl() {
  if (!lastResolvedData) return;

  try {
    await navigator.clipboard.writeText(lastResolvedData.finalUrl);
    copyBtn.classList.add('copied');
    copyBtn.querySelector('span').textContent = 'Copiado!';

    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.querySelector('span').textContent = 'Copiar';
    }, 2000);
  } catch {
    // Fallback
    const textarea = document.createElement('textarea');
    textarea.value = lastResolvedData.finalUrl;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);

    copyBtn.classList.add('copied');
    copyBtn.querySelector('span').textContent = 'Copiado!';
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.querySelector('span').textContent = 'Copiar';
    }, 2000);
  }
}

// ============================
// OPEN FINAL URL
// ============================
function openFinalUrl() {
  if (!lastResolvedData) return;
  window.open(lastResolvedData.finalUrl, '_blank', 'noopener,noreferrer');
}

// ============================
// SHAKE ANIMATION
// ============================
function shakeElement(el) {
  el.style.animation = 'none';
  el.offsetHeight; // trigger reflow
  el.style.animation = 'shake 0.4s ease-out';
  el.addEventListener('animationend', () => {
    el.style.animation = '';
  }, { once: true });
}

// Add shake keyframes dynamically
const shakeStyle = document.createElement('style');
shakeStyle.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-8px); }
    40% { transform: translateX(8px); }
    60% { transform: translateX(-4px); }
    80% { transform: translateX(4px); }
  }
`;
document.head.appendChild(shakeStyle);

// ============================
// AUTO-FOCUS
// ============================
urlInput.focus();
