// /api/admin/global — admin control of the global layer: countries (enable/disable, add new ones), payment configuration
// per country/currency, the versioned cancellation policy, and refund management. Part of the EXISTING admin panel.
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const globalConfig = require('../services/globalConfig');
const refundsSvc = require('../services/refunds');
const { shapeRefund } = require('./cancellations');
const { isValidTimezone } = require('../utils/timezone');
const { digitsFor } = require('../utils/money');

router.use(verifyToken, verifyAdmin);
const bad = (res, status, error) => res.status(status).json({ success: false, error });

// ---- countries
router.get('/countries', async (req, res) => res.json({ success: true, countries: await globalConfig.listCountries({ onlyEnabled: false }) }));

// POST { country_code, country_name, currency_code, currency_symbol?, display_prefix?, currency_name?, default_timezone, timezones? }
router.post('/countries', async (req, res) => {
  try {
    const b = req.body || {};
    const code = String(b.country_code || '').toUpperCase(); const cur = String(b.currency_code || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(code) || !/^[A-Z]{3}$/.test(cur) || !b.country_name) return bad(res, 400, 'country_code (2 letters), currency_code (3 letters) and country_name are required');
    const tzs = Array.isArray(b.timezones) && b.timezones.length ? b.timezones : [b.default_timezone];
    if (!b.default_timezone || !isValidTimezone(b.default_timezone) || !tzs.every(isValidTimezone)) return bad(res, 400, 'A valid default_timezone (IANA name, e.g. Asia/Dubai) is required');
    await pool.query(
      'INSERT INTO countries (country_code, country_name, currency_code, currency_symbol, display_prefix, currency_name, minor_digits, default_timezone, timezones, enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100)',
      [code, String(b.country_name).slice(0, 80), cur, b.currency_symbol || cur, b.display_prefix || b.currency_symbol || cur, b.currency_name || cur, digitsFor(cur), b.default_timezone, JSON.stringify(tzs), b.enabled !== false]
    );
    // a new currency is listed but takes NO payments until the admin confirms the merchant account can settle it
    await pool.query("INSERT IGNORE INTO payment_configs (country_code, currency_code, payment_provider, payment_methods, enabled, notes) VALUES (?, ?, 'razorpay', ?, false, 'Off until the merchant account is confirmed to settle this currency')", [code, cur, JSON.stringify(['card'])]);
    res.json({ success: true, country: await globalConfig.getCountry(code) });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return bad(res, 400, 'That country already exists');
    console.error('add country:', e.message); bad(res, 500, 'Could not add the country');
  }
});
router.put('/countries/:code', async (req, res) => {
  const b = req.body || {}; const sets = []; const params = [];
  if (b.enabled !== undefined) { sets.push('enabled = ?'); params.push(!!b.enabled); }
  if (b.country_name) { sets.push('country_name = ?'); params.push(String(b.country_name).slice(0, 80)); }
  if (b.default_timezone) { if (!isValidTimezone(b.default_timezone)) return bad(res, 400, 'Invalid timezone'); sets.push('default_timezone = ?'); params.push(b.default_timezone); }
  if (Array.isArray(b.timezones)) { if (!b.timezones.length || !b.timezones.every(isValidTimezone)) return bad(res, 400, 'Invalid timezone list'); sets.push('timezones = ?'); params.push(JSON.stringify(b.timezones)); }
  if (!sets.length) return bad(res, 400, 'Nothing to update');
  const [r] = await pool.query(`UPDATE countries SET ${sets.join(', ')} WHERE country_code = ?`, [...params, req.params.code.toUpperCase()]);
  if (!r.affectedRows) return bad(res, 404, 'Country not found');
  res.json({ success: true, country: await globalConfig.getCountry(req.params.code) });
});

// ---- payment configuration
router.get('/payment-configs', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM payment_configs ORDER BY country_code, currency_code');
  res.json({ success: true, configs: rows.map((r) => ({ ...r, enabled: !!r.enabled })) });
});
router.put('/payment-configs/:id', async (req, res) => {
  const b = req.body || {}; const sets = []; const params = [];
  if (b.enabled !== undefined) { sets.push('enabled = ?'); params.push(!!b.enabled); }
  if (b.provider_account !== undefined) { sets.push('provider_account = ?'); params.push(b.provider_account ? String(b.provider_account).slice(0, 80) : null); }
  if (Array.isArray(b.payment_methods)) { sets.push('payment_methods = ?'); params.push(JSON.stringify(b.payment_methods)); }
  if (b.notes !== undefined) { sets.push('notes = ?'); params.push(b.notes ? String(b.notes).slice(0, 255) : null); }
  if (!sets.length) return bad(res, 400, 'Nothing to update');
  const [r] = await pool.query(`UPDATE payment_configs SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
  if (!r.affectedRows) return bad(res, 404, 'Configuration not found');
  res.json({ success: true });
});

// ---- cancellation policy (editing publishes a NEW version; existing bookings keep theirs)
router.get('/policy', async (req, res) => {
  const [hist] = await pool.query('SELECT * FROM cancellation_policies ORDER BY id DESC LIMIT 20');
  res.json({ success: true, active: await globalConfig.getActivePolicy(), history: hist.map((p) => ({ version: p.id, cancellationEnabled: !!p.cancellation_enabled, windowHours: Number(p.window_hours), feePercent: Number(p.fee_percent), customerRefundEnabled: !!p.customer_refund_enabled, ownerRefundPercent: Number(p.owner_refund_percent), isActive: !!p.is_active, createdAt: p.created_at, note: p.note })) });
});
router.put('/policy', async (req, res) => {
  const r = await globalConfig.publishPolicy(req.body || {}, req.user.id);
  if (r.error) return bad(res, 400, r.error);
  res.json({ success: true, policy: r.policy });
});

// ---- refund management
// GET /refunds?country=&currency=&venue=&status=&from=&to=&business_type=&cancelled_by=
router.get('/refunds', async (req, res) => {
  try {
    const where = ['1=1']; const params = []; const q = req.query;
    if (q.country) { where.push('r.country_code = ?'); params.push(String(q.country).toUpperCase()); }
    if (q.currency) { where.push('r.currency_code = ?'); params.push(String(q.currency).toUpperCase()); }
    if (q.status) { where.push('r.refund_status = ?'); params.push(String(q.status)); }
    if (q.business_type) { where.push('r.business_type = ?'); params.push(String(q.business_type).toUpperCase()); }
    if (q.cancelled_by) { where.push('r.cancelled_by = ?'); params.push(String(q.cancelled_by)); }
    if (q.venue) { where.push('(r.venue_name LIKE ? OR r.venue_id = ?)'); params.push(`%${String(q.venue).slice(0, 60)}%`, Number(q.venue) || 0); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) { where.push('DATE(r.requested_at) >= ?'); params.push(q.from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) { where.push('DATE(r.requested_at) <= ?'); params.push(q.to); }
    const [rows] = await pool.query(
      `SELECT r.*, u.name AS customer_name, u.email AS customer_email FROM refunds r LEFT JOIN users u ON u.id = r.user_id WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 300`, params
    );
    res.json({ success: true, refunds: rows.map((r) => ({ ...shapeRefund(r), customer_name: r.customer_name, customer_email: r.customer_email, payment_id: r.payment_id })) });
  } catch (e) { console.error('admin refunds:', e.message); bad(res, 500, 'Could not load refunds'); }
});
router.post('/refunds/:id/retry', async (req, res) => {
  const r = await refundsSvc.retry(Number(req.params.id));
  if (r.error) return bad(res, r.status || 400, r.error);
  res.json({ success: true, refund: r.refund ? shapeRefund(r.refund) : null, failed: !!r.failed, error: r.error });
});
// Manual settlement: the money was paid out another way (dashboard / bank). Only for a refund that has not completed.
router.post('/refunds/:id/mark-completed', async (req, res) => {
  const [r] = await pool.query("UPDATE refunds SET refund_status = 'REFUND_COMPLETED', completed_at = NOW(), failure_reason = ? WHERE id = ? AND refund_status IN ('REFUND_FAILED','REFUND_PENDING','REFUND_INITIATED','REFUND_PROCESSING')", [`Settled manually by admin ${req.user.id}`, req.params.id]);
  if (!r.affectedRows) return bad(res, 400, 'This refund cannot be marked completed');
  const { fire } = require('../utils/notifications/events');
  const [[done]] = await pool.query('SELECT * FROM refunds WHERE id = ?', [req.params.id]);
  await refundsSvc.onCompleted(done);
  fire('refund.status', { refundId: Number(req.params.id), status: 'REFUND_COMPLETED' });
  res.json({ success: true });
});

module.exports = router;
