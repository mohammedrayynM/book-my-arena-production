// /api/cancellations — the ONE cancellation surface for sports/turf and activity bookings. The client sends only
// { type, id } (+ a reason for owner/admin, + acceptNoRefund for a no-refund customer cancel); the backend works out
// eligibility, fee, refund, currency, payment and inventory (services/cancellation.js).
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyOwner, verifyAdmin } = require('../middleware/auth');
const cancellation = require('../services/cancellation');
const refundsSvc = require('../services/refunds');
const { rateLimit } = require('../middleware/rateLimit');
const { fromMinor } = require('../utils/money');

const bad = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });
const limiter = rateLimit({ windowMs: 60000, max: 30, keyFn: (req) => `${req.user ? req.user.role || 'user' : 'x'}:${req.user ? req.user.id : req.ip}:${(req.query && req.query.id) || (req.body && req.body.id) || ''}`, message: 'Too many cancellation requests. Please wait a minute.' });
const TYPES = ['turf', 'activity'];
const parse = (src) => { const type = String(src.type || ''); const id = Number(src.id); return TYPES.includes(type) && Number.isInteger(id) && id > 0 ? { type, id } : null; };

router.get('/reasons', (req, res) => res.json({ success: true, owner: cancellation.OWNER_REASONS, admin: cancellation.ADMIN_REASONS, refund_note: cancellation.REFUND_NOTE }));

const customerOnly = (req, res, next) => (req.user && req.user.role ? bad(res, 403, 'Only customers can use this') : next());

// GET /quote?type=turf|activity&id= — what cancelling would cost/refund, for the confirmation screen (changes nothing)
router.get('/quote', verifyToken, limiter, async (req, res) => {
  try {
    const p = parse(req.query); if (!p) return bad(res, 400, 'type (turf|activity) and id are required');
    const actor = req.user.role === 'owner' ? { kind: 'owner', id: req.user.id } : req.user.role === 'admin' ? { kind: 'admin', id: req.user.id } : { kind: 'customer', id: req.user.id };
    const q = await cancellation.quote({ ...p, actor });
    if (q.error) return bad(res, q.status, q.error);
    res.json({ success: true, quote: q.view });
  } catch (e) { console.error('cancel quote:', e.message); bad(res, 500, 'Could not work out the cancellation'); }
});

// POST /cancel { type, id, acceptNoRefund?, reason? } — customer
router.post('/cancel', verifyToken, customerOnly, limiter, async (req, res) => {
  try {
    const p = parse(req.body || {}); if (!p) return bad(res, 400, 'type (turf|activity) and id are required');
    const r = await cancellation.cancel({ ...p, actor: { kind: 'customer', id: req.user.id }, reason: req.body.reason, acceptNoRefund: req.body.acceptNoRefund === true });
    if (r.error) return bad(res, r.status || 400, r.error, { code: r.code, quote: r.view });
    res.json({ success: true, already_cancelled: !!r.alreadyCancelled, cancelled: !!r.cancelled, quote: r.view, refunds: (r.refunds || []).map(shapeRefund) });
  } catch (e) { console.error('customer cancel:', e.message); bad(res, 500, 'Could not cancel this booking'); }
});

// POST /owner-cancel { type, id, reason } — the venue owner cancels (venue closure, maintenance...) -> full refund
router.post('/owner-cancel', verifyToken, verifyOwner, limiter, async (req, res) => {
  try {
    const p = parse(req.body || {}); if (!p) return bad(res, 400, 'type (turf|activity) and id are required');
    const r = await cancellation.cancel({ ...p, actor: { kind: 'owner', id: req.user.id }, reason: req.body.reason });
    if (r.error) return bad(res, r.status || 400, r.error, { code: r.code });
    res.json({ success: true, already_cancelled: !!r.alreadyCancelled, cancelled: !!r.cancelled, quote: r.view, refunds: (r.refunds || []).map(shapeRefund) });
  } catch (e) { console.error('owner cancel:', e.message); bad(res, 500, 'Could not cancel this booking'); }
});

// POST /admin-cancel { type, id, reason }
router.post('/admin-cancel', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const p = parse(req.body || {}); if (!p) return bad(res, 400, 'type (turf|activity) and id are required');
    const r = await cancellation.cancel({ ...p, actor: { kind: 'admin', id: req.user.id }, reason: req.body.reason });
    if (r.error) return bad(res, r.status || 400, r.error, { code: r.code });
    res.json({ success: true, already_cancelled: !!r.alreadyCancelled, cancelled: !!r.cancelled, quote: r.view, refunds: (r.refunds || []).map(shapeRefund) });
  } catch (e) { console.error('admin cancel:', e.message); bad(res, 500, 'Could not cancel this booking'); }
});

function shapeRefund(r) {
  const c = r.currency_code;
  return {
    id: r.id, refund_code: r.refund_code, booking_type: r.booking_type, booking_id: r.booking_id, currency: c, country_code: r.country_code, venue_name: r.venue_name,
    original_amount: fromMinor(r.original_amount_minor, c), amount_paid: fromMinor(r.amount_paid_minor, c), cancellation_fee: fromMinor(r.cancellation_fee_minor, c), refund_amount: fromMinor(r.refund_amount_minor, c),
    refund_status: r.refund_status, refund_reason: r.refund_reason, cancelled_by: r.cancelled_by, cancellation_type: r.cancellation_type,
    gateway_refund_id: r.gateway_refund_id, requested_at: r.requested_at, completed_at: r.completed_at, failure_reason: r.failure_reason,
    policy_version: r.policy_version, policy_window_hours: r.policy_window_hours == null ? null : Number(r.policy_window_hours), policy_fee_percent: r.policy_fee_percent == null ? null : Number(r.policy_fee_percent),
    business_type: r.business_type,
  };
}

// GET /mine — the signed-in customer's own refunds
router.get('/mine', verifyToken, customerOnly, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM refunds WHERE user_id = ? ORDER BY id DESC LIMIT 100', [req.user.id]);
  res.json({ success: true, refunds: rows.map(shapeRefund) });
});

// GET /owner/refunds — refunds on the signed-in owner's venues (read-only: owners never edit amounts)
router.get('/owner/refunds', verifyToken, verifyOwner, async (req, res) => {
  const where = ['r.owner_id = ?']; const params = [req.user.id];
  if (req.query.status) { where.push('r.refund_status = ?'); params.push(String(req.query.status)); }
  const [rows] = await pool.query(
    `SELECT r.*, u.name AS customer_name FROM refunds r LEFT JOIN users u ON u.id = r.user_id WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 200`, params
  );
  res.json({ success: true, refunds: rows.map((r) => ({ ...shapeRefund(r), customer_name: r.customer_name })) });
});

module.exports = router;
module.exports.shapeRefund = shapeRefund;
