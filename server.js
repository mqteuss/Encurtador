/**
 * UNSHORTENER — Security-Hardened Local Development Server
 * Mirrors the same security as the Vercel serverless function
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

// Import the serverless handler
const resolveHandler = require('./api/resolve');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security Middleware ──

// Body size limit
app.use(express.json({ limit: '1kb' }));

// CORS — restrict origins
app.use(cors({
  origin: [`http://localhost:${PORT}`, 'http://localhost:5173'],
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 86400,
}));

// Security headers for all responses
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API route — delegates to the serverless handler
app.post('/api/resolve', (req, res) => {
  resolveHandler(req, res);
});

app.options('/api/resolve', (req, res) => {
  res.status(204).end();
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🔗 Unshortener running at http://localhost:${PORT}`);
  console.log(`🛡️  Security hardening: ACTIVE\n`);
});
