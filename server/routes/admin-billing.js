// /api/admin/billing — admin-only: dashboard overview, per-turf financial profile + versioned billing configuration,
// customer fee/tax rules, subscription cycle payments, Razorpay Payment-ID reconciliation, refund transfer reversal.
//
// Every route here requires a valid admin token AND that the admin still exists in the database. Owners and customers
// get 403 on all of it. No amount, owner id, linked account or percentage is ever taken from a request to move money:
// money-moving routes only name a payment/refund and the server works out the rest.
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const billing = require('../services/billingConfig');
const pricing = require('../services/pricing');
const routeSplit = require('../services/routeSplit');
const provider = require('../services/routeProvider');
const recon = require('../services/paymentReconciliation');
const restrictions = require('../services/venueBillingRestrictions');
const { acquireSlotLock, releaseSlotLock } = require('../services/slotLock');
const { notify } = require('../utils/notifications/service');

async function requireAdminRecord(req, res, next) {
  try {
    const [[a]] = await pool.query('SELECT id FROM admins WHERE id = ?', [req.user.id]);
    if (!a) return res.status(403).json({ success: false, error: 'Admin account not found' });
    next();
  } catch (e) { res.status(500).json({ success: false, error: 'Could not verify the admin account' }); }
}
router.use(verifyToken, verifyAdmin, requireAdminRecord);

const bad = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });
const safe = async (fn, fallback) => { try { return await fn(); } catch (e) { return fallback; } };
const num = (v) => Number(v || 0);

// tiny per-admin throttle for the Razorpay-facing endpoints (each call hits the gateway)
const hits = new Map();
function throttle(limit, windowMs) {
  return (req, res, next) => {
    const key = `${req.user.id}:${req.path}`; const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= limit) return bad(res, 429, 'Too many requests — wait a moment and try again');
    list.push(now); hits.set(key, list); next();
  };
}

function handleError(res, e, fallback) {
  if (e instanceof pricing.PricingConfigError) return bad(res, 400, e.message, { errors: e.errors });
  if (e && e.status) return bad(res, e.status, e.message);
  console.error(`[admin-billing] ${fallback}:`, e);
  return bad(res, 500, fallback);
}

// ------------------------------------------------------------------------------------------------------------------
// GET /overview — every number comes from the database; each metric has ONE definition (see `definitions`).
// ------------------------------------------------------------------------------------------------------------------
router.get('/overview', async (req, res) => {
  try {
    const one = async (sql, params = []) => (await pool.query(sql, params))[0][0] || {};
    const [venues, owners, bookingCounts] = await Promise.all([
      one(`SELECT COUNT(*) AS total, SUM(approval_status = 'APPROVED') AS approved, SUM(approval_status IN ('PENDING_APPROVAL','ACTION_REQUIRED')) AS pending FROM turfs`),
      one('SELECT COUNT(*) AS total FROM owners'),
      one(`SELECT COUNT(*) AS total FROM bookings WHERE payment_status = 'success' AND status = 'confirmed'`),
    ]);

    // customer money, per currency: captured = what customers actually paid online (advance or full), never the booking value
    const [captured] = await pool.query(
      `SELECT COALESCE(t.currency_code, 'INR') AS currency,
              COUNT(*) AS bookings,
              SUM(ROUND(COALESCE(b.advance_amount, b.amount) * 100)) AS captured_minor,
              SUM(ROUND(COALESCE(b.original_price, b.amount) * 100)) AS gross_booking_value_minor
       FROM bookings b JOIN turfs t ON t.id = b.turf_id
       WHERE b.payment_status = 'success' AND b.status = 'confirmed'
       GROUP BY COALESCE(t.currency_code, 'INR')`);

    // settlement ledger: only rows that were actually computed (FAILED rows have no amounts and are counted separately)
    const [ledger] = await pool.query(
      `SELECT COALESCE(currency, 'INR') AS currency, status,
              COUNT(*) AS n,
              SUM(COALESCE(captured_minor, 0)) AS captured_minor,
              SUM(COALESCE(owner_transfer_minor, 0)) AS owner_minor,
              SUM(COALESCE(platform_fee_minor, 0)) AS fee_minor,
              SUM(COALESCE(customer_fee_minor, 0)) AS customer_fee_minor,
              SUM(COALESCE(subscription_deduction_minor, 0)) AS deduction_minor,
              SUM(COALESCE(tax_minor, 0)) AS tax_minor,
              SUM(CASE WHEN environment <> 'live' THEN 1 ELSE 0 END) AS simulated_n
       FROM route_split_transfers WHERE status <> 'SUPERSEDED' GROUP BY COALESCE(currency, 'INR'), status`);

    const refunds = await safe(async () => (await pool.query(
      `SELECT currency_code AS currency, refund_status, COUNT(*) AS n, SUM(refund_amount_minor) AS minor FROM refunds GROUP BY currency_code, refund_status`))[0], []);

    const outstandingSubs = await safe(async () => (await pool.query(
      `SELECT c.currency, COUNT(*) AS cycles,
              SUM(GREATEST(c.amount_minor - c.paid_separately_minor - COALESCE(d.ded, 0), 0)) AS outstanding_minor
       FROM turf_subscription_cycles c
       LEFT JOIN (SELECT cycle_id, SUM(amount_minor) AS ded FROM turf_subscription_deductions WHERE reversed_at IS NULL GROUP BY cycle_id) d ON d.cycle_id = c.id
       WHERE c.cycle_start <= CURDATE() GROUP BY c.currency`))[0], []);

    const currencies = new Set([...captured.map((r) => r.currency), ...ledger.map((r) => r.currency), ...refunds.map((r) => r.currency).filter(Boolean)]);
    const byCurrency = {};
    for (const cur of currencies) {
      const cap = captured.find((r) => r.currency === cur) || {};
      const L = ledger.filter((r) => r.currency === cur);
      const sum = (statuses, f) => L.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + num(r[f]), 0);
      const SETTLED = ['SUCCESS', 'NOT_REQUIRED'], OPEN = ['PENDING', 'PROCESSING', 'RETRY_REQUIRED'];
      const realSuccess = L.filter((r) => r.status === 'SUCCESS').reduce((s, r) => s + num(r.owner_minor) * (num(r.n) ? (num(r.n) - num(r.simulated_n)) / num(r.n) : 0), 0);
      const retained = sum(SETTLED, 'captured_minor') - sum(SETTLED, 'owner_minor');
      const tax = sum(SETTLED, 'tax_minor');
      const ref = (st) => refunds.filter((r) => r.currency === cur && st.includes(r.refund_status)).reduce((s, r) => s + num(r.minor), 0);
      const sub = outstandingSubs.find((r) => r.currency === cur) || {};
      byCurrency[cur] = {
        captured_payments_minor: num(cap.captured_minor),                      // customer money actually captured online
        gross_booking_value_minor: num(cap.gross_booking_value_minor),         // full booking value, includes balance payable at the venue
        platform_revenue_minor: retained - tax,                                // what the platform kept from settled payments, net of tax it must remit
        platform_fees_collected_minor: sum(SETTLED, 'customer_fee_minor'),     // customer service fees only
        tax_collected_minor: tax,                                              // tax on platform fees (liability, not revenue)
        owner_eligible_minor: sum([...SETTLED, ...OPEN], 'owner_minor'),       // owners' share of captured payments, whether or not it has moved yet
        completed_transfers_minor: Math.round(realSuccess),                    // owner transfers confirmed at Razorpay (simulated test-mode ones excluded)
        pending_transfers_minor: sum(OPEN, 'owner_minor'),
        pending_transfers_count: L.filter((r) => OPEN.includes(r.status)).reduce((s, r) => s + num(r.n), 0),
        simulated_transfers_count: L.reduce((s, r) => s + num(r.simulated_n), 0),
        refunds_completed_minor: ref(['REFUND_COMPLETED']),
        refunds_pending_minor: ref(['REFUND_PENDING', 'REFUND_PROCESSING']),
        subscription_outstanding_minor: num(sub.outstanding_minor),
      };
    }
    const failedTransfers = ledger.filter((r) => r.status === 'FAILED').reduce((s, r) => s + num(r.n), 0);

    const [recentBookings] = await pool.query(
      `SELECT b.id, b.customer_name, b.booking_date, b.time_slot, b.status, b.payment_status, COALESCE(b.advance_amount, b.amount) AS paid, t.name AS turf_name, COALESCE(t.currency_code, 'INR') AS currency, b.created_at
       FROM bookings b JOIN turfs t ON t.id = b.turf_id WHERE b.payment_status IN ('success','pending','failed') ORDER BY b.id DESC LIMIT 8`);
    const [pendingApprovals] = await pool.query(
      `SELECT t.id, t.name, t.approval_status, o.name AS owner_name, t.created_at FROM turfs t LEFT JOIN owners o ON o.id = t.owner_id
       WHERE t.approval_status IN ('PENDING_APPROVAL','ACTION_REQUIRED') ORDER BY t.created_at DESC LIMIT 6`);
    const [attention] = await pool.query(
      `SELECT r.id, r.status, r.razorpay_payment_id, r.error_message, r.created_at, t.name AS turf_name, t.id AS turf_id, COALESCE(r.owner_transfer_minor, 0) AS owner_minor, COALESCE(r.currency, 'INR') AS currency
       FROM route_split_transfers r JOIN turfs t ON t.id = r.turf_id WHERE r.status IN ('FAILED','RETRY_REQUIRED','PENDING','PROCESSING') ORDER BY r.id DESC LIMIT 8`);

    // reconciliation alerts: facts the admin should look at, each with a count and a pointer to the tool that fixes it
    const alerts = [];
    const missing = await safe(async () => (await one(
      `SELECT COUNT(*) AS n FROM bookings b JOIN turfs t ON t.id = b.turf_id
       WHERE b.payment_status = 'success' AND b.payment_id IS NOT NULL AND t.route_enabled = true
         AND NOT EXISTS (SELECT 1 FROM route_split_transfers r WHERE r.razorpay_payment_id = b.payment_id)`)).n, 0);
    if (num(missing) > 0) alerts.push({ key: 'missing_transfer', severity: 'high', count: num(missing), message: 'Paid bookings on Route-enabled venues with no transfer record', action: 'payments' });
    const stuck = attention.filter((r) => r.status === 'RETRY_REQUIRED').length;
    if (stuck) alerts.push({ key: 'retry_required', severity: 'high', count: stuck, message: 'Owner transfers that failed at the gateway and need a retry', action: 'payments' });
    if (failedTransfers) alerts.push({ key: 'failed_transfers', severity: 'medium', count: failedTransfers, message: 'Payments Route could not process (configuration problem)', action: 'transfers' });
    const unreversed = await safe(async () => (await one(
      `SELECT COUNT(*) AS n FROM refunds f JOIN route_split_transfers r ON r.razorpay_payment_id = f.gateway_payment_id AND r.status = 'SUCCESS'
       WHERE f.refund_status = 'REFUND_COMPLETED' AND NOT EXISTS (SELECT 1 FROM route_transfer_reversals v WHERE v.refund_id = f.id)`)).n, 0);
    if (num(unreversed) > 0) alerts.push({ key: 'refund_not_reversed', severity: 'high', count: num(unreversed), message: 'Refunded payments whose owner transfer has not been reversed', action: 'refunds' });
    const noAcct = await safe(async () => (await one(`SELECT COUNT(*) AS n FROM turfs WHERE route_enabled = true AND (route_linked_account_id IS NULL OR route_linked_account_id = '')`)).n, 0);
    if (num(noAcct) > 0) alerts.push({ key: 'no_linked_account', severity: 'high', count: num(noAcct), message: 'Route-enabled venues with no linked account', action: 'turfs' });

    const [activity] = await pool.query(
      `SELECT a.id, 'billing' AS kind, a.action, a.field, a.new_value AS detail, a.created_at, ad.username AS admin_name, t.name AS turf_name
       FROM route_audit_log a LEFT JOIN admins ad ON ad.id = a.admin_id LEFT JOIN turfs t ON t.id = a.turf_id ORDER BY a.id DESC LIMIT 8`);
    const payActions = await safe(async () => (await pool.query(
      `SELECT p.id, 'payment' AS kind, p.action, p.razorpay_payment_id AS field, p.outcome AS detail, p.created_at, ad.username AS admin_name, NULL AS turf_name
       FROM admin_payment_actions p LEFT JOIN admins ad ON ad.id = p.admin_id ORDER BY p.id DESC LIMIT 6`))[0], []);

    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      platform: { venues_total: num(venues.total), venues_approved: num(venues.approved), venues_pending: num(venues.pending), owners_total: num(owners.total), bookings_total: num(bookingCounts.total) },
      by_currency: byCurrency,
      primary_currency: byCurrency.INR ? 'INR' : (Object.keys(byCurrency)[0] || 'INR'),
      failed_transfers_count: failedTransfers,
      recent_bookings: recentBookings, pending_approvals: pendingApprovals, transfers_needing_attention: attention, alerts,
      recent_activity: [...activity, ...payActions].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 10),
      definitions: {
        captured_payments: 'Customer money actually captured online (advance or full payment). Authorizations are not counted.',
        gross_booking_value: 'Full value of confirmed bookings, including any balance the customer pays at the venue. This is NOT platform revenue.',
        platform_revenue: 'What the platform kept from settled payments (commission, subscription deductions, customer fees) minus the tax it must remit.',
        tax_collected: 'Tax on platform fees. A liability to remit, not revenue.',
        owner_eligible: "Owners' share of captured payments (settled or still to be transferred).",
        completed_transfers: 'Owner transfers confirmed at Razorpay. Pending, failed and simulated (test-mode) transfers are never counted here.',
        pending_transfers: 'Owner transfers created but not yet confirmed (pending, processing, or awaiting retry).',
        subscription_outstanding: 'Unpaid balance of started subscription cycles (amount − deductions − separate payments).',
      },
    });
  } catch (e) { handleError(res, e, 'Could not load the overview'); }
});

// ------------------------------------------------------------------------------------------------------------------
// Turf financial profile + billing configuration
// ------------------------------------------------------------------------------------------------------------------
router.get('/turfs', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const where = []; const params = [];
    if (q) { where.push('(t.name LIKE ? OR o.name LIKE ? OR t.sport_type LIKE ? OR t.id = ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, Number(q) || 0); }
    if (req.query.model) { where.push('h.billing_model = ?'); params.push(String(req.query.model)); }
    if (req.query.status) { where.push(`CASE
      WHEN c.id IS NULL AND h.billing_model = 'SUBSCRIPTION' THEN 'NOT_OPENED'
      WHEN c.id IS NULL THEN 'NOT_APPLICABLE'
      WHEN GREATEST(c.amount_minor - c.paid_separately_minor - COALESCE(ded.deducted_minor, 0), 0) = 0 THEN 'PAID'
      WHEN DATEDIFF(CURDATE(), c.cycle_start) > COALESCE(h.grace_period_days, 0) THEN 'OVERDUE'
      ELSE 'PAYMENT_DUE' END = ?`); params.push(String(req.query.status).toUpperCase()); }
    // TiDB does not support subqueries inside ON clauses. Use a derived table with ROW_NUMBER() to
    // pick the latest effective billing config per turf, then LEFT JOIN the result.
    const [rows] = await pool.query(
      `SELECT t.id, t.name, t.sport_type, t.approval_status, t.country_code, COALESCE(t.currency_code,'INR') AS currency, o.id AS owner_id, o.name AS owner_name,
              t.route_enabled, t.route_status, t.route_linked_account_id, t.route_environment,
              COALESCE(h.billing_model, CASE WHEN t.route_commission_type = 'subscription' OR t.billing_model = 'MONTHLY' THEN 'SUBSCRIPTION' WHEN t.route_commission_type = 'flat' THEN 'FLAT' WHEN t.route_commission_type = 'percentage' OR t.route_split_percentage IS NOT NULL OR t.commission_percentage IS NOT NULL THEN 'PERCENTAGE' ELSE NULL END) AS billing_model,
              h.version AS config_version, h.commission_bps, h.flat_fee_minor, h.subscription_amount_minor, h.subscription_period, h.subscription_policy, h.grace_period_days,
              c.id AS current_cycle_id, c.cycle_start, c.cycle_end, c.currency AS cycle_currency, c.amount_minor AS cycle_amount_minor,
              c.paid_separately_minor, COALESCE(ded.deducted_minor, 0) AS deducted_minor,
              GREATEST(c.amount_minor - c.paid_separately_minor - COALESCE(ded.deducted_minor, 0), 0) AS outstanding_minor,
              CASE
                WHEN c.id IS NULL AND h.billing_model = 'SUBSCRIPTION' THEN 'NOT_OPENED'
                WHEN c.id IS NULL THEN 'NOT_APPLICABLE'
                WHEN GREATEST(c.amount_minor - c.paid_separately_minor - COALESCE(ded.deducted_minor, 0), 0) = 0 THEN 'PAID'
                WHEN DATEDIFF(CURDATE(), c.cycle_start) > COALESCE(h.grace_period_days, 0) THEN 'OVERDUE'
                ELSE 'PAYMENT_DUE' END AS billing_status,
              CASE WHEN h.id IS NOT NULL THEN 0 WHEN t.route_commission_type = 'subscription' OR t.billing_model = 'MONTHLY' THEN (t.monthly_subscription_amount IS NULL OR t.monthly_subscription_amount <= 0 OR t.subscription_start_date IS NULL) WHEN t.route_commission_type = 'flat' THEN (t.route_flat_amount IS NULL OR t.route_flat_amount < 0) WHEN t.route_commission_type = 'percentage' OR t.route_split_percentage IS NOT NULL OR t.commission_percentage IS NOT NULL THEN (COALESCE(t.route_split_percentage, t.commission_percentage) IS NULL OR COALESCE(t.route_split_percentage, t.commission_percentage) < 0 OR COALESCE(t.route_split_percentage, t.commission_percentage) > 100) ELSE 1 END AS billing_configuration_error
       FROM turfs t LEFT JOIN owners o ON o.id = t.owner_id
       LEFT JOIN (
         SELECT id, turf_id, billing_model, version,
                ROW_NUMBER() OVER (PARTITION BY turf_id ORDER BY effective_from DESC, id DESC) AS rn
         FROM turf_billing_config_history
         WHERE effective_from <= NOW()
       ) h ON h.turf_id = t.id AND h.rn = 1
       LEFT JOIN (
         SELECT c0.*, ROW_NUMBER() OVER (PARTITION BY c0.turf_id ORDER BY c0.cycle_start DESC, c0.id DESC) AS rn
         FROM turf_subscription_cycles c0 WHERE c0.cycle_start <= CURDATE() AND c0.cycle_end >= CURDATE()
       ) c ON c.turf_id = t.id AND c.rn = 1
       LEFT JOIN (
         SELECT cycle_id, SUM(amount_minor) AS deducted_minor
         FROM turf_subscription_deductions WHERE reversed_at IS NULL GROUP BY cycle_id
       ) ded ON ded.cycle_id = c.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.name ASC LIMIT 500`, params);
    res.json({ success: true, turfs: rows });
  } catch (e) { handleError(res, e, 'Could not load venues'); }
});

router.get('/ledger', async (req, res) => {
  try {
    const [models] = await pool.query(
      `SELECT COALESCE(h.billing_model,
         CASE WHEN t.route_commission_type = 'subscription' OR t.billing_model = 'MONTHLY' THEN 'SUBSCRIPTION'
              WHEN t.route_commission_type = 'flat' THEN 'FLAT'
              WHEN t.route_commission_type = 'percentage' OR t.route_split_percentage IS NOT NULL OR t.commission_percentage IS NOT NULL THEN 'PERCENTAGE'
              ELSE 'UNCONFIGURED' END) AS billing_model, COUNT(*) AS venues
       FROM turfs t LEFT JOIN (
         SELECT turf_id, billing_model, ROW_NUMBER() OVER (PARTITION BY turf_id ORDER BY effective_from DESC, id DESC) AS rn
         FROM turf_billing_config_history WHERE effective_from <= NOW()
       ) h ON h.turf_id = t.id AND h.rn = 1
       GROUP BY billing_model`
    );
    const [cycles] = await pool.query(
      `SELECT c.currency,
         SUM(c.amount_minor) AS billed_minor,
         SUM(c.paid_separately_minor + COALESCE(d.deducted_minor, 0)) AS paid_minor,
         SUM(GREATEST(c.amount_minor - c.paid_separately_minor - COALESCE(d.deducted_minor, 0), 0)) AS outstanding_minor,
         SUM(CASE WHEN GREATEST(c.amount_minor - c.paid_separately_minor - COALESCE(d.deducted_minor, 0), 0) > 0
                       AND DATEDIFF(CURDATE(), c.cycle_start) > COALESCE(h.grace_period_days, 0)
                  THEN GREATEST(c.amount_minor - c.paid_separately_minor - COALESCE(d.deducted_minor, 0), 0) ELSE 0 END) AS overdue_minor,
         SUM(CASE WHEN GREATEST(c.amount_minor - c.paid_separately_minor - COALESCE(d.deducted_minor, 0), 0) > 0
                       AND DATEDIFF(CURDATE(), c.cycle_start) > COALESCE(h.grace_period_days, 0) THEN 1 ELSE 0 END) AS overdue_cycles
       FROM turf_subscription_cycles c
       LEFT JOIN turf_billing_config_history h ON h.id = c.config_history_id
       LEFT JOIN (SELECT cycle_id, SUM(amount_minor) AS deducted_minor FROM turf_subscription_deductions WHERE reversed_at IS NULL GROUP BY cycle_id) d ON d.cycle_id = c.id
       WHERE c.policy = 'SEPARATE' AND c.cycle_start <= CURDATE()
       GROUP BY c.currency`
    );
    const [payments] = await pool.query(
      `SELECT currency, SUM(amount_minor) AS paid_minor
       FROM venue_billing_payments WHERE status = 'CAPTURED' GROUP BY currency`
    );
    const [currentSubs] = await pool.query(
      `SELECT COUNT(*) AS count FROM turf_subscription_cycles
       WHERE cycle_start <= CURDATE() AND cycle_end >= CURDATE()`
    );
    const byCurrency = {};
    for (const row of cycles) byCurrency[row.currency] = {
      billed_minor: Number(row.billed_minor || 0),
      paid_minor: Number(row.paid_minor || 0),
      outstanding_minor: Number(row.outstanding_minor || 0),
      overdue_minor: Number(row.overdue_minor || 0),
      overdue_cycles: Number(row.overdue_cycles || 0),
    };
    for (const row of payments) {
      if (!byCurrency[row.currency]) byCurrency[row.currency] = { billed_minor: 0, paid_minor: 0, outstanding_minor: 0, overdue_minor: 0, overdue_cycles: 0 };
      byCurrency[row.currency].online_payments_captured_minor = Number(row.paid_minor || 0);
    }
    for (const value of Object.values(byCurrency)) if (value.online_payments_captured_minor == null) value.online_payments_captured_minor = 0;
    res.json({
      success: true,
      summary: {
        total_venues: models.reduce((sum, r) => sum + Number(r.venues || 0), 0),
        by_model: Object.fromEntries(models.map((r) => [r.billing_model, Number(r.venues || 0)])),
        active_subscriptions: Number(currentSubs[0]?.count || 0),
        by_currency: byCurrency,
      },
      definitions: {
        paid_minor: 'Subscription-cycle amounts settled through booking proceeds or a recorded separate payment; currencies are kept separate.',
        outstanding_minor: 'Unpaid balance on separately billed subscription cycles. Percentage and per-booking flat fees are accounted for at booking settlement, not counted as subscription debt.',
        overdue_minor: 'Outstanding separate subscription balance after its configured grace period, measured from the cycle start/due date.',
      },
    });
  } catch (e) { handleError(res, e, 'Could not load the billing ledger'); }
});

router.get('/turfs/:id/financial-profile', async (req, res) => {
  try {
    const turf = await routeSplit.getRouteConfig(req.params.id);
    if (!turf) return bad(res, 404, 'Venue not found');
    const [[owner]] = await pool.query('SELECT id, name, email FROM owners WHERE id = ?', [turf.owner_id]);
    const config = await billing.getEffectiveConfig(turf);
    const history = await billing.listHistory(turf.id);
    const upcoming = history.filter((h) => new Date(h.effective_from) > new Date());
    let account = null;
    if (routeSplit.validLinkedAccountId(turf.route_linked_account_id || '') && turf.route_environment === 'live') account = await safe(() => provider.fetchAccount(turf.route_linked_account_id), { status: 'unknown' });
    const rule = await billing.getActiveFeeRule(turf.country_code || 'IN', turf.currency_code || 'INR');
    const [bookings] = await pool.query(
      `SELECT id, customer_name, booking_date, time_slot, status, payment_status, amount, advance_amount, payment_id FROM bookings WHERE turf_id = ? ORDER BY id DESC LIMIT 10`, [turf.id]);
    const [transfers] = await pool.query(
      `SELECT id, razorpay_payment_id, razorpay_transfer_id, status, billing_model, captured_minor, platform_fee_minor, tax_minor, subscription_deduction_minor, owner_transfer_minor, currency, source, error_message, created_at
       FROM route_split_transfers WHERE turf_id = ? AND status <> 'SUPERSEDED' ORDER BY id DESC LIMIT 10`, [turf.id]);
    const [restrictionHistory] = await pool.query(
      `SELECT id, cycle_id, outstanding_minor, currency, reason, expected_impact, applied_by, applied_at, removed_by, removed_at, remove_reason
       FROM turf_billing_restrictions WHERE turf_id = ? ORDER BY id DESC`,
      [turf.id]
    );
    const refunds = await safe(async () => (await pool.query('SELECT id, refund_status, refund_amount_minor, currency_code, created_at FROM refunds WHERE venue_id = ? ORDER BY id DESC LIMIT 10', [turf.id]))[0], []);
    res.json({
      success: true,
      turf: { id: turf.id, name: turf.name, approval_status: turf.approval_status, country_code: turf.country_code || 'IN', currency: turf.currency_code || 'INR' },
      owner: owner || null,
      route: { enabled: !!turf.route_enabled, status: turf.route_status, environment: turf.route_environment, linked_account_id: turf.route_linked_account_id || null,
        linked_account_format_valid: routeSplit.validLinkedAccountId(turf.route_linked_account_id || ''), linked_account_status: account ? account.status : null,
        ready: routeSplit.isRouteConnected(turf), approved_at: turf.route_approved_at },
      config, config_problems: billing.validateForSettlement(config), upcoming_configs: upcoming, history,
      subscription: await billing.subscriptionOverview(turf, config),
      restriction: {
        active: restrictionHistory.find((item) => !item.removed_at) || null,
        history: restrictionHistory,
      },
      fee_rule: rule, recent_bookings: bookings, recent_transfers: transfers, recent_refunds: refunds,
    });
  } catch (e) { handleError(res, e, 'Could not load the financial profile'); }
});

router.post('/turfs/:id/restriction', async (req, res) => {
  const turfId = Number(req.params.id);
  const { action, reason } = req.body || {};
  const documentedReason = String(reason || '').trim();
  if (!Number.isSafeInteger(turfId) || turfId <= 0) return bad(res, 400, 'Invalid venue id');
  if (!['apply', 'remove'].includes(action)) return bad(res, 400, 'Action must be apply or remove');
  if (documentedReason.length < 3 || documentedReason.length > 500) return bad(res, 400, 'A reason between 3 and 500 characters is required');

  let locked = false;
  try {
    locked = await acquireSlotLock(turfId, null, null);
    if (!locked) return bad(res, 503, 'Could not lock venue bookings. Please retry.');
    const [[turf]] = await pool.query('SELECT id, name, owner_id, currency_code FROM turfs WHERE id = ?', [turfId]);
    if (!turf) return bad(res, 404, 'Venue not found');

    if (action === 'apply') {
      const cycleId = Number(req.body.cycle_id);
      if (!Number.isSafeInteger(cycleId) || cycleId <= 0) return bad(res, 400, 'A subscription cycle is required');
      const routeTurf = await routeSplit.getRouteConfig(turf.id);
      const config = await billing.getEffectiveConfig(routeTurf);
      const subscription = await billing.subscriptionOverview(routeTurf, config);
      const cycle = subscription?.cycles.find((item) => Number(item.id) === cycleId);
      if (!cycle) return bad(res, 404, 'Subscription cycle not found for this venue');
      const result = await restrictions.apply({ turfId, cycleId, adminId: req.user.id, reason: documentedReason });
      let ownerNotice = 'not_applicable';
      if (turf.owner_id) {
        try {
          const notice = await notify({
            to: { type: 'owner', id: turf.owner_id },
            type: 'OWNER_BILLING_NOTICE',
            eventKey: `billing-restriction:${result.id}:applied`,
            data: {
              noticeKind: 'BOOKING_RESTRICTION_APPLIED', turfId, venue: turf.name,
              plan: `${config.subscription_period} subscription`,
              amountMinor: result.outstanding_minor, currency: result.currency,
              dueDate: cycle.due_date, reason: documentedReason, expectedImpact: restrictions.EXPECTED_IMPACT,
            },
          });
          ownerNotice = notice.error ? 'not_persisted' : notice.id ? 'in_app_persisted' : 'in_app_already_persisted';
          if (notice.error) console.error('[admin-billing] Restriction applied but owner notice could not be persisted:', notice.error);
        } catch (error) {
          ownerNotice = 'not_persisted';
          console.error('[admin-billing] Restriction applied but owner notice failed:', error);
        }
      }
      return res.json({
        success: true,
        restriction: { ...result, active: true, applied_at: new Date().toISOString(), reason: documentedReason },
        venue: turf.name,
        owner_id: turf.owner_id,
        outstanding_minor: result.outstanding_minor,
        currency: result.currency,
        expected_impact: restrictions.EXPECTED_IMPACT,
        owner_notice: ownerNotice,
      });
    }

    const result = await restrictions.remove({ turfId, adminId: req.user.id, reason: documentedReason });
    let ownerNotice = 'not_applicable';
    if (turf.owner_id) {
      try {
        const notice = await notify({
          to: { type: 'owner', id: turf.owner_id },
          type: 'OWNER_BILLING_NOTICE',
          eventKey: `billing-restriction:${result.id}:removed:${Date.now()}`,
          data: {
            noticeKind: 'BOOKING_RESTRICTION_REMOVED', turfId, venue: turf.name,
            plan: 'Venue billing', reason: documentedReason,
            expectedImpact: 'New bookings are allowed again; existing and confirmed bookings remain unchanged',
          },
        });
        ownerNotice = notice.error ? 'not_persisted' : notice.id ? 'in_app_persisted' : 'in_app_already_persisted';
        if (notice.error) console.error('[admin-billing] Restriction removed but owner notice could not be persisted:', notice.error);
      } catch (error) {
        ownerNotice = 'not_persisted';
        console.error('[admin-billing] Restriction removed but owner notice failed:', error);
      }
    }
    return res.json({
      success: true,
      restriction: { ...result, active: false },
      expected_impact: 'New bookings are allowed again; existing and confirmed bookings remain unchanged',
      owner_notice: ownerNotice,
    });
  } catch (e) {
    handleError(res, e, 'Could not update the venue booking restriction');
  } finally {
    if (locked) await releaseSlotLock(turfId).catch((e) => console.error('[admin-billing] Could not release venue booking lock:', e));
  }
});

router.get('/turfs/:id/billing-history', async (req, res) => {
  try { res.json({ success: true, history: await billing.listHistory(Number(req.params.id), req.query.limit) }); }
  catch (e) { handleError(res, e, 'Could not load history'); }
});

// PUT /turfs/:id/billing-config — publishes a NEW version. Validates the whole configuration on the server.
router.put('/turfs/:id/billing-config', async (req, res) => {
  try {
    const cfg = await billing.publishConfig({ turfId: Number(req.params.id), input: req.body || {}, adminId: req.user.id, reason: (req.body || {}).reason });
    let notification = null;
    if (cfg.billing_model === 'SUBSCRIPTION' && new Date(cfg.effective_from) <= new Date()) {
      const [[target]] = await pool.query('SELECT id, owner_id, name FROM turfs WHERE id = ?', [req.params.id]);
      if (target?.owner_id) {
        notification = await notify({
          to: { type: 'owner', id: target.owner_id },
          type: 'OWNER_BILLING_NOTICE',
          eventKey: `billing-assigned:${target.id}:${cfg.id}`,
          data: { noticeKind: 'NEW_SUBSCRIPTION_ASSIGNED', turfId: target.id, venue: target.name, plan: `${cfg.subscription_period} subscription` },
        });
      }
    }
    res.json({ success: true, config: cfg, notification: notification ? { in_app: !!notification.id, result: notification.error || notification.skipped || null } : null });
  } catch (e) { handleError(res, e, 'Could not save the billing configuration'); }
});

router.post('/bulk-billing-config', async (req, res) => {
  const b = req.body || {};
  const targetType = String(b.target_type || '').toUpperCase();
  let targets = [];
  try {
    if (targetType === 'VENUES') {
      const ids = [...new Set((Array.isArray(b.venue_ids) ? b.venue_ids : []).map(Number))];
      if (!ids.length || ids.length > 500 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        return bad(res, 400, 'Select between 1 and 500 valid venue IDs');
      }
      const [rows] = await pool.query(`SELECT id, owner_id, name FROM turfs WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      if (rows.length !== ids.length) return bad(res, 404, 'One or more selected venues no longer exist');
      targets = rows;
    } else if (targetType === 'OWNER') {
      if (!/^\d+$/.test(String(b.owner_id || '')) || Number(b.owner_id) <= 0) return bad(res, 400, 'owner_id is required');
      [targets] = await pool.query(
        "SELECT id, owner_id, name FROM turfs WHERE owner_id = ? AND approval_status = 'APPROVED' ORDER BY id",
        [Number(b.owner_id)]
      );
    } else if (targetType === 'SPORT') {
      const sport = String(b.sport_type || '').trim();
      if (!sport || sport.length > 80) return bad(res, 400, 'sport_type is required');
      [targets] = await pool.query(
        "SELECT id, owner_id, name FROM turfs WHERE LOWER(sport_type) = LOWER(?) AND approval_status = 'APPROVED' ORDER BY id",
        [sport]
      );
    } else if (targetType === 'ALL_APPROVED') {
      [targets] = await pool.query("SELECT id, owner_id, name FROM turfs WHERE approval_status = 'APPROVED' ORDER BY id");
    } else {
      return bad(res, 400, 'target_type must be VENUES, OWNER, SPORT, or ALL_APPROVED');
    }
    if (!targets.length) return bad(res, 404, 'No eligible venues match this assignment');
    const input = { ...(b.config || b) };
    delete input.target_type; delete input.venue_ids; delete input.owner_id; delete input.sport_type; delete input.config;
    if (!input.effective_from) input.effective_from = new Date().toISOString();

    const conn = await pool.getConnection();
    const published = [];
    try {
      await conn.beginTransaction();
      for (const target of targets) {
        const config = await billing.publishConfig({
          turfId: target.id, input, adminId: req.user.id, reason: input.reason, connection: conn,
        });
        published.push({ turf_id: target.id, owner_id: target.owner_id, venue: target.name, config });
      }
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch (_) { /* transaction may already be closed */ }
      throw e;
    } finally {
      conn.release();
    }

    const notifications = [];
    for (const item of published) {
      if (item.owner_id && item.config.billing_model === 'SUBSCRIPTION') {
        notifications.push(await notify({
          to: { type: 'owner', id: item.owner_id },
          type: 'OWNER_BILLING_NOTICE',
          eventKey: `billing-assigned:${item.turf_id}:${item.config.id}`,
          data: { noticeKind: 'NEW_SUBSCRIPTION_ASSIGNED', turfId: item.turf_id, venue: item.venue, plan: `${item.config.subscription_period} subscription` },
        }));
      }
    }
    res.json({ success: true, assigned_count: published.length, venues: published.map(({ turf_id, venue, config }) => ({ turf_id, venue, version: config.version, billing_model: config.billing_model })), notification_count: notifications.filter((n) => n.id).length });
  } catch (e) { handleError(res, e, 'Could not assign billing to the selected venues'); }
});

router.post('/turfs/:id/payment-notice', async (req, res) => {
  try {
    const noticeKind = String((req.body || {}).notice_kind || '').toUpperCase();
    const allowed = ['PAYMENT_DUE_SOON', 'PAYMENT_OVERDUE', 'PAYMENT_FAILED', 'SUBSCRIPTION_EXPIRING', 'ACCOUNT_RESTRICTION_WARNING'];
    if (!allowed.includes(noticeKind)) return bad(res, 400, 'Unsupported billing notice type');
    const [[turf]] = await pool.query(
      `SELECT id, owner_id, name, currency_code FROM turfs WHERE id = ?`,
      [req.params.id]
    );
    if (!turf) return bad(res, 404, 'Venue not found');
    if (!turf.owner_id) return bad(res, 409, 'Venue has no assigned owner');
    const routeTurf = await routeSplit.getRouteConfig(turf.id);
    const config = await billing.getEffectiveConfig(routeTurf);
    const subscription = await billing.subscriptionOverview(routeTurf, config);
    const currentCycle = subscription?.cycles.find((cycle) => cycle.cycle_start === subscription.current?.start) || null;
    if (noticeKind !== 'ACCOUNT_RESTRICTION_WARNING' && (!currentCycle || currentCycle.outstandingMinor <= 0)) {
      return bad(res, 409, 'There is no outstanding subscription balance to notify about');
    }
    if (noticeKind === 'ACCOUNT_RESTRICTION_WARNING' && (!req.body.reason || String(req.body.reason).trim().length < 3)) {
      return bad(res, 400, 'A restriction warning requires an auditable reason');
    }
    const result = await notify({
      to: { type: 'owner', id: turf.owner_id },
      type: 'OWNER_BILLING_NOTICE',
      eventKey: `admin-billing:${turf.id}:${noticeKind}:${Date.now()}`,
      data: {
        noticeKind, turfId: turf.id, venue: turf.name,
        plan: config.billing_model === 'SUBSCRIPTION' ? `${config.subscription_period} subscription` : config.billing_model,
        amountMinor: currentCycle?.outstandingMinor ?? null,
        currency: currentCycle?.currency || turf.currency_code || 'INR',
        dueDate: currentCycle?.due_date || null,
        reason: req.body.reason ? String(req.body.reason).trim().slice(0, 255) : null,
      },
    });
    if (result.error) return bad(res, 500, 'Could not persist the in-app notice');
    res.json({
      success: true,
      delivery: result.id ? 'in_app_persisted' : result.deduped ? 'in_app_already_persisted' : 'not_delivered',
      external_delivery: 'not_configured',
    });
  } catch (e) { handleError(res, e, 'Could not send the billing notice'); }
});

// POST /turfs/:id/subscription/cycles/:cycleId/record-payment — a subscription billed SEPARATELY from bookings was paid
router.post('/turfs/:id/subscription/cycles/:cycleId/record-payment', async (req, res) => {
  try {
    const { amount, reference, note } = req.body || {};
    if (!reference || String(reference).trim().length < 3) return bad(res, 400, 'A payment reference is required');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[cyc]] = await conn.query('SELECT * FROM turf_subscription_cycles WHERE id = ? AND turf_id = ? FOR UPDATE', [req.params.cycleId, req.params.id]);
      if (!cyc) { await conn.rollback(); return bad(res, 404, 'Subscription cycle not found'); }
      if (cyc.policy !== 'SEPARATE') { await conn.rollback(); return bad(res, 409, 'This cycle is paid from booking proceeds; separate payments are not recorded against it'); }
      const [[pendingOrder]] = await conn.query("SELECT id FROM venue_billing_payments WHERE active_cycle_id = ? AND status = 'PENDING' FOR UPDATE", [cyc.id]);
      if (pendingOrder) { await conn.rollback(); return bad(res, 409, 'An online payment is already in progress for this billing cycle'); }
      const auditField = `c${cyc.id}:${String(reference).trim()}`.slice(0, 40);
      const [[dup]] = await conn.query("SELECT id FROM route_audit_log WHERE turf_id = ? AND action = 'subscription_payment' AND field = ?", [req.params.id, auditField]);
      if (dup) { await conn.rollback(); return bad(res, 409, 'That payment reference was already recorded'); }
      const md = await billing.minorDigitsFor(cyc.currency, conn);
      const minor = pricing.toMinor(amount, md);
      const totals = await billing.cycleTotals(conn, cyc.id);
      if (minor <= 0 || minor > totals.outstandingMinor) { await conn.rollback(); return bad(res, 400, `Amount must be between 0 and the outstanding balance (${totals.outstandingMinor} minor units)`); }
      await conn.query('UPDATE turf_subscription_cycles SET paid_separately_minor = paid_separately_minor + ? WHERE id = ?', [minor, cyc.id]);
      await conn.query('INSERT INTO route_audit_log (turf_id, admin_id, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)',
        [req.params.id, req.user.id, 'subscription_payment', auditField, String(note || '').slice(0, 255), String(minor)]);
      const status = await billing.refreshCycleStatus(conn, cyc.id);
      if (status.status === 'PAID') {
        await restrictions.releaseForPaidCycle(conn, Number(req.params.id), Number(cyc.id));
      }
      await conn.commit();
      res.json({ success: true, cycle: { id: cyc.id, ...status } });
    } catch (e) { try { await conn.rollback(); } catch (_) { /* */ } throw e; } finally { conn.release(); }
  } catch (e) { handleError(res, e, 'Could not record the subscription payment'); }
});

// ------------------------------------------------------------------------------------------------------------------
// Customer fee / tax rules
// ------------------------------------------------------------------------------------------------------------------
router.get('/fee-rules', async (req, res) => {
  try { res.json({ success: true, rules: await billing.listFeeRules() }); } catch (e) { handleError(res, e, 'Could not load fee rules'); }
});
router.post('/fee-rules', async (req, res) => {
  try {
    const b = req.body || {};
    const rule = await billing.publishFeeRule({ countryCode: b.country_code, currencyCode: b.currency_code, input: b, adminId: req.user.id });
    res.json({ success: true, rule });
  } catch (e) { handleError(res, e, 'Could not save the fee rule'); }
});

// ------------------------------------------------------------------------------------------------------------------
// Razorpay Payment-ID lookup & reconciliation
// ------------------------------------------------------------------------------------------------------------------
router.get('/payments/lookup', throttle(20, 60000), async (req, res) => {
  try {
    const view = await recon.inspectPayment(String(req.query.payment_id || '').trim());
    if (view.error) return bad(res, view.status || 400, view.error);
    await recon.logAction({ adminId: req.user.id, action: 'lookup', paymentId: view.payment.id, turfId: view.turf && view.turf.id, outcome: view.action.type, details: null });
    res.json({ success: true, ...view });
  } catch (e) { handleError(res, e, 'Could not look up that payment'); }
});

router.post('/payments/reconcile', throttle(5, 60000), async (req, res) => {
  try {
    const b = req.body || {};
    const out = await recon.reconcilePayment({ paymentId: String(b.payment_id || '').trim(), adminId: req.user.id, confirmPaymentId: b.confirm_payment_id });
    if (out.error) return bad(res, out.status || 400, out.error, out.view ? { view: out.view } : {});
    res.json({ success: true, result: { status: out.result.status, razorpay_transfer_id: out.result.razorpay_transfer_id || null, simulated: !!out.result.simulated, error: out.result.error_message || out.result.error || null }, view: out.view });
  } catch (e) { handleError(res, e, 'Could not reconcile that payment'); }
});

router.get('/payments/actions', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, a.username AS admin_name FROM admin_payment_actions p LEFT JOIN admins a ON a.id = p.admin_id WHERE (? = '' OR p.razorpay_payment_id = ?) ORDER BY p.id DESC LIMIT 100`,
      [String(req.query.payment_id || ''), String(req.query.payment_id || '')]);
    res.json({ success: true, actions: rows });
  } catch (e) { handleError(res, e, 'Could not load the audit trail'); }
});

// ------------------------------------------------------------------------------------------------------------------
// Refund -> reverse the owner's share of the transfer (the only supported way to take that money back)
// ------------------------------------------------------------------------------------------------------------------
router.post('/refunds/:refundId/reverse-transfer', throttle(5, 60000), async (req, res) => {
  try {
    const [[refund]] = await pool.query('SELECT * FROM refunds WHERE id = ?', [req.params.refundId]);
    if (!refund) return bad(res, 404, 'Refund not found');
    if (refund.refund_status !== 'REFUND_COMPLETED') return bad(res, 409, 'Only a completed refund can have its transfer reversed');
    const paymentId = refund.gateway_payment_id || refund.payment_id;
    const [[record]] = await pool.query("SELECT * FROM route_split_transfers WHERE razorpay_payment_id = ? AND status = 'SUCCESS' AND razorpay_transfer_id IS NOT NULL ORDER BY id LIMIT 1", [paymentId]);
    if (!record) return bad(res, 409, 'No completed owner transfer exists for this refund\'s payment — nothing to reverse');
    if (String(req.body && req.body.confirm_refund_code) !== String(refund.refund_code || refund.id)) return bad(res, 400, 'Type the refund code to confirm');
    const snap = JSON.parse(record.config_snapshot || 'null');
    if (!snap || !snap.settlement) return bad(res, 409, 'This transfer has no stored settlement snapshot; reverse it manually in Razorpay');
    const rev = pricing.computeRefundReversal({ settlement: snap.settlement, refundMinor: Number(refund.refund_amount_minor) });
    if (rev.ownerReversalMinor <= 0) return bad(res, 409, 'The owner share of this refund is 0; nothing to reverse');

    let row;
    try {
      const [ins] = await pool.query('INSERT INTO route_transfer_reversals (refund_id, transfer_record_id, razorpay_transfer_id, amount_minor, status, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        [refund.id, record.id, record.razorpay_transfer_id, rev.ownerReversalMinor, 'PENDING', req.user.id]);
      row = { id: ins.insertId };
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return bad(res, 409, 'This refund has already been reversed (or a reversal is in progress)');
      throw e;
    }
    try {
      const r = await provider.reverseTransfer({ environment: record.environment, transferId: record.razorpay_transfer_id, amountPaise: rev.ownerReversalMinor, notes: { refund_id: String(refund.id) } });
      await pool.query("UPDATE route_transfer_reversals SET status = 'SUCCESS', razorpay_reversal_id = ? WHERE id = ?", [r.id, row.id]);
      await pool.query('INSERT INTO route_audit_log (turf_id, admin_id, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)', [record.turf_id, req.user.id, 'transfer_reversal', `refund${refund.id}`, String(record.razorpay_transfer_id).slice(0, 255), String(rev.ownerReversalMinor)]);
      res.json({ success: true, reversal: { id: r.id, amount_minor: rev.ownerReversalMinor, simulated: !!r.simulated, platform_share_minor: rev.platformReversalMinor } });
    } catch (e) {
      await pool.query("UPDATE route_transfer_reversals SET status = 'FAILED', error_message = ? WHERE id = ?", [String((e && e.error && e.error.description) || e.message).slice(0, 1000), row.id]);
      return bad(res, 502, 'Razorpay rejected the reversal: ' + ((e && e.error && e.error.description) || e.message));
    }
  } catch (e) { handleError(res, e, 'Could not reverse the transfer'); }
});

// POST /transfers/:id/retry — re-attempt a RETRY_REQUIRED transfer (same amount, same account)
router.post('/transfers/:id/retry', throttle(10, 60000), async (req, res) => {
  try {
    const r = await routeSplit.retryTransferRecord(Number(req.params.id));
    if (r.error) return bad(res, 409, r.error);
    await pool.query('INSERT INTO route_audit_log (turf_id, admin_id, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)', [r.record.turf_id, req.user.id, 'transfer_retry', `record${r.record.id}`, null, r.record.status]);
    res.json({ success: true, record: { id: r.record.id, status: r.record.status, razorpay_transfer_id: r.record.razorpay_transfer_id || null, error: r.record.error_message || null } });
  } catch (e) { handleError(res, e, 'Could not retry the transfer'); }
});

module.exports = router;
