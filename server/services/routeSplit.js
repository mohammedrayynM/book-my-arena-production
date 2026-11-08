// The per-turf Razorpay Route split engine.
//
//   CUSTOMER PAYMENT -> backend-verified capture -> load the PAYING turf (from the database, via the bookings the
//   payment covers) -> is Route active for it? -> compute the split with services/pricing.js from the turf's versioned
//   billing configuration -> ONE idempotent ledger row (+ subscription deduction, same DB transaction) ->
//   routeProvider.createTransfer (simulated unless the turf is 'live').
//
// Nothing here trusts the request: the caller passes payment/order ids and the booking ids; the turf, owner linked
// account, billing model, fees and amounts are all re-read from the database (and the captured amount from Razorpay).
// A booking for Turf A can only ever be routed to Turf A's linked account because the turf comes from the booking row.
const pool = require('../config/db');
const provider = require('./routeProvider');
const pricing = require('./pricing');
const billing = require('./billingConfig');

const STATUSES = { PENDING: 'PENDING', PROCESSING: 'PROCESSING', SUCCESS: 'SUCCESS', FAILED: 'FAILED', RETRY_REQUIRED: 'RETRY_REQUIRED', NOT_REQUIRED: 'NOT_REQUIRED' };
const ROUTE_STATUSES = ['not_configured', 'configured', 'approved', 'active', 'suspended'];
const COMMISSION_TYPES = ['percentage', 'flat', 'subscription'];

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// ---- legacy decimal helpers (kept: exported API of this module; the engine itself now uses services/pricing.js) ----
function calculateSplit(grossAmount, percentage) {
  const gross = round2(grossAmount);
  const pct = Number(percentage);
  if (!(gross > 0)) return { error: 'grossAmount must be greater than 0' };
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { error: 'percentage must be between 0 and 100' };
  const platformAmount = Math.round(gross * pct) / 100;
  const ownerAmount = round2(gross - platformAmount);
  return { platformAmount, ownerAmount, grossAmount: gross };
}
function calculateFlatSplit(grossAmount, flatAmount) {
  const gross = round2(grossAmount);
  const flat = Number(flatAmount);
  if (!(gross > 0)) return { error: 'grossAmount must be greater than 0' };
  if (!Number.isFinite(flat) || flat < 0) return { error: 'flat amount must be zero or a positive number' };
  const platformAmount = round2(Math.min(flat, gross));
  const ownerAmount = round2(gross - platformAmount);
  return { platformAmount, ownerAmount, grossAmount: gross, clamped: flat > gross };
}
// Read-only: never touches a ledger. A subscription turf's deduction depends on its cycle, which only
// processSplitTransfer (in a transaction) is allowed to change, so a preview shows no deduction.
async function calculateSplitFor(turf, grossAmount) {
  const cfg = billing.legacyConfigFromTurf(turf);
  if (cfg.billing_model === 'FLAT') return calculateFlatSplit(grossAmount, (cfg.flat_fee_minor || 0) / 100);
  if (cfg.billing_model === 'SUBSCRIPTION') return { ...calculateSplit(grossAmount, 0), note: 'subscription deduction is applied per cycle at settlement' };
  return calculateSplit(grossAmount, (cfg.commission_bps || 0) / 100);
}

function validPercentage(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 100; }
function validFlatAmount(v) { const n = Number(v); return Number.isFinite(n) && n >= 0; }
function validCommissionType(v) { return COMMISSION_TYPES.includes(v); }
// Razorpay linked account ids look like "acc_XXXXXXXXXXXXXX". Format-only check — no account is ever created here.
function validLinkedAccountId(v) { return typeof v === 'string' && /^acc_[A-Za-z0-9]{8,40}$/.test(v.trim()); }

async function getRouteConfig(turfId) {
  const [[t]] = await pool.query(
    `SELECT id, owner_id, name, country_code, currency_code, approval_status, route_enabled, route_status, route_linked_account_id, route_commission_type,
            route_split_percentage, route_flat_amount, route_environment, route_configured_at, route_approved_at,
            route_approved_by, billing_model, commission_percentage, monthly_subscription_amount, subscription_start_date
     FROM turfs WHERE id = ?`, [turfId]
  );
  return t || null;
}

// Whether this turf's commission is fully specified under the legacy columns (what admin-route.js checks when approving).
// A subscription needs a real amount: the old code silently assumed 799, which is no longer done.
function hasValidCommission(turf) {
  if (turf.route_commission_type === 'flat') return turf.route_flat_amount !== null && turf.route_flat_amount !== undefined && validFlatAmount(turf.route_flat_amount);
  if (turf.route_commission_type === 'subscription' || turf.billing_model === 'MONTHLY') return Number(turf.monthly_subscription_amount) > 0;
  return validPercentage(turf.route_split_percentage != null ? turf.route_split_percentage : turf.commission_percentage);
}

// Route switched on, approved, active and pointing at a well-formed linked account (commission is checked separately by pricing).
function isRouteConnected(turf) {
  return !!turf && !!turf.route_enabled && turf.route_status === 'active' && validLinkedAccountId(turf.route_linked_account_id || '');
}
function isRouteReady(turf) { return isRouteConnected(turf) && hasValidCommission(turf); }

async function existingTransfer(idempotencyKey, conn = pool) {
  const [[row]] = await conn.query('SELECT * FROM route_split_transfers WHERE idempotency_key = ?', [idempotencyKey]);
  return row || null;
}

const COLS = ['booking_id', 'turf_id', 'razorpay_payment_id', 'razorpay_order_id', 'linked_account_id', 'commission_type', 'split_percentage', 'flat_amount',
  'gross_amount', 'platform_amount', 'owner_amount', 'environment', 'status', 'error_message', 'idempotency_key', 'currency', 'captured_minor',
  'platform_fee_minor', 'tax_minor', 'customer_fee_minor', 'subscription_deduction_minor', 'owner_transfer_minor', 'billing_model', 'config_history_id',
  'config_snapshot', 'source', 'reconciled_by'];

// Inserts one ledger row on `conn`. A duplicate idempotency key is reported as { __existing: true, ...theOtherRow }.
async function insertRecord(conn, rec) {
  const cols = COLS.filter((c) => rec[c] !== undefined);
  try {
    const [ins] = await conn.query(`INSERT INTO route_split_transfers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => rec[c]));
    const [[row]] = await conn.query('SELECT * FROM route_split_transfers WHERE id = ?', [ins.insertId]);
    return row;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' && /idempotency|uniq_route_transfer_key/i.test(String(e.message))) {
      // read through the pool (a fresh snapshot): inside the caller's REPEATABLE READ transaction the other
      // transaction's just-committed row may not be visible yet
      const row = await existingTransfer(rec.idempotency_key, pool);
      return { ...(row || {}), __existing: true };
    }
    throw e;
  }
}

function legacyPct(captured, platform) { return captured > 0 ? Math.min(999.99, Math.round((platform / captured) * 10000) / 100) : 0; }

/**
 * Called after a booking payment has been verified (signature-checked /verify or a signed webhook) — never from
 * anything the frontend alone controls.
 *
 * @param {{ paymentId: string, orderId?: string, bookingIds: number[], capturedMinor?: number, currency?: string, source?: string, adminId?: number }} p
 *   capturedMinor/currency, when given, are what Razorpay itself reported for this payment (fetched server-side).
 * @returns {Promise<{ skipped: string }|{ error: string }|object>} the route_split_transfers row, or a reason it did nothing
 */
async function processSplitTransfer({ paymentId, orderId, bookingIds, capturedMinor: verifiedCaptured, currency: verifiedCurrency, source = 'auto', adminId = null }) {
  if (!paymentId || !Array.isArray(bookingIds) || bookingIds.length === 0) return { error: 'paymentId and bookingIds are required' };
  const idempotencyKey = `booking:${paymentId}`;

  const already = await existingTransfer(idempotencyKey);
  if (already) return already; // duplicate webhook / duplicate verify call: never create a second transfer

  const placeholders = bookingIds.map(() => '?').join(',');
  const [rows] = await pool.query(`SELECT * FROM bookings WHERE id IN (${placeholders})`, bookingIds);
  if (rows.length === 0) return { error: `No bookings found for ids: ${bookingIds.join(',')}` };

  const turfIds = [...new Set(rows.map((r) => r.turf_id))];
  if (turfIds.length > 1) {
    console.error(`[RouteSplit] payment ${paymentId} covers bookings from multiple turfs (${turfIds.join(',')}); refusing to split`);
    return { error: 'bookings span more than one turf' };
  }
  if (orderId && rows.some((r) => r.razorpay_order_id && r.razorpay_order_id !== orderId)) {
    return { error: 'bookings do not belong to the supplied Razorpay order' };
  }
  const turfId = turfIds[0];
  const turf = await getRouteConfig(turfId);
  if (!turf) return { error: `Turf ${turfId} not found` };
  if (!turf.route_enabled) return { skipped: 'route_disabled' }; // the existing (non-Route) settlement applies; nothing to write here

  const currency = turf.currency_code || 'INR';
  const expectedMinor = rows.reduce((sum, r) => sum + Math.round(Number(r.advance_amount != null ? r.advance_amount : r.amount || 0) * 100), 0);
  const base = {
    idempotency_key: idempotencyKey, booking_id: bookingIds[0], turf_id: turfId, razorpay_payment_id: paymentId, razorpay_order_id: orderId || null,
    linked_account_id: turf.route_linked_account_id || null, commission_type: turf.route_commission_type || 'percentage', environment: turf.route_environment,
    currency, source, reconciled_by: adminId,
  };
  const failed = (message, extra = {}) => insertRecord(pool, {
    ...base, split_percentage: 0, flat_amount: null, gross_amount: round2(expectedMinor / 100), platform_amount: 0, owner_amount: 0,
    owner_transfer_minor: 0, status: STATUSES.FAILED, error_message: String(message).slice(0, 2000), ...extra,
  });

  if (!isRouteConnected(turf)) {
    const reason = !validLinkedAccountId(turf.route_linked_account_id || '') ? 'no linked account configured' : `route status is "${turf.route_status}", not "active"`;
    return failed(`Route enabled but not ready: ${reason}`);
  }
  if (turf.approval_status && turf.approval_status !== 'APPROVED') return failed(`Venue is not approved (status ${turf.approval_status})`);
  if (currency !== 'INR') return failed(`Razorpay Route transfers are INR-only; this venue is priced in ${currency}`);
  if (verifiedCurrency && verifiedCurrency !== currency) return failed(`Payment currency ${verifiedCurrency} does not match the venue currency ${currency}`);

  // The captured amount is whatever Razorpay says it is. It may differ from the booking rows only by per-row rounding.
  let capturedMinor = expectedMinor;
  if (Number.isSafeInteger(verifiedCaptured)) {
    if (Math.abs(verifiedCaptured - expectedMinor) > rows.length) return failed(`Captured amount ${verifiedCaptured} does not match the booking amount ${expectedMinor} (minor units)`);
    capturedMinor = verifiedCaptured;
  }
  if (!(capturedMinor > 0)) return failed('Captured amount is zero');

  if (turf.route_environment === 'live') {
    try {
      const acct = await provider.fetchAccount(turf.route_linked_account_id);
      if (acct.status !== 'activated') return failed(`Linked account ${turf.route_linked_account_id} is "${acct.status}", not activated`);
    } catch (e) {
      return failed(`Could not verify the linked account with Razorpay: ${(e && e.error && e.error.description) || e.message}`);
    }
  }

  const customerFeeMinor = rows.reduce((s, r) => s + Math.round(Number(r.service_fee || 0) * 100), 0);
  const customerFeeTaxMinor = rows.reduce((s, r) => s + Math.round(Number(r.service_fee_tax || 0) * 100), 0);

  // ---- one DB transaction: ledger row + subscription deduction (so a failure can never leave a half-counted ledger) ----
  const conn = await pool.getConnection();
  let record;
  let settlement;
  try {
    await conn.beginTransaction();
    const bookedAt = rows[0].created_at ? new Date(rows[0].created_at) : new Date();
    const config = await billing.getEffectiveConfig(turf, bookedAt > new Date() ? new Date() : bookedAt, conn);

    const configProblems = billing.validateForSettlement(config);
    if (configProblems.length) {
      await conn.rollback();
      return failed(`Billing configuration problem: ${configProblems.join('; ')}`);
    }

    let cycle = null;
    let outstanding = 0;
    if (config.billing_model === 'SUBSCRIPTION' && config.subscription_policy === 'DEDUCT_FROM_PROCEEDS') {
      cycle = await billing.ensureCycle(conn, turfId, config);
      if (cycle) {
        await conn.query('SELECT id FROM turf_subscription_cycles WHERE id = ? FOR UPDATE', [cycle.id]);
        outstanding = (await billing.cycleTotals(conn, cycle.id)).outstandingMinor;
      }
    }

    try {
      settlement = pricing.computeSettlement({ capturedMinor, currency, config, customerFeeMinor, customerFeeTaxMinor, subscriptionOutstandingMinor: outstanding });
    } catch (e) {
      await conn.rollback();
      if (e instanceof pricing.PricingConfigError) return failed(`Billing configuration problem: ${e.message}`);
      throw e;
    }

    record = await insertRecord(conn, {
      ...base, split_percentage: legacyPct(capturedMinor, settlement.platformRetainedMinor), flat_amount: config.billing_model === 'FLAT' ? round2(config.flat_fee_minor / 100) : null,
      gross_amount: round2(capturedMinor / 100), platform_amount: round2(settlement.platformRetainedMinor / 100), owner_amount: round2(settlement.ownerTransferMinor / 100),
      status: STATUSES.PENDING,
      error_message: settlement.flags.length ? `flags: ${settlement.flags.join(', ')}` : null,
      captured_minor: capturedMinor, platform_fee_minor: settlement.platformFeeMinor, tax_minor: settlement.taxLiabilityMinor,
      customer_fee_minor: settlement.customerFeeMinor, subscription_deduction_minor: settlement.subscriptionDeductionMinor, owner_transfer_minor: settlement.ownerTransferMinor,
      billing_model: config.billing_model, config_history_id: config.id,
      config_snapshot: JSON.stringify({ config, settlement }),
    });
    if (record.__existing) { await conn.rollback(); return record; } // a concurrent /verify or webhook got there first

    if (cycle && settlement.subscriptionDeductionMinor > 0) {
      await conn.query(
        'INSERT INTO turf_subscription_deductions (cycle_id, turf_id, amount_minor, idempotency_key, split_transfer_id) VALUES (?, ?, ?, ?, ?)',
        [cycle.id, turfId, settlement.subscriptionDeductionMinor, `deduct:${idempotencyKey}`, record.id]
      );
      await billing.refreshCycleStatus(conn, cycle.id);
    }
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* already rolled back */ }
    throw e;
  } finally {
    conn.release();
  }

  // ---- money movement happens only after the ledger is safely committed ----
  if (settlement.ownerTransferMinor === 0) {
    await pool.query('UPDATE route_split_transfers SET status = ?, error_message = ? WHERE id = ?', [STATUSES.NOT_REQUIRED, 'Owner share is 0 for this payment; no transfer needed', record.id]);
    return { ...record, status: STATUSES.NOT_REQUIRED };
  }
  return executeTransfer(record, { capturedMinor, notesBookingIds: bookingIds });
}

// Calls Razorpay for an existing ledger row and records the actual result. Safe to repeat for RETRY_REQUIRED rows:
// the provider checks Razorpay for an identical existing transfer before creating a new one.
async function executeTransfer(record, { capturedMinor, notesBookingIds } = {}) {
  try {
    const transfer = await provider.createTransfer({
      environment: record.environment,
      paymentId: record.razorpay_payment_id,
      linkedAccountId: record.linked_account_id,
      amountPaise: Number(record.owner_transfer_minor != null ? record.owner_transfer_minor : Math.round(Number(record.owner_amount) * 100)),
      currency: record.currency || 'INR',
      capturedPaise: capturedMinor != null ? capturedMinor : (record.captured_minor != null ? Number(record.captured_minor) : undefined),
      notes: { booking_ids: (notesBookingIds || [record.booking_id]).join(','), turf_id: String(record.turf_id) },
    });
    await pool.query('UPDATE route_split_transfers SET status = ?, razorpay_transfer_id = ?, error_message = NULL WHERE id = ?', [STATUSES.SUCCESS, transfer.id, record.id]);
    return { ...record, status: STATUSES.SUCCESS, razorpay_transfer_id: transfer.id, simulated: transfer.simulated };
  } catch (apiError) {
    const message = (apiError && apiError.error && apiError.error.description) || apiError.message || 'Route transfer API error';
    await pool.query('UPDATE route_split_transfers SET status = ?, error_message = ? WHERE id = ?', [STATUSES.RETRY_REQUIRED, String(message).slice(0, 2000), record.id]);
    console.error(`[RouteSplit] transfer failed for payment ${record.razorpay_payment_id}:`, message);
    return { ...record, status: STATUSES.RETRY_REQUIRED, error_message: message };
  }
}

/** Re-attempts the transfer of a RETRY_REQUIRED ledger row. Never creates a second row or a second transfer. */
async function retryTransferRecord(recordId) {
  const [[row]] = await pool.query('SELECT * FROM route_split_transfers WHERE id = ?', [recordId]);
  if (!row) return { error: 'Transfer record not found' };
  if (row.status === STATUSES.SUCCESS || row.razorpay_transfer_id) return { error: 'This payment has already been transferred', record: row };
  if (row.status !== STATUSES.RETRY_REQUIRED) return { error: `Only RETRY_REQUIRED records can be retried (this one is ${row.status})`, record: row };
  if (!(Number(row.owner_transfer_minor) > 0)) return { error: 'Nothing to transfer for this record', record: row };
  // claim the row so two admins clicking at once cannot both call Razorpay
  const [claim] = await pool.query('UPDATE route_split_transfers SET status = ? WHERE id = ? AND status = ?', [STATUSES.PROCESSING, row.id, STATUSES.RETRY_REQUIRED]);
  if (claim.affectedRows !== 1) return { error: 'Another retry is already in progress', record: row };
  return { record: await executeTransfer({ ...row, status: STATUSES.PROCESSING }) };
}

// Read-only preview for a sport/activity subscription payment: no transfer is ever created from here and no ledger is touched.
async function previewSubscriptionSplit({ turfId, grossAmount }) {
  const turf = await getRouteConfig(turfId);
  if (!turf) return { routeEligible: false, reason: 'turf not found' };
  if (!isRouteReady(turf)) return { routeEligible: false, reason: turf && turf.route_enabled ? 'not fully configured/approved' : 'route not enabled for this venue' };
  const split = await calculateSplitFor(turf, grossAmount);
  return { routeEligible: true, routeConfig: { turfId, commissionType: turf.route_commission_type, splitPercentage: turf.route_split_percentage, flatAmount: turf.route_flat_amount, environment: turf.route_environment }, ...split };
}

module.exports = {
  STATUSES, ROUTE_STATUSES, COMMISSION_TYPES, calculateSplit, calculateFlatSplit, calculateSplitFor,
  validPercentage, validFlatAmount, validCommissionType, validLinkedAccountId,
  getRouteConfig, hasValidCommission, isRouteConnected, isRouteReady, processSplitTransfer, retryTransferRecord, previewSubscriptionSplit,
};
