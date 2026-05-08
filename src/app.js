// FarmIQ Backend — app.js
require('express-async-errors'); // auto-catches async route errors → passes to errorHandler
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const flockRoutes = require('./routes/flock');
const healthRoutes = require('./routes/health');
const feedRoutes = require('./routes/feed');
const transactionRoutes = require('./routes/transactions');
const reportRoutes = require('./routes/reports');
const eggRoutes = require('./routes/eggs');
const auditRoutes = require('./routes/audit');
const alertRoutes = require('./routes/alerts');

const path = require('path');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

// ── Static frontend ────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Security ──────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
}));

// ── Rate limiting ──────────────────────────────────────────
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many auth attempts' });
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);

// ── Body parsing ───────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Logging ────────────────────────────────────────────────
app.use(morgan('combined'));

// ── Routes ────────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/users',        userRoutes);
app.use('/api/flock',        flockRoutes);
app.use('/api/health',       healthRoutes);
app.use('/api/feed',         feedRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/reports',      reportRoutes);
app.use('/api/eggs',         eggRoutes);
app.use('/api/audit',        auditRoutes);
app.use('/api/alerts',       alertRoutes);

app.get('/api/health-check', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>FarmIQ API</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f4f8; color: #1a202c; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #fff; border-radius: 16px; padding: 40px 48px; max-width: 640px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .badge { display: inline-flex; align-items: center; gap: 6px; background: #dcfce7; color: #16a34a; font-size: 13px; font-weight: 600; padding: 4px 12px; border-radius: 99px; margin-bottom: 20px; }
    .dot { width: 8px; height: 8px; background: #16a34a; border-radius: 50%; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    h1 { font-size: 28px; font-weight: 700; color: #1a202c; margin-bottom: 6px; }
    .sub { color: #64748b; font-size: 15px; margin-bottom: 32px; }
    h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin-bottom: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 28px; }
    .endpoint { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 14px; text-decoration: none; color: #1a202c; display: flex; flex-direction: column; gap: 2px; transition: border-color .15s, background .15s; }
    .endpoint:hover { border-color: #22c55e; background: #f0fdf4; }
    .endpoint .method { font-size: 11px; font-weight: 700; color: #22c55e; }
    .endpoint .path { font-size: 13px; font-family: monospace; }
    .footer { font-size: 13px; color: #94a3b8; padding-top: 20px; border-top: 1px solid #f1f5f9; }
    .footer code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: #475569; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge"><span class="dot"></span> Running</div>
    <h1>FarmIQ API</h1>
    <p class="sub">Poultry Farm Management System &mdash; v1.0.0</p>

    <h2>Available Endpoints</h2>
    <div class="grid">
      <a class="endpoint" href="/api/health-check"><span class="method">GET</span><span class="path">/api/health-check</span></a>
      <a class="endpoint" href="/api/auth/me"><span class="method">POST</span><span class="path">/api/auth</span></a>
      <a class="endpoint" href="/api/flock/batches"><span class="method">GET</span><span class="path">/api/flock</span></a>
      <a class="endpoint" href="/api/health"><span class="method">GET</span><span class="path">/api/health</span></a>
      <a class="endpoint" href="/api/feed/inventory"><span class="method">GET</span><span class="path">/api/feed</span></a>
      <a class="endpoint" href="/api/eggs"><span class="method">GET</span><span class="path">/api/eggs</span></a>
      <a class="endpoint" href="/api/transactions"><span class="method">GET</span><span class="path">/api/transactions</span></a>
      <a class="endpoint" href="/api/reports/dashboard"><span class="method">GET</span><span class="path">/api/reports</span></a>
    </div>

    <div class="footer">
      Use a REST client (Postman / Bruno / Insomnia) to test authenticated routes.<br/>
      All protected routes require <code>Authorization: Bearer &lt;token&gt;</code>
    </div>
  </div>
</body>
</html>`);
});

// ── Error handler ──────────────────────────────────────────
app.use(errorHandler);

module.exports = app;
