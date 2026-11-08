// /api/owner-billing — READ-ONLY view for venue owners of the platform terms that apply to THEIR venues and of their
// own settlement statements. There is deliberately no write route here: only admins (routes/admin-billing.js) can
// change a billing model, price, commission, flat fee, fee or tax rule.
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyOwner } = require('../middleware/auth');
const billing = require('../services/billingConfig');
const routeSplit = require('../services/routeSplit');
const payments = require('../services/venueBillingPayments');
const provider = require('../services/routeProvider');

router.use(verifyToken, verifyOwner);
const bad = (res, status, error) => res.status(status).json({ success: false, error });

// every query below is scoped by owner_id = the caller; a venue id belonging to anyone else is a 404, never data
async function ownTurf(req, res) {
  const [[t]] = await pool.query('SELECT id FROM turfs WHERE id = ? AND owner_id = ?', [Number(req.params.id), req.user.id]);
  if (!t) { res.status(404).json({ success: false, error: 'Venue not found' }); return null; }
  return routeSplit.getRouteConfig(t.id);
}

router.get('/turfs', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, COALESCE(currency_code, \'INR\') AS currency, approval_status FROM turfs WHERE owner_id = ? ORDER BY name', [req.user.id]);
    res.json({ success: true, turfs: rows });
  } catch (e) { res.status(500).json({ success: false, error: 'Could not load your venues' }); }
});

router.get('/overview', async (req, res) => {
  try {
    const [turfs] = await pool.query(
      `SELECT id, name, COALESCE(currency_code, 'INR') AS currency, approval_status, sport_type
       FROM turfs WHERE owner_id = ? ORDER BY name`,
      [req.user.id]
    );
    const venues = await Promise.all(turfs.map(async (item) => {
      const turf = await routeSplit.getRouteConfig(item.id);
      const config = await billing.getEffectiveConfig(turf);
      const subscription = await billing.subscriptionOverview(turf, config);
      const [restrictionHistory] = await pool.query(
        `SELECT id, cycle_id, outstanding_minor, currency, reason, expected_impact, applied_at, removed_at, remove_reason
         FROM turf_billing_restrictions WHERE turf_id = ? ORDER BY id DESC`,
        [item.id]
      );
      const cycleIds = (subscription?.cycles || []).map((cycle) => cycle.id);
      let paymentHistory = [];
      if (cycleIds.length) {
        const [rows] = await pool.query(
          `SELECT id, cycle_id, razorpay_payment_id, amount_minor, currency, status, failure_reason, created_at, paid_at
           FROM venue_billing_payments WHERE owner_id = ? AND turf_id = ? AND cycle_id IN (${cycleIds.map(() => '?').join(',')})
           ORDER BY id DESC`,
          [req.user.id, item.id, ...cycleIds]
        );
        paymentHistory = rows;
      }
      return {
        ...item,
        billing: {
          billing_model: config.billing_model,
          source: config.source,
          version: config.version || 0,
          commission_percent: config.commission_bps == null ? null : config.commission_bps / 100,
          flat_fee_minor: config.flat_fee_minor,
          subscription_amount_minor: config.subscription_amount_minor,
          subscription_period: config.subscription_period,
          subscription_policy: config.subscription_policy,
          currency: config.currency,
          effective_from: config.effective_from,
          subscription,
          restriction: {
            active: restrictionHistory.find((restriction) => !restriction.removed_at) || null,
            history: restrictionHistory,
          },
          payment_history: paymentHistory,
        },
      };
    }));
    res.json({ success: true, venues });
  } catch (e) {
    console.error('[owner-billing] Could not load owner billing overview:', e);
    bad(res, 500, 'Could not load your venue billing');
  }
});

router.get('/turfs/:id/terms', async (req, res) => {
  try {
    const turf = await ownTurf(req, res); if (!turf) return;
    const c = await billing.getEffectiveConfig(turf);
    const md = await billing.minorDigitsFor(c.currency);
    const major = (m) => (m === null || m === undefined ? null : Number((m / 10 ** md).toFixed(md)));
    res.json({
      success: true, read_only: true,
      terms: {
        venue: turf.name, currency: c.currency, billing_model: c.billing_model,
        commission_percent: c.commission_bps === null ? null : c.commission_bps / 100,
        flat_fee: major(c.flat_fee_minor), subscription_amount: major(c.subscription_amount_minor),
        subscription_period: c.subscription_period, subscription_policy: c.subscription_policy,
        min_fee: major(c.min_fee_minor), max_fee: major(c.max_fee_minor),
        tax_mode: c.tax_mode, tax_percent: c.tax_bps === null ? null : c.tax_bps / 100,
        effective_from: c.effective_from, version: c.version,
      },
      subscription: await billing.subscriptionOverview(turf, c),
    });
  } catch (e) { res.status(500).json({ success: false, error: 'Could not load the terms' }); }
});

router.get('/turfs/:id/statement', async (req, res) => {
  try {
    const turf = await ownTurf(req, res); if (!turf) return;
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const [rows] = await pool.query(
      `SELECT id, razorpay_payment_id, status, billing_model, currency, captured_minor, platform_fee_minor, tax_minor, customer_fee_minor, subscription_deduction_minor, owner_transfer_minor, created_at
       FROM route_split_transfers WHERE turf_id = ? AND status <> 'SUPERSEDED' ORDER BY id DESC LIMIT ${lim}`, [turf.id]);
    res.json({ success: true, statement: rows.map((r) => ({ ...r, owner_status: r.status === 'SUCCESS' ? 'Transferred' : r.status === 'NOT_REQUIRED' ? 'Nothing to transfer' : r.status === 'FAILED' ? 'Under review' : 'Processing' })) });
  } catch (e) { res.status(500).json({ success: false, error: 'Could not load the statement' }); }
});

router.post('/turfs/:id/subscription/cycles/:cycleId/order', async (req, res) => {
  try {
    const turf = await ownTurf(req, res);
    if (!turf) return;
    const result = await payments.createOrder({ turfId: turf.id, cycleId: Number(req.params.cycleId), ownerId: req.user.id });
    res.json({ success: true, ...result });
  } catch (e) {
    if (e.status) return bad(res, e.status, e.message);
    console.error('[owner-billing] Could not create Razorpay order:', e);
    bad(res, 500, 'Could not start the billing payment');
  }
});

router.post('/payments/verify', async (req, res) => {
  try {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    if (!(await payments.verifySignature({ orderId, paymentId, signature }))) {
      return bad(res, 400, 'Payment signature is invalid');
    }
    const [[order]] = await pool.query(
      `SELECT id, owner_id, razorpay_order_id, amount_minor, currency
       FROM venue_billing_payments WHERE razorpay_order_id = ? AND owner_id = ?`,
      [orderId, req.user.id]
    );
    if (!order) return bad(res, 404, 'Billing payment order not found');

    const gatewayPayment = await provider.fetchPayment(paymentId);
    if (gatewayPayment.order_id !== orderId) return bad(res, 400, 'Payment does not belong to this billing order');
    if (gatewayPayment.status !== 'captured') return bad(res, 409, 'Payment has not been captured yet');
    const result = await payments.applyCapturedPayment({
      orderId,
      paymentId,
      amountMinor: Number(gatewayPayment.amount),
      currency: gatewayPayment.currency,
    });
    if (!result.accepted) return bad(res, 409, result.error || 'Payment is awaiting review');
    res.json({ success: true, status: result.status, duplicate: !!result.duplicate });
  } catch (e) {
    if (e.status) return bad(res, e.status, e.message);
    console.error('[owner-billing] Payment verification failed:', e);
    bad(res, 503, 'Payment could not be verified right now. Billing remains unchanged; refresh before retrying.');
  }
});

// A dismissed checkout leaves the order open so a late capture cannot race a second order.
router.post('/payments/cancel', async (_req, res) => res.json({ success: true, payment_status: 'unchanged' }));

module.exports = router;
