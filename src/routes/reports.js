// routes/reports.js — Reporting & Analytics
const router = require('express').Router();
const { pool } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

// GET /api/reports/profit-loss
router.get('/profit-loss', requirePermission('reports', 'view'), async (req, res) => {
  const { year = new Date().getFullYear(), month } = req.query;
  const conds = [`org_id = $1`, `EXTRACT(YEAR FROM transaction_date) = $2`, `approval_status = 'approved'`];
  const vals = [req.user.org_id, year];
  if (month) { conds.push(`EXTRACT(MONTH FROM transaction_date) = $3`); vals.push(month); }

  const { rows } = await pool.query(
    `SELECT category, type, SUM(amount) AS total, COUNT(*) AS count
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
    totals: {
      income: totalIncome,
      expenses: totalExpenses,
      net_profit: totalIncome - totalExpenses,
      margin: totalIncome ? ((totalIncome - totalExpenses) / totalIncome * 100).toFixed(2) : 0
    }
  });
});

// GET /api/reports/production-summary
router.get('/production-summary', requirePermission('reports', 'view'), async (req, res) => {
  const { year = new Date().getFullYear(), month } = req.query;
  const conds = [`org_id = $1`, `EXTRACT(YEAR FROM record_date) = $2`];
  const vals = [req.user.org_id, year];
  if (month) { conds.push(`EXTRACT(MONTH FROM record_date) = $3`); vals.push(month); }

  const { rows } = await pool.query(
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

// GET /api/reports/dashboard
router.get('/dashboard', requirePermission('dashboard', 'view'), async (req, res) => {
  const orgId = req.user.org_id;
  const [birds, eggs, finance, alerts] = await Promise.all([
    pool.query(
      `SELECT SUM(current_count) AS total, COUNT(*) AS batches
       FROM batches WHERE org_id = $1 AND status NOT IN ('sold','culled')`,
      [orgId]
    ),
    pool.query(
      `SELECT
         SUM(CASE WHEN record_date = CURRENT_DATE THEN eggs_collected ELSE 0 END) AS today,
         SUM(eggs_collected) AS week_total
       FROM egg_production_records
       WHERE org_id = $1 AND record_date >= CURRENT_DATE - INTERVAL '6 days'`,
      [orgId]
    ),
    pool.query(
      `SELECT
         SUM(CASE WHEN type='income' THEN amount ELSE 0 END) AS income,
         SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expenses
       FROM transactions
       WHERE org_id = $1 AND approval_status = 'approved'
         AND DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', NOW())`,
      [orgId]
    ),
    pool.query(
      `SELECT COUNT(*) AS pending_approvals
       FROM transactions WHERE org_id = $1 AND approval_status = 'pending'`,
      [orgId]
    ),
  ]);

  res.json({
    total_birds: birds.rows[0].total || 0,
    active_batches: birds.rows[0].batches || 0,
    eggs_today: eggs.rows[0].today || 0,
    eggs_week:  eggs.rows[0].week_total || 0,
    monthly_income: finance.rows[0].income || 0,
    monthly_expenses: finance.rows[0].expenses || 0,
    monthly_profit: (+finance.rows[0].income || 0) - (+finance.rows[0].expenses || 0),
    pending_approvals: alerts.rows[0].pending_approvals || 0,
  });
});

module.exports = router;
