// The only place that ever calls Razorpay's real Route transfer API. Everything else in the split-payment engine goes
// through here, so there is exactly one gate between this codebase and real money movement.
//
// A turf's `route_environment` decides which path runs:
//   'test' (the default for every turf) -> SIMULATED. No network call. Returns a fake transfer id. Safe to run any
//           number of times, in development or in the e2e tests, without touching Razorpay or moving money.
//   'live' -> the real Razorpay Route transfer call, using the account's live keys.
// A turf can only reach 'test' -> 'live' through an explicit admin action that requires typing a confirmation phrase
// (routes/admin-route.js). No turf is live by default, and this file never decides that on its own.
//
// Reads (fetchPayment / listTransfers) always go to Razorpay with the server-side keys: they move no money and are how
// the backend learns the TRUE captured amount instead of trusting anything the client sent.
const crypto = require('crypto');
const Razorpay = require('razorpay');
require('dotenv').config();

let razorpay = null;
function client() {
  if (!razorpay) razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  return razorpay;
}

/** The payment exactly as Razorpay reports it ({ id, status, amount, currency, order_id, captured, amount_refunded, ... }). */
async function fetchPayment(paymentId) {
  return client().payments.fetch(paymentId);
}

/** Payments attempted against an order, including failed, authorized, and captured attempts. */
async function fetchOrderPayments(orderId) {
  const res = await client().orders.fetchPayments(orderId, { count: 100 });
  if (!res || !Array.isArray(res.items)) throw new Error('Razorpay returned an invalid order payment list');
  return res.items;
}

/** Transfers already made from this payment ([] if none). A transfer that was fully reversed does not count as committed. */
async function listTransfers(paymentId) {
  const res = await client().payments.fetchTransfer(paymentId);
  return Array.isArray(res && res.items) ? res.items : [];
}

/** A linked account as Razorpay reports it ({ id, status: 'created'|'activated'|..., ... }). Never returns bank details. */
async function fetchAccount(accountId) {
  const a = await client().accounts.fetch(accountId);
  return { id: a.id, status: a.status, type: a.type, business_type: a.business_type || null, legal_business_name: a.legal_business_name || null };
}

/** Reverses (part of) a transfer — the only supported way to take an owner's share back after a refund. */
async function reverseTransfer({ environment, transferId, amountPaise, notes }) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error('reversal amount must be a positive integer (minor units)');
  if (environment !== 'live' || String(transferId).startsWith('sim_')) return { id: `sim_reversal_${crypto.randomBytes(8).toString('hex')}`, simulated: true };
  const r = await client().transfers.reverse(transferId, { amount: amountPaise, notes });
  if (!r || !r.id) throw new Error('Razorpay did not return a reversal id');
  return { id: r.id, simulated: false, raw: r };
}

/**
 * @param {{ environment: 'test'|'live', paymentId: string, linkedAccountId: string, amountPaise: number, currency?: string, capturedPaise?: number, notes: object }} p
 * @returns {Promise<{ id: string, simulated: boolean, raw?: object }>}
 */
async function createTransfer({ environment, paymentId, linkedAccountId, amountPaise, currency = 'INR', capturedPaise, notes }) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error('transfer amount must be a positive integer (minor units)');
  if (environment !== 'live') {
    const id = `sim_transfer_${crypto.randomBytes(10).toString('hex')}`;
    console.log(`[RouteSplit][SIMULATED] would transfer ${(amountPaise / 100).toFixed(2)} ${currency} to ${linkedAccountId} for payment ${paymentId} (no network call, test environment)`);
    return { id, simulated: true };
  }
  if (currency !== 'INR') throw new Error(`Razorpay Route transfers are INR-only; refusing to send a ${currency} transfer`);

  // Never move more than the captured money, and never a second time for the same payment: ask Razorpay what has
  // already been transferred from this payment before creating anything.
  const existing = await listTransfers(paymentId);
  const committed = existing.filter((t) => t.status !== 'reversed' && t.status !== 'failed');
  const already = committed.reduce((s, t) => s + Number(t.amount || 0) - Number(t.amount_reversed || 0), 0);
  if (committed.some((t) => t.recipient === linkedAccountId && Number(t.amount) === amountPaise)) {
    return { id: committed.find((t) => t.recipient === linkedAccountId && Number(t.amount) === amountPaise).id, simulated: false, alreadyExisted: true };
  }
  if (Number.isSafeInteger(capturedPaise) && already + amountPaise > capturedPaise) {
    throw new Error(`Refusing transfer: ${already + amountPaise} would exceed the captured amount ${capturedPaise} (already transferred ${already})`);
  }

  const result = await client().payments.transfer(paymentId, {
    transfers: [{ account: linkedAccountId, amount: amountPaise, currency, notes, on_hold: 0 }],
  });
  const id = result && Array.isArray(result.items) && result.items.length ? result.items[0].id : null;
  if (!id) throw new Error('Razorpay did not return a transfer id');
  return { id, simulated: false, raw: result };
}

module.exports = { createTransfer, reverseTransfer, fetchPayment, fetchOrderPayments, listTransfers, fetchAccount };
