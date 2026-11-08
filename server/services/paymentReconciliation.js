// Admin Payment-ID lookup and reconciliation.
//
// Pasting a Razorpay payment id never moves money by itself. inspectPayment() asks Razorpay (server-side keys) what
// that payment really is, matches it to OUR booking / venue / owner / ledger, recomputes what the owner should have
// been paid from the historical configuration, compares it with what the gateway and the ledger actually say, and
// decides — from facts only — whether exactly one safe action exists. reconcilePayment() performs that one action
// through the same idempotent engine the live payment flow uses, so a transfer can never be duplicated, redirected to
// another owner's account, or computed from anything the admin typed.
const pool = require('../config/db');
const provider = require('./routeProvider');
const routeSplit = require('./routeSplit');
const billing = require('./billingConfig');
const pricing = require('./pricing');

const PAYMENT_ID = /^pay_[A-Za-z0-9]{8,32}$/;
const isSim = (id) => String(id || '').startsWith('sim_');

async function safe(fn, fallback = null) { try { return await fn(); } catch (e) { return fallback; } }

async function inspectPayment(paymentId) {
  if (!PAYMENT_ID.test(String(paymentId || ''))) return { error: 'That does not look like a Razorpay payment id (expected pay_XXXXXXXXXXXXXX)', status: 400 };

  let rp;
  try { rp = await provider.fetchPayment(paymentId); }
  catch (e) {
    const code = e && (e.statusCode || (e.error && e.error.code));
    if (code === 400 || code === 404 || code === 'BAD_REQUEST_ERROR') return { error: 'Razorpay does not know this payment id on this account', status: 404 };
    return { error: `Could not reach Razorpay: ${(e && e.error && e.error.description) || e.message}`, status: 502 };
  }

  const [bookings] = await pool.query(
    'SELECT * FROM bookings WHERE payment_id = ? OR (razorpay_order_id IS NOT NULL AND razorpay_order_id = ?) ORDER BY id', [paymentId, rp.order_id || '\u0000']
  );
  const payment = {
    id: rp.id, status: rp.status, captured: rp.status === 'captured', amount_minor: Number(rp.amount), currency: rp.currency, order_id: rp.order_id || null,
    method: rp.method || null, amount_refunded_minor: Number(rp.amount_refunded || 0), created_at: rp.created_at ? new Date(rp.created_at * 1000).toISOString() : null,
  };
  const out = { payment, matched: bookings.length > 0, bookings: [], turf: null, owner: null, linked_account: null, ledger: [], gateway_transfers: null, refunds: [], reversals: [], expected: null, checks: [], issues: [], action: { type: 'none', reason: '' } };

  const [ledger] = await pool.query('SELECT * FROM route_split_transfers WHERE razorpay_payment_id = ? ORDER BY id', [paymentId]);
  out.ledger = ledger.map((r) => ({ id: r.id, status: r.status, source: r.source, billing_model: r.billing_model, currency: r.currency, captured_minor: r.captured_minor == null ? null : Number(r.captured_minor),
    platform_fee_minor: r.platform_fee_minor == null ? null : Number(r.platform_fee_minor), tax_minor: r.tax_minor == null ? null : Number(r.tax_minor),
    subscription_deduction_minor: r.subscription_deduction_minor == null ? null : Number(r.subscription_deduction_minor),
    owner_transfer_minor: r.owner_transfer_minor == null ? Math.round(Number(r.owner_amount) * 100) : Number(r.owner_transfer_minor),
    linked_account_id: r.linked_account_id, razorpay_transfer_id: r.razorpay_transfer_id, simulated: isSim(r.razorpay_transfer_id), environment: r.environment,
    error_message: r.error_message, created_at: r.created_at }));
  out.gateway_transfers = await safe(async () => (await provider.listTransfers(paymentId)).map((t) => ({ id: t.id, recipient: t.recipient, amount_minor: Number(t.amount), amount_reversed_minor: Number(t.amount_reversed || 0), status: t.status })));
  out.refunds = await safe(async () => (await pool.query('SELECT id, refund_status, refund_amount_minor, gateway_refund_id FROM refunds WHERE gateway_payment_id = ? OR payment_id = ?', [paymentId, paymentId]))[0].map((r) => ({ ...r, refund_amount_minor: Number(r.refund_amount_minor) })), []);
  out.reversals = await safe(async () => (await pool.query('SELECT refund_id, amount_minor, status, razorpay_reversal_id FROM route_transfer_reversals WHERE transfer_record_id IN (SELECT id FROM route_split_transfers WHERE razorpay_payment_id = ?)', [paymentId]))[0], []);

  const check = (key, ok, message, blocking = true) => out.checks.push({ key, ok: !!ok, message, blocking });

  if (!bookings.length) {
    check('matched', false, 'No Book Arena booking is linked to this payment (it may be a subscription payment, a test payment, or from another system).');
    out.action = { type: 'none', reason: 'No matching booking, so there is no venue or owner to pay.' };
    return out;
  }
  check('matched', true, `Matched ${bookings.length} booking(s) on order ${rp.order_id || '—'}`);

  const turfIds = [...new Set(bookings.map((b) => b.turf_id))];
  out.bookings = bookings.map((b) => ({ id: b.id, turf_id: b.turf_id, customer_name: b.customer_name, booking_date: b.booking_date, time_slot: b.time_slot,
    amount: Number(b.amount), advance_amount: b.advance_amount == null ? null : Number(b.advance_amount), payment_status: b.payment_status, status: b.status }));
  check('single_turf', turfIds.length === 1, turfIds.length === 1 ? 'All bookings belong to one venue' : `Bookings span ${turfIds.length} venues — cannot be split automatically`);
  if (turfIds.length !== 1) { out.action = { type: 'none', reason: 'Bookings span more than one venue.' }; return out; }

  const turf = await routeSplit.getRouteConfig(turfIds[0]);
  const [[owner]] = await pool.query('SELECT id, name, email FROM owners WHERE id = ?', [turf.owner_id]);
  out.turf = { id: turf.id, name: turf.name, owner_id: turf.owner_id, approval_status: turf.approval_status, currency: turf.currency_code || 'INR', route_enabled: !!turf.route_enabled, route_status: turf.route_status, route_environment: turf.route_environment };
  out.owner = owner || null;
  out.linked_account = { id: turf.route_linked_account_id || null, format_valid: routeSplit.validLinkedAccountId(turf.route_linked_account_id || ''), status: null };
  if (out.linked_account.format_valid && turf.route_environment === 'live') out.linked_account.status = await safe(async () => (await provider.fetchAccount(turf.route_linked_account_id)).status, 'unknown');

  const currency = turf.currency_code || 'INR';
  const expectedMinor = bookings.reduce((s, b) => s + Math.round(Number(b.advance_amount != null ? b.advance_amount : b.amount || 0) * 100), 0);
  check('captured', payment.captured, payment.captured ? 'Payment is captured' : `Payment status is "${payment.status}", not captured`);
  check('currency', payment.currency === currency, payment.currency === currency ? `Currency ${currency} matches the venue` : `Payment currency ${payment.currency} ≠ venue currency ${currency}`);
  check('amount', Math.abs(payment.amount_minor - expectedMinor) <= bookings.length, Math.abs(payment.amount_minor - expectedMinor) <= bookings.length ? 'Captured amount matches the bookings' : `Captured ${payment.amount_minor} ≠ bookings ${expectedMinor} (minor units)`);
  check('bookings_paid', bookings.every((b) => b.payment_status === 'success'), bookings.every((b) => b.payment_status === 'success') ? 'Bookings are confirmed/paid' : 'Some bookings are not marked paid');
  check('approved', !turf.approval_status || turf.approval_status === 'APPROVED', `Venue approval status: ${turf.approval_status || 'n/a'}`);
  check('route_enabled', !!turf.route_enabled, turf.route_enabled ? 'Route is enabled for this venue' : 'Route is not enabled for this venue (settled outside Route)');
  check('route_active', routeSplit.isRouteConnected(turf), routeSplit.isRouteConnected(turf) ? `Route active, linked account ${turf.route_linked_account_id}` : `Route is "${turf.route_status}" or the linked account is missing/malformed`);
  if (out.linked_account.status) check('account_activated', out.linked_account.status === 'activated', `Linked account status at Razorpay: ${out.linked_account.status}`);
  check('inr_only', currency === 'INR', currency === 'INR' ? 'INR payment (Route supported)' : 'Razorpay Route supports INR only');

  // ---- expected owner-eligible amount: the ledger snapshot if there is one, else recomputed from the config in force when it was booked ----
  const active = ledger.find((r) => !['FAILED', 'SUPERSEDED'].includes(r.status));
  if (active && active.config_snapshot) {
    const snap = JSON.parse(active.config_snapshot);
    out.expected = { source: 'ledger_snapshot', ...snap.settlement };
  } else {
    try {
      const bookedAt = bookings[0].created_at ? new Date(bookings[0].created_at) : new Date();
      const config = await billing.getEffectiveConfig(turf, bookedAt > new Date() ? new Date() : bookedAt);
      const problems = billing.validateForSettlement(config);
      if (problems.length) throw new pricing.PricingConfigError(problems.join('; '));
      let outstanding = 0;
      if (config.billing_model === 'SUBSCRIPTION' && config.subscription_policy === 'DEDUCT_FROM_PROCEEDS') {
        const conn = await pool.getConnection();
        try { const cyc = await billing.ensureCycle(conn, turf.id, config); if (cyc) outstanding = (await billing.cycleTotals(conn, cyc.id)).outstandingMinor; } finally { conn.release(); }
      }
      out.expected = { source: 'recomputed', config_version: config.version, config_source: config.source,
        ...pricing.computeSettlement({ capturedMinor: payment.amount_minor, currency, config,
          customerFeeMinor: bookings.reduce((s, b) => s + Math.round(Number(b.service_fee || 0) * 100), 0), customerFeeTaxMinor: bookings.reduce((s, b) => s + Math.round(Number(b.service_fee_tax || 0) * 100), 0), subscriptionOutstandingMinor: outstanding }) };
    } catch (e) {
      out.expected = { source: 'error', error: e.message };
    }
  }
  check('expected', out.expected && out.expected.source !== 'error', out.expected && out.expected.source === 'error' ? `Cannot compute the owner share: ${out.expected.error}` : `Expected owner share ${out.expected.ownerTransferMinor} (${out.expected.source})`);

  // ---- what has actually happened ----
  const ledgerDone = ledger.filter((r) => r.status === 'SUCCESS' || r.razorpay_transfer_id);
  const gatewayCommitted = (out.gateway_transfers || []).filter((t) => t.status !== 'reversed' && t.status !== 'failed');
  if (out.gateway_transfers === null) out.issues.push('Could not read existing transfers from Razorpay; showing the ledger only.');
  if (gatewayCommitted.length && !ledgerDone.length) out.issues.push('Razorpay already holds a transfer for this payment that the ledger does not know about. Reconcile it manually; no new transfer will be created.');
  if (ledgerDone.some((r) => !isSim(r.razorpay_transfer_id)) && out.gateway_transfers && !gatewayCommitted.length) out.issues.push('The ledger says a transfer succeeded but Razorpay shows none for this payment.');
  for (const r of ledgerDone) {
    const g = (out.gateway_transfers || []).find((t) => t.id === r.razorpay_transfer_id);
    if (g && r.owner_transfer_minor != null && Number(r.owner_transfer_minor) !== g.amount_minor) out.issues.push(`Ledger transfer ${r.razorpay_transfer_id} is ${r.owner_transfer_minor} but Razorpay shows ${g.amount_minor}.`);
    if (g && g.recipient && r.linked_account_id && g.recipient !== r.linked_account_id) out.issues.push(`Transfer ${g.id} went to ${g.recipient}, not the venue's linked account ${r.linked_account_id}.`);
  }
  if (out.expected && out.expected.ownerTransferMinor != null && ledgerDone[0]) {
    const paid = Number(ledgerDone[0].owner_transfer_minor != null ? ledgerDone[0].owner_transfer_minor : Math.round(Number(ledgerDone[0].owner_amount) * 100));
    if (paid !== out.expected.ownerTransferMinor) out.issues.push(`Owner was paid ${paid} but the expected share is ${out.expected.ownerTransferMinor}.`);
  }
  const refunded = out.refunds.filter((r) => r.refund_status === 'REFUND_COMPLETED').reduce((s, r) => s + r.refund_amount_minor, 0);
  if (refunded > 0 && ledgerDone.length && !out.reversals.length) out.issues.push(`A refund of ${refunded} was completed but the owner's transfer has not been reversed.`);

  // ---- the one safe action, from facts only ----
  const blockers = out.checks.filter((c) => c.blocking && !c.ok && c.key !== 'route_enabled' && c.key !== 'matched');
  const noRoute = !turf.route_enabled;
  if (ledgerDone.length || gatewayCommitted.length) out.action = { type: 'none', reason: 'This payment has already been transferred. A second transfer is never created.' };
  else if (noRoute) out.action = { type: 'none', reason: 'Route is not enabled for this venue, so this payment is settled outside Route.' };
  else if (refunded > 0) out.action = { type: 'none', reason: 'This payment has a completed refund; reconcile the refund first.' };
  else if (blockers.length) out.action = { type: 'none', reason: `Not eligible: ${blockers.map((b) => b.message).join(' · ')}` };
  else if (!(out.expected.ownerTransferMinor > 0)) out.action = { type: 'none', reason: 'The owner share is 0, so no transfer is needed.' };
  else {
    const retry = ledger.find((r) => r.status === 'RETRY_REQUIRED');
    const failed = ledger.find((r) => r.status === 'FAILED' && !r.razorpay_transfer_id);
    if (retry) out.action = { type: 'retry_transfer', record_id: retry.id, amount_minor: Number(retry.owner_transfer_minor), reason: 'A previous attempt failed at the gateway; retry the same transfer.' };
    else if (failed) out.action = { type: 'reprocess', record_id: failed.id, amount_minor: out.expected.ownerTransferMinor, reason: `The earlier attempt was rejected (${failed.error_message || 'unknown reason'}); the blocking problem is now resolved, so it can be processed again.` };
    else out.action = { type: 'create_transfer', amount_minor: out.expected.ownerTransferMinor, reason: 'Captured, matched, venue and linked account eligible, and no transfer exists yet.' };
  }
  if (out.action.type !== 'none') out.action.environment = turf.route_environment;
  if (out.action.type !== 'none') out.action.target_account = turf.route_linked_account_id;
  return out;
}

async function logAction({ adminId, action, paymentId, turfId, outcome, details }) {
  await pool.query('INSERT INTO admin_payment_actions (admin_id, action, razorpay_payment_id, turf_id, outcome, details) VALUES (?, ?, ?, ?, ?, ?)',
    [adminId, action, paymentId, turfId || null, outcome, details ? JSON.stringify(details).slice(0, 4000) : null]);
}

/** Performs the single eligible action found by inspectPayment — never an action the caller names. */
async function reconcilePayment({ paymentId, adminId, confirmPaymentId }) {
  if (String(confirmPaymentId || '').trim() !== String(paymentId || '').trim()) return { error: 'Type the payment id again to confirm', status: 400 };
  const view = await inspectPayment(paymentId);
  if (view.error) return view;
  const turfId = view.turf && view.turf.id;
  if (view.action.type === 'none') {
    await logAction({ adminId, action: 'reconcile_transfer', paymentId, turfId, outcome: 'REFUSED', details: { reason: view.action.reason } });
    return { error: view.action.reason, status: 409, view };
  }

  let result;
  if (view.action.type === 'retry_transfer') {
    const r = await routeSplit.retryTransferRecord(view.action.record_id);
    result = r.error ? { error: r.error } : r.record;
  } else {
    if (view.action.type === 'reprocess') {
      const [sup] = await pool.query(
        "UPDATE route_split_transfers SET idempotency_key = CONCAT(idempotency_key, ':superseded:', id), status = 'SUPERSEDED' WHERE id = ? AND status = 'FAILED' AND razorpay_transfer_id IS NULL", [view.action.record_id]
      );
      if (sup.affectedRows !== 1) return { error: 'This record was already handled by someone else', status: 409, view: await inspectPayment(paymentId) };
    }
    result = await routeSplit.processSplitTransfer({
      paymentId, orderId: view.payment.order_id || undefined, bookingIds: view.bookings.map((b) => b.id),
      capturedMinor: view.payment.amount_minor, currency: view.payment.currency, source: 'admin_reconcile', adminId,
    });
  }
  const outcome = result && result.status ? result.status : (result && result.error ? 'ERROR' : 'UNKNOWN');
  await logAction({ adminId, action: 'reconcile_transfer', paymentId, turfId, outcome, details: { action: view.action.type, transfer_id: result && result.razorpay_transfer_id, simulated: !!(result && result.simulated), error: result && (result.error || result.error_message) } });
  return { result, view: await inspectPayment(paymentId) };
}

module.exports = { PAYMENT_ID, inspectPayment, reconcilePayment, logAction };
