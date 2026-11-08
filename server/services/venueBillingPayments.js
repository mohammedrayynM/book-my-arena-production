const crypto = require('crypto');
const Razorpay = require('razorpay');
const pool = require('../config/db');
const billing = require('./billingConfig');
const globalConfig = require('./globalConfig');
const restrictions = require('./venueBillingRestrictions');
const { fire } = require('../utils/notifications/events');

const gateway = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    const err = new Error('Razorpay payments are not configured');
    err.status = 503;
    throw err;
  }
  return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
};

const conflict = (message) => Object.assign(new Error(message), { status: 409 });

async function createOrder({ turfId, cycleId, ownerId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[cycle]] = await conn.query(
      `SELECT c.*, t.name AS turf_name, t.owner_id, t.country_code
       FROM turf_subscription_cycles c JOIN turfs t ON t.id = c.turf_id
       WHERE c.id = ? AND c.turf_id = ? AND t.owner_id = ? FOR UPDATE`,
      [cycleId, turfId, ownerId]
    );
    if (!cycle) { await conn.rollback(); throw Object.assign(new Error('Billing cycle not found'), { status: 404 }); }
    if (cycle.policy !== 'SEPARATE') { await conn.rollback(); throw conflict('This subscription is paid from booking proceeds, not through a separate payment'); }
    if (!(await globalConfig.paymentsEnabledFor(cycle.country_code || 'IN', cycle.currency))) {
      await conn.rollback();
      throw Object.assign(new Error(`Online payments in ${cycle.currency} are not available`), { status: 400 });
    }

    const totals = await billing.cycleTotals(conn, cycle.id);
    if (totals.outstandingMinor <= 0) { await conn.rollback(); throw conflict('This billing cycle has no amount due'); }

    const [[review]] = await conn.query(
      "SELECT id FROM venue_billing_payments WHERE cycle_id = ? AND status = 'REVIEW' LIMIT 1 FOR UPDATE",
      [cycle.id]
    );
    if (review) {
      await conn.rollback();
      throw conflict('A captured billing payment needs manual review. Do not retry until support resolves it.');
    }

    const [[pending]] = await conn.query(
      "SELECT razorpay_order_id, amount_minor, currency FROM venue_billing_payments WHERE active_cycle_id = ? AND status = 'PENDING' FOR UPDATE",
      [cycle.id]
    );
    if (pending) {
      if (Number(pending.amount_minor) !== totals.outstandingMinor || pending.currency !== cycle.currency) {
        await conn.rollback();
        throw conflict('A payment is already in progress for a different balance. Contact support before retrying.');
      }
      await conn.commit();
      return { order_id: pending.razorpay_order_id, amount_minor: totals.outstandingMinor, currency: cycle.currency, key_id: process.env.RAZORPAY_KEY_ID };
    }

    const rz = gateway();
    const order = await rz.orders.create({
      amount: totals.outstandingMinor,
      currency: cycle.currency,
      receipt: `venue_${turfId}_cycle_${cycle.id}_${Date.now()}`,
      notes: { turf_id: String(turfId), cycle_id: String(cycle.id), owner_id: String(ownerId), purpose: 'venue_billing' },
    });
    await conn.query(
      `INSERT INTO venue_billing_payments
        (cycle_id, turf_id, owner_id, razorpay_order_id, amount_minor, currency, status, active_cycle_id)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [cycle.id, turfId, ownerId, order.id, totals.outstandingMinor, cycle.currency, cycle.id]
    );
    await conn.commit();
    return { order_id: order.id, amount_minor: totals.outstandingMinor, currency: cycle.currency, key_id: process.env.RAZORPAY_KEY_ID };
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* transaction may already be committed */ }
    throw e;
  } finally {
    conn.release();
  }
}

async function applyCapturedPayment({ orderId, paymentId, amountMinor, currency }) {
  if (!orderId || !paymentId) return { notFound: true };
  const conn = await pool.getConnection();
  let ownerId = null;
  let turfId = null;
  let cycleId = null;
  try {
    await conn.beginTransaction();
    const [[payment]] = await conn.query(
      'SELECT * FROM venue_billing_payments WHERE razorpay_order_id = ? FOR UPDATE',
      [orderId]
    );
    if (!payment) { await conn.rollback(); return { notFound: true }; }
    if (payment.status === 'CAPTURED') {
      const samePayment = payment.razorpay_payment_id === paymentId;
      await conn.rollback();
      return { notFound: false, accepted: samePayment, duplicate: samePayment, error: samePayment ? null : 'Order was already settled with a different payment' };
    }
    if (payment.status !== 'PENDING') {
      await conn.rollback();
      return { notFound: false, accepted: false, error: `Payment is ${payment.status.toLowerCase()}` };
    }
    if (Number(amountMinor) !== Number(payment.amount_minor) || String(currency).toUpperCase() !== payment.currency) {
      await conn.query(
        "UPDATE venue_billing_payments SET status = 'REVIEW', active_cycle_id = NULL, failure_reason = 'Captured amount or currency does not match order' WHERE id = ?",
        [payment.id]
      );
      await conn.commit();
      return { notFound: false, accepted: false, error: 'Captured amount or currency does not match the billing order' };
    }

    const [[cycle]] = await conn.query('SELECT * FROM turf_subscription_cycles WHERE id = ? FOR UPDATE', [payment.cycle_id]);
    if (!cycle || cycle.turf_id !== payment.turf_id) {
      await conn.rollback();
      return { notFound: false, accepted: false, error: 'Billing cycle no longer exists' };
    }
    const totals = await billing.cycleTotals(conn, cycle.id);
    if (totals.outstandingMinor !== Number(payment.amount_minor)) {
      await conn.query(
        "UPDATE venue_billing_payments SET status = 'REVIEW', active_cycle_id = NULL, failure_reason = 'Billing balance changed while payment was in progress' WHERE id = ?",
        [payment.id]
      );
      await conn.commit();
      return { notFound: false, accepted: false, error: 'Billing balance changed while payment was in progress; manual review is required' };
    }

    await conn.query(
      "UPDATE venue_billing_payments SET status = 'CAPTURED', razorpay_payment_id = ?, active_cycle_id = NULL, paid_at = NOW() WHERE id = ?",
      [paymentId, payment.id]
    );
    await conn.query(
      'UPDATE turf_subscription_cycles SET paid_separately_minor = paid_separately_minor + ? WHERE id = ?',
      [payment.amount_minor, cycle.id]
    );
    const cycleStatus = await billing.refreshCycleStatus(conn, cycle.id);
    ownerId = Number(payment.owner_id);
    turfId = Number(payment.turf_id);
    cycleId = Number(payment.cycle_id);
    if (cycleStatus.status === 'PAID') {
      await restrictions.releaseForPaidCycle(conn, turfId, cycleId);
    }
    await conn.commit();

    fire('owner.billing_payment_received', { ownerId, turfId, cycleId, paymentId });
    return { notFound: false, accepted: true, status: cycleStatus.status };
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* transaction may already be committed */ }
    throw e;
  } finally {
    conn.release();
  }
}

async function markFailed({ orderId, reason = 'Payment failed' }) {
  if (!orderId) return { notFound: true };
  const [result] = await pool.query(
    "UPDATE venue_billing_payments SET failure_reason = ? WHERE razorpay_order_id = ? AND status = 'PENDING'",
    [String(reason).slice(0, 255), orderId]
  );
  if (result.affectedRows) {
    const [[payment]] = await pool.query('SELECT owner_id, turf_id, cycle_id, razorpay_payment_id FROM venue_billing_payments WHERE razorpay_order_id = ?', [orderId]);
    fire('owner.billing_payment_failed', { ...payment, reason });
    return { notFound: false, updated: true };
  }
  const [[existing]] = await pool.query('SELECT id FROM venue_billing_payments WHERE razorpay_order_id = ?', [orderId]);
  return { notFound: !existing, updated: false };
}

async function verifySignature({ orderId, paymentId, signature }) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest();
  let received;
  try { received = Buffer.from(String(signature), 'hex'); } catch (_) { return false; }
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

module.exports = { createOrder, applyCapturedPayment, markFailed, verifySignature };
