/**
 * UNSHORTENER API — Security-Hardened Serverless Function
 * 
 * Security layers implemented:
 * 1. Rate Limiting (sliding window, per-IP)
 * 2. SSRF Protection (private IP blocking, DNS rebinding guard)
 * 3. Protocol Whitelist (http/https only)
 * 4. Input Validation & Sanitization
 * 5. Request Size Limiting
 * 6. Timeout Enforcement (per-request + total)
 * 7. Security Headers (CSP, HSTS, X-Frame-Options, etc.)
 * 8. Error Sanitization (no stack traces leaked)
 * 9. CORS Restriction
 * 10. Hostname Blacklist (metadata endpoints, cloud internals)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const dns = require('dns');
const net = require('net');

// ═══════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════
const CONFIG = {
  MAX_REDIRECTS: 15,
  MAX_URL_LENGTH: 2048,
  PER_REQUEST_TIMEOUT: 6000,    // 6s per individual request
  TOTAL_TIMEOUT: 15000,         // 15s total for entire chain
  MAX_BODY_SIZE: 1024,          // 1KB max request body
  RATE_LIMIT_WINDOW: 60000,     // 1 minute window
  RATE_LIMIT_MAX: 30,           // 30 requests per window per IP
  ALLOWED_PROTOCOLS: ['http:', 'https:'],
  BLOCKED_PORTS: [21, 22, 23, 25, 53, 110, 143, 445, 587, 993, 995, 3306, 3389, 5432, 5900, 6379, 8080, 8443, 9200, 27017],
};

// ═══════════════════════════════════════════
// RATE LIMITER (in-memory, per serverless instance)
// ═══════════════════════════════════════════
const rateLimitStore = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - CONFIG.RATE_LIMIT_WINDOW;

  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, []);
  }

  const timestamps = rateLimitStore.get(ip).filter(t => t > windowStart);
  rateLimitStore.set(ip, timestamps);

  if (timestamps.length >= CONFIG.RATE_LIMIT_MAX) {
    return true;
  }

  timestamps.push(now);
  return false;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - CONFIG.RATE_LIMIT_WINDOW * 2;
  for (const [ip, timestamps] of rateLimitStore) {
    const filtered = timestamps.filter(t => t > cutoff);
    if (filtered.length === 0) {
      rateLimitStore.delete(ip);
    } else {
      rateLimitStore.set(ip, filtered);
    }
  }
}, 300000);

// ═══════════════════════════════════════════
// SSRF PROTECTION — Private IP Detection
// ═══════════════════════════════════════════
const PRIVATE_IP_RANGES = [
  // IPv4 private ranges
  /^127\./,                           // Loopback
  /^10\./,                            // Class A private
  /^172\.(1[6-9]|2\d|3[01])\./,      // Class B private
  /^192\.168\./,                      // Class C private
  /^169\.254\./,                      // Link-local
  /^0\./,                             // Current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // Shared address space (CGN)
  /^198\.1[89]\./,                    // Benchmark testing
  /^192\.0\.[02]\./,                  // IETF protocol assignments
  /^198\.51\.100\./,                  // Documentation (TEST-NET-2)
  /^203\.0\.113\./,                   // Documentation (TEST-NET-3)
  /^(22[4-9]|23\d|24\d|25[0-5])\./,  // Multicast + reserved
];

const BLOCKED_HOSTNAMES = [
  'localhost',
  'metadata.google.internal',        // GCP metadata
  'metadata.google',
  '169.254.169.254',                  // AWS/GCP/Azure metadata endpoint
  'metadata',
  'kubernetes.default',
  'kubernetes.default.svc',
  '[::1]',                            // IPv6 loopback
  'instance-data',                    // AWS instance data
  'metadata.internal',
];

function isPrivateIP(ip) {
  // Check IPv4 private ranges
  for (const range of PRIVATE_IP_RANGES) {
    if (range.test(ip)) return true;
  }

  // Check IPv6 loopback and private
  if (ip === '::1' || ip === '::' || ip === '0:0:0:0:0:0:0:1') return true;
  if (ip.startsWith('fe80:')) return true;   // Link-local IPv6
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // Unique local IPv6

  return false;
}

function isBlockedHostname(hostname) {
  const lower = hostname.toLowerCase().trim();

  // Direct match
  if (BLOCKED_HOSTNAMES.includes(lower)) return true;

  // Numeric IP check
  if (net.isIP(lower)) {
    return isPrivateIP(lower);
  }

  // Block hostnames that resolve to numeric IPs directly (bypass attempts)
  // e.g., 0x7f000001, 2130706433, 017700000001
  try {
    // Detect decimal IP encoding: e.g., http://2130706433/
    if (/^\d+$/.test(lower)) {
      const num = parseInt(lower, 10);
      if (num >= 0 && num <= 0xFFFFFFFF) {
        const ip = [
          (num >>> 24) & 0xFF,
          (num >>> 16) & 0xFF,
          (num >>> 8) & 0xFF,
          num & 0xFF
        ].join('.');
        if (isPrivateIP(ip)) return true;
      }
    }

    // Detect hex IP: 0x7f000001
    if (/^0x[0-9a-f]+$/i.test(lower)) {
      const num = parseInt(lower, 16);
      if (num >= 0 && num <= 0xFFFFFFFF) {
        const ip = [
          (num >>> 24) & 0xFF,
          (num >>> 16) & 0xFF,
          (num >>> 8) & 0xFF,
          num & 0xFF
        ].join('.');
        if (isPrivateIP(ip)) return true;
      }
    }
  } catch (e) {
    // Ignore parse errors
  }

  return false;
}

/**
 * DNS resolution check — resolve hostname and verify it doesn't point to private IPs
 * This prevents DNS rebinding attacks
 */
function dnsResolveCheck(hostname) {
  return new Promise((resolve, reject) => {
    // Skip check for direct IPs
    if (net.isIP(hostname)) {
      if (isPrivateIP(hostname)) {
        return reject(new Error('Acesso a endereços IP privados não é permitido'));
      }
      return resolve();
    }

    dns.resolve4(hostname, (err, addresses) => {
      if (err) {
        // If DNS fails, let the HTTP request handle the error naturally
        return resolve();
      }

      for (const addr of addresses) {
        if (isPrivateIP(addr)) {
          return reject(new Error('O hostname resolve para um endereço IP privado — acesso bloqueado'));
        }
      }

      resolve();
    });
  });
}

// ═══════════════════════════════════════════
// INPUT VALIDATION
// ═══════════════════════════════════════════
function validateUrl(urlString) {
  // Length check
  if (!urlString || typeof urlString !== 'string') {
    throw new Error('URL é obrigatória');
  }

  if (urlString.length > CONFIG.MAX_URL_LENGTH) {
    throw new Error(`URL muito longa (máximo ${CONFIG.MAX_URL_LENGTH} caracteres)`);
  }

  // Strip whitespace and control characters
  const cleaned = urlString.trim().replace(/[\x00-\x1F\x7F]/g, '');

  // Add protocol if missing
  let url = cleaned;
  if (!url.match(/^https?:\/\//i)) {
    url = 'https://' + url;
  }

  // Parse URL
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error('URL inválida');
  }

  // Protocol whitelist
  if (!CONFIG.ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error(`Protocolo "${parsed.protocol}" não é permitido. Use http:// ou https://`);
  }

  // Block dangerous hostnames
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error('Este hostname não é permitido por razões de segurança');
  }

  // Block empty hostname
  if (!parsed.hostname || parsed.hostname.length === 0) {
    throw new Error('Hostname inválido');
  }

  // Block blocked ports
  if (parsed.port && CONFIG.BLOCKED_PORTS.includes(parseInt(parsed.port, 10))) {
    throw new Error(`Porta ${parsed.port} não é permitida por razões de segurança`);
  }

  // Block credentials in URL (user:pass@host)
  if (parsed.username || parsed.password) {
    throw new Error('URLs com credenciais embutidas não são permitidas');
  }

  // Block javascript: / data: / file: schemes that may be injected via redirect
  if (/^(javascript|data|file|ftp|gopher|ldap|dict|telnet):/i.test(url)) {
    throw new Error('Esquema de URL não permitido');
  }

  return parsed.href;
}

// ═══════════════════════════════════════════
// SECURITY HEADERS
// ═══════════════════════════════════════════
function setSecurityHeaders(res) {
  // Strict Transport Security — force HTTPS
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');

  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // XSS Protection (legacy browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer Policy — don't leak origin info
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Content Security Policy for API JSON responses
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");

  // Permissions Policy — restrict browser features
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  // Prevent caching of API responses (contain potentially sensitive URLs)
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');

  // Content type
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

// ═══════════════════════════════════════════
// SAFE URL RESOLVER
// ═══════════════════════════════════════════
function resolveUrl(url, maxRedirects = CONFIG.MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const chain = [url];
    let redirectCount = 0;
    const totalStart = Date.now();
    let aborted = false;

    // Total timeout guard
    const totalTimer = setTimeout(() => {
      aborted = true;
      reject(new Error('Tempo limite total atingido (cadeia muito longa)'));
    }, CONFIG.TOTAL_TIMEOUT);

    async function follow(currentUrl) {
      if (aborted) return;

      // Check total timeout
      if (Date.now() - totalStart > CONFIG.TOTAL_TIMEOUT) {
        clearTimeout(totalTimer);
        return reject(new Error('Tempo limite total atingido'));
      }

      if (redirectCount >= maxRedirects) {
        clearTimeout(totalTimer);
        return resolve({
          finalUrl: currentUrl,
          chain,
          statusCode: 200,
          warning: `Limite de ${maxRedirects} redirecionamentos atingido`
        });
      }

      // Validate each URL in the chain (prevents redirect to internal IPs)
      let parsedUrl;
      try {
        const validated = validateUrl(currentUrl);
        parsedUrl = new URL(validated);
      } catch (e) {
        clearTimeout(totalTimer);
        return reject(e);
      }

      // DNS rebinding check — verify hostname doesn't resolve to private IP
      try {
        await dnsResolveCheck(parsedUrl.hostname);
      } catch (e) {
        clearTimeout(totalTimer);
        return reject(e);
      }

      if (aborted) return;

      const client = parsedUrl.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Unshortener/1.0; +https://encurtador-beryl.vercel.app)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        timeout: CONFIG.PER_REQUEST_TIMEOUT,
        // Prevent following redirects automatically
        maxRedirects: 0,
      };

      const req = client.request(options, (res) => {
        // Consume data to prevent memory leaks
        res.resume();

        if (aborted) return;

        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          let location = res.headers.location;
          if (!location) {
            clearTimeout(totalTimer);
            return resolve({
              finalUrl: currentUrl,
              chain,
              statusCode: res.statusCode,
              warning: 'Redirecionamento sem header Location'
            });
          }

          // Resolve relative URLs
          try {
            location = new URL(location, currentUrl).href;
          } catch (e) {
            clearTimeout(totalTimer);
            return reject(new Error('URL de redirecionamento inválida'));
          }

          // Validate the redirect target (SSRF check)
          try {
            validateUrl(location);
          } catch (e) {
            clearTimeout(totalTimer);
            return reject(new Error(`Redirecionamento bloqueado: ${e.message}`));
          }

          chain.push(location);
          redirectCount++;
          follow(location);
        } else {
          clearTimeout(totalTimer);
          resolve({
            finalUrl: currentUrl,
            chain,
            statusCode: res.statusCode,
          });
        }
      });

      req.on('error', (err) => {
        if (aborted) return;

        // If HEAD fails, try GET (some servers don't support HEAD)
        if (options.method === 'HEAD') {
          options.method = 'GET';
          const retryReq = client.request(options, (res) => {
            res.resume();
            if (aborted) return;

            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
              let location = res.headers.location;
              if (!location) {
                clearTimeout(totalTimer);
                return resolve({
                  finalUrl: currentUrl,
                  chain,
                  statusCode: res.statusCode,
                  warning: 'Redirecionamento sem header Location'
                });
              }

              try {
                location = new URL(location, currentUrl).href;
              } catch (e) {
                clearTimeout(totalTimer);
                return reject(new Error('URL de redirecionamento inválida'));
              }

              try {
                validateUrl(location);
              } catch (e) {
                clearTimeout(totalTimer);
                return reject(new Error(`Redirecionamento bloqueado: ${e.message}`));
              }

              chain.push(location);
              redirectCount++;
              follow(location);
            } else {
              clearTimeout(totalTimer);
              resolve({
                finalUrl: currentUrl,
                chain,
                statusCode: res.statusCode,
              });
            }
          });

          retryReq.on('error', (retryErr) => {
            if (aborted) return;
            clearTimeout(totalTimer);
            reject(new Error('Não foi possível conectar ao servidor de destino'));
          });

          retryReq.on('timeout', () => {
            retryReq.destroy();
            if (aborted) return;
            clearTimeout(totalTimer);
            reject(new Error('Tempo limite atingido'));
          });

          retryReq.end();
        } else {
          clearTimeout(totalTimer);
          reject(new Error('Não foi possível conectar ao servidor de destino'));
        }
      });

      req.on('timeout', () => {
        req.destroy();
        if (aborted) return;
        clearTimeout(totalTimer);
        reject(new Error('Tempo limite atingido'));
      });

      req.end();
    }

    follow(url);
  });
}

// ═══════════════════════════════════════════
// CLIENT IP EXTRACTION
// ═══════════════════════════════════════════
function getClientIP(req) {
  // Vercel sets x-forwarded-for
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // Take only the first IP (client IP), ignore proxies
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.connection?.remoteAddress || 'unknown';
}

// ═══════════════════════════════════════════
// SANITIZE ERROR MESSAGES
// ═══════════════════════════════════════════
function sanitizeError(message) {
  // Never expose internal paths, IPs, or stack traces
  if (!message || typeof message !== 'string') return 'Erro interno do servidor';

  // Remove any file paths
  let safe = message.replace(/[A-Z]:\\[^\s]+/gi, '[path]');
  safe = safe.replace(/\/[a-z_][^\s]*/gi, '[path]');

  // Remove IP addresses from error messages
  safe = safe.replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '[ip]');

  // Truncate long messages
  if (safe.length > 200) safe = safe.substring(0, 200) + '...';

  return safe;
}

// ═══════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════
module.exports = async (req, res) => {
  // ── Security Headers ──
  setSecurityHeaders(res);

  // ── CORS (restrict to same origin in production) ──
  const origin = req.headers.origin || '';
  const allowedOrigins = [
    'https://encurtador-beryl.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
  ];

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // Allow same-origin requests (no Origin header)
    res.setHeader('Access-Control-Allow-Origin', 'https://encurtador-beryl.vercel.app');
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  // ── Preflight ──
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // ── Method check ──
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  // ── Rate Limiting ──
  const clientIP = getClientIP(req);
  if (isRateLimited(clientIP)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: 'Limite de requisições atingido. Tente novamente em 1 minuto.',
    });
  }

  // ── Body size check ──
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > CONFIG.MAX_BODY_SIZE) {
    return res.status(413).json({ error: 'Payload muito grande' });
  }

  // ── Extract and validate URL ──
  let url;
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Body JSON inválido' });
    }

    url = validateUrl(body.url);
  } catch (err) {
    return res.status(400).json({ error: sanitizeError(err.message) });
  }

  // ── Resolve ──
  try {
    const result = await resolveUrl(url);

    // Sanitize result — ensure no internal info leaks
    const safeResult = {
      finalUrl: result.finalUrl,
      chain: result.chain.map(u => u.substring(0, CONFIG.MAX_URL_LENGTH)),
      statusCode: result.statusCode,
      hops: result.chain.length - 1,
    };

    if (result.warning) {
      safeResult.warning = result.warning;
    }

    return res.status(200).json(safeResult);
  } catch (err) {
    return res.status(502).json({ error: sanitizeError(err.message) });
  }
};
