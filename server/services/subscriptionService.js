// Customer sport/activity subscriptions (subscription_plans = the owner's OFFER, user_subscriptions = a customer's SUBSCRIPTION).
//
//   purchase  -> server prices it from the plan -> gateway order + a PENDING subscription + a payment attempt record. Nothing is
//                reserved and nothing is active.
//   activate  -> ONLY from a verified payment (signature on /verify, or the gateway webhook). One DB transaction, serialised per
//                venue: re-check capacity -> create the subscription period -> create EVERY reservation -> commit. If a seat is no
//                longer free, nothing is created and the payment is refunded through the refund ledger.
//   renew     -> a new verified payment extends the SAME subscription by calendar months; failure never extends it.
//   expire    -> backend sweep; future reservations are released, history is kept.
//   cancel    -> venue owner or admin only (customers cannot cancel; the venue handles it). Releases future reservations, refunds
//                server-side.
//
// Money: the price is the plan's (admin-controlled when the plan is linked to an admin plan), in the VENUE's currency, in minor
// units. Dates: calendar months anchored to the start date, in the VENUE's timezone.
const crypto = require('crypto');
const pool = require('../config/db');
const Razorpay = require('razorpay');
const T = require('../utils/notifications/time');
const { fire } = require('../utils/notifications/events');
const { zonedEpoch, todayIn } = require('../utils/timezone');
const { toMinor, fromMinor } = require('../utils/money');
const globalConfig = require('./globalConfig');
const refunds = require('./refunds');
const R = require('./subscriptionReservations');

let rz = null;
const gateway = () => (rz || (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET ? (rz = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })) : null));

const ACTIVE_LIKE = ['active', 'past_due'];

// ------------------------------------------------------------------------------------------------ small helpers
async function audit({ subscriptionId = null, venueId = null, actorId = null, actorRole = 'system', action, reason = null, details = null }, conn = pool) {
  try { await conn.query('INSERT INTO subscription_audit_log (subscription_id, venue_id, actor_id, actor_role, action, reason, details) VALUES (?, ?, ?, ?, ?, ?, ?)', [subscriptionId, venueId, actorId, actorRole, action, reason ? String(reason).slice(0, 255) : null, details ? JSON.stringify(details) : null]); }
  catch (e) { console.error('subscription audit failed:', e.message); }
}

const hhmm = (t) => String(t || '').slice(0, 5);
const hms = (t) => (hhmm(t).length === 5 ? `${hhmm(t)}:00` : null);

function planMonths(plan) {
  const m = Number(plan.duration_months);
  if (Number.isFinite(m) && m >= 1) return Math.round(m);
  const d = Number(plan.duration_days);
  return Number.isFinite(d) && d > 0 ? Math.max(1, Math.round(d / 30)) : 1;
}

async function getPlan(planId) {
  const [[p]] = await pool.query(
    `SELECT p.*, t.owner_id AS venue_owner_id, t.name AS venue_name, t.sport_type, t.country_code, t.currency_code AS venue_currency, t.timezone AS venue_tz, t.is_active AS venue_active,
            ap.is_enabled AS admin_enabled, ap.price AS admin_price, ap.duration_months AS admin_months
     FROM subscription_plans p LEFT JOIN turfs t ON t.id = p.turf_id LEFT JOIN subscription_admin_plans ap ON ap.id = p.admin_plan_id WHERE p.id = ?`, [planId]);
  if (!p) return null;
  if (p.price_source === 'admin' && p.admin_price != null) {
    // the admin controls price and duration of an admin-linked plan; a disabled admin plan can no longer be sold
    p.price = Number(p.admin_price); p.duration_months = p.admin_months;
    if (!p.admin_enabled) p.is_active = 0;
  }
  return p;
}
const planCurrency = (p) => p.venue_currency || p.currency_code || 'INR';
const planTz = (p) => p.venue_tz || 'Asia/Kolkata';

async function lockTurf(conn, turfId) { await conn.query('SELECT id FROM turfs WHERE id = ? FOR UPDATE', [turfId]); }

/** Display status derived by the BACKEND from status + dates (an app never decides "Active" itself). */
function displayStatus(row, today) {
  const s = row.status;
  if (s === 'active' || s === 'past_due') return R.ymdOf(row.expiry_date) >= today ? s.toUpperCase() : 'EXPIRED';
  if (s === 'pending') return row.payment_status === 'failed' ? 'PAYMENT_FAILED' : 'PENDING_PAYMENT';
  if (s === 'expired' && row.payment_status === 'failed') return 'PAYMENT_FAILED';
  if (s === 'cancelled' && row.cancel_reason === 'payment_cancelled') return 'PAYMENT_CANCELLED';
  return String(s).toUpperCase();
}

// ------------------------------------------------------------------------------------------------ capacity / conflicts
/**
 * Look at every occurrence date and decide, for ONE slot (court + start..end): is it free for another subscriber?
 * Reads normal bookings, owner blocks and other subscriptions' live reservations. Runs on the caller's connection so it sees the
 * transaction (and the venue lock) it is part of. Returns { conflicts:[{date,reason}], seats: Map(date -> seat_no) }.
 */
async function checkSlot(conn, { turfId, courtId, dates, start, end, capacity, excludeSubId = null }) {
  const conflicts = []; const seats = new Map();
  if (!dates.length) return { conflicts, seats };
  const s = R.toMinutes(start); const e = R.toMinutes(end);
  const ph = dates.map(() => '?').join(',');

  const [bk] = await conn.query(
    `SELECT booking_date, time_slot FROM bookings WHERE turf_id = ? AND booking_date IN (${ph})
       AND ((payment_status = 'success' AND status != 'cancelled') OR (payment_status = 'pending' AND status = 'pending' AND created_at > NOW() - INTERVAL 4 MINUTE))
       ${courtId ? 'AND (court_id IS NULL OR court_id = ?)' : ''} FOR UPDATE`, [turfId, ...dates, ...(courtId ? [courtId] : [])]);
  for (const b of bk) {
    const sl = T.parseSlot(b.time_slot); if (!sl) continue;
    const bs = R.toMinutes(sl.start); const be = sl.end ? R.toMinutes(sl.end) : bs + 60;
    if (R.overlaps(s, e, bs, be)) conflicts.push({ date: R.ymdOf(b.booking_date), reason: 'booked' });
  }

  let blocked = [];
  try { [blocked] = await conn.query(`SELECT block_date, time_slot, court_id FROM blocked_slots WHERE turf_id = ? AND block_date IN (${ph}) FOR UPDATE`, [turfId, ...dates]); }
  catch (err) { [blocked] = await conn.query(`SELECT block_date, time_slot FROM blocked_slots WHERE turf_id = ? AND block_date IN (${ph}) FOR UPDATE`, [turfId, ...dates]); }
  for (const b of blocked) {
    const applies = courtId ? (b.court_id == null || Number(b.court_id) === Number(courtId)) : b.court_id == null;
    if (!applies) continue;
    const sl = T.parseSlot(b.time_slot); if (!sl) continue;
    const bs = R.toMinutes(sl.start); const be = sl.end ? R.toMinutes(sl.end) : bs + 60;
    if (R.overlaps(s, e, bs, be)) conflicts.push({ date: R.ymdOf(b.block_date), reason: 'blocked' });
  }

  const [rs] = await conn.query(
    `SELECT reservation_date, start_time, end_time, seat_no FROM subscription_reservations
     WHERE turf_id = ? AND court_key = ? AND reservation_date IN (${ph}) AND status = 'active' AND active_key = 1${excludeSubId ? ' AND subscription_id <> ?' : ''} FOR UPDATE`,
    [turfId, courtId ? Number(courtId) : 0, ...dates, ...(excludeSubId ? [excludeSubId] : [])]);
  const used = new Map(); const bad = new Set();
  for (const r of rs) {
    const d = R.ymdOf(r.reservation_date);
    const rs0 = R.toMinutes(r.start_time); const re0 = R.toMinutes(r.end_time);
    if (rs0 === s && re0 === e) { if (!used.has(d)) used.set(d, new Set()); used.get(d).add(Number(r.seat_no)); }
    else if (R.overlaps(s, e, rs0, re0)) bad.add(d);
  }
  for (const d of bad) conflicts.push({ date: d, reason: 'subscription' });
  const cap = Math.max(1, Number(capacity) || 1);
  for (const d of dates) {
    const taken = used.get(d) || new Set();
    let seat = null; for (let i = 1; i <= cap; i++) if (!taken.has(i)) { seat = i; break; }
    if (seat == null) conflicts.push({ date: d, reason: 'full' }); else seats.set(d, seat);
  }
  return { conflicts, seats };
}

/** The dates a period reserves: weekday occurrences in [start, endExclusive), skipping ones whose slot already ended (venue time). */
function periodDates({ start, endExclusive, weekdaysSet, slotEnd, tz, now = Date.now() }) {
  return R.occurrencesBetween(start, endExclusive, weekdaysSet).filter((d) => zonedEpoch(d, slotEnd, tz) > now);
}

async function insertReservations(conn, { subscriptionId, turfId, courtId, dates, seats, start, end }) {
  if (!dates.length) return 0;
  const rows = dates.map((d) => [subscriptionId, turfId, courtId ? Number(courtId) : 0, courtId || null, d, hms(start), hms(end), seats.get(d) || 1, 'active', 1]);
  await conn.query('INSERT INTO subscription_reservations (subscription_id, turf_id, court_key, court_id, reservation_date, start_time, end_time, seat_no, status, active_key) VALUES ?', [rows]);
  return rows.length;
}

/** Free every FUTURE reservation of a subscription (history stays). `status`: cancelled | expired. */
async function releaseFuture(subscriptionId, status = 'cancelled', tz = 'Asia/Kolkata', conn = pool) {
  const today = todayIn(tz);
  const [r] = await conn.query("UPDATE subscription_reservations SET status = ?, active_key = NULL WHERE subscription_id = ? AND status = 'active' AND reservation_date >= ?", [status, subscriptionId, today]);
  return r.affectedRows;
}

// ------------------------------------------------------------------------------------------------ purchase
async function purchase({ userId, planId, now = Date.now() }) {
  const plan = await getPlan(planId);
  if (!plan || !plan.is_active || !plan.turf_id || plan.venue_active === 0) return { error: 'Plan not found', status: 404 };
  const currency = planCurrency(plan); const tz = planTz(plan);
  const set = R.parseWeekdays(plan.available_days);
  if (set === undefined) return { error: 'This plan has an invalid schedule. Contact the venue.', status: 409 };

  // already subscribed to this slot? (never charge twice for the same thing)
  const [dup] = await pool.query(
    `SELECT id FROM user_subscriptions WHERE user_id = ? AND turf_id = ? AND COALESCE(court_id,0) = ? AND status IN ('active','past_due') AND expiry_date >= ? AND start_time = ? AND end_time = ?`,
    [userId, plan.turf_id, plan.court_id || 0, todayIn(tz, now), hms(plan.start_time), hms(plan.end_time)]);
  if (dup.length) return { error: 'You already have an active subscription for this schedule.', status: 409, code: 'DUPLICATE_SUBSCRIPTION' };

  const [[cap]] = await pool.query("SELECT COUNT(*) AS c FROM user_subscriptions WHERE plan_id = ? AND status IN ('active','past_due') AND expiry_date >= ?", [plan.id, todayIn(tz, now)]);
  if (Number(cap.c) >= Math.max(1, Number(plan.max_subscribers) || 1)) return { error: 'This plan is full.', status: 409, code: 'PLAN_FULL' };

  const price = Number(plan.price);
  const amountMinor = price > 0 ? toMinor(price, currency) : 0;
  if (amountMinor > 0 && !(await globalConfig.paymentsEnabledFor(plan.country_code || 'IN', currency))) return { error: `Online payments in ${currency} are not available for this venue yet.`, status: 400 };

  // double-click / retry: reuse the pending purchase that is still fresh
  const [fresh] = await pool.query(
    `SELECT us.id AS subscription_id, sp.gateway_order_id, sp.amount_minor, sp.currency_code FROM user_subscriptions us JOIN subscription_payments sp ON sp.subscription_id = us.id
     WHERE us.user_id = ? AND us.plan_id = ? AND us.status = 'pending' AND sp.kind = 'purchase' AND sp.status = 'created' AND sp.gateway_order_id IS NOT NULL AND sp.created_at > NOW() - INTERVAL 15 MINUTE
     ORDER BY sp.id DESC LIMIT 1`, [userId, plan.id]);
  if (fresh.length && amountMinor > 0) return { reused: true, subscriptionId: fresh[0].subscription_id, orderId: fresh[0].gateway_order_id, amountMinor: Number(fresh[0].amount_minor), currency: fresh[0].currency_code };

  const months = planMonths(plan);
  const start = todayIn(tz, now);
  const [ins] = await pool.query(
    `INSERT INTO user_subscriptions (user_id, plan_id, turf_id, court_id, start_date, expiry_date, status, payment_status, currency_code, amount_due_minor, source, payment_type, weekdays, start_time, end_time, period_months)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, 'online', 'online', ?, ?, ?, ?)`,
    [userId, plan.id, plan.turf_id, plan.court_id || null, start, R.addDays(R.addMonthsClamped(start, months), -1), currency, amountMinor, R.weekdaysCsv(set), hms(plan.start_time), hms(plan.end_time), months]).catch(async (e) => {
    if (!/Unknown column 'period_months'/.test(e.message)) throw e;
    return pool.query(
      `INSERT INTO user_subscriptions (user_id, plan_id, turf_id, court_id, start_date, expiry_date, status, payment_status, currency_code, amount_due_minor, source, payment_type, weekdays, start_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, 'online', 'online', ?, ?, ?)`,
      [userId, plan.id, plan.turf_id, plan.court_id || null, start, R.addDays(R.addMonthsClamped(start, months), -1), currency, amountMinor, R.weekdaysCsv(set), hms(plan.start_time), hms(plan.end_time)]);
  });
  const subscriptionId = ins.insertId;
  await audit({ subscriptionId, venueId: plan.turf_id, actorId: userId, actorRole: 'user', action: 'SUBSCRIPTION_CREATED', details: { planId: plan.id, amountMinor, currency } });

  if (amountMinor === 0) {
    const [pay] = await pool.query("INSERT INTO subscription_payments (subscription_id, kind, amount_minor, currency_code, period_months, status) VALUES (?, 'purchase', 0, ?, ?, 'created')", [subscriptionId, currency, months]);
    const r = await activate({ paymentRecordId: pay.insertId, free: true, userId, now });
    return { free: true, subscriptionId, ...r };
  }

  const g = gateway();
  if (!g) return { error: 'Payments are not configured', status: 503 };
  const order = await g.orders.create({ amount: amountMinor, currency, receipt: `sub_${subscriptionId}_${Date.now()}`.slice(0, 40), notes: { kind: 'subscription', subscription_id: String(subscriptionId), plan_id: String(plan.id) } });
  await pool.query("INSERT INTO subscription_payments (subscription_id, kind, gateway_order_id, amount_minor, currency_code, period_months, status) VALUES (?, 'purchase', ?, ?, ?, ?, 'created')", [subscriptionId, order.id, amountMinor, currency, months]);
  await pool.query('UPDATE user_subscriptions SET razorpay_order_id = ? WHERE id = ?', [order.id, subscriptionId]).catch(() => {}); // legacy column (UNIQUE): the attempt table is the source of truth
  await audit({ subscriptionId, venueId: plan.turf_id, actorId: userId, actorRole: 'user', action: 'SUBSCRIPTION_PAYMENT_CREATED', details: { orderId: order.id, amountMinor, currency } });
  return { subscriptionId, orderId: order.id, amountMinor, currency };
}

/** Customer-requested renewal of THEIR subscription: a new verified payment extends it. */
async function renewalOrder({ userId, subscriptionId, now = Date.now() }) {
  const [[s]] = await pool.query('SELECT us.*, p.price, p.duration_months, p.duration_days, p.is_active AS plan_active, p.turf_id AS plan_turf FROM user_subscriptions us JOIN subscription_plans p ON p.id = us.plan_id WHERE us.id = ?', [subscriptionId]);
  if (!s) return { error: 'Subscription not found', status: 404 };
  if (Number(s.user_id) !== Number(userId)) return { error: 'Forbidden', status: 403 };
  if (!['active', 'past_due', 'expired'].includes(s.status) || s.source !== 'online') return { error: 'This subscription cannot be renewed online.', status: 409 };
  const plan = await getPlan(s.plan_id);
  if (!plan || !plan.is_active) return { error: 'This plan is no longer offered. Contact the venue.', status: 409 };
  const currency = planCurrency(plan); const price = Number(plan.price);
  const amountMinor = toMinor(price, currency);
  if (!(amountMinor > 0)) return { error: 'This plan is free; there is nothing to renew.', status: 409 };
  if (!(await globalConfig.paymentsEnabledFor(plan.country_code || 'IN', currency))) return { error: `Online payments in ${currency} are not available for this venue yet.`, status: 400 };
  const months = planMonths(plan);
  const [fresh] = await pool.query("SELECT gateway_order_id, amount_minor, currency_code FROM subscription_payments WHERE subscription_id = ? AND kind = 'renewal' AND status = 'created' AND gateway_order_id IS NOT NULL AND created_at > NOW() - INTERVAL 15 MINUTE ORDER BY id DESC LIMIT 1", [s.id]);
  if (fresh.length) return { reused: true, subscriptionId: s.id, orderId: fresh[0].gateway_order_id, amountMinor: Number(fresh[0].amount_minor), currency: fresh[0].currency_code };
  const g = gateway();
  if (!g) return { error: 'Payments are not configured', status: 503 };
  const order = await g.orders.create({ amount: amountMinor, currency, receipt: `rnw_${s.id}_${Date.now()}`.slice(0, 40), notes: { kind: 'subscription_renewal', subscription_id: String(s.id) } });
  await pool.query("INSERT INTO subscription_payments (subscription_id, kind, gateway_order_id, amount_minor, currency_code, period_months, status) VALUES (?, 'renewal', ?, ?, ?, ?, 'created')", [s.id, order.id, amountMinor, currency, months]);
  await audit({ subscriptionId: s.id, venueId: s.turf_id, actorId: userId, actorRole: 'user', action: 'SUBSCRIPTION_PAYMENT_CREATED', details: { kind: 'renewal', orderId: order.id, amountMinor, currency } });
  return { subscriptionId: s.id, orderId: order.id, amountMinor, currency };
}

// ------------------------------------------------------------------------------------------------ activation (the only way a subscription becomes ACTIVE online)
/**
 * A verified payment arrived (client /verify with a valid signature, or the gateway webhook). Idempotent and race-safe.
 * Resolves the payment attempt by order id, so the plan, customer, amount and currency are OUR records, never the request's.
 * @returns {Promise<{subscriptionId, activated, conflict?, refunded?, notFound?, forbidden?, mismatch?}>}
 */
async function activateByOrder({ orderId, paymentId, userId = null, amountMinor = null, currency = null, now = Date.now() }) {
  let [[pay]] = await pool.query('SELECT * FROM subscription_payments WHERE gateway_order_id = ?', [orderId]);
  if (!pay) {
    // a purchase created before the attempt table existed: adopt it
    const [[legacy]] = await pool.query('SELECT us.id, us.plan_id, p.price, p.duration_months, p.duration_days FROM user_subscriptions us JOIN subscription_plans p ON p.id = us.plan_id WHERE us.razorpay_order_id = ?', [orderId]);
    if (!legacy) return { notFound: true };
    const plan = await getPlan(legacy.plan_id);
    const cur = planCurrency(plan);
    await pool.query("INSERT IGNORE INTO subscription_payments (subscription_id, kind, gateway_order_id, amount_minor, currency_code, period_months, status) VALUES (?, 'purchase', ?, ?, ?, ?, 'created')", [legacy.id, orderId, toMinor(legacy.price, cur), cur, planMonths(plan)]);
    [[pay]] = await pool.query('SELECT * FROM subscription_payments WHERE gateway_order_id = ?', [orderId]);
  }
  return activate({ paymentRecordId: pay.id, paymentId, userId, amountMinor, currency, now });
}

async function activate({ paymentRecordId, paymentId = null, userId = null, amountMinor = null, currency = null, free = false, now = Date.now(), forceConflict = false }) {
  const conn = await pool.getConnection();
  let outcome; let post = null;
  try {
    await conn.beginTransaction();
    const [[pay0]] = await conn.query('SELECT subscription_id FROM subscription_payments WHERE id = ?', [paymentRecordId]);
    const [[sub0]] = await conn.query('SELECT turf_id FROM user_subscriptions WHERE id = ?', [pay0.subscription_id]);
    await lockTurf(conn, sub0.turf_id);                                    // serialise every subscription / manual activation on this venue
    const [[pay]] = await conn.query('SELECT * FROM subscription_payments WHERE id = ? FOR UPDATE', [paymentRecordId]);
    const [[sub]] = await conn.query('SELECT * FROM user_subscriptions WHERE id = ? FOR UPDATE', [pay.subscription_id]);
    if (userId !== null && Number(sub.user_id) !== Number(userId)) { await conn.rollback(); return { forbidden: true, subscriptionId: sub.id }; }
    if (pay.status === 'success') { await conn.rollback(); return { subscriptionId: sub.id, activated: false }; }            // duplicate verify / webhook
    if (amountMinor != null && Number(amountMinor) !== Number(pay.amount_minor)) { await conn.rollback(); await audit({ subscriptionId: sub.id, venueId: sub.turf_id, action: 'SUBSCRIPTION_PAYMENT_FAILED', reason: 'amount mismatch', details: { expected: Number(pay.amount_minor), got: Number(amountMinor) } }); return { subscriptionId: sub.id, activated: false, mismatch: true }; }
    if (currency && String(currency).toUpperCase() !== pay.currency_code) { await conn.rollback(); return { subscriptionId: sub.id, activated: false, mismatch: true }; }

    const plan = await getPlan(sub.plan_id);
    const tz = planTz(plan);
    const today = todayIn(tz, now);
    const set = R.parseWeekdays(sub.weekdays);
    const start = hhmm(sub.start_time); const end = hhmm(sub.end_time);
    const capacity = Math.max(1, Number(plan.max_subscribers) || 1);
    const renewal = pay.kind === 'renewal';

    // which statuses may a verified payment bring to life?
    const okStatus = renewal ? ['active', 'past_due', 'expired'] : ['pending', 'expired'];
    const revivable = okStatus.includes(sub.status) || (sub.status === 'cancelled' && sub.cancel_reason === 'payment_cancelled');

    let periodStart; let periodEnd; let monthsTotal;
    if (!renewal) {
      periodStart = today; monthsTotal = pay.period_months; periodEnd = R.addMonthsClamped(periodStart, monthsTotal);
    } else {
      const stillRunning = ['active', 'past_due'].includes(sub.status) && R.ymdOf(sub.current_period_end || sub.expiry_date) > today;
      periodStart = stillRunning ? R.ymdOf(sub.current_period_end) : today;
      const anchor = sub.subscription_start_date ? R.ymdOf(sub.subscription_start_date) : periodStart;
      monthsTotal = stillRunning ? Number(sub.months_total) + pay.period_months : pay.period_months;
      if (!stillRunning) { periodEnd = R.addMonthsClamped(periodStart, pay.period_months); }
      else periodEnd = R.addMonthsClamped(anchor, monthsTotal);
    }

    let conflicts = [];
    let seats = new Map(); let dates = [];
    if (revivable && !forceConflict) {
      dates = periodDates({ start: periodStart, endExclusive: periodEnd, weekdaysSet: set, slotEnd: end, tz, now });
      ({ conflicts, seats } = await checkSlot(conn, { turfId: sub.turf_id, courtId: sub.court_id, dates, start, end, capacity, excludeSubId: renewal ? sub.id : null }));
    }

    if (!revivable || conflicts.length || forceConflict) {
      // money was taken but the subscription cannot be given: record the payment, change nothing else, refund it
      await conn.query("UPDATE subscription_payments SET status = 'success', gateway_payment_id = ?, paid_at = NOW() WHERE id = ?", [paymentId, pay.id]);
      let upd = null;
      if (!renewal && revivable) { await conn.query("UPDATE user_subscriptions SET status = 'cancelled', payment_status = 'paid', razorpay_payment_id = ?, cancelled_at = NOW(), cancelled_by = 'system', cancel_reason = 'slot_conflict' WHERE id = ?", [paymentId, sub.id]); upd = 'cancelled'; }
      const reason = !revivable ? 'subscription_not_payable' : 'slot_conflict';
      const refund = await refunds.createRecord(conn, {
        bookingType: 'subscription', bookingId: sub.id, paymentId: paymentId || '', userId: sub.user_id, ownerId: plan.venue_owner_id, venueId: sub.turf_id, venueName: plan.venue_name, countryCode: plan.country_code,
        businessType: 'SPORTS', originalAmountMinor: Number(pay.amount_minor), amountPaidMinor: Number(pay.amount_minor), cancellationFeeMinor: 0, refundAmountMinor: free ? 0 : Number(pay.amount_minor),
        currency: pay.currency_code, reason, cancelledBy: 'system', cancellationType: 'subscription_conflict', policy: null,
      });
      await conn.commit();
      post = { refund: refund.refund, upd };
      outcome = { subscriptionId: sub.id, activated: false, conflict: true, conflicts: conflicts.slice(0, 20), refunded: !free };
      await audit({ subscriptionId: sub.id, venueId: sub.turf_id, action: 'SUBSCRIPTION_PAYMENT_SUCCESS', reason: 'payment verified but subscription could not be activated: ' + reason, details: { conflicts: conflicts.slice(0, 5) } });
    } else {
      await conn.query("UPDATE subscription_payments SET status = 'success', gateway_payment_id = ?, paid_at = NOW() WHERE id = ?", [paymentId, pay.id]);
      await insertReservations(conn, { subscriptionId: sub.id, turfId: sub.turf_id, courtId: sub.court_id, dates, seats, start, end });
      const lastDay = R.addDays(periodEnd, -1);
      await conn.query(
        `UPDATE user_subscriptions SET status = 'active', payment_status = 'paid', razorpay_payment_id = ?, start_date = ?, expiry_date = ?,
           subscription_start_date = COALESCE(subscription_start_date, ?), current_period_start = ?, current_period_end = ?, next_billing_date = ?, months_total = ?,
           amount_paid_minor = amount_paid_minor + ?, activated_at = COALESCE(activated_at, NOW()), cancel_reason = NULL, cancelled_at = NULL, cancelled_by = NULL
         WHERE id = ?`,
        [paymentId, periodStart, lastDay, periodStart, periodStart, periodEnd, periodEnd, monthsTotal, Number(pay.amount_minor), sub.id]);
      await conn.commit();
      outcome = { subscriptionId: sub.id, activated: true, reservations: dates.length, renewal };
      post = { activated: true, renewal };
      await audit({ subscriptionId: sub.id, venueId: sub.turf_id, actorId: sub.user_id, actorRole: 'system', action: 'SUBSCRIPTION_PAYMENT_SUCCESS', details: { paymentId, amountMinor: Number(pay.amount_minor), currency: pay.currency_code } });
      await audit({ subscriptionId: sub.id, venueId: sub.turf_id, actorRole: 'system', action: renewal ? 'SUBSCRIPTION_RENEWED' : 'SUBSCRIPTION_ACTIVATED', details: { periodStart, periodEnd, reservations: dates.length } });
    }
  } catch (e) {
    try { await conn.rollback(); } catch (x) { /* already rolled back */ }
    if (e && e.code === 'ER_DUP_ENTRY') {
      // two writers reached the same seat or payment id: the database refused, nothing was created
      if (/uniq_subpay_payment|uniq_sub_payment/.test(e.message)) return { activated: false, duplicate: true };
      // the unique seat key refused a second reservation: the customer HAS paid, so settle it exactly like any other conflict (record + refund)
      return activate({ paymentRecordId, paymentId, userId, amountMinor, currency, free, now, forceConflict: true });
    }
    throw e;
  } finally { conn.release(); }

  if (post && post.activated) fire('subscription.activated', { subscriptionId: outcome.subscriptionId, renewal: !!post.renewal });
  if (post && post.refund && Number(post.refund.refund_amount_minor) > 0 && post.refund.refund_status === refunds.S.PENDING) {
    await audit({ subscriptionId: outcome.subscriptionId, action: 'SUBSCRIPTION_REFUND_INITIATED', reason: 'could not activate', details: { refundCode: post.refund.refund_code } });
    await refunds.initiate(post.refund.id).catch((e) => console.error('subscription refund initiate failed:', e.message));
    fire('subscription.payment_failed', { subscriptionId: outcome.subscriptionId, paymentId: paymentId || null, reason: 'slot_conflict' });
  }
  return outcome;
}

// ------------------------------------------------------------------------------------------------ payment failed / cancelled
async function reportPaymentFailed({ orderId, paymentId = null, reason = null }) {
  const [[pay]] = await pool.query('SELECT * FROM subscription_payments WHERE gateway_order_id = ?', [orderId]);
  if (!pay) {
    const [[row]] = await pool.query('SELECT id, payment_status FROM user_subscriptions WHERE razorpay_order_id = ?', [orderId]);
    if (!row || row.payment_status === 'paid') return { notFound: !row };
    fire('subscription.payment_failed', { subscriptionId: row.id, paymentId });
    return { subscriptionId: row.id };
  }
  if (pay.status === 'success') return { subscriptionId: pay.subscription_id };
  await pool.query("UPDATE subscription_payments SET status = 'failed', failure_reason = ? WHERE id = ? AND status IN ('created','failed')", [reason ? String(reason).slice(0, 255) : null, pay.id]);
  const [[sub]] = await pool.query('SELECT * FROM user_subscriptions WHERE id = ?', [pay.subscription_id]);
  if (pay.kind === 'renewal') {
    // a failed renewal NEVER extends the period; the subscription simply runs out at its paid end date
    if (sub.status === 'active') await pool.query("UPDATE user_subscriptions SET status = 'past_due' WHERE id = ? AND status = 'active'", [sub.id]);
    fire('subscription.renewal_failed', { subscriptionId: sub.id, paymentId });
  } else {
    await pool.query("UPDATE user_subscriptions SET payment_status = 'failed' WHERE id = ? AND status = 'pending'", [sub.id]);
    fire('subscription.payment_failed', { subscriptionId: sub.id, paymentId });
  }
  await audit({ subscriptionId: sub.id, venueId: sub.turf_id, actorRole: 'system', action: 'SUBSCRIPTION_PAYMENT_FAILED', reason, details: { orderId, paymentId, kind: pay.kind } });
  return { subscriptionId: sub.id, failed: true };
}

/** The customer closed / backed out of checkout. Nothing is reserved or active; the attempt is kept for audit. */
async function cancelPayment({ userId, orderId }) {
  const [[pay]] = await pool.query('SELECT sp.*, us.user_id, us.turf_id, us.status AS sub_status FROM subscription_payments sp JOIN user_subscriptions us ON us.id = sp.subscription_id WHERE sp.gateway_order_id = ?', [orderId]);
  if (!pay) return { notFound: true };
  if (userId !== null && Number(pay.user_id) !== Number(userId)) return { forbidden: true };
  if (pay.status !== 'created') return { subscriptionId: pay.subscription_id, changed: false };
  await pool.query("UPDATE subscription_payments SET status = 'cancelled' WHERE id = ? AND status = 'created'", [pay.id]);
  if (pay.kind === 'purchase') await pool.query("UPDATE user_subscriptions SET status = 'cancelled', payment_status = 'failed', cancelled_at = NOW(), cancelled_by = 'user', cancelled_by_id = ?, cancel_reason = 'payment_cancelled' WHERE id = ? AND status = 'pending'", [userId || pay.user_id, pay.subscription_id]);
  await audit({ subscriptionId: pay.subscription_id, venueId: pay.turf_id, actorId: userId || pay.user_id, actorRole: 'user', action: 'SUBSCRIPTION_PAYMENT_FAILED', reason: 'payment cancelled by the customer', details: { orderId } });
  return { subscriptionId: pay.subscription_id, changed: true };
}

// ------------------------------------------------------------------------------------------------ cancellation (owner / admin only)
const REFUND_MODES = ['full', 'prorata', 'none'];

async function cancelSubscription({ subscriptionId, actor, reason, refundMode = 'full', now = Date.now() }) {
  if (!REFUND_MODES.includes(refundMode)) return { error: 'refund_mode must be full, prorata or none', status: 400 };
  const [[sub0]] = await pool.query('SELECT id, turf_id FROM user_subscriptions WHERE id = ?', [subscriptionId]);
  if (!sub0) return { error: 'Subscription not found', status: 404 };
  const conn = await pool.getConnection();
  let result; let refundRow = null;
  try {
    await conn.beginTransaction();
    await lockTurf(conn, sub0.turf_id);
    const [[sub]] = await conn.query('SELECT * FROM user_subscriptions WHERE id = ? FOR UPDATE', [subscriptionId]);
    const plan = await getPlan(sub.plan_id);
    if (actor.kind === 'owner' && Number(plan.venue_owner_id) !== Number(actor.id)) { await conn.rollback(); return { error: 'Forbidden', status: 403 }; }
    if (!['active', 'past_due', 'pending', 'suspended'].includes(sub.status)) { await conn.rollback(); return { status: 200, already: true, subscriptionId: sub.id, subscriptionStatus: sub.status }; }
    const tz = planTz(plan); const today = todayIn(tz, now);

    // refund the LATEST successful payment (the period being cancelled), never more than it was
    let refundMinor = 0; let payment = null;
    if (sub.source === 'online' && refundMode !== 'none') {
      const [[p]] = await conn.query("SELECT * FROM subscription_payments WHERE subscription_id = ? AND status = 'success' AND gateway_payment_id IS NOT NULL ORDER BY id DESC LIMIT 1", [sub.id]);
      payment = p || null;
      if (payment && Number(payment.amount_minor) > 0) {
        if (refundMode === 'full') refundMinor = Number(payment.amount_minor);
        else {
          const ps = R.ymdOf(sub.current_period_start || sub.start_date); const pe = R.ymdOf(sub.current_period_end || R.addDays(sub.expiry_date, 1));
          const set = R.parseWeekdays(sub.weekdays);
          const total = R.occurrencesBetween(ps, pe, set).length;
          const future = R.occurrencesBetween(today > ps ? today : ps, pe, set).length;
          refundMinor = total > 0 ? Math.floor((Number(payment.amount_minor) * future) / total) : 0;
        }
      }
    }
    await conn.query("UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = ?, cancelled_by_id = ?, cancel_reason = ? WHERE id = ?", [actor.kind, actor.id, reason ? String(reason).slice(0, 255) : null, sub.id]);
    const released = await releaseFuture(sub.id, 'cancelled', tz, conn);
    if (payment && refundMinor >= 0 && Number(payment.amount_minor) > 0 && refundMode !== 'none') {
      const r = await refunds.createRecord(conn, {
        bookingType: 'subscription', bookingId: sub.id, paymentId: payment.gateway_payment_id, userId: sub.user_id, ownerId: plan.venue_owner_id, venueId: sub.turf_id, venueName: plan.venue_name, countryCode: plan.country_code,
        businessType: 'SPORTS', originalAmountMinor: Number(payment.amount_minor), amountPaidMinor: Number(payment.amount_minor), cancellationFeeMinor: Number(payment.amount_minor) - refundMinor, refundAmountMinor: refundMinor,
        currency: payment.currency_code, reason: reason || 'Cancelled', cancelledBy: actor.kind, cancellationType: `subscription_${refundMode}`, policy: null,
      });
      refundRow = r.refund;
    }
    await conn.commit();
    result = { status: 200, cancelled: true, subscriptionId: sub.id, releasedReservations: released, refundMinor, currency: sub.currency_code, userId: sub.user_id, venueId: sub.turf_id, manual: sub.source === 'manual' };
  } catch (e) { try { await conn.rollback(); } catch (x) { /* ignore */ } throw e; } finally { conn.release(); }

  await audit({ subscriptionId, venueId: result.venueId, actorId: actor.id, actorRole: actor.kind, action: result.manual ? 'MANUAL_MEMBER_CANCELLED' : 'SUBSCRIPTION_CANCELLED', reason, details: { refundMode, refundMinor: result.refundMinor } });
  fire('subscription.cancelled', { subscriptionId });
  if (refundRow && refundRow.refund_status === refunds.S.PENDING && Number(refundRow.refund_amount_minor) > 0) {
    await audit({ subscriptionId, venueId: result.venueId, actorId: actor.id, actorRole: actor.kind, action: 'SUBSCRIPTION_REFUND_INITIATED', details: { refundCode: refundRow.refund_code } });
    await refunds.initiate(refundRow.id).catch((e) => console.error('subscription refund initiate failed:', e.message));
  }
  return result;
}

async function suspendSubscription({ subscriptionId, adminId, reason }) {
  const [[sub]] = await pool.query('SELECT * FROM user_subscriptions WHERE id = ?', [subscriptionId]);
  if (!sub) return { error: 'Subscription not found', status: 404 };
  if (!['active', 'past_due'].includes(sub.status)) return { error: `A ${sub.status} subscription cannot be suspended`, status: 409 };
  const plan = await getPlan(sub.plan_id);
  await pool.query("UPDATE user_subscriptions SET status = 'suspended' WHERE id = ? AND status IN ('active','past_due')", [sub.id]);
  const released = await releaseFuture(sub.id, 'cancelled', planTz(plan));
  await audit({ subscriptionId: sub.id, venueId: sub.turf_id, actorId: adminId, actorRole: 'admin', action: 'SUBSCRIPTION_SUSPENDED', reason, details: { released } });
  fire('subscription.suspended', { subscriptionId: sub.id });
  return { status: 200, subscriptionId: sub.id, released };
}

/** Admin lifts a suspension: only while paid time remains, and only if every remaining slot can be taken again. */
async function reactivateSubscription({ subscriptionId, adminId, reason, now = Date.now() }) {
  const [[sub0]] = await pool.query('SELECT id, turf_id FROM user_subscriptions WHERE id = ?', [subscriptionId]);
  if (!sub0) return { error: 'Subscription not found', status: 404 };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await lockTurf(conn, sub0.turf_id);
    const [[sub]] = await conn.query('SELECT * FROM user_subscriptions WHERE id = ? FOR UPDATE', [subscriptionId]);
    if (sub.status !== 'suspended') { await conn.rollback(); return { error: 'Only a suspended subscription can be reactivated', status: 409 }; }
    const plan = await getPlan(sub.plan_id); const tz = planTz(plan); const today = todayIn(tz, now);
    const periodEnd = R.ymdOf(sub.current_period_end || R.addDays(sub.expiry_date, 1));
    if (periodEnd <= today) { await conn.rollback(); return { error: 'The paid period has already ended. Renew instead.', status: 409 }; }
    const dates = periodDates({ start: today, endExclusive: periodEnd, weekdaysSet: R.parseWeekdays(sub.weekdays), slotEnd: hhmm(sub.end_time), tz, now });
    const { conflicts, seats } = await checkSlot(conn, { turfId: sub.turf_id, courtId: sub.court_id, dates, start: hhmm(sub.start_time), end: hhmm(sub.end_time), capacity: Math.max(1, Number(plan.max_subscribers) || 1), excludeSubId: sub.id });
    if (conflicts.length) { await conn.rollback(); return { error: 'Some of this subscription\'s slots are no longer free.', status: 409, conflicts: conflicts.slice(0, 20) }; }
    await insertReservations(conn, { subscriptionId: sub.id, turfId: sub.turf_id, courtId: sub.court_id, dates, seats, start: hhmm(sub.start_time), end: hhmm(sub.end_time) });
    await conn.query("UPDATE user_subscriptions SET status = 'active' WHERE id = ?", [sub.id]);
    await conn.commit();
    await audit({ subscriptionId: sub.id, venueId: sub.turf_id, actorId: adminId, actorRole: 'admin', action: 'SUBSCRIPTION_ACTIVATED', reason: reason || 'reactivated by admin', details: { reservations: dates.length } });
    return { status: 200, subscriptionId: sub.id, reservations: dates.length };
  } catch (e) { try { await conn.rollback(); } catch (x) { /* ignore */ } if (e.code === 'ER_DUP_ENTRY') return { error: 'Some of this subscription\'s slots are no longer free.', status: 409 }; throw e; } finally { conn.release(); }
}

// ------------------------------------------------------------------------------------------------ manual membership (owner)
/**
 * The venue owner adds a member (paid online elsewhere, offline, or complimentary). Reserves EXACTLY like an online subscription.
 * Authorisation (the owner owns the venue) is the caller's job; this still re-checks that the plan belongs to that owner.
 */
async function addManualMember({ ownerId, planId, member, startDate = null, endDate = null, weekdays = undefined, paymentType = 'offline', amountPaid = 0, now = Date.now() }) {
  const plan = await getPlan(planId);
  if (!plan || Number(plan.owner_id) !== Number(ownerId) || Number(plan.venue_owner_id) !== Number(ownerId)) return { error: 'Forbidden', status: 403 };
  if (!['paid', 'offline', 'manual'].includes(paymentType)) return { error: 'payment_type must be paid, offline or manual', status: 400 };
  if (!member || (!member.userId && !member.name)) return { error: 'The member needs a name (or an existing customer)', status: 400 };
  const tz = planTz(plan); const currency = planCurrency(plan); const today = todayIn(tz, now);
  const start = startDate || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return { error: 'start_date must be YYYY-MM-DD', status: 400 };
  if (start < today) return { error: 'start_date cannot be in the past', status: 400 };
  const months = planMonths(plan);
  const endExclusive = endDate ? R.addDays(endDate, 1) : R.addMonthsClamped(start, months); // end_date is the last day of the membership
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return { error: 'end_date must be YYYY-MM-DD', status: 400 };
  if (endExclusive <= start) return { error: 'end_date must be after start_date', status: 400 };
  if (endExclusive > R.addMonthsClamped(start, 12)) return { error: 'A membership cannot be longer than 12 months', status: 400 };
  const set = weekdays === undefined ? R.parseWeekdays(plan.available_days) : R.parseWeekdays(weekdays);
  if (set === undefined) return { error: 'weekdays must be numbers 0-6 (0 = Sunday), e.g. "1,3,5"', status: 400 };
  const phone = member.phone ? String(member.phone).trim() : null;

  const conn = await pool.getConnection();
  let outcome;
  try {
    await conn.beginTransaction();
    await lockTurf(conn, plan.turf_id);
    // the same customer twice for the same schedule + overlapping time
    const [dup] = await conn.query(
      `SELECT id FROM user_subscriptions WHERE turf_id = ? AND COALESCE(court_id,0) = ? AND start_time = ? AND end_time = ? AND status IN ('active','past_due','suspended') AND expiry_date >= ?
         AND ((? IS NOT NULL AND user_id = ?) OR (? IS NOT NULL AND member_phone = ?))`,
      [plan.turf_id, plan.court_id || 0, hms(plan.start_time), hms(plan.end_time), start, member.userId || null, member.userId || null, phone, phone]);
    if (dup.length) { await conn.rollback(); return { error: 'Customer already has an active membership for this schedule. Extend it instead.', status: 409, code: 'DUPLICATE_MEMBERSHIP', existingId: dup[0].id }; }
    const dates = periodDates({ start, endExclusive, weekdaysSet: set, slotEnd: hhmm(plan.end_time), tz, now });
    const { conflicts, seats } = await checkSlot(conn, { turfId: plan.turf_id, courtId: plan.court_id, dates, start: hhmm(plan.start_time), end: hhmm(plan.end_time), capacity: Math.max(1, Number(plan.max_subscribers) || 1) });
    if (conflicts.length) { await conn.rollback(); return { error: 'Some selected slots are already unavailable.', status: 409, conflicts: conflicts.slice(0, 30) }; }
    const paidMinor = paymentType === 'manual' ? 0 : toMinor(Number(amountPaid) || 0, currency);
    const [ins] = await conn.query(
      `INSERT INTO user_subscriptions (user_id, plan_id, turf_id, court_id, start_date, expiry_date, status, payment_status, currency_code, amount_due_minor, amount_paid_minor, source, payment_type,
         member_name, member_phone, member_email, subscription_start_date, current_period_start, current_period_end, next_billing_date, months_total, weekdays, start_time, end_time, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [member.userId || null, plan.id, plan.turf_id, plan.court_id || null, start, R.addDays(endExclusive, -1), paymentType === 'manual' ? 'pending' : 'paid', currency, toMinor(Number(plan.price) || 0, currency), paidMinor, paymentType,
        member.name || null, phone, member.email || null, start, start, endExclusive, endExclusive, endDate ? 0 : months, R.weekdaysCsv(set), hms(plan.start_time), hms(plan.end_time)]);
    await insertReservations(conn, { subscriptionId: ins.insertId, turfId: plan.turf_id, courtId: plan.court_id, dates, seats, start: hhmm(plan.start_time), end: hhmm(plan.end_time) });
    await conn.commit();
    outcome = { status: 200, subscriptionId: ins.insertId, reservations: dates.length, endDate: R.addDays(endExclusive, -1) };
  } catch (e) {
    try { await conn.rollback(); } catch (x) { /* ignore */ }
    if (e.code === 'ER_DUP_ENTRY') return { error: 'Some selected slots are already unavailable.', status: 409 };
    throw e;
  } finally { conn.release(); }
  await audit({ subscriptionId: outcome.subscriptionId, venueId: plan.turf_id, actorId: ownerId, actorRole: 'owner', action: 'MANUAL_MEMBER_ADDED', details: { paymentType, reservations: outcome.reservations } });
  fire('subscription.manual_added', { subscriptionId: outcome.subscriptionId });
  return outcome;
}

/** Owner extends a MANUAL membership by whole calendar months (adds the new occurrences atomically). */
async function extendManualMember({ ownerId, subscriptionId, months = 1, now = Date.now() }) {
  const m = Math.round(Number(months));
  if (!(m >= 1 && m <= 12)) return { error: 'months must be between 1 and 12', status: 400 };
  const [[sub0]] = await pool.query('SELECT id, turf_id, plan_id FROM user_subscriptions WHERE id = ?', [subscriptionId]);
  if (!sub0) return { error: 'Subscription not found', status: 404 };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await lockTurf(conn, sub0.turf_id);
    const [[sub]] = await conn.query('SELECT * FROM user_subscriptions WHERE id = ? FOR UPDATE', [subscriptionId]);
    const plan = await getPlan(sub.plan_id);
    if (Number(plan.venue_owner_id) !== Number(ownerId)) { await conn.rollback(); return { error: 'Forbidden', status: 403 }; }
    if (sub.source !== 'manual') { await conn.rollback(); return { error: 'Online subscriptions are renewed by the customer\'s payment.', status: 409 }; }
    if (!['active', 'past_due', 'expired'].includes(sub.status)) { await conn.rollback(); return { error: `A ${sub.status} membership cannot be extended`, status: 409 }; }
    const tz = planTz(plan); const today = todayIn(tz, now);
    const curEnd = R.ymdOf(sub.current_period_end || R.addDays(sub.expiry_date, 1));
    const from = curEnd > today && sub.status !== 'expired' ? curEnd : today;
    const newEnd = R.addMonthsClamped(from, m);
    const dates = periodDates({ start: from, endExclusive: newEnd, weekdaysSet: R.parseWeekdays(sub.weekdays), slotEnd: hhmm(sub.end_time), tz, now });
    const { conflicts, seats } = await checkSlot(conn, { turfId: sub.turf_id, courtId: sub.court_id, dates, start: hhmm(sub.start_time), end: hhmm(sub.end_time), capacity: Math.max(1, Number(plan.max_subscribers) || 1), excludeSubId: sub.id });
    if (conflicts.length) { await conn.rollback(); return { error: 'Some selected slots are already unavailable.', status: 409, conflicts: conflicts.slice(0, 30) }; }
    await insertReservations(conn, { subscriptionId: sub.id, turfId: sub.turf_id, courtId: sub.court_id, dates, seats, start: hhmm(sub.start_time), end: hhmm(sub.end_time) });
    await conn.query("UPDATE user_subscriptions SET status = 'active', expiry_date = ?, current_period_end = ?, next_billing_date = ?, months_total = months_total + ? WHERE id = ?", [R.addDays(newEnd, -1), newEnd, newEnd, m, sub.id]);
    await conn.commit();
    await audit({ subscriptionId: sub.id, venueId: sub.turf_id, actorId: ownerId, actorRole: 'owner', action: 'SUBSCRIPTION_RENEWED', details: { months: m, reservations: dates.length } });
    return { status: 200, subscriptionId: sub.id, newEnd: R.addDays(newEnd, -1), reservations: dates.length };
  } catch (e) { try { await conn.rollback(); } catch (x) { /* ignore */ } if (e.code === 'ER_DUP_ENTRY') return { error: 'Some selected slots are already unavailable.', status: 409 }; throw e; } finally { conn.release(); }
}

// ------------------------------------------------------------------------------------------------ scheduled maintenance
/**
 * Backend sweep (called by the notification scheduler each tick): expire subscriptions whose paid period has passed IN THE VENUE'S
 * TIMEZONE and release their future reservations; mark finished occurrences USED. Idempotent. Returns what it changed.
 */
async function sweep({ now = Date.now(), dryRun = false, scopeIds = null } = {}) {
  const report = { expired: [], released: 0, used: 0 };
  const [cand] = await pool.query(
    `SELECT us.id, us.expiry_date, us.status, t.timezone AS tz FROM user_subscriptions us LEFT JOIN turfs t ON t.id = us.turf_id
     WHERE us.status IN ('active','past_due') AND us.expiry_date < DATE_ADD(UTC_DATE(), INTERVAL 2 DAY)${scopeIds ? ` AND us.id IN (${scopeIds.map(() => '?').join(',')})` : ''}`, scopeIds || []);
  for (const s of cand) {
    const today = todayIn(s.tz || 'Asia/Kolkata', now);
    if (R.ymdOf(s.expiry_date) >= today) continue;
    report.expired.push(s.id);
    if (dryRun) continue;
    const [u] = await pool.query("UPDATE user_subscriptions SET status = 'expired' WHERE id = ? AND status IN ('active','past_due')", [s.id]);
    if (u.affectedRows === 1) {
      report.released += await releaseFuture(s.id, 'expired', s.tz || 'Asia/Kolkata');
      await audit({ subscriptionId: s.id, actorRole: 'system', action: 'SUBSCRIPTION_EXPIRED' });
    }
  }
  if (!dryRun && !scopeIds) {
    // anything still holding seats whose subscription is no longer active (e.g. expired by the older scheduler step)
    const [r1] = await pool.query(
      `UPDATE subscription_reservations r JOIN user_subscriptions s ON s.id = r.subscription_id SET r.status = IF(s.status = 'expired', 'expired', 'cancelled'), r.active_key = NULL
       WHERE r.status = 'active' AND s.status NOT IN ('active','past_due') AND r.reservation_date >= DATE_SUB(UTC_DATE(), INTERVAL 1 DAY)`);
    report.released += r1.affectedRows;
    const [r2] = await pool.query("UPDATE subscription_reservations SET status = 'used', active_key = NULL WHERE status = 'active' AND reservation_date < DATE_SUB(UTC_DATE(), INTERVAL 1 DAY)");
    report.used = r2.affectedRows;
  }
  return report;
}

/** Called by the refund ledger when a subscription refund is confirmed by the gateway. */
async function onRefundCompleted(refund) {
  const subId = refund.booking_id;
  const [[sub]] = await pool.query('SELECT id, turf_id, status, amount_paid_minor FROM user_subscriptions WHERE id = ?', [subId]);
  if (!sub) return;
  await pool.query("UPDATE subscription_payments SET status = 'refunded' WHERE subscription_id = ? AND gateway_payment_id = ? AND status = 'success' AND ? >= amount_minor", [subId, refund.payment_id, Number(refund.refund_amount_minor)]);
  // a fully refunded, cancelled subscription is REFUNDED (the cancellation facts stay on the row)
  if (sub.status === 'cancelled' && Number(refund.refund_amount_minor) >= Number(sub.amount_paid_minor) && Number(sub.amount_paid_minor) > 0) await pool.query("UPDATE user_subscriptions SET status = 'refunded' WHERE id = ? AND status = 'cancelled'", [subId]);
  await audit({ subscriptionId: subId, venueId: sub.turf_id, actorRole: 'system', action: 'SUBSCRIPTION_REFUND_COMPLETED', details: { refundCode: refund.refund_code, amountMinor: Number(refund.refund_amount_minor), currency: refund.currency_code } });
}

module.exports = {
  onRefundCompleted, planMonths, getPlan, displayStatus, audit, purchase, renewalOrder, activateByOrder, activate, reportPaymentFailed, cancelPayment, cancelSubscription,
  suspendSubscription, reactivateSubscription, addManualMember, extendManualMember, sweep, releaseFuture, checkSlot, periodDates, REFUND_MODES, lockTurf, ACTIVE_LIKE, planCurrency, planTz,
};
