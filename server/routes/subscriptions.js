// /api/subscriptions — the EXISTING subscription routes, hardened.
//   subscription_plans   = the owner's OFFER (venue, sport, court, days, time, plan price/duration, capacity)
//   user_subscriptions   = a customer's (or owner-added) SUBSCRIPTION
// The client only ever sends WHICH offer it wants; price, currency, duration, venue and schedule are the server's. A subscription
// becomes ACTIVE only after a verified payment (see services/subscriptionService.js).
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyOwner } = require('../middleware/auth');
const { dateOnlyResponses } = require('../utils/tournamentValidation');
const { todayIn } = require('../utils/timezone');
const { fromMinor } = require('../utils/money');
const subs = require('../services/subscriptionService');
const R = require('../services/subscriptionReservations');

// SQL DATE columns leave this router as plain 'YYYY-MM-DD'
router.use(dateOnlyResponses);

// Customer routes act on the signed-in CUSTOMER. User ids, owner ids and admin ids overlap, so an owner/admin token must never be
// interpreted as a customer id.
const requireCustomer = [verifyToken, (req, res, next) => (req.user.role ? res.status(403).json({ error: 'This action is for customer accounts' }) : next())];
const requireOwner = [verifyToken, verifyOwner];

const CANCEL_MESSAGE = 'Subscription cancellation must be requested through the venue.';
const isId = (v) => /^\d+$/.test(String(v));
const fail = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });
const hhmm = (t) => String(t || '').slice(0, 5);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const daysLabel = (csv) => { const s = R.parseWeekdays(csv); return s ? [...s].sort().map((d) => DAY_NAMES[d]).join(', ') : 'Every day'; };

/** One subscription row -> the shape every client gets. `display_status` is computed here; apps never infer "Active" themselves. */
function shapeSub(s, extra = {}) {
  const today = todayIn(s.venue_tz || 'Asia/Kolkata');
  const cur = s.currency_code || 'INR';
  return {
    id: s.id, plan_id: s.plan_id, turf_id: s.turf_id, court_id: s.court_id, status: s.status, payment_status: s.payment_status, display_status: subs.displayStatus(s, today),
    source: s.source, payment_type: s.payment_type, start_date: s.start_date, expiry_date: s.expiry_date, subscription_start_date: s.subscription_start_date,
    current_period_start: s.current_period_start, current_period_end: s.current_period_end, next_billing_date: s.next_billing_date,
    currency: cur, amount_paid_minor: Number(s.amount_paid_minor || 0), amount_paid: fromMinor(Number(s.amount_paid_minor || 0), cur), amount_due_minor: Number(s.amount_due_minor || 0),
    weekdays: s.weekdays, days_label: daysLabel(s.weekdays), start_time: hhmm(s.start_time), end_time: hhmm(s.end_time),
    plan_name: s.plan_name, turf_name: s.turf_name, sport_type: s.sport_type, court_name: s.court_name, timezone: s.venue_tz || 'Asia/Kolkata',
    member_name: s.member_name || s.user_name || null, member_phone: s.member_phone, member_email: s.member_email || s.user_email || null, user_id: s.user_id,
    cancelled_at: s.cancelled_at, cancelled_by: s.cancelled_by, cancel_reason: s.cancel_reason, activated_at: s.activated_at, created_at: s.created_at,
    ...extra,
  };
}

const SUB_SELECT = `SELECT s.*, p.name AS plan_name, p.owner_id AS plan_owner_id, p.price AS plan_price, t.name AS turf_name, t.sport_type, t.timezone AS venue_tz, t.owner_id AS venue_owner_id, c.name AS court_name,
    u.name AS user_name, u.email AS user_email
  FROM user_subscriptions s JOIN subscription_plans p ON s.plan_id = p.id LEFT JOIN turfs t ON s.turf_id = t.id LEFT JOIN courts c ON s.court_id = c.id LEFT JOIN users u ON s.user_id = u.id`;

// =====================================================================================================  OWNER: offers
// Admin-configured plans the owner can base an offer on (only enabled ones, in the venue's currency).
router.get('/owner/admin-plans', requireOwner, async (req, res) => {
  try {
    let cur = null;
    if (req.query.turf_id) {
      if (!isId(req.query.turf_id)) return fail(res, 400, 'turf_id is invalid');
      const [[t]] = await pool.query('SELECT currency_code, owner_id FROM turfs WHERE id = ?', [req.query.turf_id]);
      if (!t || Number(t.owner_id) !== Number(req.user.id)) return fail(res, 403, 'Forbidden');
      cur = t.currency_code || 'INR';
    }
    const [plans] = await pool.query(`SELECT id, name, duration_months, price, currency_code, billing_interval, features FROM subscription_admin_plans WHERE is_enabled = true${cur ? ' AND currency_code = ?' : ''} ORDER BY price ASC`, cur ? [cur] : []);
    res.json({ success: true, plans });
  } catch (err) { console.error(err); fail(res, 500, 'Failed to fetch plans'); }
});

router.get('/owner/plans', requireOwner, async (req, res) => {
  try {
    const [plans] = await pool.query(
      `SELECT p.*, t.name AS turf_name, t.currency_code AS venue_currency, c.name AS court_name,
         (SELECT COUNT(*) FROM user_subscriptions s WHERE s.plan_id = p.id AND s.status IN ('active','past_due') AND s.expiry_date >= UTC_DATE() - INTERVAL 1 DAY) AS active_count
       FROM subscription_plans p LEFT JOIN turfs t ON t.id = p.turf_id LEFT JOIN courts c ON c.id = p.court_id WHERE p.owner_id = ? ORDER BY p.created_at DESC`, [req.user.id]);
    res.json({ plans: plans.map((p) => ({ ...p, days_label: daysLabel(p.available_days) })) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch plans' }); }
});

async function validateOffer(ownerId, b, existing = null) {
  const out = {}; const errs = [];
  const turfId = existing ? existing.turf_id : Number(b.turf_id);
  if (!existing && !isId(b.turf_id)) return { error: 'turf_id is required' };
  const [[turf]] = await pool.query('SELECT id, owner_id, currency_code, is_active FROM turfs WHERE id = ?', [turfId]);
  if (!turf || Number(turf.owner_id) !== Number(ownerId)) return { error: 'Forbidden', status: 403 };
  out.turf_id = turf.id; out.currency = turf.currency_code || 'INR';

  const courtId = existing ? existing.court_id : (b.court_id ? Number(b.court_id) : null);
  if (!existing && b.court_id) {
    if (!isId(b.court_id)) return { error: 'court_id is invalid' };
    const [[c]] = await pool.query('SELECT id FROM courts WHERE id = ? AND turf_id = ?', [courtId, turf.id]);
    if (!c) return { error: 'That court does not belong to this venue', status: 403 };
  }
  out.court_id = courtId || null;

  const name = (b.name !== undefined ? b.name : existing?.name);
  if (!name || !String(name).trim() || String(name).length > 80) errs.push('name is required (max 80 characters)');
  out.name = String(name || '').trim();
  out.description = b.description !== undefined ? (b.description ? String(b.description).slice(0, 1000) : null) : (existing?.description ?? null);

  const st = b.start_time !== undefined ? b.start_time : existing?.start_time; const en = b.end_time !== undefined ? b.end_time : existing?.end_time;
  if (!TIME_RE.test(String(st || '')) || !TIME_RE.test(String(en || ''))) errs.push('start_time and end_time must be HH:MM');
  else if (R.toMinutes(en) <= R.toMinutes(st)) errs.push('end_time must be after start_time');
  out.start_time = hhmm(st); out.end_time = hhmm(en);

  const dRaw = b.available_days !== undefined ? b.available_days : (existing ? existing.available_days : 'all');
  const set = R.parseWeekdays(dRaw);
  if (set === undefined) errs.push('available_days must be "all" or weekday numbers 0-6 (0 = Sunday), e.g. "1,3,5"');
  out.available_days = set === undefined ? 'all' : R.weekdaysCsv(set);

  const cap = b.max_subscribers !== undefined ? Number(b.max_subscribers) : Number(existing?.max_subscribers ?? 1);
  if (!Number.isInteger(cap) || cap < 1 || cap > 500) errs.push('max_subscribers must be a whole number between 1 and 500');
  out.max_subscribers = cap;
  out.popular_badge = b.popular_badge !== undefined ? !!b.popular_badge : !!existing?.popular_badge;
  out.time_format = b.time_format === '24h' ? '24h' : (b.time_format === '12h' ? '12h' : (existing?.time_format || '12h'));

  // price / duration: from the admin's plan when one is chosen (the admin controls those), else the owner's own (only while the
  // admin has not configured any plan for this currency)
  const adminPlanId = b.admin_plan_id !== undefined ? b.admin_plan_id : existing?.admin_plan_id;
  if (adminPlanId) {
    const [[ap]] = await pool.query('SELECT * FROM subscription_admin_plans WHERE id = ?', [adminPlanId]);
    if (!ap || !ap.is_enabled) errs.push('That subscription plan is not available');
    else if (ap.currency_code !== out.currency) errs.push(`That plan is priced in ${ap.currency_code}; this venue uses ${out.currency}`);
    else { out.admin_plan_id = ap.id; out.price_source = 'admin'; out.price = Number(ap.price); out.duration_months = ap.duration_months; if (!out.name) out.name = ap.name; }
  } else {
    const [[cnt]] = await pool.query('SELECT COUNT(*) AS c FROM subscription_admin_plans WHERE is_enabled = true AND currency_code = ?', [out.currency]);
    if (Number(cnt.c) > 0 && !existing) errs.push('Choose one of the subscription plans offered by Book Arena (admin_plan_id)');
    const price = b.price !== undefined ? Number(b.price) : Number(existing?.price);
    const months = b.duration_months !== undefined ? Number(b.duration_months) : Number(existing?.duration_months ?? 1);
    if (!Number.isFinite(price) || price < 0 || price > 10000000) errs.push('price must be a number between 0 and 10000000');
    if (!Number.isInteger(months) || months < 1 || months > 12) errs.push('duration_months must be a whole number between 1 and 12');
    out.price = price; out.duration_months = months; out.price_source = 'owner'; out.admin_plan_id = null;
  }
  if (errs.length) return { error: errs.join('; '), status: 400 };
  return { value: out };
}

// POST /api/subscriptions/owner/plans — publish an offer. Conflicts with existing bookings / blocks / other subscriptions in the
// next period are listed (never overwritten); the owner can publish anyway with allow_conflicts=true — customers are still protected
// at purchase time, which re-checks every date.
router.post('/owner/plans', requireOwner, async (req, res) => {
  try {
    const b = req.body || {};
    const v = await validateOffer(req.user.id, b);
    if (v.error) return fail(res, v.status || 400, v.error);
    const o = v.value;
    const [[turf]] = await pool.query('SELECT timezone FROM turfs WHERE id = ?', [o.turf_id]);
    const tz = turf.timezone || 'Asia/Kolkata';
    const today = todayIn(tz);
    const set = R.parseWeekdays(o.available_days);
    const dates = subs.periodDates({ start: today, endExclusive: R.addMonthsClamped(today, o.duration_months), weekdaysSet: set, slotEnd: o.end_time, tz });
    const conn = await pool.getConnection();
    let conflicts = [];
    try { ({ conflicts } = await subs.checkSlot(conn, { turfId: o.turf_id, courtId: o.court_id, dates, start: o.start_time, end: o.end_time, capacity: o.max_subscribers })); } finally { conn.release(); }
    if (conflicts.length && b.allow_conflicts !== true) {
      return fail(res, 409, 'Part of this schedule is already booked, blocked or reserved. Review the dates, or publish anyway.', { code: 'OFFER_CONFLICT', conflicts: conflicts.slice(0, 40), conflict_count: conflicts.length });
    }
    const [ins] = await pool.query(
      `INSERT INTO subscription_plans (owner_id, turf_id, court_id, name, description, price, duration_months, start_time, end_time, max_subscribers, popular_badge, time_format, available_days, currency_code, admin_plan_id, price_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, o.turf_id, o.court_id, o.name, o.description, o.price, o.duration_months, o.start_time, o.end_time, o.max_subscribers, o.popular_badge, o.time_format, o.available_days, o.currency, o.admin_plan_id, o.price_source]);
    await subs.audit({ venueId: o.turf_id, actorId: req.user.id, actorRole: 'owner', action: 'OFFER_PUBLISHED', details: { planId: ins.insertId, conflicts: conflicts.length } });
    res.json({ success: true, message: 'Subscription plan created', plan_id: ins.insertId, conflict_count: conflicts.length });
  } catch (err) { console.error(err); fail(res, 500, 'Failed to create plan'); }
});

// PUT /api/subscriptions/owner/plans/:id — edit an offer. Schedule / price / capacity are frozen while members are subscribed (they
// bought THAT schedule); name, description, badge and the active switch can always change.
router.put('/owner/plans/:id', requireOwner, async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 404, 'Plan not found');
    const [[plan]] = await pool.query('SELECT * FROM subscription_plans WHERE id = ?', [req.params.id]);
    if (!plan) return fail(res, 404, 'Plan not found');
    if (Number(plan.owner_id) !== Number(req.user.id)) return fail(res, 403, 'Forbidden');
    const b = req.body || {};
    const [[live]] = await pool.query("SELECT COUNT(*) AS c FROM user_subscriptions WHERE plan_id = ? AND status IN ('active','past_due','pending')", [plan.id]);
    const structural = ['price', 'duration_months', 'start_time', 'end_time', 'available_days', 'admin_plan_id', 'court_id', 'turf_id'].filter((k) => b[k] !== undefined && String(b[k]) !== String(plan[k] ?? ''));
    if (Number(live.c) > 0 && structural.length) return fail(res, 409, 'This plan has members. Change its schedule or price by publishing a new plan, or ask them to finish first.');
    if (b.max_subscribers !== undefined && Number(b.max_subscribers) < Number(live.c)) return fail(res, 409, 'Capacity cannot be lower than the current number of members');
    const v = await validateOffer(req.user.id, b, plan);
    if (v.error) return fail(res, v.status || 400, v.error);
    const o = v.value;
    await pool.query(
      'UPDATE subscription_plans SET name = ?, description = ?, price = ?, duration_months = ?, start_time = ?, end_time = ?, max_subscribers = ?, popular_badge = ?, time_format = ?, available_days = ?, admin_plan_id = ?, price_source = ?, is_active = ? WHERE id = ?',
      [o.name, o.description, o.price, o.duration_months, o.start_time, o.end_time, o.max_subscribers, o.popular_badge, o.time_format, o.available_days, o.admin_plan_id, o.price_source, b.is_active !== undefined ? !!b.is_active : plan.is_active, plan.id]);
    await subs.audit({ venueId: plan.turf_id, actorId: req.user.id, actorRole: 'owner', action: 'OFFER_UPDATED', details: { planId: plan.id } });
    res.json({ success: true });
  } catch (err) { console.error(err); fail(res, 500, 'Failed to update plan'); }
});

// =====================================================================================================  OWNER: members
// GET /api/subscriptions/owner/subscribers?status=active|pending|expired|cancelled|manual|all (default active — what the app always showed)
router.get('/owner/subscribers', requireOwner, async (req, res) => {
  try {
    const f = String(req.query.status || 'active').toLowerCase();
    const where = ['t.owner_id = ?']; const params = [req.user.id];
    if (f === 'active') where.push("s.status IN ('active','past_due')");
    else if (f === 'pending') where.push("s.status = 'pending'");
    else if (f === 'expired') where.push("s.status = 'expired'");
    else if (f === 'cancelled') where.push("s.status IN ('cancelled','suspended','refunded')");
    else if (f === 'manual') where.push("s.source = 'manual'");
    else if (f !== 'all') return fail(res, 400, 'status must be active, pending, expired, cancelled, manual or all');
    if (req.query.turf_id) { if (!isId(req.query.turf_id)) return fail(res, 400, 'turf_id is invalid'); where.push('s.turf_id = ?'); params.push(req.query.turf_id); }
    if (f !== 'pending' && f !== 'all') { /* pending payments are only listed when asked for */ } else if (f === 'all') where.push("NOT (s.status = 'cancelled' AND s.cancel_reason = 'payment_cancelled')");
    const [rows] = await pool.query(`${SUB_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT 500`, params);
    const subscribers = rows.map((s) => ({ ...s, ...shapeSub(s), user_name: s.user_name || s.member_name, user_email: s.user_email || s.member_email, amount_paid: fromMinor(Number(s.amount_paid_minor || 0), s.currency_code || 'INR') }));
    res.json({ subscribers });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch subscribers' }); }
});

// POST /api/subscriptions/owner/members — add a member by hand (offline / paid elsewhere / complimentary). Reserves the slots exactly like an online subscription.
router.post('/owner/members', requireOwner, async (req, res) => {
  try {
    const b = req.body || {};
    if (!isId(b.plan_id)) return fail(res, 400, 'plan_id is required');
    let userId = null;
    if (b.user_id !== undefined && b.user_id !== null && b.user_id !== '') {
      if (!isId(b.user_id)) return fail(res, 400, 'user_id is invalid');
      const [[u]] = await pool.query('SELECT id, name, email FROM users WHERE id = ?', [b.user_id]);
      if (!u) return fail(res, 404, 'Customer not found');
      userId = u.id; b.name = b.name || u.name; b.email = b.email || u.email;
    }
    if (b.phone && !/^[0-9+\-\s()]{6,20}$/.test(String(b.phone))) return fail(res, 400, 'phone is invalid');
    const r = await subs.addManualMember({
      ownerId: req.user.id, planId: Number(b.plan_id), member: { userId, name: b.name ? String(b.name).trim().slice(0, 120) : null, phone: b.phone, email: b.email ? String(b.email).slice(0, 150) : null },
      startDate: b.start_date || null, endDate: b.end_date || null, weekdays: b.weekdays, paymentType: b.payment_type || 'offline', amountPaid: b.amount_paid || 0,
    });
    if (r.error) return fail(res, r.status || 400, r.error, { code: r.code, conflicts: r.conflicts, existing_id: r.existingId });
    res.json({ success: true, subscription_id: r.subscriptionId, reservations: r.reservations, end_date: r.endDate });
  } catch (err) { console.error(err); fail(res, 500, 'Failed to add the member'); }
});

router.post('/owner/subscribers/:id/extend', requireOwner, async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 404, 'Subscription not found');
    const r = await subs.extendManualMember({ ownerId: req.user.id, subscriptionId: Number(req.params.id), months: (req.body || {}).months || 1 });
    if (r.error) return fail(res, r.status || 400, r.error, { conflicts: r.conflicts });
    res.json({ success: true, new_end: r.newEnd, reservations: r.reservations });
  } catch (err) { console.error(err); fail(res, 500, 'Failed to extend the membership'); }
});

async function ownerCancel(req, res) {
  try {
    if (!isId(req.params.id)) return fail(res, 404, 'Subscription not found');
    const b = req.body || {};
    const [[row]] = await pool.query('SELECT s.id, s.source, t.owner_id FROM user_subscriptions s JOIN turfs t ON t.id = s.turf_id WHERE s.id = ?', [req.params.id]);
    if (!row) return fail(res, 404, 'Subscription not found');
    if (Number(row.owner_id) !== Number(req.user.id)) return fail(res, 403, 'Forbidden');
    const reason = b.reason ? String(b.reason).slice(0, 255) : 'Cancelled by the venue';
    // a venue-side problem always refunds in full; otherwise the owner chooses (default full for online, nothing to refund for manual)
    const mode = b.venue_issue ? 'full' : (b.refund_mode || 'full');
    const r = await subs.cancelSubscription({ subscriptionId: row.id, actor: { kind: 'owner', id: req.user.id }, reason, refundMode: mode });
    if (r.error) return fail(res, r.status || 400, r.error);
    res.json({ success: true, message: r.already ? 'This subscription was already closed' : 'Subscription cancelled successfully', released_reservations: r.releasedReservations || 0, refund_minor: r.refundMinor || 0, currency: r.currency });
  } catch (err) { console.error(err); fail(res, 500, 'Failed to cancel subscription'); }
}
router.delete('/owner/subscribers/:id', requireOwner, ownerCancel);
router.post('/owner/subscribers/:id/cancel', requireOwner, ownerCancel);

// =====================================================================================================  CUSTOMER
// GET /api/subscriptions/turf/:id — the price list of a venue (public). Prices/currency are the server's; seats left are live.
router.get('/turf/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.json({ plans: [] });
    const [plans] = await pool.query(
      `SELECT p.*, t.currency_code AS venue_currency, t.timezone AS venue_tz, c.name AS court_name,
         (SELECT COUNT(*) FROM user_subscriptions s WHERE s.plan_id = p.id AND s.status IN ('active','past_due') AND s.expiry_date >= UTC_DATE() - INTERVAL 1 DAY) AS active_count,
         ap.is_enabled AS admin_enabled, ap.price AS admin_price, ap.duration_months AS admin_months
       FROM subscription_plans p JOIN turfs t ON t.id = p.turf_id LEFT JOIN courts c ON c.id = p.court_id LEFT JOIN subscription_admin_plans ap ON ap.id = p.admin_plan_id
       WHERE p.turf_id = ? AND p.is_active = TRUE`, [req.params.id]);
    const out = plans.filter((p) => p.price_source !== 'admin' || p.admin_enabled).map((p) => {
      const price = p.price_source === 'admin' && p.admin_price != null ? Number(p.admin_price) : Number(p.price);
      const months = p.price_source === 'admin' && p.admin_months ? p.admin_months : p.duration_months;
      const { admin_enabled, admin_price, admin_months, owner_id, ...rest } = p;
      return { ...rest, price, duration_months: months, currency_code: p.venue_currency || p.currency_code || 'INR', days_label: daysLabel(p.available_days), seats_left: Math.max(0, Number(p.max_subscribers) - Number(p.active_count)), is_full: Number(p.active_count) >= Number(p.max_subscribers) };
    });
    res.json({ plans: out });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch plans' }); }
});

// GET /api/subscriptions/my-plans — the signed-in customer's subscriptions (never-completed/abandoned purchases are not listed)
router.get('/my-plans', requireCustomer, async (req, res) => {
  try {
    const [rows] = await pool.query(`${SUB_SELECT} WHERE s.user_id = ? AND NOT (s.status IN ('pending','expired','cancelled') AND s.activated_at IS NULL AND s.payment_status <> 'paid') ORDER BY s.created_at DESC`, [req.user.id]);
    res.json({ subscriptions: rows.map((s) => ({ ...s, ...shapeSub(s), start_time: hhmm(s.start_time), end_time: hhmm(s.end_time) })) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch your plans' }); }
});

// POST /api/subscriptions/purchase { subscription_offer_id | plan_id }
router.post('/purchase', requireCustomer, async (req, res) => {
  try {
    const b = req.body || {};
    const planId = b.subscription_offer_id ?? b.plan_id;
    if (!isId(planId)) return fail(res, 400, 'Missing requirements');
    const r = await subs.purchase({ userId: req.user.id, planId: Number(planId) });
    if (r.error) return fail(res, r.status || 400, r.error, { code: r.code });
    if (r.free) {
      if (r.conflict) return fail(res, 409, 'This slot is no longer available.', { code: 'SLOT_UNAVAILABLE' });
      return res.json({ success: true, skipPayment: true, message: 'Subscription successfully activated without payment.', subscription_id: r.subscriptionId });
    }
    res.json({ success: true, order_id: r.orderId, amount: r.amountMinor, currency: r.currency, subscription_id: r.subscriptionId, reused: !!r.reused });
  } catch (err) { console.error(err); fail(res, 500, 'Failed to initiate purchase'); }
});

function signatureOk(orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// POST /api/subscriptions/verify — verify the signature, then activate what THAT ORDER was created for. Calling it twice is harmless.
router.post('/verify', requireCustomer, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return fail(res, 400, 'Missing payment verification fields');
    if (!process.env.RAZORPAY_KEY_SECRET) return fail(res, 503, 'Payments are not configured');
    if (!signatureOk(razorpay_order_id, razorpay_payment_id, razorpay_signature)) return fail(res, 400, 'Invalid payment signature');
    const r = await subs.activateByOrder({ orderId: razorpay_order_id, paymentId: razorpay_payment_id, userId: req.user.id });
    if (r.notFound) return fail(res, 404, 'No subscription purchase found for this payment');
    if (r.forbidden) return fail(res, 403, 'This payment belongs to another account');
    if (r.mismatch) return fail(res, 400, 'Payment amount does not match this subscription');
    if (r.conflict) return res.status(409).json({ success: false, code: 'SLOT_UNAVAILABLE', error: 'Sorry, one of the subscription slots was taken just before your payment completed. Your subscription was not activated and your payment is being refunded.', subscription_id: r.subscriptionId, refunded: !!r.refunded });
    res.json({ success: true, message: 'Subscription activated', subscription_id: r.subscriptionId, activated: r.activated !== false });
  } catch (err) { console.error(err); fail(res, 500, 'Verification failed'); }
});

// The hosted checkout page (Expo Go / web) posts from a plain browser tab with no login: payment is proven by the gateway SIGNATURE alone,
// and the page only ever learns an unguessable order id. Whatever it verifies is what THAT order was created for.
router.post('/hosted/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return fail(res, 400, 'Missing payment verification fields');
    if (!process.env.RAZORPAY_KEY_SECRET) return fail(res, 503, 'Payments are not configured');
    if (!signatureOk(razorpay_order_id, razorpay_payment_id, razorpay_signature)) return fail(res, 400, 'Invalid payment signature');
    const r = await subs.activateByOrder({ orderId: razorpay_order_id, paymentId: razorpay_payment_id });
    if (r.notFound) return fail(res, 404, 'No subscription purchase found for this payment');
    if (r.mismatch) return fail(res, 400, 'Payment amount does not match this subscription');
    if (r.conflict) return res.status(409).json({ success: false, code: 'SLOT_UNAVAILABLE', error: 'A slot was taken just before your payment completed. Your subscription was not activated and your payment is being refunded.' });
    res.json({ success: true, message: 'Subscription activated', subscription_id: r.subscriptionId });
  } catch (err) { console.error(err); fail(res, 500, 'Verification failed'); }
});
router.post('/hosted/cancel', async (req, res) => {
  try {
    const orderId = (req.body || {}).booking_id;
    if (!orderId) return fail(res, 400, 'order id is required');
    const r = await subs.cancelPayment({ userId: null, orderId: String(orderId) });
    if (r.notFound) return fail(res, 404, 'No subscription purchase found for this payment');
    res.json({ success: true });
  } catch (err) { console.error(err); fail(res, 500, 'Could not update the payment'); }
});

// POST /api/subscriptions/cancel-payment { razorpay_order_id } — the customer backed out of checkout / payment failed on the device
router.post('/cancel-payment', requireCustomer, async (req, res) => {
  try {
    const { failed, reason } = req.body || {};
    const razorpay_order_id = (req.body || {}).razorpay_order_id || (req.body || {}).booking_id;
    if (!razorpay_order_id) return fail(res, 400, 'razorpay_order_id is required');
    const r = failed
      ? await (async () => { const [[o]] = await pool.query('SELECT us.user_id FROM subscription_payments sp JOIN user_subscriptions us ON us.id = sp.subscription_id WHERE sp.gateway_order_id = ?', [razorpay_order_id]); if (!o) return { notFound: true }; if (Number(o.user_id) !== Number(req.user.id)) return { forbidden: true }; return subs.reportPaymentFailed({ orderId: razorpay_order_id, reason: reason || 'payment failed' }); })()
      : await subs.cancelPayment({ userId: req.user.id, orderId: razorpay_order_id });
    if (r.notFound) return fail(res, 404, 'No subscription purchase found for this payment');
    if (r.forbidden) return fail(res, 403, 'This payment belongs to another account');
    res.json({ success: true });
  } catch (err) { console.error(err); fail(res, 500, 'Could not update the payment'); }
});

// POST /api/subscriptions/:id/renew — start a renewal payment for the customer's OWN subscription
router.post('/:id/renew', requireCustomer, async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 404, 'Subscription not found');
    const r = await subs.renewalOrder({ userId: req.user.id, subscriptionId: Number(req.params.id) });
    if (r.error) return fail(res, r.status || 400, r.error);
    res.json({ success: true, order_id: r.orderId, amount: r.amountMinor, currency: r.currency, subscription_id: r.subscriptionId, reused: !!r.reused });
  } catch (err) { console.error(err); fail(res, 500, 'Failed to start the renewal'); }
});

// POST /api/subscriptions/:id/cancel — customers cannot cancel; the venue handles it (current policy). Foreign ids are still 403.
router.post('/:id/cancel', requireCustomer, async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 404, 'Subscription not found');
    const [[s]] = await pool.query('SELECT id, user_id FROM user_subscriptions WHERE id = ?', [req.params.id]);
    if (!s) return fail(res, 404, 'Subscription not found');
    if (Number(s.user_id) !== Number(req.user.id)) return fail(res, 403, 'Forbidden');
    res.status(403).json({ success: false, error: CANCEL_MESSAGE, code: 'CANCEL_VIA_VENUE' });
  } catch (err) { console.error(err); fail(res, 500, 'Failed'); }
});

// GET /api/subscriptions/:id — one subscription: the customer who owns it, the venue's owner, or an admin. Others get 403.
// Declared last so it never shadows /my-plans etc.
router.get('/:id', verifyToken, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Subscription not found' });
    const [[s]] = await pool.query(`${SUB_SELECT.replace('t.name AS turf_name,', 't.name AS turf_name, t.location AS turf_location,')} WHERE s.id = ?`, [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Subscription not found' });
    const role = req.user.role || 'user';
    const allowed = (role === 'user' && Number(s.user_id) === Number(req.user.id)) || (role === 'owner' && Number(s.venue_owner_id) === Number(req.user.id)) || role === 'admin';
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });
    const [resv] = await pool.query("SELECT reservation_date, start_time, end_time, status FROM subscription_reservations WHERE subscription_id = ? ORDER BY reservation_date LIMIT 400", [s.id]);
    const today = todayIn(s.venue_tz || 'Asia/Kolkata');
    const upcoming = resv.filter((r) => r.status === 'active' && R.ymdOf(r.reservation_date) >= today).slice(0, 12).map((r) => ({ date: r.reservation_date, start_time: hhmm(r.start_time), end_time: hhmm(r.end_time) }));
    const extra = { turf_location: s.turf_location, upcoming_sessions: upcoming, reserved_sessions: resv.filter((r) => r.status === 'active').length };
    if (role !== 'user') {
      const [pays] = await pool.query('SELECT id, kind, status, amount_minor, currency_code, created_at, paid_at FROM subscription_payments WHERE subscription_id = ? ORDER BY id DESC', [s.id]);
      extra.payments = pays;
    }
    res.json({ subscription: { ...shapeSub(s, extra), selected_slot: s.selected_slot, selected_days: s.selected_days, price: s.plan_price, duration_months: s.months_total } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load the subscription' }); }
});

module.exports = router;
module.exports.CANCEL_MESSAGE = CANCEL_MESSAGE;
