// routes/alerts.js — Staff alert management
const router = require('express').Router();
const { pool } = require('../config/db');
const { authenticate, requireRole, auditLog } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

router.use(authenticate);

// GET /api/alerts — active alerts visible to current user
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT sa.*, u.full_name AS created_by_name,
            EXISTS(
              SELECT 1 FROM alert_reads ar
              WHERE ar.alert_id = sa.id AND ar.user_id = $2
            ) AS is_read
     FROM staff_alerts sa
     LEFT JOIN users u ON u.id = sa.created_by
     WHERE sa.org_id = $1
       AND sa.is_active = true
       AND (sa.expires_at IS NULL OR sa.expires_at > NOW())
       AND (sa.target_roles IS NULL OR $3 = ANY(sa.target_roles))
     ORDER BY sa.created_at DESC`,
    [req.user.org_id, req.user.id, req.user.role]
  );
  res.json({ alerts: rows });
});

// GET /api/alerts/unread-count — badge count
router.get('/unread-count', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS count FROM staff_alerts sa
     WHERE sa.org_id = $1
       AND sa.is_active = true
       AND (sa.expires_at IS NULL OR sa.expires_at > NOW())
       AND (sa.target_roles IS NULL OR $3 = ANY(sa.target_roles))
       AND NOT EXISTS (
         SELECT 1 FROM alert_reads ar
         WHERE ar.alert_id = sa.id AND ar.user_id = $2
       )`,
    [req.user.org_id, req.user.id, req.user.role]
  );
  res.json({ count: +rows[0].count });
});

// GET /api/alerts/all — all alerts including expired (managers only)
router.get('/all', requireRole('super_admin', 'farm_owner', 'farm_manager'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT sa.*, u.full_name AS created_by_name,
            (SELECT COUNT(*) FROM alert_reads ar WHERE ar.alert_id = sa.id) AS read_count
     FROM staff_alerts sa
     LEFT JOIN users u ON u.id = sa.created_by
     WHERE sa.org_id = $1
     ORDER BY sa.created_at DESC
     LIMIT 200`,
    [req.user.org_id]
  );
  res.json({ alerts: rows });
});

// POST /api/alerts — create a new staff alert
router.post('/',
  requireRole('super_admin', 'farm_owner', 'farm_manager'),
  auditLog('create_alert', 'alert'),
  [
    body('title').notEmpty().trim().isLength({ max: 200 }),
    body('message').notEmpty().trim(),
    body('severity').optional().isIn(['info', 'warning', 'critical']),
    body('category').optional().isIn(['health', 'feed', 'flock', 'finance', 'general']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { title, message, severity = 'info', category = 'general', target_roles, expires_at } = req.body;

    const { rows: [alert] } = await pool.query(
      `INSERT INTO staff_alerts (org_id, created_by, title, message, severity, category, target_roles, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.user.org_id, req.user.id, title, message, severity, category,
       target_roles?.length ? target_roles : null,
       expires_at || null]
    );
    res.status(201).json({ alert });
  }
);

// POST /api/alerts/:id/read — mark alert as read
router.post('/:id/read', async (req, res) => {
  await pool.query(
    `INSERT INTO alert_reads (alert_id, user_id) VALUES ($1, $2)
     ON CONFLICT (alert_id, user_id) DO NOTHING`,
    [req.params.id, req.user.id]
  );
  res.json({ message: 'Marked as read' });
});

// DELETE /api/alerts/:id — deactivate (soft delete)
router.delete('/:id',
  requireRole('super_admin', 'farm_owner', 'farm_manager'),
  auditLog('delete_alert', 'alert', (req) => req.params.id),
  async (req, res) => {
    const { rowCount } = await pool.query(
      `UPDATE staff_alerts SET is_active = false
       WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user.org_id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Alert not found' });
    res.json({ message: 'Alert deactivated' });
  }
);

module.exports = router;
