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

// GET /api/settings/org
router.get('/org', async (req, res) => {
  const { rows: [org] } = await pool.query(
    `SELECT name, slug, address, region, country, phone, email, currency, logo_url
     FROM organizations WHERE id = $1`,
    [req.user.org_id]
  );
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  res.json({ org });
});

// PUT /api/settings/org
router.put('/org', requireRole('super_admin', 'farm_owner'), async (req, res) => {
  const { name, address, region, country, phone, email, currency, logo_url } = req.body;

  if (name !== undefined && !String(name).trim())
    return res.status(422).json({ error: 'Farm name cannot be empty' });

  const { rows: [org] } = await pool.query(
    `UPDATE organizations SET
       name       = COALESCE(NULLIF($2,''), name),
       address    = COALESCE($3, address),
       region     = COALESCE($4, region),
       country    = COALESCE(NULLIF($5,''), country),
       phone      = COALESCE($6, phone),
       email      = COALESCE($7, email),
       currency   = COALESCE(NULLIF($8,''), currency),
       logo_url   = $9,
       updated_at = NOW()
     WHERE id = $1
     RETURNING name, slug, address, region, country, phone, email, currency, logo_url`,
    [
      req.user.org_id,
      name    || '',
      address ?? null,
      region  ?? null,
      country || '',
      phone   ?? null,
      email   ?? null,
      currency || '',
      logo_url ?? null,
    ]
  );
  res.json({ org, message: 'Farm profile updated' });
});

module.exports = router;
