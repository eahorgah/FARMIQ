// routes/flock.js — Flock / Batch Management

const router = require('express').Router();
const { pool } = require('../config/db');
const { authenticate, requirePermission, auditLog } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

router.use(authenticate);

// GET /api/flock/batches
router.get('/batches', requirePermission('flock', 'view'), async (req, res) => {
  try {
    const { status, purpose } = req.query;
    const conditions = ['b.org_id = $1'];
    const values = [req.user.org_id];
    let i = 2;
    if (status)  { conditions.push(`b.status = $${i++}`); values.push(status); }
    if (purpose) { conditions.push(`b.purpose = $${i++}`); values.push(purpose); }

    const { rows } = await pool.query(
      `SELECT b.*, p.name AS pen_name,
              FLOOR(EXTRACT(DAY FROM NOW() - b.doc_date::timestamptz) / 7) AS age_weeks,
              (SELECT SUM(eggs_collected) FROM egg_production_records WHERE batch_id = b.id AND record_date >= CURRENT_DATE - 7) AS eggs_last_7d,
              (SELECT COUNT(*) FROM health_records WHERE batch_id = b.id AND status = 'ongoing') AS open_health_events
       FROM batches b
       LEFT JOIN pens p ON p.id = b.pen_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY b.doc_date DESC`,
      values
    );
    res.json({ batches: rows });
  } catch (err) { throw err; }
});

// POST /api/flock/batches
router.post('/batches',
  requirePermission('flock', 'create'),
  auditLog('create_batch', 'batch'),
  [
    body('batch_code').notEmpty().trim(),
    body('breed').notEmpty().trim(),
    body('purpose').isIn(['layers','broilers','breeders','dual_purpose']),
    body('initial_count').isInt({ min: 1 }),
    body('doc_date').isDate(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { batch_code, breed, purpose, initial_count, doc_date, pen_id, supplier, purchase_cost, notes, expected_sale_date } = req.body;
    const { rows: [batch] } = await pool.query(
      `INSERT INTO batches (org_id, batch_code, breed, purpose, initial_count, current_count, doc_date,
         pen_id, supplier, purchase_cost, notes, expected_sale_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [req.user.org_id, batch_code, breed, purpose, initial_count, doc_date,
       pen_id||null, supplier||null, purchase_cost||null, notes||null, expected_sale_date||null, req.user.id]
    );
    res.status(201).json({ batch });
  }
);

// PATCH /api/flock/batches/:id
router.patch('/batches/:id',
  requirePermission('flock', 'edit'),
  auditLog('update_batch', 'batch', (req) => req.params.id),
  async (req, res) => {
    const allowed = ['status','pen_id','current_count','notes','expected_sale_date','doc_date','breed'];
    const updates = []; const values = []; let i = 1;
    for (const f of allowed) {
      if (req.body[f] !== undefined) { updates.push(`${f} = $${i++}`); values.push(req.body[f]); }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id, req.user.org_id);
    const { rowCount } = await pool.query(
      `UPDATE batches SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${i++} AND org_id = $${i}`,
      values
    );
    if (!rowCount) return res.status(404).json({ error: 'Batch not found' });
    res.json({ message: 'Batch updated' });
  }
);

// POST /api/flock/daily-records — daily mortality/count
router.post('/daily-records',
  requirePermission('flock', 'create'),
  [
    body('batch_id').isUUID(),
    body('record_date').isDate(),
    body('mortalities').isInt({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { batch_id, record_date, mortalities = 0, culled = 0, sold = 0, notes } = req.body;

    // Get opening count from batch
    const { rows: [batch] } = await pool.query(`SELECT current_count, culled_count FROM batches WHERE id = $1 AND org_id = $2`, [batch_id, req.user.org_id]);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });

    // Culled birds move to culled pen — NOT deducted from live count
    const closing = batch.current_count - mortalities - sold;

    const { rows: [record] } = await pool.query(
      `INSERT INTO daily_flock_records (org_id, batch_id, record_date, opening_count, mortalities, culled, sold, closing_count, notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (batch_id, record_date) DO UPDATE
       SET mortalities=$5, culled=$6, sold=$7, closing_count=$8, notes=$9
       RETURNING *`,
      [req.user.org_id, batch_id, record_date, batch.current_count, mortalities, culled, sold, closing, notes||null, req.user.id]
    );

    // Update live count (culled not deducted) and accumulate culled_count
    await pool.query(
      `UPDATE batches SET current_count = $1, culled_count = COALESCE(culled_count,0) + $2, updated_at = NOW() WHERE id = $3`,
      [closing, culled, batch_id]
    );

    res.status(201).json({ record });
  }
);

// GET /api/flock/daily-records
router.get('/daily-records', requirePermission('flock', 'view'), async (req, res) => {
  const { batch_id, date_from, date_to, limit = 100, page = 1 } = req.query;
  const conditions = ['dr.org_id = $1'];
  const values = [req.user.org_id];
  let i = 2;
  if (batch_id)  { conditions.push(`dr.batch_id = $${i++}`); values.push(batch_id); }
  if (date_from) { conditions.push(`dr.record_date >= $${i++}`); values.push(date_from); }
  if (date_to)   { conditions.push(`dr.record_date <= $${i++}`); values.push(date_to); }

  const offset = (page - 1) * limit;
  const { rows } = await pool.query(
    `SELECT dr.*, b.batch_code, b.breed,
            u.full_name AS recorded_by_name
     FROM daily_flock_records dr
     JOIN batches b ON b.id = dr.batch_id
     LEFT JOIN users u ON u.id = dr.recorded_by
     WHERE ${conditions.join(' AND ')}
     ORDER BY dr.record_date DESC, dr.created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, limit, offset]
  );
  res.json({ records: rows });
});

// GET /api/flock/pens
router.get('/pens', requirePermission('flock', 'view'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*,
       COUNT(b.id) FILTER (WHERE b.status NOT IN ('sold','culled')) AS active_batches,
       SUM(b.current_count) FILTER (WHERE b.status NOT IN ('sold','culled')) AS total_birds
     FROM pens p
     LEFT JOIN batches b ON b.pen_id = p.id
     WHERE p.org_id = $1
     GROUP BY p.id
     ORDER BY p.name`,
    [req.user.org_id]
  );
  res.json({ pens: rows });
});

// GET /api/flock/culled-pen — virtual culled pen summary
router.get('/culled-pen', requirePermission('flock', 'view'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(culled_count), 0) AS total_culled,
       COUNT(*) FILTER (WHERE culled_count > 0) AS batches_with_culled,
       json_agg(json_build_object(
         'batch_code', batch_code, 'breed', breed, 'culled_count', culled_count
       ) ORDER BY culled_count DESC) FILTER (WHERE culled_count > 0) AS breakdown
     FROM batches
     WHERE org_id = $1 AND status NOT IN ('sold')`,
    [req.user.org_id]
  );
  res.json({ culled_pen: rows[0] });
});

// POST /api/flock/pens
router.post('/pens', requirePermission('flock', 'create'), async (req, res) => {
  const { name, capacity, pen_type, location, notes } = req.body;
  if (!name || !capacity) return res.status(422).json({ error: 'name and capacity required' });
  const { rows: [pen] } = await pool.query(
    `INSERT INTO pens (org_id, name, capacity, pen_type, location, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user.org_id, name, capacity, pen_type||null, location||null, notes||null]
  );
  res.status(201).json({ pen });
});

module.exports = router;
