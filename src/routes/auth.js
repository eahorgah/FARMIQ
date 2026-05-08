// routes/auth.js — Authentication endpoints

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

const SALT_ROUNDS = 12;
const ACCESS_TTL  = '15m';
const REFRESH_TTL = '7d';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// In-memory failed-login tracker: email -> { count, lockedUntil }
const loginAttempts = new Map();
const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 15 * 60 * 1000; // 15 minutes

function checkLockout(email) {
  const entry = loginAttempts.get(email);
  if (!entry) return null;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    const remaining = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    return `Account locked. Try again in ${remaining} minute(s).`;
  }
  return null;
}

function recordFailure(email) {
  const entry = loginAttempts.get(email) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) entry.lockedUntil = Date.now() + LOCKOUT_MS;
  loginAttempts.set(email, entry);
}

function clearFailures(email) {
  loginAttempts.delete(email);
}

function issueTokens(userId, orgId, role) {
  const payload = { userId, orgId, role };
  const accessToken  = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_TTL });
  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: REFRESH_TTL });
  return { accessToken, refreshToken };
}

// POST /api/auth/register  — create org + first farm_owner user
router.post('/register', [
  body('org_name').notEmpty().trim(),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('full_name').notEmpty().trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { org_name, email, password, full_name, phone } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create organization
    const slug = org_name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
    const { rows: [org] } = await client.query(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [org_name, slug]
    );

    // Create first user as farm_owner
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows: [user] } = await client.query(
      `INSERT INTO users (org_id, email, password_hash, full_name, phone, role)
       VALUES ($1, $2, $3, $4, $5, 'farm_owner') RETURNING id, org_id, role`,
      [org.id, email, hash, full_name, phone || null]
    );

    // Seed default permissions for farm_owner from template
    await client.query(
      `INSERT INTO user_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve)
       SELECT $1, module, can_view, can_create, can_edit, can_delete, can_approve
       FROM role_permission_templates WHERE role = 'farm_owner'`,
      [user.id]
    );

    // Seed finance settings
    await client.query(
      `INSERT INTO finance_settings (org_id) VALUES ($1)`,
      [org.id]
    );

    const { accessToken, refreshToken } = issueTokens(user.id, user.org_id, user.role);
    await client.query(
      `INSERT INTO user_sessions (user_id, refresh_token, expires_at) VALUES ($1, $2, $3)`,
      [user.id, refreshToken, new Date(Date.now() + REFRESH_TTL_MS)]
    );

    await client.query('COMMIT');
    res.status(201).json({ accessToken, refreshToken, user: { id: user.id, email, full_name, role: 'farm_owner', org_id: org.id } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.constraint === 'users_email_key')
      return res.status(409).json({ error: 'Email already registered' });
    throw err;
  } finally { client.release(); }
});

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { email, password } = req.body;

  const lockoutMsg = checkLockout(email);
  if (lockoutMsg) return res.status(429).json({ error: lockoutMsg });

  const { rows } = await pool.query(
    `SELECT id, org_id, email, password_hash, full_name, role, is_active FROM users WHERE email = $1`,
    [email]
  );
  const user = rows[0];
  const passwordOk = user && await bcrypt.compare(password, user.password_hash);

  if (!user || !passwordOk) {
    recordFailure(email);
    await pool.query(
      `INSERT INTO audit_logs (org_id, user_id, action, resource_type, ip_address, user_agent, new_value)
       VALUES ($1, $2, 'login_failed', 'auth', $3, $4, $5)`,
      [user?.org_id || null, user?.id || null, req.ip, req.headers['user-agent'], JSON.stringify({ email })]
    ).catch(() => {});
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (!user.is_active)
    return res.status(403).json({ error: 'Account is deactivated. Contact your administrator.' });

  clearFailures(email);

  const { accessToken, refreshToken } = issueTokens(user.id, user.org_id, user.role);
  await pool.query(
    `INSERT INTO user_sessions (user_id, refresh_token, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, refreshToken, req.ip, req.headers['user-agent'], new Date(Date.now() + REFRESH_TTL_MS)]
  );
  await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
  await pool.query(
    `INSERT INTO audit_logs (org_id, user_id, action, resource_type, ip_address, user_agent)
     VALUES ($1, $2, 'login_success', 'auth', $3, $4)`,
    [user.org_id, user.id, req.ip, req.headers['user-agent']]
  ).catch(() => {});

  res.json({
    accessToken, refreshToken,
    user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, org_id: user.org_id }
  });
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const { rows } = await pool.query(
      `SELECT id FROM user_sessions WHERE refresh_token = $1 AND revoked = false AND expires_at > NOW()`,
      [refreshToken]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const tokens = issueTokens(decoded.userId, decoded.orgId, decoded.role);
    // Rotate refresh token
    await pool.query(`UPDATE user_sessions SET revoked = true WHERE refresh_token = $1`, [refreshToken]);
    await pool.query(
      `INSERT INTO user_sessions (user_id, refresh_token, expires_at) VALUES ($1, $2, $3)`,
      [decoded.userId, tokens.refreshToken, new Date(Date.now() + REFRESH_TTL_MS)]
    );
    res.json(tokens);
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken)
    await pool.query(`UPDATE user_sessions SET revoked = true WHERE refresh_token = $1`, [refreshToken]);
  res.json({ message: 'Logged out successfully' });
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, org_id, email, full_name, role, phone, avatar_url, last_login_at FROM users WHERE id = $1`,
    [req.user.id]
  );
  res.json({ user: rows[0], permissions: req.user.permissions });
});

module.exports = router;
