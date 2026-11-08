// Payment-gateway refunds. Razorpay today; the rest of the code only sees { id, status, simulated }.
// A refund is NEVER treated as complete here: the gateway call only *initiates* it. Completion arrives later (webhook
// refund.processed / refund.failed) and is applied by services/refunds.js applyGatewayEvent().
//
// Safety: ids that are not real Razorpay payment ids (test fixtures, free bookings, demo mode) are SIMULATED with no
// network call, so tests and demos can never move real money on the live keys.
const crypto = require('crypto');
const Razorpay = require('razorpay');
require('dotenv').config();

let client = null;
const rz = () => (client || (client = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })));

const REAL_PAYMENT_ID = /^pay_[A-Za-z0-9]{14}$/;
const failedOnce = new Set();
const shouldSimulate =(paymentId) => process.env.REFUND_GATEWAY === 'simulated' || !REAL_PAYMENT_ID.test(String(paymentId || ''));

/**
 * @returns {Promise<{ id: string, status: 'initiated'|'processed'|'failed', simulated: boolean, error?: string }>}
 * `status: 'initiated'` = accepted by the gateway, money not yet confirmed back to the customer.
 */
async function createRefund({ paymentId, amountMinor, currency, idempotencyKey, notes = {} }) {
  if (!(amountMinor > 0)) return { id: '', status: 'failed', simulated: false, error: 'Nothing to refund' };
  if (shouldSimulate(paymentId)) {
    // test hook (simulated ids only): a payment id ending in "_failonce" is refused the first time and accepted on retry
    if (/_failonce$/.test(String(paymentId)) && !failedOnce.has(paymentId)) { failedOnce.add(paymentId); return { id: '', status: 'failed', simulated: true, error: 'Simulated gateway failure' }; }
    const id = `rfnd_sim_${crypto.createHash('sha1').update(idempotencyKey).digest('hex').slice(0, 14)}`;
    console.log(`[Refund][SIMULATED] ${currency} ${amountMinor} minor units for payment ${paymentId} (no network call)`);
    return { id, status: 'initiated', simulated: true };
  }
  try {
    const r = await rz().payments.refund(paymentId, { amount: amountMinor, speed: 'normal', receipt: String(idempotencyKey).slice(0, 40), notes: { ...notes, currency } });
    return { id: r.id, status: r.status === 'processed' ? 'processed' : 'initiated', simulated: false };
  } catch (e) {
    const msg = e?.error?.description || e?.message || 'Gateway refused the refund';
    return { id: '', status: 'failed', simulated: false, error: String(msg).slice(0, 240) };
  }
}

module.exports = { createRefund, shouldSimulate, REAL_PAYMENT_ID };
