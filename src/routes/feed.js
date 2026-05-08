// routes/feed.js
const router = require('express').Router();
const { pool } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
router.use(authenticate);

router.get('/inventory', requirePermission('feed', 'view'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT *, CASE WHEN current_stock_kg <= minimum_stock_kg THEN true ELSE false END AS low_stock_alert
     FROM feed_inventory WHERE org_id = $1 ORDER BY feed_type`,
    [req.user.org_id]
  );
  res.json({ inventory: rows });
});

router.post('/transactions', requirePermission('feed', 'create'), async (req, res) => {
  const { transaction_type, feed_type, batch_id, pen_id, quantity_kg, bags_count, kg_per_bag,
    unit_cost, supplier, invoice_ref, transaction_date, notes } = req.body;
  if (!transaction_type || !feed_type || !quantity_kg || !transaction_date)
    return res.status(422).json({ error: 'transaction_type, feed_type, quantity_kg, transaction_date required' });
  const total = unit_cost ? unit_cost * quantity_kg : null;
  const { rows: [tx] } = await pool.query(
    `INSERT INTO feed_transactions (org_id, transaction_type, feed_type, batch_id, pen_id, quantity_kg,
       bags_count, kg_per_bag, unit_cost, total_cost, supplier, invoice_ref, transaction_date, notes, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [req.user.org_id, transaction_type, feed_type, batch_id||null, pen_id||null, quantity_kg,
     bags_count||null, kg_per_bag||null, unit_cost||null, total, supplier||null,
     invoice_ref||null, transaction_date, notes||null, req.user.id]
  );
  res.status(201).json({ feed_transaction: tx });
});

router.get('/transactions', requirePermission('feed', 'view'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ft.*, b.batch_code, u.full_name AS recorded_by_name
     FROM feed_transactions ft
     LEFT JOIN batches b ON b.id = ft.batch_id
     LEFT JOIN users u ON u.id = ft.recorded_by
     WHERE ft.org_id = $1 ORDER BY ft.transaction_date DESC LIMIT 100`,
    [req.user.org_id]
  );
  res.json({ transactions: rows });
});

module.exports = router;
