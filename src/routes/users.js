// routes/users.js — User & Permission Management

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { authenticate, requireRole, requirePermission, auditLog } = require('../middleware/auth');
const { body, param, validationResult } = require('express-validator');

// All routes require authentication
router.use(authenticate);

// GET /api/users — list all users in org
router.get('/', requirePermission('users', 'view'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.role, u.phone, u.is_active, u.last_login_at, u.created_at,
            json_object_agg(up.module, json_build_object(
              'view', up.can_view, 'create', up.can_create,
              'edit', up.can_edit, 'delete', up.can_delete, 'approve', up.can_approve
            )) FILTER (WHERE up.module IS NOT NULL) AS permissions
     FROM users u
     LEFT JOIN user_permissions up ON up.user_id = u.id
     WHERE u.org_id = $1
     GROUP BY u.id
     ORDER BY u.created_at DESC`,
    [req.user.org_id]
  );
  res.json({ users: rows });
});

// POST /api/users — invite/create a new user
router.post('/', requirePermission('users', 'create'),
  auditLog('create_user', 'user'),
  [
    body('email').isEmail().normalizeEmail(),
    body('full_name').notEmpty().trim(),
    body('role').isIn(['super_admin','farm_owner','farm_manager','finance_officer','veterinarian','data_entry','viewer']),
    body('password').isLength({ min: 8 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    // Only super_admin can create super_admin accounts
    if (req.body.role === 'super_admin' && req.user.role !== 'super_admin')
      return res.status(403).json({ error: 'Only super_admin can create super_admin accounts' });

    const { email, full_name, role, phone, password } = req.body;
    const hash = await bcrypt.hash(password, 12);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [user] } = await client.query(
        `INSERT INTO users (org_id, email, password_hash, full_name, phone, role, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [req.user.org_id, email, hash, full_name, phone || null, role, req.user.id]
      );
      // Seed from role template
      await client.query(
        `INSERT INTO user_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve)
         SELECT $1, module, can_view, can_create, can_edit, can_delete, can_approve
         FROM role_permission_templates WHERE role = $2`,
        [user.id, role]
      );
      await client.query('COMMIT');
      res.status(201).json({ message: 'User created', user_id: user.id });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.constraint === 'users_email_key')
        return res.status(409).json({ error: 'Email already in use' });
      throw err;
    } finally { client.release(); }
  }
);

// GET /api/users/:id
router.get('/:id', requirePermission('users', 'view'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.role, u.phone, u.is_active, u.last_login_at,
            json_object_agg(up.module, json_build_object(
              'view', up.can_view, 'create', up.can_create,
              'edit', up.can_edit, 'delete', up.can_delete, 'approve', up.can_approve
            )) FILTER (WHERE up.module IS NOT NULL) AS permissions
     FROM users u
     LEFT JOIN user_permissions up ON up.user_id = u.id
     WHERE u.id = $1 AND u.org_id = $2
     GROUP BY u.id`,
    [req.params.id, req.user.org_id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ user: rows[0] });
});

// PATCH /api/users/:id — update role or details
router.patch('/:id', requirePermission('users', 'edit'),
  auditLog('update_user', 'user', (req) => req.params.id),
  async (req, res) => {
    const { full_name, phone, role, is_active } = req.body;
    const updates = [];
    const values = [];
    let i = 1;

    if (full_name) { updates.push(`full_name = $${i++}`); values.push(full_name); }
    if (phone !== undefined) { updates.push(`phone = $${i++}`); values.push(phone); }
    if (is_active !== undefined) { updates.push(`is_active = $${i++}`); values.push(is_active); }
    if (role) {
      if (role === 'farm_owner' && req.user.role !== 'super_admin')
        return res.status(403).json({ error: 'Only super_admin can assign farm_owner role' });
      updates.push(`role = $${i++}`); values.push(role);
    }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id, req.user.org_id);
    const { rowCount } = await pool.query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${i++} AND org_id = $${i}`,
      values
    );
    if (!rowCount) return res.status(404).json({ error: 'User not found' });

    // If role changed, re-seed permissions from template
    if (role) {
      await pool.query(`DELETE FROM user_permissions WHERE user_id = $1`, [req.params.id]);
      await pool.query(
        `INSERT INTO user_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve)
         SELECT $1, module, can_view, can_create, can_edit, can_delete, can_approve
         FROM role_permission_templates WHERE role = $2`,
        [req.params.id, role]
      );
    }
    res.json({ message: 'User updated' });
  }
);

// PUT /api/users/:id/permissions — override specific module permissions
router.put('/:id/permissions', requireRole('super_admin', 'farm_owner'),
  auditLog('update_permissions', 'user', (req) => req.params.id),
  async (req, res) => {
    const { permissions } = req.body;  // { flock: { view: true, create: false, ... }, ... }
    if (!permissions) return res.status(400).json({ error: 'permissions object required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [module, perms] of Object.entries(permissions)) {
        await client.query(
          `INSERT INTO user_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, module) DO UPDATE
           SET can_view=$3, can_create=$4, can_edit=$5, can_delete=$6, can_approve=$7`,
          [req.params.id, module,
           perms.view ?? false, perms.create ?? false, perms.edit ?? false,
           perms.delete ?? false, perms.approve ?? false]
        );
      }
      await client.query('COMMIT');
      res.json({ message: 'Permissions updated' });
    } catch (err) {
      await client.query('ROLLBACK'); throw err;
    } finally { client.release(); }
  }
);

// GET /api/users/audit-logs — activity history
router.get('/audit/logs', requireRole('super_admin', 'farm_owner'), async (req, res) => {
  const { page = 1, limit = 50, user_id, action } = req.query;
  const offset = (page - 1) * limit;
  const conditions = ['al.org_id = $1'];
  const values = [req.user.org_id];
  let i = 2;
  if (user_id) { conditions.push(`al.user_id = $${i++}`); values.push(user_id); }
  if (action)  { conditions.push(`al.action = $${i++}`); values.push(action); }

  const { rows } = await pool.query(
    `SELECT al.*, u.full_name, u.email FROM audit_logs al
     JOIN users u ON u.id = al.user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY al.created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, limit, offset]
  );
  res.json({ logs: rows });
});

module.exports = router;
