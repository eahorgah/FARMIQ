// routes/eggs.js
const router = require('express').Router();
const { pool } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
router.use(authenticate);

// POST daily egg record
router.post('/', requirePermission('flock', 'create'), async (req, res) => {
  const { batch_id, pen_id, record_date, eggs_collected, broken_eggs = 0, notes } = req.body;
  if (!batch_id || !record_date || eggs_collected == null)
    return res.status(422).json({ error: 'batch_id, record_date, eggs_collected required' });

  // Calculate lay rate
  const { rows: [batch] } = await pool.query(`SELECT current_count FROM batches WHERE id = $1 AND org_id = $2`, [batch_id, req.user.org_id]);
  const layingRate = batch ? ((eggs_collected / batch.current_count) * 100).toFixed(2) : null;

  const { rows: [record] } = await pool.query(
    `INSERT INTO egg_production_records (org_id, batch_id, pen_id, record_date, eggs_collected, broken_eggs, laying_rate, notes, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (batch_id, record_date) DO UPDATE
     SET eggs_collected=$5, broken_eggs=$6, laying_rate=$7, notes=$8
     RETURNING *`,
    [req.user.org_id, batch_id, pen_id||null, record_date, eggs_collected, broken_eggs, layingRate, notes||null, req.user.id]
  );
  res.status(201).json({ record });
});

// GET egg records
router.get('/', requirePermission('flock', 'view'), async (req, res) => {
  const { batch_id, date_from, date_to } = req.query;
  const conds = ['e.org_id = $1']; const vals = [req.user.org_id]; let i = 2;
  if (batch_id) { conds.push(`e.batch_id = $${i++}`); vals.push(batch_id); }
  if (date_from) { conds.push(`e.record_date >= $${i++}`); vals.push(date_from); }
  if (date_to)   { conds.push(`e.record_date <= $${i++}`); vals.push(date_to); }
  const { rows } = await pool.query(
    `SELECT e.*, b.batch_code FROM egg_production_records e
     LEFT JOIN batches b ON b.id = e.batch_id
     WHERE ${conds.join(' AND ')} ORDER BY e.record_date DESC LIMIT 500`,
    vals
  );
  res.json({ records: rows });
});

module.exports = router;


// ──────────────────────────────────────────────────────────────
// routes/reports.js
// ──────────────────────────────────────────────────────────────
const reportsRouter = require('express').Router();
const { authenticate: auth2, requirePermission: reqPerm } = require('../middleware/auth');
reportsRouter.use(auth2);

// GET /api/reports/profit-loss
reportsRouter.get('/profit-loss', reqPerm('reports', 'view'), async (req, res) => {
  const { year = new Date().getFullYear(), month } = req.query;
  const { pool: db } = require('../config/db');
  const conds = [`org_id = $1`, `EXTRACT(YEAR FROM transaction_date) = $2`, `approval_status = 'approved'`];
  const vals = [req.user.org_id, year];
  if (month) { conds.push(`EXTRACT(MONTH FROM transaction_date) = $3`); vals.push(month); }

  const { rows } = await db.query(
    `SELECT
       category,
       type,
       SUM(amount) AS total,
       COUNT(*) AS count
     FROM transactions
     WHERE ${conds.join(' AND ')}
     GROUP BY category, type
     ORDER BY type, total DESC`,
    vals
  );

  const income = rows.filter(r => r.type === 'income');
  const expenses = rows.filter(r => r.type === 'expense');
  const totalIncome = income.reduce((s, r) => s + +r.total, 0);
  const totalExpenses = expenses.reduce((s, r) => s + +r.total, 0);

  res.json({
    year, month: month || 'all',
    income, expenses,
    totals: { income: totalIncome, expenses: totalExpenses, net_profit: totalIncome - totalExpenses, margin: totalIncome ? ((totalIncome - totalExpenses) / totalIncome * 100).toFixed(2) : 0 }
  });
});

// GET /api/reports/production-summary
reportsRouter.get('/production-summary', reqPerm('reports', 'view'), async (req, res) => {
  const { year = new Date().getFullYear(), month } = req.query;
  const { pool: db } = require('../config/db');
  const conds = [`org_id = $1`, `EXTRACT(YEAR FROM record_date) = $2`];
  const vals = [req.user.org_id, year];
  if (month) { conds.push(`EXTRACT(MONTH FROM record_date) = $3`); vals.push(month); }

  const { rows } = await db.query(
    `SELECT
       DATE_TRUNC('week', record_date) AS week,
       SUM(eggs_collected) AS total_eggs,
       SUM(saleable_eggs) AS saleable_eggs,
       AVG(laying_rate) AS avg_laying_rate
     FROM egg_production_records
     WHERE ${conds.join(' AND ')}
     GROUP BY week ORDER BY week`,
    vals
  );
  res.json({ production: rows });
});

// GET /api/reports/dashboard — single call for dashboard metrics
reportsRouter.get('/dashboard', reqPerm('reports', 'view'), async (req, res) => {
  const { pool: db } = require('../config/db');
  const orgId = req.user.org_id;
  const [birds, eggs, finance, alerts] = await Promise.all([
    db.query(`SELECT SUM(current_count) AS total, COUNT(*) AS batches FROM batches WHERE org_id = $1 AND status NOT IN ('sold','culled')`, [orgId]),
    db.query(`SELECT SUM(eggs_collected) AS today FROM egg_production_records WHERE org_id = $1 AND record_date = CURRENT_DATE`, [orgId]),
    db.query(`SELECT SUM(CASE WHEN type='income' THEN amount ELSE 0 END) AS income, SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expenses FROM transactions WHERE org_id = $1 AND approval_status = 'approved' AND DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', NOW())`, [orgId]),
    db.query(`SELECT COUNT(*) AS pending_approvals FROM transactions WHERE org_id = $1 AND approval_status = 'pending'`, [orgId]),
  ]);
  res.json({
    total_birds: birds.rows[0].total || 0,
    active_batches: birds.rows[0].batches || 0,
    eggs_today: eggs.rows[0].today || 0,
    monthly_income: finance.rows[0].income || 0,
    monthly_expenses: finance.rows[0].expenses || 0,
    monthly_profit: (+finance.rows[0].income || 0) - (+finance.rows[0].expenses || 0),
    pending_approvals: alerts.rows[0].pending_approvals || 0,
  });
});

module.exports = { eggsRouter: module.exports, reportsRouter };
