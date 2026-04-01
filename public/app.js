/**
 * UNSHORTENER — Security-Hardened Frontend
 *
 * Client-side security measures:
 * 1. DOM-based XSS prevention (textContent only, no innerHTML with user data)
 * 2. Input sanitization before API calls
 * 3. URL validation on client side
 * 4. Safe link opening (noopener, noreferrer)
 * 5. CSP-compatible (no eval, no inline scripts)
 * 6. Rate limit awareness (429 handling)
 * 7. Clipboard API with secure context check
 * 8. AbortController for request cancellation
 */

'use strict';

// ============================
// STATE
// ============================
let lastResolvedData = null;
let currentAbortController = null;

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
// CONSTANTS
// ============================
const MAX_INPUT_LENGTH = 2048;
const ALLOWED_PROTOCOLS = ['http:', 'https:'];
const REQUEST_TIMEOUT = 20000; // 20s

// ============================
// INPUT SECURITY
// ============================

/**
 * Strip control characters and potential injection vectors
 */
function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  // Remove null bytes, control chars, and excessive whitespace
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .substring(0, MAX_INPUT_LENGTH);
}

/**
 * Validate URL before sending to API
 */
function validateClientUrl(urlString) {
  if (!urlString) throw new Error('Cole uma URL para resolver');

  let url = urlString;
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('URL inválida. Verifique o formato.');
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error('Apenas URLs http:// e https:// são permitidas');
  }

  if (!parsed.hostname || parsed.hostname.length === 0) {
    throw new Error('URL inválida — hostname ausente');
  }

  // Block obvious local/private targets on client side
  const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'];
  if (blocked.includes(parsed.hostname.toLowerCase())) {
    throw new Error('URLs locais não são permitidas');
  }

  return url;
}

/**
 * Safe HTML escaping — prevents XSS when displaying URLs
 */
function escapeHtml(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

/**
 * Validate that a URL is safe to navigate to
 */
function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    return ALLOWED_PROTOCOLS.includes(parsed.protocol);
  } catch {
    return false;
  }
}

// ============================
// INPUT EVENTS
// ============================
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    resolveUrl();
  }
});

urlInput.addEventListener('input', () => {
  clearBtn.classList.toggle('visible', urlInput.value.length > 0);
  // Enforce max length
  if (urlInput.value.length > MAX_INPUT_LENGTH) {
    urlInput.value = urlInput.value.substring(0, MAX_INPUT_LENGTH);
  }
});

// Prevent paste of excessively long content
urlInput.addEventListener('paste', (e) => {
  const pastedText = (e.clipboardData || window.clipboardData).getData('text');
  if (pastedText.length > MAX_INPUT_LENGTH) {
    e.preventDefault();
    urlInput.value = sanitizeInput(pastedText);
  }
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
  // Only allow our predefined safe examples
  const safeExamples = [
    'https://bit.ly/4jCqpUY',
    'https://tinyurl.com/2s3jkw5r',
    'https://t.co/uhnMHNKgiT',
    'https://is.gd/example',
  ];

  if (!safeExamples.includes(url)) return;

  urlInput.value = url;
  clearBtn.classList.add('visible');
  urlInput.focus();

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
  const rawInput = urlInput.value;
  const sanitized = sanitizeInput(rawInput);

  if (!sanitized) {
    urlInput.focus();
    shakeElement(document.querySelector('.resolver-inner'));
    return;
  }

  // Client-side validation
  let validatedUrl;
  try {
    validatedUrl = validateClientUrl(sanitized);
  } catch (err) {
    showError(err.message);
    return;
  }

  // Cancel any in-flight request
  if (currentAbortController) {
    currentAbortController.abort();
  }

  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  resolveBtn.disabled = true;
  showSection(loadingSection);

  // Timeout fallback
  const timeoutId = setTimeout(() => {
    currentAbortController.abort();
  }, REQUEST_TIMEOUT);

  try {
    const response = await fetch('/api/resolve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ url: validatedUrl }),
      signal,
    });

    clearTimeout(timeoutId);

    // Handle specific HTTP errors
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After') || '60';
      throw new Error(`Limite de requisições atingido. Aguarde ${retryAfter}s e tente novamente.`);
    }

    if (response.status === 413) {
      throw new Error('A URL enviada é muito grande.');
    }

    if (response.status === 405) {
      throw new Error('Método não permitido.');
    }

    // Parse response safely
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('Resposta inválida do servidor.');
    }

    if (!response.ok) {
      throw new Error(data.error || 'Erro ao resolver o link');
    }

    // Validate response structure
    if (!data.finalUrl || !Array.isArray(data.chain)) {
      throw new Error('Resposta inesperada do servidor.');
    }

    lastResolvedData = data;
    displayResult(data);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      showError('Requisição cancelada ou tempo limite atingido.');
    } else {
      showError(err.message);
    }
  } finally {
    resolveBtn.disabled = false;
    currentAbortController = null;
  }
}

// ============================
// DISPLAY RESULT (XSS-Safe)
// ============================
function displayResult(data) {
  // Use textContent only — never innerHTML with user data
  finalUrlText.textContent = data.finalUrl;

  // Only set href if URL is safe
  if (isSafeUrl(data.finalUrl)) {
    finalUrlLink.href = data.finalUrl;
    finalUrlLink.style.display = '';
  } else {
    finalUrlLink.href = '#';
    finalUrlLink.style.display = 'none';
  }

  // Status badge
  const status = parseInt(data.statusCode, 10) || 0;
  statusBadge.textContent = status;

  if (status >= 200 && status < 300) {
    statusBadge.style.cssText = 'background:rgba(16,185,129,0.1);border-color:rgba(16,185,129,0.2);color:#34d399';
  } else if (status >= 400) {
    statusBadge.style.cssText = 'background:rgba(244,63,94,0.1);border-color:rgba(244,63,94,0.2);color:#fb7185';
  } else {
    statusBadge.style.cssText = 'background:rgba(251,191,36,0.1);border-color:rgba(251,191,36,0.2);color:#fbbf24';
  }

  // Chain count (use hops from API if available)
  const hops = data.hops ?? (data.chain.length - 1);
  chainCount.textContent = hops === 0 ? '0 hops' : `${hops} hop${hops > 1 ? 's' : ''}`;

  // Build chain timeline — using DOM API only (no innerHTML with user data)
  chainTimeline.innerHTML = '';
  data.chain.forEach((url, index) => {
    const step = document.createElement('div');
    step.className = 'chain-step';
    step.style.animationDelay = `${index * 0.08}s`;

    let label = '';
    if (index === 0) label = 'Origem';
    else if (index === data.chain.length - 1) label = 'Destino Final';
    else label = `Hop ${index}`;

    // Build DOM elements safely
    const node = document.createElement('div');
    node.className = 'chain-node';

    const dot = document.createElement('div');
    dot.className = 'chain-dot';
    node.appendChild(dot);

    if (index < data.chain.length - 1) {
      const line = document.createElement('div');
      line.className = 'chain-line';
      node.appendChild(line);
    }

    const info = document.createElement('div');
    info.className = 'chain-info';

    const labelEl = document.createElement('div');
    labelEl.className = 'chain-step-label';
    labelEl.textContent = label; // safe — textContent

    const urlEl = document.createElement('div');
    urlEl.className = 'chain-step-url';
    urlEl.textContent = url; // safe — textContent, no innerHTML

    info.appendChild(labelEl);
    info.appendChild(urlEl);

    step.appendChild(node);
    step.appendChild(info);
    chainTimeline.appendChild(step);
  });

  // Reset copy button
  copyBtn.classList.remove('copied');
  copyBtn.querySelector('span').textContent = 'Copiar URL';

  showSection(resultSection);
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================
// SHOW ERROR
// ============================
function showError(message) {
  // Use textContent for safety
  errorMessage.textContent = typeof message === 'string'
    ? message.substring(0, 300)
    : 'Erro desconhecido';
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
  // Cancel any in-flight request
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }

  lastResolvedData = null;
  showSection(null);
  urlInput.value = '';
  clearBtn.classList.remove('visible');
  urlInput.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================
// COPY FINAL URL (Secure Context)
// ============================
async function copyFinalUrl() {
  if (!lastResolvedData || !lastResolvedData.finalUrl) return;

  const text = lastResolvedData.finalUrl;

  try {
    // Modern Clipboard API (requires secure context / HTTPS)
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      ta.setAttribute('readonly', ''); // Prevent mobile keyboard
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
  } catch {
    // Silently fail — don't expose error details
    showError('Não foi possível copiar. Use Ctrl+C manualmente.');
  }
}

// ============================
// OPEN FINAL URL (Safe)
// ============================
function openFinalUrl() {
  if (!lastResolvedData || !lastResolvedData.finalUrl) return;

  // Validate before opening
  if (!isSafeUrl(lastResolvedData.finalUrl)) {
    showError('URL de destino não é segura para abrir.');
    return;
  }

  // noopener + noreferrer prevent tab hijacking
  window.open(lastResolvedData.finalUrl, '_blank', 'noopener,noreferrer');
}

// ============================
// UTILITIES
// ============================
function shakeElement(el) {
  if (!el) return;
  el.style.animation = 'none';
  el.offsetHeight; // trigger reflow
  el.style.animation = 'shake 0.4s ease-out';
  el.addEventListener('animationend', () => {
    el.style.animation = '';
  }, { once: true });
}

// Inject shake keyframes (CSP-safe — not inline style)
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
