// routes/eggs.js — Egg Production Records
const router = require('express').Router();
const { pool } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

router.post('/', requirePermission('flock', 'create'), async (req, res) => {
  const { batch_id, pen_id, record_date, notes } = req.body;
  const eggs_collected = Number(req.body.eggs_collected);
  const broken_eggs    = Number(req.body.broken_eggs ?? 0);

  if (!batch_id || !record_date || isNaN(eggs_collected))
    return res.status(422).json({ error: 'batch_id, record_date, eggs_collected required' });

  const { rows: [batch] } = await pool.query(
    `SELECT current_count FROM batches WHERE id = $1 AND org_id = $2`,
    [batch_id, req.user.org_id]
  );
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  const layingRate = batch.current_count > 0
    ? ((eggs_collected / batch.current_count) * 100).toFixed(2)
    : null;

  const { rows: [record] } = await pool.query(
    `INSERT INTO egg_production_records
       (org_id, batch_id, pen_id, record_date, eggs_collected, broken_eggs, laying_rate, notes, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (batch_id, record_date) DO UPDATE
       SET eggs_collected = EXCLUDED.eggs_collected,
           broken_eggs    = EXCLUDED.broken_eggs,
           laying_rate    = EXCLUDED.laying_rate,
           notes          = EXCLUDED.notes
     RETURNING *`,
    [req.user.org_id, batch_id, pen_id || null, record_date,
     eggs_collected, broken_eggs, layingRate, notes || null, req.user.id]
  );
  res.status(201).json({ record });
});

router.get('/', requirePermission('flock', 'view'), async (req, res) => {
  const { batch_id, date_from, date_to } = req.query;
  const conds = ['e.org_id = $1'];
  const vals = [req.user.org_id];
  let i = 2;
  if (batch_id)  { conds.push(`e.batch_id = $${i++}`); vals.push(batch_id); }
  if (date_from) { conds.push(`e.record_date >= $${i++}`); vals.push(date_from); }
  if (date_to)   { conds.push(`e.record_date <= $${i++}`); vals.push(date_to); }

  const { rows } = await pool.query(
    `SELECT e.*, b.batch_code, b.breed, b.purpose, b.current_count AS bird_count
     FROM egg_production_records e
     LEFT JOIN batches b ON b.id = e.batch_id
     WHERE ${conds.join(' AND ')} ORDER BY e.record_date DESC LIMIT 500`,
    vals
  );
  res.json({ records: rows });
});

module.exports = router;
