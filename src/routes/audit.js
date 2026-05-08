// routes/audit.js — Audit trail viewer
const router = require('express').Router();
const { pool } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);

// GET /api/audit/logs — paginated audit log with filters
router.get('/logs', requireRole('super_admin', 'farm_owner', 'farm_manager'), async (req, res) => {
  const { page = 1, limit = 50, user_id, action, resource_type, date_from, date_to } = req.query;
  const offset = (page - 1) * limit;

  const conditions = ['al.org_id = $1'];
  const values = [req.user.org_id];
  let i = 2;

  if (user_id)       { conditions.push(`al.user_id = $${i++}`);        values.push(user_id); }
  if (action)        { conditions.push(`al.action ILIKE $${i++}`);      values.push(`%${action}%`); }
  if (resource_type) { conditions.push(`al.resource_type = $${i++}`);   values.push(resource_type); }
  if (date_from)     { conditions.push(`al.created_at >= $${i++}`);     values.push(date_from); }
  if (date_to)       { conditions.push(`al.created_at <  $${i++}`);     values.push(date_to + 'T23:59:59'); }

  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query(
      `SELECT al.id, al.action, al.resource_type, al.resource_id, al.ip_address,
              al.created_at, u.full_name, u.email, u.role
       FROM audit_logs al
       JOIN users u ON u.id = al.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY al.created_at DESC
       LIMIT $${i++} OFFSET $${i}`,
      [...values, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) FROM audit_logs al WHERE ${conditions.join(' AND ')}`,
      values
    ),
  ]);

  res.json({ logs: rows, pagination: { page: +page, limit: +limit, total: +countRows[0].count } });
});

// GET /api/audit/users — distinct users who have audit entries (for filter dropdown)
router.get('/users', requireRole('super_admin', 'farm_owner', 'farm_manager'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.full_name, u.email
     FROM audit_logs al JOIN users u ON u.id = al.user_id
     WHERE al.org_id = $1 ORDER BY u.full_name`,
    [req.user.org_id]
  );
  res.json({ users: rows });
});

// GET /api/audit/actions — distinct action types for filter dropdown
router.get('/actions', requireRole('super_admin', 'farm_owner', 'farm_manager'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT action FROM audit_logs WHERE org_id = $1 ORDER BY action`,
    [req.user.org_id]
  );
  res.json({ actions: rows.map(r => r.action) });
});

module.exports = router;
