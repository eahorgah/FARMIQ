// routes/health.js
const router = require('express').Router();
const { pool } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
router.use(authenticate);

router.get('/', requirePermission('health', 'view'), async (req, res) => {
  const { batch_id, event_type, status, severity } = req.query;
  const conds = ['h.org_id = $1']; const vals = [req.user.org_id]; let i = 2;
  if (batch_id)   { conds.push(`h.batch_id = $${i++}`); vals.push(batch_id); }
  if (event_type) { conds.push(`h.event_type = $${i++}`); vals.push(event_type); }
  if (status)     { conds.push(`h.status = $${i++}`); vals.push(status); }
  if (severity)   { conds.push(`h.severity = $${i++}`); vals.push(severity); }
  const { rows } = await pool.query(
    `SELECT h.*, b.batch_code, b.breed, p.name AS pen_name, u.full_name AS recorded_by_name
     FROM health_records h
     LEFT JOIN batches b ON b.id = h.batch_id
     LEFT JOIN pens p ON p.id = h.pen_id
     LEFT JOIN users u ON u.id = h.recorded_by
     WHERE ${conds.join(' AND ')} ORDER BY h.event_date DESC`,
    vals
  );
  res.json({ records: rows });
});

router.post('/', requirePermission('health', 'create'), async (req, res) => {
  const { batch_id, pen_id, event_type, event_date, severity = 'low', diagnosis, treatment,
    medication_used, dosage, birds_affected = 0, birds_treated = 0, birds_died = 0,
    vet_name, next_action, next_action_date, cost = 0, status = 'completed', notes } = req.body;
  if (!batch_id || !event_type || !event_date)
    return res.status(422).json({ error: 'batch_id, event_type, event_date required' });
  const { rows: [record] } = await pool.query(
    `INSERT INTO health_records (org_id, batch_id, pen_id, event_type, event_date, severity,
       diagnosis, treatment, medication_used, dosage, birds_affected, birds_treated, birds_died,
       vet_name, next_action, next_action_date, cost, status, notes, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [req.user.org_id, batch_id, pen_id||null, event_type, event_date, severity,
     diagnosis||null, treatment||null, medication_used||null, dosage||null,
     birds_affected, birds_treated, birds_died, vet_name||null,
     next_action||null, next_action_date||null, cost, status, notes||null, req.user.id]
  );
  res.status(201).json({ record });
});

router.patch('/:id', requirePermission('health', 'edit'), async (req, res) => {
  const allowed = ['status','treatment','notes','next_action','next_action_date','birds_died','cost'];
  const updates = []; const values = []; let i = 1;
  for (const f of allowed) {
    if (req.body[f] !== undefined) { updates.push(`${f} = $${i++}`); values.push(req.body[f]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields' });
  values.push(req.params.id, req.user.org_id);
  await pool.query(`UPDATE health_records SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${i++} AND org_id = $${i}`, values);
  res.json({ message: 'Updated' });
});

module.exports = router;
