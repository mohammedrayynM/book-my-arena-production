// /api/admin/subscriptions — admin control of the EXISTING subscription system (part of the existing admin panel):
//   plan templates (name, duration, price, currency, billing interval, features, enabled) that owners publish offers from, and
//   a global view of every subscription with cancel / suspend / reactivate (each logged with admin id, action, reason, timestamp).
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { dateOnlyResponses } = require('../utils/tournamentValidation');
const { todayIn } = require('../utils/timezone');
const { fromMinor } = require('../utils/money');
const subs = require('../services/subscriptionService');

router.use(dateOnlyResponses);
router.use(verifyToken, verifyAdmin);
const bad = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });
const isId = (v) => /^\d+$/.test(String(v));
const INTERVALS = ['monthly', 'quarterly', 'yearly'];

function parsePlan(b, existing = null) {
  const errs = []; const o = {};
  const name = b.name !== undefined ? b.name : existing?.name;
  if (!name || !String(name).trim() || String(name).length > 80) errs.push('name is required (max 80 characters)');
  o.name = String(name || '').trim();
  const months = b.duration_months !== undefined ? Number(b.duration_months) : Number(existing?.duration_months);
  if (!Number.isInteger(months) || months < 1 || months > 12) errs.push('duration_months must be a whole number between 1 and 12');
  o.duration_months = months;
  const price = b.price !== undefined ? Number(b.price) : Number(existing?.price);
  if (!Number.isFinite(price) || price < 0 || price > 10000000) errs.push('price must be a number between 0 and 10000000');
  o.price = price;
  const cur = String(b.currency_code !== undefined ? b.currency_code : (existing?.currency_code || 'INR')).toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) errs.push('currency_code must be a 3-letter code');
  o.currency_code = cur;
  const bi = b.billing_interval !== undefined ? b.billing_interval : (existing?.billing_interval || 'monthly');
  if (!INTERVALS.includes(bi)) errs.push(`billing_interval must be one of ${INTERVALS.join(', ')}`);
  o.billing_interval = bi;
  let features = b.features !== undefined ? b.features : existing?.features;
  if (typeof features === 'string') features = features.split('\n').map((s) => s.trim()).filter(Boolean);
  if (features == null) features = [];
  if (!Array.isArray(features) || features.length > 30 || features.some((f) => typeof f !== 'string' || f.length > 200)) errs.push('features must be a list of up to 30 short texts');
  o.features = JSON.stringify(features);
  o.is_enabled = b.is_enabled !== undefined ? !!b.is_enabled : (existing ? !!existing.is_enabled : true);
  return errs.length ? { error: errs.join('; ') } : { value: o };
}

// ---- plan templates
router.get('/plans', async (req, res) => {
  try {
    const [plans] = await pool.query('SELECT a.*, (SELECT COUNT(*) FROM subscription_plans p WHERE p.admin_plan_id = a.id) AS offers FROM subscription_admin_plans a ORDER BY a.is_enabled DESC, a.price ASC');
    res.json({ success: true, plans });
  } catch (e) { console.error(e); bad(res, 500, 'Failed to load plans'); }
});
router.post('/plans', async (req, res) => {
  try {
    const p = parsePlan(req.body || {});
    if (p.error) return bad(res, 400, p.error);
    const o = p.value;
    const [ins] = await pool.query('INSERT INTO subscription_admin_plans (name, duration_months, price, currency_code, billing_interval, features, is_enabled, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [o.name, o.duration_months, o.price, o.currency_code, o.billing_interval, o.features, o.is_enabled, req.user.id]);
    await subs.audit({ actorId: req.user.id, actorRole: 'admin', action: 'PLAN_CREATED', details: { planId: ins.insertId } });
    res.json({ success: true, id: ins.insertId });
  } catch (e) { console.error(e); bad(res, 500, 'Could not create the plan'); }
});
router.put('/plans/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) return bad(res, 404, 'Plan not found');
    const [[ex]] = await pool.query('SELECT * FROM subscription_admin_plans WHERE id = ?', [req.params.id]);
    if (!ex) return bad(res, 404, 'Plan not found');
    const p = parsePlan(req.body || {}, ex);
    if (p.error) return bad(res, 400, p.error);
    const o = p.value;
    // a price change affects only FUTURE purchases/renewals: amounts already paid are stored on each payment
    await pool.query('UPDATE subscription_admin_plans SET name = ?, duration_months = ?, price = ?, currency_code = ?, billing_interval = ?, features = ?, is_enabled = ? WHERE id = ?', [o.name, o.duration_months, o.price, o.currency_code, o.billing_interval, o.features, o.is_enabled, ex.id]);
    await subs.audit({ actorId: req.user.id, actorRole: 'admin', action: 'PLAN_UPDATED', details: { planId: ex.id } });
    res.json({ success: true });
  } catch (e) { console.error(e); bad(res, 500, 'Could not update the plan'); }
});
// "delete" only disables: offers and subscriptions already built on the plan keep their history
router.delete('/plans/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) return bad(res, 404, 'Plan not found');
    const [r] = await pool.query('UPDATE subscription_admin_plans SET is_enabled = false WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return bad(res, 404, 'Plan not found');
    await subs.audit({ actorId: req.user.id, actorRole: 'admin', action: 'PLAN_DISABLED', details: { planId: Number(req.params.id) } });
    res.json({ success: true });
  } catch (e) { console.error(e); bad(res, 500, 'Could not disable the plan'); }
});

// ---- every subscription, platform-wide
router.get('/', async (req, res) => {
  try {
    const where = ['1=1']; const params = [];
    const st = String(req.query.status || '').toLowerCase();
    if (st) { where.push('s.status = ?'); params.push(st); }
    if (req.query.venue_id && isId(req.query.venue_id)) { where.push('s.turf_id = ?'); params.push(req.query.venue_id); }
    if (req.query.source === 'online' || req.query.source === 'manual') { where.push('s.source = ?'); params.push(req.query.source); }
    if (req.query.q) { where.push('(u.name LIKE ? OR u.email LIKE ? OR s.member_name LIKE ? OR s.member_phone LIKE ? OR t.name LIKE ?)'); const q = `%${String(req.query.q).slice(0, 60)}%`; params.push(q, q, q, q, q); }
    const [rows] = await pool.query(
      `SELECT s.*, p.name AS plan_name, t.name AS turf_name, t.timezone AS venue_tz, t.owner_id AS venue_owner_id, c.name AS court_name, u.name AS user_name, u.email AS user_email
       FROM user_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id LEFT JOIN turfs t ON t.id = s.turf_id LEFT JOIN courts c ON c.id = s.court_id LEFT JOIN users u ON u.id = s.user_id
       WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT 300`, params);
    res.json({ success: true, subscriptions: rows.map((s) => ({
      id: s.id, status: s.status, display_status: subs.displayStatus(s, todayIn(s.venue_tz || 'Asia/Kolkata')), payment_status: s.payment_status, source: s.source, plan_name: s.plan_name, turf_name: s.turf_name, court_name: s.court_name,
      member: s.user_name || s.member_name, email: s.user_email || s.member_email, phone: s.member_phone, start_date: s.start_date, expiry_date: s.expiry_date, next_billing_date: s.next_billing_date,
      currency: s.currency_code, amount_paid: fromMinor(Number(s.amount_paid_minor || 0), s.currency_code || 'INR'), cancelled_by: s.cancelled_by, cancel_reason: s.cancel_reason, created_at: s.created_at })) });
  } catch (e) { console.error(e); bad(res, 500, 'Failed to load subscriptions'); }
});

router.get('/audit-log', async (req, res) => {
  try {
    const where = ['1=1']; const params = [];
    if (req.query.subscription_id && isId(req.query.subscription_id)) { where.push('subscription_id = ?'); params.push(req.query.subscription_id); }
    if (req.query.venue_id && isId(req.query.venue_id)) { where.push('venue_id = ?'); params.push(req.query.venue_id); }
    const [rows] = await pool.query(`SELECT * FROM subscription_audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 300`, params);
    res.json({ success: true, entries: rows });
  } catch (e) { console.error(e); bad(res, 500, 'Failed to load the log'); }
});

router.get('/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) return bad(res, 404, 'Subscription not found');
    const [[s]] = await pool.query('SELECT s.*, t.name AS turf_name, u.name AS user_name FROM user_subscriptions s LEFT JOIN turfs t ON t.id = s.turf_id LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?', [req.params.id]);
    if (!s) return bad(res, 404, 'Subscription not found');
    const [payments] = await pool.query('SELECT * FROM subscription_payments WHERE subscription_id = ? ORDER BY id', [s.id]);
    const [reservations] = await pool.query('SELECT reservation_date, start_time, end_time, status, seat_no FROM subscription_reservations WHERE subscription_id = ? ORDER BY reservation_date LIMIT 400', [s.id]);
    const [audit] = await pool.query('SELECT * FROM subscription_audit_log WHERE subscription_id = ? ORDER BY id', [s.id]);
    const [refunds] = await pool.query("SELECT refund_code, refund_status, refund_amount_minor, currency_code, refund_reason, requested_at FROM refunds WHERE booking_type = 'subscription' AND booking_id = ?", [s.id]);
    res.json({ success: true, subscription: s, payments, reservations, audit, refunds });
  } catch (e) { console.error(e); bad(res, 500, 'Failed to load the subscription'); }
});

const reasonOf = (req) => (req.body && req.body.reason ? String(req.body.reason).slice(0, 255) : null);
router.post('/:id/cancel', async (req, res) => {
  try {
    if (!isId(req.params.id)) return bad(res, 404, 'Subscription not found');
    const reason = reasonOf(req);
    if (!reason) return bad(res, 400, 'A reason is required');
    const r = await subs.cancelSubscription({ subscriptionId: Number(req.params.id), actor: { kind: 'admin', id: req.user.id }, reason, refundMode: (req.body || {}).refund_mode || 'full' });
    if (r.error) return bad(res, r.status || 400, r.error);
    res.json({ success: true, already: !!r.already, released_reservations: r.releasedReservations || 0, refund_minor: r.refundMinor || 0, currency: r.currency });
  } catch (e) { console.error(e); bad(res, 500, 'Could not cancel the subscription'); }
});
router.post('/:id/suspend', async (req, res) => {
  try {
    if (!isId(req.params.id)) return bad(res, 404, 'Subscription not found');
    const reason = reasonOf(req);
    if (!reason) return bad(res, 400, 'A reason is required');
    const r = await subs.suspendSubscription({ subscriptionId: Number(req.params.id), adminId: req.user.id, reason });
    if (r.error) return bad(res, r.status || 400, r.error);
    res.json({ success: true, released_reservations: r.released });
  } catch (e) { console.error(e); bad(res, 500, 'Could not suspend the subscription'); }
});
router.post('/:id/reactivate', async (req, res) => {
  try {
    if (!isId(req.params.id)) return bad(res, 404, 'Subscription not found');
    const r = await subs.reactivateSubscription({ subscriptionId: Number(req.params.id), adminId: req.user.id, reason: reasonOf(req) });
    if (r.error) return bad(res, r.status || 400, r.error, { conflicts: r.conflicts });
    res.json({ success: true, reservations: r.reservations });
  } catch (e) { console.error(e); bad(res, 500, 'Could not reactivate the subscription'); }
});

module.exports = router;
