// middleware/auth.js — JWT verification + RBAC permission guards

const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

// ── Verify JWT access token ────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
      return res.status(401).json({ error: 'Missing or invalid authorization header' });

    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Load user + permissions from DB
    const { rows } = await pool.query(
      `SELECT u.id, u.org_id, u.email, u.full_name, u.role, u.is_active,
              json_object_agg(up.module, json_build_object(
                'view',    up.can_view,
                'create',  up.can_create,
                'edit',    up.can_edit,
                'delete',  up.can_delete,
                'approve', up.can_approve
              )) FILTER (WHERE up.module IS NOT NULL) AS permissions
       FROM users u
       LEFT JOIN user_permissions up ON up.user_id = u.id
       WHERE u.id = $1 AND u.is_active = true
       GROUP BY u.id`,
      [decoded.userId]
    );

    if (!rows[0]) return res.status(401).json({ error: 'User not found or inactive' });

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ── Role-based guard ───────────────────────────────────────
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role))
    return res.status(403).json({ error: `Access denied. Requires one of: ${roles.join(', ')}` });
  next();
};

// ── Module permission guard factory ───────────────────────
// Usage: requirePermission('transactions', 'approve')
const requirePermission = (module, action) => (req, res, next) => {
  const perms = req.user.permissions?.[module];

  // super_admin bypasses all module checks
  if (req.user.role === 'super_admin') return next();

  if (!perms || !perms[action]) {
    return res.status(403).json({
      error: `You do not have '${action}' permission on '${module}'`,
      module, action,
    });
  }
  next();
};

// ── Org isolation — ensure resource belongs to user's org ──
const requireSameOrg = (getOrgId) => async (req, res, next) => {
  try {
    const orgId = await getOrgId(req);
    if (orgId && orgId !== req.user.org_id)
      return res.status(403).json({ error: 'Access denied: resource belongs to another organization' });
    next();
  } catch {
    next();
  }
};

// ── Audit logger middleware ────────────────────────────────
const auditLog = (action, resourceType, getResourceId) => async (req, res, next) => {
  res.on('finish', async () => {
    if (res.statusCode < 400) {
      try {
        const resourceId = getResourceId?.(req, res);
        await pool.query(
          `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id, new_value, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            req.user?.org_id, req.user?.id, action, resourceType,
            resourceId || null,
            req.body ? JSON.stringify(req.body) : null,
            req.ip, req.headers['user-agent']
          ]
        );
      } catch { /* non-blocking */ }
    }
  });
  next();
};

module.exports = { authenticate, requireRole, requirePermission, requireSameOrg, auditLog };
