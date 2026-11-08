// A customer paid, but by the time the payment was verified the slot had been taken (another booking or an owner block won the
// race). The booking is already marked failed/cancelled by the caller; this makes sure the customer's money is not left stranded:
// a FULL refund is recorded in the refund ledger (idempotent per booking+payment) and sent to the gateway. It never throws —
// the caller's response to the customer must not depend on it — and a failed gateway call stays REFUND_FAILED for retry/admin.
const pool = require('../config/db');
const refunds = require('./refunds');
const { toMinor } = require('../utils/money');

async function refundConflictedPayment({ bookingIds, paymentId, reason = 'Slot no longer available' }) {
  const out = { attempted: false, refunds: [] };
  try {
    const ids = (bookingIds || []).map(Number).filter(Boolean);
    if (!ids.length || !paymentId) return out;
    const [rows] = await pool.query(
      `SELECT b.id, b.user_id, b.turf_id, b.amount, b.payment_type, b.advance_amount, t.name AS venue_name, t.owner_id, t.country_code, t.currency_code
       FROM bookings b JOIN turfs t ON t.id = b.turf_id WHERE b.id IN (?) ORDER BY b.id`, [ids]);
    if (!rows.length) return out;
    const first = rows[0];
    const currency = first.currency_code || 'INR';
    const paidMajor = rows.reduce((s, r) => s + (r.payment_type === 'advance' && r.advance_amount != null ? Number(r.advance_amount) : Number(r.amount || 0)), 0);
    const paidMinor = toMinor(paidMajor, currency);
    if (paidMinor <= 0) return out;
    out.attempted = true;
    const conn = await pool.getConnection();
    let rec;
    try {
      rec = await refunds.createRecord(conn, {
        bookingType: 'turf', bookingId: first.id, paymentId, userId: first.user_id, ownerId: first.owner_id, venueId: first.turf_id, venueName: first.venue_name,
        countryCode: first.country_code, businessType: 'SPORTS', originalAmountMinor: paidMinor, amountPaidMinor: paidMinor, cancellationFeeMinor: 0, refundAmountMinor: paidMinor,
        currency, reason, cancelledBy: 'admin', cancellationType: 'admin_cancelled',
      });
    } finally { conn.release(); }
    if (rec && rec.refund) {
      const r = await refunds.initiate(rec.refund.id);
      out.refunds.push((r && r.refund) || rec.refund);
    }
  } catch (e) {
    console.error('[conflict-refund] failed (booking already cancelled; refund needs admin retry):', e.message);
    out.error = e.message;
  }
  return out;
}

module.exports = { refundConflictedPayment };
