// The refund ledger (table `refunds`) — one row per booking+payment, enforced by UNIQUE constraints, so pressing Cancel
// twice, a retried request, a duplicate webhook or an owner/customer race can never produce two refunds.
//
//   REFUND_PENDING  -> row exists, gateway not called yet
//   REFUND_PROCESSING -> a worker has claimed it and the gateway call is in flight
//   REFUND_INITIATED -> gateway accepted it (money is on its way, NOT confirmed)
//   REFUND_COMPLETED -> gateway confirmed (webhook refund.processed)
//   REFUND_FAILED   -> gateway refused / reported failure; safe to retry (same idempotency key, never double-pays)
//   NOT_REQUIRED    -> nothing is owed (e.g. unpaid booking, or cancelled inside the no-refund window)
const pool = require('../config/db');
const gateway = require('./refundGateway');
const { fire } = require('../utils/notifications/events');

const S = { NOT_REQUIRED: 'NOT_REQUIRED', PENDING: 'REFUND_PENDING', INITIATED: 'REFUND_INITIATED', PROCESSING: 'REFUND_PROCESSING', COMPLETED: 'REFUND_COMPLETED', FAILED: 'REFUND_FAILED' };
const newCode = () => `RF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const keyFor = (type, bookingId, paymentId) => `refund:${type}:${bookingId}:${paymentId || 'none'}`;

/**
 * Insert (or find) the ledger row for one booking payment. `conn` lets the caller do it inside the cancellation transaction.
 * Returns { refund, created }. Calling it twice for the same booking+payment returns the first row untouched.
 */
async function createRecord(conn, d) {
  const key = keyFor(d.bookingType, d.bookingId, d.paymentId);
  const status = d.refundAmountMinor > 0 ? S.PENDING : S.NOT_REQUIRED;
  const [ins] = await conn.query(
    `INSERT IGNORE INTO refunds (refund_code, booking_type, booking_id, payment_id, user_id, owner_id, venue_id, venue_name, country_code, business_type,
       original_amount_minor, amount_paid_minor, cancellation_fee_minor, refund_amount_minor, currency_code, refund_reason, cancelled_by, cancellation_type,
       refund_status, gateway_payment_id, idempotency_key, policy_version, policy_window_hours, policy_fee_percent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newCode(), d.bookingType, d.bookingId, d.paymentId || '', d.userId || null, d.ownerId || null, d.venueId || null, d.venueName || null, d.countryCode || null, d.businessType || null,
      d.originalAmountMinor, d.amountPaidMinor, d.cancellationFeeMinor, d.refundAmountMinor, d.currency, d.reason ? String(d.reason).slice(0, 255) : null, d.cancelledBy, d.cancellationType,
      status, d.paymentId || null, key, d.policy?.version || null, d.policy?.windowHours ?? null, d.policy?.feePercent ?? null]
  );
  const [[refund]] = await conn.query('SELECT * FROM refunds WHERE idempotency_key = ?', [key]);
  return { refund, created: ins.affectedRows === 1 };
}

// Never refund more than was paid on a payment, across all refund rows that are not failed.
async function alreadyRefundedMinor(paymentId, exceptRefundId) {
  if (!paymentId) return 0;
  const [[r]] = await pool.query("SELECT COALESCE(SUM(refund_amount_minor),0) AS s FROM refunds WHERE payment_id = ? AND id <> ? AND refund_status NOT IN ('REFUND_FAILED','NOT_REQUIRED')", [paymentId, exceptRefundId]);
  return Number(r.s);
}

// What "refund completed" means for the booking itself: an activity's tickets become REFUNDED and its payment refunded.
async function onCompleted(r) {
  if (r.booking_type === 'activity') {
    await pool.query("UPDATE activity_tickets SET status = 'REFUNDED' WHERE booking_id = ? AND status = 'CANCELLED'", [r.booking_id]);
    await pool.query("UPDATE activity_bookings SET payment_status = 'refunded', refund_status = 'processed', refund_processed_at = NOW() WHERE id = ?", [r.booking_id]);
  } else if (r.booking_type === 'subscription') {
    await require('./subscriptionService').onRefundCompleted(r); // lazy: the subscription engine itself uses this ledger
  }
}

/** Claim + call the gateway. Safe to call repeatedly / concurrently: only one caller wins the claim. */
async function initiate(refundId) {
  const [claim] = await pool.query(
    "UPDATE refunds SET refund_status = 'REFUND_PROCESSING', attempts = attempts + 1, failure_reason = NULL WHERE id = ? AND refund_status IN ('REFUND_PENDING','REFUND_FAILED') AND gateway_refund_id IS NULL", [refundId]
  );
  const [[r]] = await pool.query('SELECT * FROM refunds WHERE id = ?', [refundId]);
  if (!r) return { error: 'Refund not found' };
  if (claim.affectedRows === 0) return { refund: r, skipped: true };

  const prior = await alreadyRefundedMinor(r.payment_id, r.id);
  if (!r.payment_id) return fail(r, 'There is no gateway payment to refund. The venue will refund this manually.');
  if (prior + Number(r.refund_amount_minor) > Number(r.amount_paid_minor)) return fail(r, 'Refund would exceed the amount paid');

  const res = await gateway.createRefund({
    paymentId: r.payment_id, amountMinor: Number(r.refund_amount_minor), currency: r.currency_code, idempotencyKey: r.idempotency_key,
    notes: { booking_type: r.booking_type, booking_id: String(r.booking_id), refund_code: r.refund_code },
  });
  if (res.status === 'failed') return fail(r, res.error || 'Gateway error');

  const done = res.status === 'processed';
  await pool.query(
    'UPDATE refunds SET refund_status = ?, gateway_refund_id = ?, processed_at = NOW(), completed_at = ? WHERE id = ?',
    [done ? S.COMPLETED : S.INITIATED, res.id, done ? new Date() : null, r.id]
  );
  if (done) await onCompleted(r);
  fire('refund.status', { refundId: r.id, status: done ? S.COMPLETED : S.INITIATED });
  const [[updated]] = await pool.query('SELECT * FROM refunds WHERE id = ?', [r.id]);
  return { refund: updated, simulated: res.simulated };
}

async function fail(r, reason) {
  await pool.query("UPDATE refunds SET refund_status = 'REFUND_FAILED', failure_reason = ? WHERE id = ?", [String(reason).slice(0, 255), r.id]);
  fire('refund.status', { refundId: r.id, status: S.FAILED });
  const [[updated]] = await pool.query('SELECT * FROM refunds WHERE id = ?', [r.id]);
  return { refund: updated, failed: true, error: reason };
}

/** Admin/system retry. Only a FAILED refund can be retried, and it reuses the same idempotency key. */
async function retry(refundId) {
  const [[r]] = await pool.query('SELECT refund_status FROM refunds WHERE id = ?', [refundId]);
  if (!r) return { error: 'Refund not found', status: 404 };
  if (r.refund_status !== S.FAILED && r.refund_status !== S.PENDING) return { error: `A ${r.refund_status} refund cannot be retried`, status: 400 };
  return { ...(await initiate(refundId)), status: 200 };
}

/**
 * Apply a gateway status event (refund.processed / refund.failed). Idempotent: the same event twice changes nothing,
 * a late "failed" never un-completes a refund, and the refund is found by the gateway's own refund id.
 */
async function applyGatewayEvent({ gatewayRefundId, outcome, reason }) {
  const [[r]] = await pool.query('SELECT * FROM refunds WHERE gateway_refund_id = ?', [gatewayRefundId]);
  if (!r) return { notFound: true };
  if (outcome === 'processed') {
    if (r.refund_status === S.COMPLETED) return { refund: r, duplicate: true };
    await pool.query("UPDATE refunds SET refund_status = 'REFUND_COMPLETED', completed_at = NOW(), failure_reason = NULL WHERE id = ? AND refund_status <> 'REFUND_COMPLETED'", [r.id]);
    await onCompleted(r);
    fire('refund.status', { refundId: r.id, status: S.COMPLETED });
  } else if (outcome === 'failed') {
    if (r.refund_status === S.COMPLETED || r.refund_status === S.FAILED) return { refund: r, duplicate: true };
    // the gateway id stays on the row for the record; clearing it lets a retry create a fresh gateway refund
    await pool.query("UPDATE refunds SET refund_status = 'REFUND_FAILED', failure_reason = ?, gateway_refund_id = NULL WHERE id = ?", [String(reason || 'Gateway reported the refund failed').slice(0, 255), r.id]);
    fire('refund.status', { refundId: r.id, status: S.FAILED });
  }
  const [[updated]] = await pool.query('SELECT * FROM refunds WHERE id = ?', [r.id]);
  return { refund: updated };
}

async function forBooking(type, bookingId) {
  const [rows] = await pool.query('SELECT * FROM refunds WHERE booking_type = ? AND booking_id = ? ORDER BY id', [type, bookingId]);
  return rows;
}

module.exports = { onCompleted, S, createRecord, initiate, retry, applyGatewayEvent, forBooking, keyFor };
