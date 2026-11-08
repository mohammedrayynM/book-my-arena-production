// Cancellation + refund decisions for BOTH engines (sports/turf slots and activity tickets). The backend decides
// everything — eligibility, fee, refund, currency, which payment, whether inventory is released. Clients only ever say
// "cancel this booking" (and, for a non-refundable cancel, "yes I accept no refund").
//
// Policy (platform-wide, versioned in `cancellation_policies`, snapshot per booking):
//   customer cancels MORE than windowHours before the venue-local start -> fee = feePercent of the booking total (after coupon);
//                                                                            refund = max(0, paid - fee)
//   customer cancels inside the window                                   -> not eligible for a refund; booking stays confirmed unless
//                                                                            the customer explicitly accepts a no-refund cancellation
//   owner / admin cancels                                                -> ownerRefundPercent (default 100%) of the amount actually paid, no fee
// Unpaid balance (advance bookings) is simply cancelled; nothing more is ever charged after a cancellation.
const pool = require('../config/db');
const T = require('../utils/notifications/time');
const { zonedEpoch } = require('../utils/timezone');
const { toMinor, fromMinor, percentOf, formatMoney } = require('../utils/money');
const { policyForBooking } = require('./globalConfig');
const refunds = require('./refunds');
const { fire } = require('../utils/notifications/events');

const OWNER_REASONS = ['Venue closure', 'Maintenance', 'Emergency', 'Court unavailable', 'Event cancelled', 'Activity cancelled', 'Operational issue', 'Other'];
const ADMIN_REASONS = ['Venue issue', 'Payment issue', 'System issue', 'Event cancelled', 'Activity unavailable', 'Fraud/security', 'Other'];
const REFUND_NOTE = 'Refund will be processed to your original payment method and may take 4–5 business days to reach your bank/payment provider.';

// ------------------------------------------------------------------------------------------------ loading
async function loadTurf(bookingId) {
  const [[first]] = await pool.query(
    `SELECT b.*, t.name AS venue_name, t.owner_id AS venue_owner_id, t.country_code AS venue_country, t.currency_code AS venue_currency, t.timezone AS venue_tz
     FROM bookings b JOIN turfs t ON t.id = b.turf_id WHERE b.id = ?`, [bookingId]
  );
  if (!first) return null;
  let rows = [first];
  if (first.razorpay_order_id) {
    [rows] = await pool.query('SELECT * FROM bookings WHERE razorpay_order_id = ? AND turf_id = ? AND booking_date = ? ORDER BY id', [first.razorpay_order_id, first.turf_id, first.booking_date]);
  }
  const live = rows.filter((r) => r.status === 'confirmed');
  const status = live.length ? 'confirmed' : (rows.every((r) => r.status === 'cancelled') ? 'cancelled' : first.status);
  const currency = first.currency_code && first.currency_code !== 'INR' ? first.currency_code : first.venue_currency || first.currency_code || 'INR';
  const paidRows = (live.length ? live : rows).filter((r) => r.payment_status === 'success');
  const totalMajor = (live.length ? live : rows).reduce((s, r) => s + Number(r.amount || 0), 0);
  const paidMajor = paidRows.reduce((s, r) => s + (r.payment_type === 'advance' && r.advance_amount != null ? Number(r.advance_amount) : Number(r.amount || 0)), 0);
  const starts = rows.map((r) => T.parseSlot(r.time_slot)).filter(Boolean).map((s) => s.start).sort();
  const date = T.dateOnly(first.booking_date);
  const policy = await policyForBooking('bookings', first);
  let participants = [];
  if (first.match_request_id) {
    const [mp] = await pool.query(
      "SELECT id, user_id, amount_paid, razorpay_payment_id FROM match_players WHERE match_id = ? AND payment_status = 'paid' AND amount_paid > 0 AND razorpay_payment_id IS NOT NULL AND user_id <> ?",
      [first.match_request_id, first.user_id || 0]
    );
    participants = mp.map((p) => ({ id: p.id, userId: p.user_id, paymentId: p.razorpay_payment_id, paidMinor: toMinor(p.amount_paid, currency) }));
  }
  return {
    type: 'turf', bookingId: first.id, rowIds: rows.map((r) => r.id), userId: first.user_id, ownerId: first.venue_owner_id, venueId: first.turf_id,
    venueName: first.venue_name, countryCode: first.venue_country, currency, tz: first.venue_tz || 'Asia/Kolkata', businessType: 'SPORTS',
    status, totalMinor: toMinor(totalMajor, currency), paidMinor: toMinor(paidMajor, currency), paymentId: first.payment_id || (paidRows[0] && paidRows[0].payment_id) || '',
    startEpoch: starts.length ? zonedEpoch(date, starts[0], first.venue_tz || 'Asia/Kolkata') : NaN, startDate: date, startTime: starts[0] || null,
    policy, participants, matchRequestId: first.match_request_id || null, label: `${first.venue_name} · ${date}`,
  };
}

async function loadActivity(bookingId) {
  const [[b]] = await pool.query(
    `SELECT b.*, a.name AS venue_name, a.owner_id AS venue_owner_id, a.country_code AS venue_country, a.currency_code AS venue_currency, a.timezone AS venue_tz, a.opening_time
     FROM activity_bookings b JOIN activities a ON a.id = b.activity_id WHERE b.id = ?`, [bookingId]
  );
  if (!b) return null;
  let t = b.opening_time;
  if (b.time_window_id) { const [[w]] = await pool.query('SELECT start_time FROM activity_time_windows WHERE id = ?', [b.time_window_id]); if (w) t = w.start_time; }
  const currency = b.currency_code && b.currency_code !== 'INR' ? b.currency_code : b.venue_currency || b.currency_code || 'INR';
  const date = T.dateOnly(b.booking_date);
  const policy = await policyForBooking('activity_bookings', b);
  const paid = b.payment_status === 'success' || b.payment_status === 'refunded';
  const [[used]] = await pool.query('SELECT COALESCE(SUM(redeemed_quantity),0) AS n FROM activity_tickets WHERE booking_id = ?', [b.id]);
  return {
    type: 'activity', bookingId: b.id, rowIds: [b.id], userId: b.user_id, ownerId: b.venue_owner_id, venueId: b.activity_id, venueName: b.venue_name,
    countryCode: b.venue_country, currency, tz: b.venue_tz || 'Asia/Kolkata', businessType: 'ACTIVITY', status: b.status,
    totalMinor: toMinor(b.total_amount, currency), paidMinor: paid ? toMinor(b.total_amount, currency) : 0, paymentId: b.razorpay_payment_id || '',
    startEpoch: zonedEpoch(date, String(t || '00:00:00').slice(0, 8), b.venue_tz || 'Asia/Kolkata'), startDate: date, startTime: String(t || '').slice(0, 5),
    policy, participants: [], bookingCode: b.booking_code, redeemedQty: Number(used.n), label: `${b.venue_name} · ${date}`,
  };
}
const load = (type, id) => (type === 'activity' ? loadActivity(id) : type === 'turf' ? loadTurf(id) : Promise.resolve(null));

// ------------------------------------------------------------------------------------------------ the decision
/** Pure function of (booking facts, policy, who, now). Nothing here touches the database. */
function evaluate(ctx, { actor, now = Date.now(), acceptNoRefund = false }) {
  const p = ctx.policy;
  const hoursLeft = Number.isFinite(ctx.startEpoch) ? (ctx.startEpoch - now) / 3600000 : Infinity;
  const base = {
    bookingType: ctx.type, bookingId: ctx.bookingId, currency: ctx.currency, bookingTotalMinor: ctx.totalMinor, amountPaidMinor: ctx.paidMinor,
    policy: { version: p.version, windowHours: p.windowHours, feePercent: p.feePercent }, hoursUntilStart: Math.round(hoursLeft * 100) / 100,
  };
  if (ctx.status !== 'confirmed') return { ...base, canCancel: false, code: 'NOT_CONFIRMED', message: ctx.status === 'cancelled' ? 'This booking is already cancelled.' : `A ${ctx.status} booking cannot be cancelled.` };

  if (actor !== 'customer') {
    const pct = actor === 'admin' ? 100 : p.ownerRefundPercent; // admin default = full refund; owner follows the policy (default 100)
    const refund = Math.min(ctx.paidMinor, percentOf(ctx.paidMinor, pct));
    return { ...base, canCancel: true, eligible: true, cancellationFeeMinor: ctx.paidMinor - refund, refundAmountMinor: refund, balanceCancelledMinor: Math.max(0, ctx.totalMinor - ctx.paidMinor), cancellationType: `${actor}_cancelled` };
  }
  if (ctx.redeemedQty > 0) return { ...base, canCancel: false, code: 'ALREADY_USED', message: 'This booking has already been used (fully or partly) and cannot be cancelled.' };
  if (!p.cancellationEnabled) return { ...base, canCancel: false, code: 'CANCELLATION_DISABLED', message: 'Cancellations are currently disabled.' };
  if (hoursLeft <= 0) return { ...base, canCancel: false, code: 'STARTED', message: 'This booking has already started and cannot be cancelled.' };

  // Policy: cancelling is allowed only when the slot starts AT LEAST windowHours away (inclusive: exactly 8h00m is allowed).
  // Inside the window the customer cannot cancel at all (they contact the venue); owner/admin exception paths above are unchanged.
  if (p.customerRefundEnabled && hoursLeft < p.windowHours) {
    return { ...base, eligible: false, canCancel: false, code: 'TOO_LATE', cancellationFeeMinor: ctx.paidMinor, refundAmountMinor: 0, balanceCancelledMinor: Math.max(0, ctx.totalMinor - ctx.paidMinor),
      message: `Bookings can only be cancelled at least ${p.windowHours} hours before the slot starts. This slot starts in less than ${p.windowHours} hours, so it can no longer be cancelled online. Please contact the venue for help.` };
  }
  const eligible = p.customerRefundEnabled && hoursLeft >= p.windowHours;
  const balanceCancelled = Math.max(0, ctx.totalMinor - ctx.paidMinor);
  if (eligible) {
    const fee = percentOf(ctx.totalMinor, p.feePercent);              // fee is on the FINAL total (coupon already applied)
    const refund = Math.max(0, ctx.paidMinor - fee);                  // never negative
    return { ...base, canCancel: true, eligible: true, cancellationFeeMinor: Math.min(fee, ctx.paidMinor), refundAmountMinor: Math.min(refund, ctx.paidMinor), balanceCancelledMinor: balanceCancelled, cancellationType: 'customer_eligible' };
  }
  const msg = `Cancellation is not eligible for a refund because your booking starts within ${p.windowHours} hours.`;
  const nr = { ...base, eligible: false, cancellationFeeMinor: ctx.paidMinor, refundAmountMinor: 0, balanceCancelledMinor: balanceCancelled, message: msg, requiresNoRefundConfirmation: true, cancellationType: 'customer_no_refund' };
  return acceptNoRefund ? { ...nr, canCancel: true } : { ...nr, canCancel: false, code: 'NOT_REFUNDABLE' };
}

const major = (minor, cur) => fromMinor(minor, cur);
/** Client-safe view of a decision. Amounts are major units for display plus *_minor for exactness. */
function toView(d, ctx) {
  const c = d.currency;
  const showRefund = d.refundAmountMinor != null;
  const participantsPaid = (ctx.participants || []).reduce((s, p) => s + p.paidMinor, 0);
  return {
    booking_type: d.bookingType, booking_id: d.bookingId, venue_name: ctx.venueName, currency: c, country_code: ctx.countryCode, timezone: ctx.tz,
    can_cancel: !!d.canCancel, eligible: d.eligible ?? null, code: d.code || null, message: d.message || null,
    requires_no_refund_confirmation: !!d.requiresNoRefundConfirmation,
    hours_until_start: d.hoursUntilStart,
    policy: d.policy,
    start_at: Number.isFinite(ctx.startEpoch) ? new Date(ctx.startEpoch).toISOString() : null,
    cancel_cutoff_at: Number.isFinite(ctx.startEpoch) && d.policy ? new Date(ctx.startEpoch - d.policy.windowHours * 3600000).toISOString() : null,
    refund_percent: d.policy ? 100 - d.policy.feePercent : null,
    policy_text: d.policy ? `Cancel at least ${d.policy.windowHours} hours before the slot starts to get ${100 - d.policy.feePercent}% back (${d.policy.feePercent}% is retained). Inside ${d.policy.windowHours} hours, bookings cannot be cancelled online.` : null,
    booking_total: major(d.bookingTotalMinor, c), amount_paid: major(d.amountPaidMinor, c),
    cancellation_fee: showRefund ? major(d.cancellationFeeMinor, c) : null,
    refund_amount: showRefund ? major(d.refundAmountMinor, c) : null,
    balance_cancelled: showRefund ? major(d.balanceCancelledMinor, c) : null,
    booking_total_minor: d.bookingTotalMinor, amount_paid_minor: d.amountPaidMinor, cancellation_fee_minor: showRefund ? d.cancellationFeeMinor : null,
    refund_amount_minor: showRefund ? d.refundAmountMinor : null,
    player_payments_refunded: participantsPaid > 0 ? (ctx.participants || []).length : 0,
    refund_note: showRefund && d.refundAmountMinor > 0 ? REFUND_NOTE : null,
  };
}

// ------------------------------------------------------------------------------------------------ authorisation
function authorize(ctx, actor) {
  if (!ctx) return { error: 'Booking not found', status: 404 };
  if (actor.kind === 'admin') return {};
  if (actor.kind === 'owner') return ctx.ownerId === actor.id ? {} : { error: 'Booking not found', status: 404 };
  return ctx.userId && ctx.userId === actor.id ? {} : { error: 'Booking not found', status: 404 };
}

async function quote({ type, id, actor, now = Date.now() }) {
  const ctx = await load(type, id);
  const auth = authorize(ctx, actor);
  if (auth.error) return auth;
  const d = evaluate(ctx, { actor: actor.kind, now });
  return { status: 200, view: toView(d, ctx), ctx, decision: d };
}

// ------------------------------------------------------------------------------------------------ the cancellation itself
async function cancel({ type, id, actor, reason, acceptNoRefund = false, now = Date.now() }) {
  const pre = await load(type, id);
  const auth = authorize(pre, actor);
  if (auth.error) return auth;

  if (actor.kind === 'owner' && !OWNER_REASONS.includes(reason)) return { error: `A reason is required: ${OWNER_REASONS.join(', ')}`, status: 400 };
  if (actor.kind === 'admin' && !ADMIN_REASONS.includes(reason)) return { error: `A reason is required: ${ADMIN_REASONS.join(', ')}`, status: 400 };
  const reasonText = actor.kind === 'customer' ? (reason ? String(reason).slice(0, 200) : 'Cancelled by customer') : reason;

  const conn = await pool.getConnection();
  let ctx; let decision; let created = [];
  try {
    await conn.beginTransaction();
    // serialise every cancel of this booking (customer, owner, admin, double-tap) on its rows
    const table = type === 'activity' ? 'activity_bookings' : 'bookings';
    const [locked] = await conn.query(`SELECT id, status FROM ${table} WHERE id IN (${pre.rowIds.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, pre.rowIds);
    const stillConfirmed = locked.some((r) => r.status === 'confirmed');
    if (!stillConfirmed) {
      await conn.rollback();
      const existing = await refunds.forBooking(type, pre.bookingId);
      return { status: 200, alreadyCancelled: true, refunds: existing, view: toView(evaluate({ ...pre, status: 'cancelled' }, { actor: actor.kind, now }), pre) };
    }
    ctx = await loadFresh(conn, type, id, pre);
    decision = evaluate(ctx, { actor: actor.kind, now, acceptNoRefund });
    if (!decision.canCancel) {
      await conn.rollback();
      return { status: (decision.code === 'NOT_REFUNDABLE' || decision.code === 'TOO_LATE') ? 409 : 400, error: decision.message, code: decision.code, view: toView(decision, ctx) };
    }

    const cancelledBy = actor.kind;
    if (type === 'turf') {
      const [u] = await conn.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_by = ?, cancel_reason = ?, cancelled_at = NOW(), pending_balance = 0 WHERE id IN (${ctx.rowIds.map(() => '?').join(',')}) AND status = 'confirmed'`,
        [cancelledBy, reasonText, ...ctx.rowIds]
      );
      if (u.affectedRows === 0) { await conn.rollback(); return { status: 409, error: 'This booking changed while cancelling. Please try again.' }; }
      if (ctx.matchRequestId) await conn.query("UPDATE player_requests SET status = 'cancelled' WHERE id = ? AND status <> 'cancelled'", [ctx.matchRequestId]);
    } else {
      await conn.query(
        "UPDATE activity_bookings SET status = 'cancelled', cancelled_by = ?, cancel_reason = ?, cancelled_at = NOW(), refund_amount = ?, refund_status = ? WHERE id = ? AND status = 'confirmed'",
        [cancelledBy, reasonText, major(decision.refundAmountMinor, ctx.currency), decision.refundAmountMinor > 0 ? 'pending' : 'none', ctx.bookingId]
      );
      await conn.query("UPDATE activity_tickets SET status = 'CANCELLED' WHERE booking_id = ? AND status IN ('VALID','UNUSED')", [ctx.bookingId]);
      // inventory is released inside the SAME transaction: it only becomes bookable again if the cancellation commits
      const [items] = await conn.query('SELECT * FROM activity_booking_items WHERE booking_id = ?', [ctx.bookingId]);
      const [[bk]] = await conn.query('SELECT booking_date, time_window_id FROM activity_bookings WHERE id = ?', [ctx.bookingId]);
      for (const item of items) await conn.query('UPDATE activity_inventory SET sold = GREATEST(0, sold - ?) WHERE ticket_type_id = ? AND date = ?', [item.quantity, item.ticket_type_id, bk.booking_date]);
      if (bk.time_window_id) await conn.query('UPDATE activity_time_windows SET sold = GREATEST(0, sold - ?) WHERE id = ?', [items.reduce((s, i) => s + i.quantity, 0), bk.time_window_id]);
    }

    const common = {
      bookingType: type, bookingId: ctx.bookingId, userId: ctx.userId, ownerId: ctx.ownerId, venueId: ctx.venueId, venueName: ctx.venueName, countryCode: ctx.countryCode,
      businessType: ctx.businessType, currency: ctx.currency, reason: reasonText, cancelledBy, cancellationType: decision.cancellationType, policy: ctx.policy,
    };
    // the host/booker's own payment
    created.push((await refunds.createRecord(conn, {
      ...common, paymentId: ctx.paymentId, originalAmountMinor: ctx.totalMinor, amountPaidMinor: ctx.paidMinor,
      cancellationFeeMinor: decision.cancellationFeeMinor, refundAmountMinor: decision.refundAmountMinor,
    })).refund);
    // players who really paid through the gateway for this match: same rules, each on their own payment — never invented
    for (const p of ctx.participants) {
      const pd = evaluate({ ...ctx, totalMinor: p.paidMinor, paidMinor: p.paidMinor }, { actor: actor.kind, now, acceptNoRefund });
      created.push((await refunds.createRecord(conn, {
        ...common, userId: p.userId, paymentId: p.paymentId, originalAmountMinor: p.paidMinor, amountPaidMinor: p.paidMinor,
        cancellationFeeMinor: pd.cancellationFeeMinor ?? 0, refundAmountMinor: pd.refundAmountMinor ?? 0,
      })).refund);
    }
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch (x) { /* already rolled back */ }
    throw e;
  } finally { conn.release(); }

  // after the commit: tell the gateway (each refund is claimed atomically, so concurrent/duplicate calls cannot double-pay)
  const results = [];
  for (const r of created) results.push(r.refund_status === refunds.S.PENDING ? (await refunds.initiate(r.id)).refund || r : r);

  if (type === 'turf') fire('booking.cancelled', { bookingIds: ctx.rowIds, wasConfirmed: true });
  else fire('activity.booking_cancelled', { bookingId: ctx.bookingId, reason: `${actor.kind}_cancelled` });
  return { status: 200, cancelled: true, refunds: results, view: toView(decision, ctx) };
}

// re-read the booking facts using the locking connection's committed view (status can have changed between load and lock)
async function loadFresh(conn, type, id, pre) {
  const table = type === 'activity' ? 'activity_bookings' : 'bookings';
  const [rows] = await conn.query(`SELECT status FROM ${table} WHERE id IN (${pre.rowIds.map(() => '?').join(',')})`, pre.rowIds);
  return { ...pre, status: rows.some((r) => r.status === 'confirmed') ? 'confirmed' : 'cancelled' };
}

const money = (minor, cur) => formatMoney(fromMinor(minor, cur), cur);
module.exports = { OWNER_REASONS, ADMIN_REASONS, REFUND_NOTE, load, evaluate, toView, quote, cancel, authorize, money };
