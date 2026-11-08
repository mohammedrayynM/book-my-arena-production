const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { HOST_NAME_SQL, HOST_EMAIL_SQL } = require('../utils/tournamentAccess');
const tournamentPricing = require('../services/tournamentPricing');

// GET /api/admin-tournaments - List all tournaments
router.get('/', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status, sport, search } = req.query;
    
    let query = `
      SELECT t.*, ${HOST_NAME_SQL} as owner_name, ${HOST_EMAIL_SQL} as owner_email
      FROM tournaments t
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ` AND t.status = ?`;
      params.push(status);
    }
    if (sport) {
      query += ` AND t.sport = ?`;
      params.push(sport);
    }
    if (search) {
      query += ` AND (t.name LIKE ? OR t.slug LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY t.created_at DESC';

    const [tournaments] = await pool.query(query, params);
    res.json({ success: true, tournaments });
  } catch (error) {
    console.error('Error fetching admin tournaments:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tournaments' });
  }
});

// GET /api/admin-tournaments/settings - Get tournament creation fee
router.get('/settings', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const config = await tournamentPricing.getConfig();
    res.json({ success: true, settings: config });
  } catch (error) {
    console.error('Error fetching tournament settings:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tournament settings' });
  }
});

// POST /api/admin-tournaments/settings - Update the tournament creation fee, currency, duration limits,
// allowed formats/sports and whether creation is open at all. Every change is audited; completed payments
// are never rewritten, because the charged amount lives on the payment ledger row, not here.
router.post('/settings', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const before = await tournamentPricing.getConfig();

    const num = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : Number(v));
    const fee = num(b.fee_amount, before.fee_amount);
    const minD = Math.max(1, parseInt(num(b.min_duration_days, before.min_duration_days), 10) || 1);
    const maxD = Math.max(minD, parseInt(num(b.max_duration_days, before.max_duration_days), 10) || minD);
    if (!Number.isFinite(fee) || fee < 0 || fee > 99999999.99) {
      return res.status(400).json({ success: false, error: 'Fee must be a valid amount between 0 and 99,999,999.99' });
    }
    const currency = String(b.currency_code || before.currency_code || 'INR').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({ success: false, error: 'Currency must be a valid three-letter code' });
    }
    const asList = (v, fallback) => {
      if (v === undefined) return fallback ? JSON.stringify(fallback) : null;
      if (v === null || (Array.isArray(v) && !v.length)) return null;
      return JSON.stringify(Array.isArray(v) ? v : [v]);
    };

    await pool.query(
      `UPDATE tournament_settings SET
         fee_amount = ?, is_active = ?, creation_enabled = ?, currency_code = ?,
         min_duration_days = ?, max_duration_days = ?, allowed_formats = ?, allowed_sports = ?,
         disabled_message = ?, notify_radius_km = ?, updated_by = ?, updated_by_role = 'admin'`,
      [fee,
       b.is_active === undefined ? before.is_active : !!b.is_active,
       b.creation_enabled === undefined ? before.creation_enabled : !!b.creation_enabled,
       currency, minD, maxD,
       asList(b.allowed_formats, before.allowed_formats),
       asList(b.allowed_sports, before.allowed_sports),
       b.disabled_message === undefined ? before.disabled_message : (b.disabled_message || null),
       Math.max(0, parseInt(num(b.notify_radius_km, before.notify_radius_km), 10) || 0),
       req.user.id]);

    const after = await tournamentPricing.getConfig();
    await tournamentPricing.audit(pool, { adminId: req.user.id, entity: 'settings', action: 'UPDATE', before, after });
    res.json({ success: true, message: 'Tournament settings updated successfully', settings: after });
  } catch (error) {
    console.error('Error updating tournament settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update tournament settings' });
  }
});

// ----------------------------------------------------------------------------------------------------------
// Offers on the creation fee
// ----------------------------------------------------------------------------------------------------------
router.get('/offers', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [offers] = await pool.query('SELECT * FROM tournament_offers ORDER BY is_active DESC, created_at DESC');
    res.json({ success: true, offers });
  } catch (error) {
    console.error('Error fetching tournament offers:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch offers' });
  }
});

function readOffer(b) {
  const code = String(b.code || '').trim().toUpperCase();
  if (!code || !/^[A-Z0-9_-]{3,40}$/.test(code)) return { error: 'Code must be 3-40 letters, digits, - or _' };
  if (!String(b.title || '').trim()) return { error: 'Offer title is required' };
  const type = b.discount_type === 'fixed' ? 'fixed' : 'percentage';
  const value = Number(b.discount_value);
  if (!(value > 0)) return { error: 'Discount value must be greater than zero' };
  if (type === 'percentage' && value > 100) return { error: 'A percentage discount cannot exceed 100' };
  const date = (v) => (v ? String(v).slice(0, 10) : null);
  if (date(b.valid_from) && date(b.valid_until) && date(b.valid_from) > date(b.valid_until)) {
    return { error: 'The start date must be on or before the end date' };
  }
  return {
    value: {
      code, title: String(b.title).trim(), description: b.description ? String(b.description).trim() : null,
      discount_type: type, discount_value: value,
      max_discount: b.max_discount === undefined || b.max_discount === null || b.max_discount === '' ? null : Number(b.max_discount),
      min_amount: Number(b.min_amount) || 0,
      valid_from: date(b.valid_from), valid_until: date(b.valid_until),
      max_uses: b.max_uses === undefined || b.max_uses === null || b.max_uses === '' ? null : parseInt(b.max_uses, 10),
      per_user_limit: Math.max(1, parseInt(b.per_user_limit, 10) || 1),
      is_active: b.is_active === undefined ? 1 : (b.is_active ? 1 : 0),
    },
  };
}

router.post('/offers', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const parsed = readOffer(req.body || {});
    if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
    const o = parsed.value;
    const [result] = await pool.query(
      `INSERT INTO tournament_offers
         (code, title, description, discount_type, discount_value, max_discount, min_amount, valid_from, valid_until, max_uses, per_user_limit, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [o.code, o.title, o.description, o.discount_type, o.discount_value, o.max_discount, o.min_amount,
       o.valid_from, o.valid_until, o.max_uses, o.per_user_limit, o.is_active, req.user.id]);
    await tournamentPricing.audit(pool, { adminId: req.user.id, entity: 'offer', entityId: result.insertId, action: 'CREATE', after: o });
    res.json({ success: true, message: 'Offer created', offer_id: result.insertId });
  } catch (error) {
    if (/duplicate/i.test(error.message)) return res.status(400).json({ success: false, error: 'That coupon code already exists' });
    console.error('Error creating tournament offer:', error);
    res.status(500).json({ success: false, error: 'Failed to create offer' });
  }
});

router.put('/offers/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [[before]] = await pool.query('SELECT * FROM tournament_offers WHERE id = ?', [req.params.id]);
    if (!before) return res.status(404).json({ success: false, error: 'Offer not found' });
    const parsed = readOffer({ ...before, ...(req.body || {}) });
    if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
    const o = parsed.value;
    await pool.query(
      `UPDATE tournament_offers SET code = ?, title = ?, description = ?, discount_type = ?, discount_value = ?,
         max_discount = ?, min_amount = ?, valid_from = ?, valid_until = ?, max_uses = ?, per_user_limit = ?, is_active = ?
       WHERE id = ?`,
      [o.code, o.title, o.description, o.discount_type, o.discount_value, o.max_discount, o.min_amount,
       o.valid_from, o.valid_until, o.max_uses, o.per_user_limit, o.is_active, req.params.id]);
    await tournamentPricing.audit(pool, { adminId: req.user.id, entity: 'offer', entityId: Number(req.params.id), action: 'UPDATE', before, after: o });
    res.json({ success: true, message: 'Offer updated' });
  } catch (error) {
    console.error('Error updating tournament offer:', error);
    res.status(500).json({ success: false, error: 'Failed to update offer' });
  }
});

// Deactivates rather than deletes: redemption history stays intact for reconciliation.
router.delete('/offers/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [[before]] = await pool.query('SELECT * FROM tournament_offers WHERE id = ?', [req.params.id]);
    if (!before) return res.status(404).json({ success: false, error: 'Offer not found' });
    await pool.query('UPDATE tournament_offers SET is_active = 0 WHERE id = ?', [req.params.id]);
    await tournamentPricing.audit(pool, { adminId: req.user.id, entity: 'offer', entityId: Number(req.params.id), action: 'DEACTIVATE', before });
    res.json({ success: true, message: 'Offer deactivated' });
  } catch (error) {
    console.error('Error deactivating tournament offer:', error);
    res.status(500).json({ success: false, error: 'Failed to deactivate offer' });
  }
});

// ----------------------------------------------------------------------------------------------------------
// Creation-fee reconciliation + settings history
// ----------------------------------------------------------------------------------------------------------
router.get('/payments', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const status = req.query.status;
    const params = [];
    let where = '';
    if (status && ['created', 'paid', 'failed', 'cancelled', 'refunded'].includes(status)) {
      where = 'WHERE p.status = ?';
      params.push(status);
    }
    const [rows] = await pool.query(
      `SELECT p.*, t.name AS tournament_name, t.sport, t.status AS tournament_status
         FROM tournament_fee_payments p
         LEFT JOIN tournaments t ON t.id = p.tournament_id
         ${where}
        ORDER BY p.id DESC LIMIT 200`, params);
    const [[totals]] = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS collected,
              COALESCE(SUM(CASE WHEN status = 'created' THEN amount END), 0) AS pending,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN discount_amount END), 0) AS discounts_given
         FROM tournament_fee_payments`);
    res.json({ success: true, payments: rows, totals });
  } catch (error) {
    console.error('Error fetching tournament fee payments:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch payments' });
  }
});

router.get('/settings/audit', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, ad.name AS admin_name FROM tournament_settings_audit a
         LEFT JOIN admins ad ON ad.id = a.admin_id
        ORDER BY a.id DESC LIMIT 100`);
    res.json({ success: true, history: rows });
  } catch (error) {
    // admins table name varies on older deployments — fall back to the raw rows
    try {
      const [rows] = await pool.query('SELECT * FROM tournament_settings_audit ORDER BY id DESC LIMIT 100');
      return res.json({ success: true, history: rows });
    } catch {
      res.status(500).json({ success: false, error: 'Failed to fetch settings history' });
    }
  }
});

// PATCH /api/admin-tournaments/:id/status - Admin suspend/cancel tournament
router.patch('/:id/status', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    
    if (!['CANCELLED', 'SUSPENDED'].includes(status)) {
        return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    // Since our enum is CANCELLED but we don't have SUSPENDED, we will map SUSPENDED to CANCELLED for now or adjust DB later.
    const finalStatus = status === 'SUSPENDED' ? 'CANCELLED' : status;

    await pool.query('UPDATE tournaments SET status = ? WHERE id = ?', [finalStatus, req.params.id]);
    
    res.json({ success: true, message: `Tournament ${finalStatus.toLowerCase()} successfully` });
  } catch (error) {
    console.error('Error updating tournament status:', error);
    res.status(500).json({ success: false, error: 'Failed to update tournament status' });
  }
});

// GET /api/admin-tournaments/plans - Admin views tournament pricing tiers
router.get('/plans', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [plans] = await pool.query('SELECT * FROM tournament_plans ORDER BY sort_order ASC');
    res.json({ success: true, plans });
  } catch (error) {
    console.error('Error fetching tournament plans:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tournament plans' });
  }
});

// PUT /api/admin-tournaments/plans/:id - Admin edits a pricing tier (price/features/active)
router.put('/plans/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { price, features, is_active } = req.body;
    const [result] = await pool.query(`
      UPDATE tournament_plans SET
        price = COALESCE(?, price),
        features = COALESCE(?, features),
        is_active = COALESCE(?, is_active)
      WHERE id = ?
    `, [price, features ? JSON.stringify(features) : null, is_active, req.params.id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }
    res.json({ success: true, message: 'Plan updated' });
  } catch (error) {
    console.error('Error updating tournament plan:', error);
    res.status(500).json({ success: false, error: 'Failed to update plan' });
  }
});

module.exports = router;
