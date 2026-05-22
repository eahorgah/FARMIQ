// routes/transactions.js — Financial Transaction Management with Approval Workflow

const router = require('express').Router();
const { pool } = require('../config/db');
const { authenticate, requirePermission, requireRole, auditLog } = require('../middleware/auth');
const { body, query, validationResult } = require('express-validator');

router.use(authenticate);

// ── Helpers ────────────────────────────────────────────────

// GET /api/transactions — list with filters + pagination
// Allows transactions.view (all) OR expenditure.view (expense-only)
router.get('/',
  (req, res, next) => {
    if (req.user.role === 'super_admin') return next();
    const hasTx  = req.user.permissions?.transactions?.view;
    const hasExp = req.user.permissions?.expenditure?.view;
    if (hasTx || (req.query.type === 'expense' && hasExp)) return next();
    return res.status(403).json({ error: 'Permission denied: transactions.view' });
  },
  async (req, res) => {
  const {
    page = 1, limit = 50,
    type, category, approval_status,
    date_from, date_to, batch_id,
    search
  } = req.query;

  const conditions = ['t.org_id = $1'];
  const values = [req.user.org_id];
  let i = 2;

  if (type)            { conditions.push(`t.type = $${i++}`); values.push(type); }
  if (category)        { conditions.push(`t.category = $${i++}`); values.push(category); }
  if (approval_status) { conditions.push(`t.approval_status = $${i++}`); values.push(approval_status); }
  if (date_from)       { conditions.push(`t.transaction_date >= $${i++}`); values.push(date_from); }
  if (date_to)         { conditions.push(`t.transaction_date <= $${i++}`); values.push(date_to); }
  if (batch_id)        { conditions.push(`t.batch_id = $${i++}`); values.push(batch_id); }
  if (search) {
    if (search.length > 100) return res.status(400).json({ error: 'Search term too long' });
    conditions.push(`(t.description ILIKE $${i} OR t.counterparty_name ILIKE $${i})`); values.push(`%${search}%`); i++;
  }

  // Finance officers see all; others see only their org
  // (org_id filter already applied above)

  const offset = (page - 1) * limit;

  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query(
      `SELECT t.*, u.full_name AS created_by_name, a.full_name AS approved_by_name,
              b.batch_code, b.breed
       FROM transactions t
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN users a ON a.id = t.approved_by
       LEFT JOIN batches b ON b.id = t.batch_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.transaction_date DESC, t.created_at DESC
       LIMIT $${i++} OFFSET $${i}`,
      [...values, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) FROM transactions t WHERE ${conditions.join(' AND ')}`,
      values
    )
  ]);

  res.json({
    transactions: rows,
    pagination: { page: +page, limit: +limit, total: +countRows[0].count }
  });
});

// GET /api/transactions/export — all transactions for report (no pagination)
router.get('/export', requirePermission('transactions', 'view'), async (req, res) => {
  const { type, date_from, date_to, category } = req.query;
  const conditions = ['t.org_id = $1'];
  const values = [req.user.org_id];
  let i = 2;
  if (type)      { conditions.push(`t.type = $${i++}`);                    values.push(type); }
  if (category)  { conditions.push(`t.category = $${i++}`);                values.push(category); }
  if (date_from) { conditions.push(`t.transaction_date >= $${i++}`);       values.push(date_from); }
  if (date_to)   { conditions.push(`t.transaction_date <= $${i++}`);       values.push(date_to); }

  const { rows } = await pool.query(
    `SELECT t.id, t.transaction_ref, t.type, t.category, t.amount, t.transaction_date,
            t.description, t.payment_method, t.counterparty_name,
            t.approval_status, t.invoice_number,
            b.batch_code,
            sr.quantity AS sale_qty, sr.unit AS sale_unit, sr.unit_price AS sale_unit_price, sr.egg_type AS sale_egg_type,
            u.full_name AS recorded_by
     FROM transactions t
     LEFT JOIN batches b     ON b.id = t.batch_id
     LEFT JOIN sales_records sr ON sr.transaction_id = t.id
     LEFT JOIN users u        ON u.id = t.created_by
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.transaction_date DESC, t.created_at DESC
     LIMIT 5000`,
    values
  );
  res.json({ transactions: rows });
});

// GET /api/transactions/summary — monthly totals
router.get('/summary', requirePermission('transactions', 'view'), async (req, res) => {
  const { year = new Date().getFullYear(), month } = req.query;
  let dateFilter = `EXTRACT(YEAR FROM transaction_date) = $2`;
  const values = [req.user.org_id, year];
  if (month) { dateFilter += ` AND EXTRACT(MONTH FROM transaction_date) = $3`; values.push(month); }

  const { rows } = await pool.query(
    `SELECT
       SUM(CASE WHEN type = 'income' AND approval_status != 'rejected' THEN amount ELSE 0 END) AS total_income,
       SUM(CASE WHEN type = 'expense' AND approval_status != 'rejected' THEN amount ELSE 0 END) AS total_expenses,
       SUM(CASE WHEN type = 'income' AND approval_status != 'rejected' THEN amount
                WHEN type = 'expense' AND approval_status != 'rejected' THEN -amount ELSE 0 END) AS net_profit,
       COUNT(*) AS transaction_count,
       COUNT(*) FILTER (WHERE approval_status = 'pending') AS pending_approval_count,
       json_object_agg(category, category_total) AS by_category
     FROM (
       SELECT *, SUM(amount) OVER (PARTITION BY category) AS category_total
       FROM transactions WHERE org_id = $1 AND ${dateFilter}
     ) sub`,
    values
  );
  res.json({ summary: rows[0] });
});

// GET /api/transactions/pending — items awaiting approval
router.get('/pending', requirePermission('transactions', 'approve'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*, u.full_name AS created_by_name, u.email AS created_by_email
     FROM transactions t
     JOIN users u ON u.id = t.created_by
     WHERE t.org_id = $1 AND t.approval_status = 'pending' AND t.requires_approval = true
     ORDER BY t.created_at ASC`,
    [req.user.org_id]
  );
  res.json({ pending: rows });
});

// POST /api/transactions — create transaction
router.post('/',
  requirePermission('transactions', 'create'),
  auditLog('create_transaction', 'transaction'),
  [
    body('type').isIn(['income', 'expense']),
    body('category').notEmpty(),
    body('amount').isFloat({ min: 0.01 }),
    body('transaction_date').isDate(),
    body('description').notEmpty().trim(),
    body('payment_method').optional().isIn(['cash','mobile_money','bank_transfer','cheque','credit']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const {
      type, category, amount, transaction_date, description,
      payment_method = 'cash', batch_id, pen_id,
      counterparty_name, counterparty_phone, invoice_number,
      // Product sale fields
      sale_quantity, sale_unit, sale_unit_price, sale_batch_id, egg_type,
      // Multi-line egg sales
      egg_lines,
    } = req.body;

    const VALID_EGG_TYPES = ['jumbo', 'extra_large', 'large', 'medium', 'pullet'];
    const saleEggType = VALID_EGG_TYPES.includes(egg_type) ? egg_type : null;

    const approvalStatus = 'pending';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [tx] } = await client.query(
        `INSERT INTO transactions
           (org_id, type, category, amount, transaction_date, description, payment_method,
            batch_id, pen_id, counterparty_name, counterparty_phone, invoice_number,
            requires_approval, approval_status, approved_by, approved_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          req.user.org_id, type, category, amount, transaction_date, description, payment_method,
          batch_id || sale_batch_id || null, pen_id || null,
          counterparty_name || null, counterparty_phone || null, invoice_number || null,
          true, approvalStatus,
          null, null,
          req.user.id,
        ]
      );

      // ── Product sale: write sales_records + deduct from batch ──
      const SALE_CATEGORIES = { egg_sales: 'eggs', broiler_sales: 'broilers', day_old_chick_sales: 'chicks', layer_sales: 'layers', manure_sales: 'other' };
      const saleBatch = sale_batch_id || batch_id || null;

      if (type === 'income' && category === 'egg_sales' && Array.isArray(egg_lines) && egg_lines.length > 0) {
        // Multi-line egg sale — one sales_record per egg type
        for (const line of egg_lines) {
          const lineEggType = VALID_EGG_TYPES.includes(line.egg_type) ? line.egg_type : null;
          const lineQty     = parseFloat(line.quantity) || 0;
          const linePrice   = parseFloat(line.unit_price) || 0;
          if (!lineQty || !linePrice) continue;
          await client.query(
            `INSERT INTO sales_records
               (org_id, transaction_id, sale_type, sale_date, batch_id, quantity, unit, unit_price,
                total_amount, buyer_name, buyer_phone, egg_type, recorded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              req.user.org_id, tx.id, 'eggs', transaction_date, saleBatch,
              lineQty, line.unit || 'tray', linePrice, lineQty * linePrice,
              counterparty_name || null, counterparty_phone || null,
              lineEggType,
              req.user.id,
            ]
          );
        }
      } else if (type === 'income' && sale_quantity && sale_unit_price && SALE_CATEGORIES[category]) {
        // Single-line product sale (non-egg categories or legacy single-type egg sale)
        const saleType = SALE_CATEGORIES[category];

        await client.query(
          `INSERT INTO sales_records
             (org_id, transaction_id, sale_type, sale_date, batch_id, quantity, unit, unit_price,
              total_amount, buyer_name, buyer_phone, egg_type, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            req.user.org_id, tx.id, saleType, transaction_date, saleBatch,
            sale_quantity, sale_unit || 'unit', sale_unit_price, amount,
            counterparty_name || null, counterparty_phone || null,
            saleType === 'eggs' ? saleEggType : null,
            req.user.id,
          ]
        );

        // Deduct birds from batch for broiler / chick / layer sales
        if (['broilers', 'chicks', 'layers'].includes(saleType) && saleBatch) {
          await client.query(
            `UPDATE batches
             SET current_count = GREATEST(0, current_count - $1), updated_at = NOW()
             WHERE id = $2 AND org_id = $3`,
            [Math.floor(sale_quantity), saleBatch, req.user.org_id]
          );
        }
      }

      await client.query('COMMIT');
      res.status(201).json({
        transaction: tx,
        message: 'Transaction submitted — pending approval from farm owner or finance officer',
      });
    } catch (err) {
      await client.query('ROLLBACK'); throw err;
    } finally { client.release(); }
  }
);

// PATCH /api/transactions/:id — edit (only own pending, or manager+)
router.patch('/:id', requirePermission('transactions', 'edit'),
  auditLog('update_transaction', 'transaction', (req) => req.params.id),
  async (req, res) => {
    const { rows: [tx] } = await pool.query(
      `SELECT * FROM transactions WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.user.org_id]
    );
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.approval_status === 'approved' && !['super_admin','farm_owner'].includes(req.user.role))
      return res.status(403).json({ error: 'Cannot edit an approved transaction' });

    const allowed = ['description','amount','transaction_date','payment_method','counterparty_name','invoice_number'];
    const updates = []; const values = []; let i = 1;
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${i++}`);
        values.push(req.body[field]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No editable fields provided' });
    // Reset to pending if amount changed
    if (req.body.amount) { updates.push(`approval_status = 'pending'`); }
    values.push(req.params.id, req.user.org_id);
    await pool.query(
      `UPDATE transactions SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${i++} AND org_id = $${i}`,
      values
    );
    res.json({ message: 'Transaction updated' });
  }
);

// POST /api/transactions/:id/approve
router.post('/:id/approve',
  requirePermission('transactions', 'approve'),
  auditLog('approve_transaction', 'transaction', (req) => req.params.id),
  async (req, res) => {
    const { rows: [tx] } = await pool.query(
      `UPDATE transactions
       SET approval_status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND org_id = $3 AND approval_status = 'pending'
       RETURNING *`,
      [req.user.id, req.params.id, req.user.org_id]
    );
    if (!tx) return res.status(404).json({ error: 'Transaction not found or already processed' });
    res.json({ message: 'Transaction approved', transaction: tx });
  }
);

// POST /api/transactions/:id/reject
router.post('/:id/reject',
  requirePermission('transactions', 'approve'),
  auditLog('reject_transaction', 'transaction', (req) => req.params.id),
  async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Rejection reason required' });
    const { rows: [tx] } = await pool.query(
      `UPDATE transactions
       SET approval_status = 'rejected', rejection_reason = $1, approved_by = $2, approved_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND org_id = $4 AND approval_status = 'pending'
       RETURNING *`,
      [reason, req.user.id, req.params.id, req.user.org_id]
    );
    if (!tx) return res.status(404).json({ error: 'Transaction not found or already processed' });
    res.json({ message: 'Transaction rejected', transaction: tx });
  }
);

// POST /api/transactions/:id/flag
router.post('/:id/flag', requireRole('super_admin','farm_owner','finance_officer'),
  async (req, res) => {
    const { reason } = req.body;
    await pool.query(
      `UPDATE transactions SET approval_status = 'flagged', flagged_reason = $1, updated_at = NOW()
       WHERE id = $2 AND org_id = $3`,
      [reason, req.params.id, req.user.org_id]
    );
    res.json({ message: 'Transaction flagged for review' });
  }
);

// DELETE /api/transactions/:id — soft delete via rejection
router.delete('/:id',
  requirePermission('transactions', 'delete'),
  auditLog('delete_transaction', 'transaction', (req) => req.params.id),
  async (req, res) => {
    const { rowCount } = await pool.query(
      `DELETE FROM transactions WHERE id = $1 AND org_id = $2 AND approval_status != 'approved'`,
      [req.params.id, req.user.org_id]
    );
    if (!rowCount) return res.status(403).json({ error: 'Cannot delete an approved transaction' });
    res.json({ message: 'Transaction deleted' });
  }
);

module.exports = router;
