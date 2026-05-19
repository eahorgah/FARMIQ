// routes/settings.js — Finance & Org Settings
const router = require('express').Router();
const { pool } = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);

const VALID_ROLES = ['super_admin','farm_owner','farm_manager','finance_officer','veterinarian','data_entry','viewer'];

// GET /api/settings/finance
router.get('/finance', requireRole('super_admin', 'farm_owner'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM finance_settings WHERE org_id = $1`,
    [req.user.org_id]
  );
  if (!rows[0]) {
    // Return defaults if no row exists yet
    return res.json({
      settings: {
        approval_threshold: 500,
        auto_approve_roles: ['farm_owner'],
        fiscal_year_start: 1,
        tax_rate: 0,
      }
    });
  }
  res.json({ settings: rows[0] });
});

// PUT /api/settings/finance
router.put('/finance', requireRole('super_admin', 'farm_owner'), async (req, res) => {
  const { approval_threshold, auto_approve_roles, fiscal_year_start, tax_rate } = req.body;

  if (approval_threshold !== undefined && +approval_threshold < 0)
    return res.status(422).json({ error: 'Approval threshold must be >= 0' });

  if (auto_approve_roles !== undefined) {
    if (!Array.isArray(auto_approve_roles))
      return res.status(422).json({ error: 'auto_approve_roles must be an array' });
    const invalid = auto_approve_roles.filter(r => !VALID_ROLES.includes(r));
    if (invalid.length)
      return res.status(422).json({ error: `Invalid roles: ${invalid.join(', ')}` });
  }

  const { rows: [setting] } = await pool.query(
    `INSERT INTO finance_settings (org_id, approval_threshold, auto_approve_roles, fiscal_year_start, tax_rate)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id) DO UPDATE SET
       approval_threshold  = COALESCE($2, finance_settings.approval_threshold),
       auto_approve_roles  = COALESCE($3, finance_settings.auto_approve_roles),
       fiscal_year_start   = COALESCE($4, finance_settings.fiscal_year_start),
       tax_rate            = COALESCE($5, finance_settings.tax_rate),
       updated_at          = NOW()
     RETURNING *`,
    [
      req.user.org_id,
      approval_threshold !== undefined ? +approval_threshold : null,
      auto_approve_roles !== undefined ? auto_approve_roles : null,
      fiscal_year_start  !== undefined ? +fiscal_year_start  : null,
      tax_rate           !== undefined ? +tax_rate           : null,
    ]
  );
  res.json({ settings: setting, message: 'Finance settings saved' });
});

module.exports = router;
