// Per-turf billing configuration: one versioned, audited source of truth for HOW the platform earns on each venue.
// Admin-only writes (enforced at the route layer); owners and everything else only ever read through getEffectiveConfig.
//
// A config row is immutable once written. Changing a model/price inserts a NEW version with an effective date; old
// rows (and the snapshot stored on every transfer) are never edited, so a price change cannot rewrite history.
const pool = require('../config/db');
const pricing = require('./pricing');
const { cycleContaining, PERIOD_MONTHS } = require('./subscriptionCycle');

const MODEL_TO_LEGACY = { PERCENTAGE: 'percentage', FLAT: 'flat', SUBSCRIPTION: 'subscription' };
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function ymdToday(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function minorDigitsFor(currency, conn = pool) {
  try {
    const [[r]] = await conn.query('SELECT minor_digits FROM countries WHERE currency_code = ? LIMIT 1', [currency]);
    if (r && Number.isInteger(Number(r.minor_digits))) return Number(r.minor_digits);
  } catch (e) { /* countries table absent in a very old DB: fall through */ }
  return 2;
}

function normaliseRow(r) {
  if (!r) return null;
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: r.id, turf_id: r.turf_id, version: r.version, billing_model: r.billing_model,
    commission_bps: n(r.commission_bps), flat_fee_minor: n(r.flat_fee_minor), subscription_amount_minor: n(r.subscription_amount_minor),
    subscription_period: r.subscription_period || null, subscription_policy: r.subscription_policy || null,
    subscription_anchor_date: r.subscription_anchor_date ? (r.subscription_anchor_date instanceof Date ? ymdToday(r.subscription_anchor_date) : String(r.subscription_anchor_date).slice(0, 10)) : null,
    grace_period_days: n(r.grace_period_days), min_fee_minor: n(r.min_fee_minor), max_fee_minor: n(r.max_fee_minor),
    tax_mode: r.tax_mode || 'NONE', tax_bps: n(r.tax_bps), currency: r.currency, effective_from: r.effective_from,
    created_by: r.created_by, reason: r.reason, created_at: r.created_at, source: 'history',
  };
}

// What the engine did before versioned configs existed. Kept so a turf nobody has configured yet behaves exactly as it
// did, but never with an invented subscription amount (the old code silently assumed 799).
function legacyConfigFromTurf(turf) {
  const currency = turf.currency_code || 'INR';
  const isSub = turf.route_commission_type === 'subscription' || turf.billing_model === 'MONTHLY';
  const base = { id: null, turf_id: turf.id, version: 0, currency, tax_mode: 'NONE', tax_bps: null, source: 'legacy', min_fee_minor: null, max_fee_minor: null };
  if (isSub) {
    const amt = Number(turf.monthly_subscription_amount);
    return { ...base, billing_model: 'SUBSCRIPTION', commission_bps: null, flat_fee_minor: null, subscription_policy: 'DEDUCT_FROM_PROCEEDS', subscription_period: 'MONTHLY',
      subscription_anchor_date: turf.subscription_start_date ? String(turf.subscription_start_date instanceof Date ? ymdToday(turf.subscription_start_date) : turf.subscription_start_date).slice(0, 10) : null,
      subscription_amount_minor: amt > 0 ? Math.round(amt * 100) : null };
  }
  if (turf.route_commission_type === 'flat') {
    const f = Number(turf.route_flat_amount);
    return { ...base, billing_model: 'FLAT', commission_bps: null, subscription_amount_minor: null, flat_fee_minor: Number.isFinite(f) && f >= 0 ? Math.round(f * 100) : null };
  }
  // A missing legacy percentage is a configuration error. Never invent a 5% charge.
  const pct = turf.route_split_percentage != null ? Number(turf.route_split_percentage) : (turf.commission_percentage != null ? Number(turf.commission_percentage) : NaN);
  return { ...base, billing_model: 'PERCENTAGE', flat_fee_minor: null, subscription_amount_minor: null, commission_bps: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? Math.round(pct * 100) : null };
}

/** The configuration in force for a turf at `asOf` (default now). Falls back to the legacy columns if none was ever published. */
async function getEffectiveConfig(turf, asOf = new Date(), conn = pool) {
  const [[row]] = await conn.query(
    'SELECT * FROM turf_billing_config_history WHERE turf_id = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1',
    [turf.id, asOf]
  );
  return row ? normaliseRow(row) : legacyConfigFromTurf(turf);
}

async function listHistory(turfId, limit = 50) {
  const [rows] = await pool.query(
    `SELECT h.*, a.username AS admin_name FROM turf_billing_config_history h LEFT JOIN admins a ON a.id = h.created_by
     WHERE h.turf_id = ? ORDER BY h.version DESC LIMIT ?`, [turfId, Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  return rows.map((r) => ({ ...normaliseRow(r), admin_name: r.admin_name || null }));
}

const pctToBps = (v, label) => {
  const s = String(v).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new pricing.PricingConfigError(`${label} must be a number with at most 2 decimals`);
  return Math.round(Number(s) * 100);
};
const has = (v) => v !== undefined && v !== null && v !== '';

/**
 * Turns the admin form (major units: percent, rupees) into a validated config. Throws PricingConfigError.
 * Unknown/extra fields for another model are rejected by pricing.validateConfig.
 */
async function buildConfigFromInput(input, currency, conn = pool) {
  const md = await minorDigitsFor(currency, conn);
  const cfg = { billing_model: input.billing_model, currency, tax_mode: input.tax_mode || 'NONE' };
  cfg.commission_bps = has(input.commission_percent) ? pctToBps(input.commission_percent, 'commission_percent') : null;
  cfg.flat_fee_minor = has(input.flat_fee) ? pricing.toMinor(input.flat_fee, md) : null;
  cfg.subscription_amount_minor = has(input.subscription_amount) ? pricing.toMinor(input.subscription_amount, md) : null;
  cfg.min_fee_minor = has(input.min_fee) ? pricing.toMinor(input.min_fee, md) : null;
  cfg.max_fee_minor = has(input.max_fee) ? pricing.toMinor(input.max_fee, md) : null;
  cfg.tax_bps = has(input.tax_percent) ? pctToBps(input.tax_percent, 'tax_percent') : null;
  cfg.subscription_policy = has(input.subscription_policy) ? String(input.subscription_policy) : null;
  cfg.subscription_period = has(input.subscription_period) ? String(input.subscription_period) : null;
  cfg.subscription_anchor_date = has(input.subscription_start_date) ? String(input.subscription_start_date) : null;
  cfg.grace_period_days = has(input.grace_period_days) ? Number(input.grace_period_days) : null;

  const errors = pricing.validateConfig(cfg);
  if (cfg.billing_model === 'SUBSCRIPTION') {
    if (!PERIOD_MONTHS[cfg.subscription_period]) errors.push(`subscription_period must be one of ${Object.keys(PERIOD_MONTHS).join(', ')}`);
    if (!cfg.subscription_anchor_date || !YMD.test(cfg.subscription_anchor_date)) errors.push('subscription_start_date (YYYY-MM-DD) is required for the SUBSCRIPTION model');
    if (cfg.grace_period_days !== null && !(Number.isInteger(cfg.grace_period_days) && cfg.grace_period_days >= 0 && cfg.grace_period_days <= 90)) errors.push('grace_period_days must be an integer between 0 and 90');
  } else {
    for (const k of ['subscription_period', 'subscription_anchor_date', 'grace_period_days']) if (cfg[k] !== null) errors.push(`${k} only applies to the SUBSCRIPTION model`);
  }
  if (errors.length) throw new pricing.PricingConfigError(`Invalid billing configuration: ${errors.join('; ')}`, errors);
  return cfg;
}

/**
 * Publishes a NEW immutable version for a turf. One transaction: lock the turf, number the version, store the previous
 * configuration as a snapshot, write the audit row, and mirror the legacy columns when it is already in effect.
 * Never edits an earlier version and never touches any booking or transfer.
 */
async function publishConfig({ turfId, input, adminId, reason, connection = null }) {
  if (!has(reason) || String(reason).trim().length < 3) throw new pricing.PricingConfigError('A reason / note is required for every billing change');
  const conn = connection || await pool.getConnection();
  const ownsTransaction = !connection;
  try {
    if (ownsTransaction) await conn.beginTransaction();
    const [[turf]] = await conn.query(
      `SELECT id, currency_code, billing_model, commission_percentage, monthly_subscription_amount, route_commission_type, route_split_percentage, route_flat_amount, subscription_start_date
       FROM turfs WHERE id = ? FOR UPDATE`, [turfId]
    );
    if (!turf) { const e = new Error('Turf not found'); e.status = 404; throw e; }
    const currency = turf.currency_code || 'INR';
    const cfg = await buildConfigFromInput(input, currency, conn);

    const now = new Date();
    let effectiveFrom = now;
    if (has(input.effective_from)) {
      effectiveFrom = new Date(input.effective_from);
      if (Number.isNaN(effectiveFrom.getTime())) throw new pricing.PricingConfigError('effective_from is not a valid date');
      if (effectiveFrom.getTime() < now.getTime() - 60 * 1000) throw new pricing.PricingConfigError('effective_from cannot be in the past — changes are never applied retroactively');
      if (effectiveFrom.getTime() < now.getTime()) effectiveFrom = now;
    }

    const previous = await getEffectiveConfig(turf, now, conn);
    const [[v]] = await conn.query('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM turf_billing_config_history WHERE turf_id = ?', [turfId]);
    const [ins] = await conn.query(
      `INSERT INTO turf_billing_config_history
        (turf_id, version, billing_model, commission_bps, flat_fee_minor, subscription_amount_minor, subscription_period, subscription_policy,
         subscription_anchor_date, grace_period_days, min_fee_minor, max_fee_minor, tax_mode, tax_bps, currency, effective_from, created_by, reason, previous_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [turfId, v.next, cfg.billing_model, cfg.commission_bps, cfg.flat_fee_minor, cfg.subscription_amount_minor, cfg.subscription_period, cfg.subscription_policy,
       cfg.subscription_anchor_date, cfg.grace_period_days, cfg.min_fee_minor, cfg.max_fee_minor, cfg.tax_mode, cfg.tax_bps, currency, effectiveFrom, adminId || null,
       String(reason).trim().slice(0, 500), JSON.stringify(previous)]
    );

    // keep the legacy columns that older screens/code still read consistent with the live configuration
    if (effectiveFrom.getTime() <= now.getTime()) {
      const major = (minor) => (minor === null ? null : Number((minor / 100).toFixed(2)));
      await conn.query(
        `UPDATE turfs SET billing_model = ?, route_commission_type = ?, commission_percentage = COALESCE(?, commission_percentage),
           route_split_percentage = ?, route_flat_amount = ?, monthly_subscription_amount = COALESCE(?, monthly_subscription_amount),
           subscription_start_date = COALESCE(?, subscription_start_date)
         WHERE id = ?`,
        [cfg.billing_model === 'SUBSCRIPTION' ? 'MONTHLY' : 'PERCENTAGE', MODEL_TO_LEGACY[cfg.billing_model],
         cfg.commission_bps === null ? null : cfg.commission_bps / 100,
         cfg.billing_model === 'PERCENTAGE' ? cfg.commission_bps / 100 : null,
         cfg.billing_model === 'FLAT' ? major(cfg.flat_fee_minor) : null,
         cfg.billing_model === 'SUBSCRIPTION' ? major(cfg.subscription_amount_minor) : null,
         cfg.subscription_anchor_date, turfId]
      );
    }
    await conn.query(
      'INSERT INTO route_audit_log (turf_id, admin_id, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)',
      [turfId, adminId || 0, 'billing_config', `v${v.next}`, `${previous.billing_model}${previous.source === 'legacy' ? ' (legacy)' : ` v${previous.version}`}`.slice(0, 255), `${cfg.billing_model} effective ${effectiveFrom.toISOString()}`.slice(0, 255)]
    );
    if (ownsTransaction) await conn.commit();
    const [[row]] = await conn.query('SELECT * FROM turf_billing_config_history WHERE id = ?', [ins.insertId]);
    return normaliseRow(row);
  } catch (e) {
    if (ownsTransaction) { try { await conn.rollback(); } catch (_) { /* ignore */ } }
    throw e;
  } finally {
    if (ownsTransaction) conn.release();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Subscription cycles (one ledger row per cycle, price frozen at creation)
// ---------------------------------------------------------------------------------------------------------------

/** Everything that must be true before a payment can be settled under `config` (model rules + subscription schedule). */
function validateForSettlement(config) {
  const errors = pricing.validateConfig(config);
  if (config.billing_model === 'SUBSCRIPTION') {
    if (!PERIOD_MONTHS[config.subscription_period || '']) errors.push('subscription_period is not configured');
    if (!config.subscription_anchor_date || !YMD.test(config.subscription_anchor_date)) errors.push('the subscription start date is not configured');
  }
  return errors;
}

/**
 * Finds or creates the cycle containing `onDate` for a SUBSCRIPTION config. Returns null if the subscription has not
 * started. Must be called with a connection inside a transaction when the caller goes on to lock/deduct.
 */
async function ensureCycle(conn, turfId, config, onDate = ymdToday()) {
  if (config.billing_model !== 'SUBSCRIPTION') return null;
  const c = cycleContaining(config.subscription_anchor_date, onDate, config.subscription_period || 'MONTHLY');
  if (!c) return null;
  await conn.query(
    `INSERT IGNORE INTO turf_subscription_cycles (turf_id, cycle_start, cycle_end, amount_minor, currency, policy, config_history_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'UNPAID')`,
    [turfId, c.start, c.end, config.subscription_amount_minor, config.currency, config.subscription_policy, config.id]
  );
  const [[row]] = await conn.query('SELECT * FROM turf_subscription_cycles WHERE turf_id = ? AND cycle_start = ?', [turfId, c.start]);
  return row;
}

async function cycleTotals(conn, cycleId) {
  const [[d]] = await conn.query('SELECT COALESCE(SUM(amount_minor), 0) AS ded FROM turf_subscription_deductions WHERE cycle_id = ? AND reversed_at IS NULL', [cycleId]);
  const [[c]] = await conn.query('SELECT amount_minor, paid_separately_minor, cycle_start, cycle_end FROM turf_subscription_cycles WHERE id = ?', [cycleId]);
  const deducted = Number(d.ded);
  const paid = Number(c.paid_separately_minor);
  const outstanding = Math.max(0, Number(c.amount_minor) - deducted - paid);
  return { amountMinor: Number(c.amount_minor), deductedMinor: deducted, paidSeparatelyMinor: paid, outstandingMinor: outstanding, cycleStart: c.cycle_start, cycleEnd: c.cycle_end };
}

async function refreshCycleStatus(conn, cycleId) {
  const t = await cycleTotals(conn, cycleId);
  const status = t.outstandingMinor === 0 ? 'PAID' : (t.deductedMinor + t.paidSeparatelyMinor > 0 ? 'PARTIAL' : 'UNPAID');
  await conn.query('UPDATE turf_subscription_cycles SET status = ? WHERE id = ?', [status, cycleId]);
  return { ...t, status };
}

/** Read-only view for admin/owner screens: current cycle + recent cycles with computed OVERDUE/EXPIRED/SUSPENDED state. */
async function subscriptionOverview(turf, config) {
  if (config.billing_model !== 'SUBSCRIPTION') return null;
  const today = ymdToday();
  const current = cycleContaining(config.subscription_anchor_date, today, config.subscription_period || 'MONTHLY');
  if (current) await ensureCycle(pool, turf.id, config, today);
  const [rows] = await pool.query('SELECT * FROM turf_subscription_cycles WHERE turf_id = ? ORDER BY cycle_start DESC LIMIT 12', [turf.id]);
  const grace = config.grace_period_days || 0;
  const graceCutoff = (date) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + grace);
    return d.toISOString().slice(0, 10);
  };
  const daysBetween = (from, to) => Math.ceil((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  const cycles = [];
  for (const r of rows) {
    const t = await cycleTotals(pool, r.id);
    const endStr = r.cycle_end instanceof Date ? ymdToday(r.cycle_end) : String(r.cycle_end).slice(0, 10);
    const startStr = r.cycle_start instanceof Date ? ymdToday(r.cycle_start) : String(r.cycle_start).slice(0, 10);
    const dueDate = startStr;
    let status = t.outstandingMinor === 0 ? 'PAID' : (t.deductedMinor + t.paidSeparatelyMinor > 0 ? 'PARTIAL' : 'UNPAID');
    if (t.outstandingMinor > 0 && graceCutoff(dueDate) < today) status = 'OVERDUE';
    else if (t.outstandingMinor === 0 && endStr < today) status = 'EXPIRED';
    cycles.push({
      id: r.id, cycle_start: startStr, cycle_end: endStr, due_date: dueDate,
      days_remaining: daysBetween(today, dueDate), currency: r.currency, policy: r.policy, status,
      ...t,
      amount_minor: t.amountMinor, deducted_minor: t.deductedMinor,
      paid_separately_minor: t.paidSeparatelyMinor, outstanding_minor: t.outstandingMinor,
    });
  }
  return { today, current, grace_period_days: grace, cycles, started: !!current };
}

// ---------------------------------------------------------------------------------------------------------------
// Customer fee / tax rules (central, per country + currency)
// ---------------------------------------------------------------------------------------------------------------
async function getActiveFeeRule(countryCode, currencyCode, sectionType = 'ALL', asOf = new Date(), conn = pool) {
  const cCode = String(countryCode || 'IN').toUpperCase();
  const currCode = String(currencyCode || 'INR').toUpperCase();
  const sec = String(sectionType || 'ALL').toUpperCase();

  const [rows] = await conn.query(
    `SELECT * FROM platform_fee_rules 
     WHERE country_code = ? AND currency_code = ? AND is_active = 1 AND effective_from <= ?
       AND (apply_to = 'ALL' OR apply_to = ? OR apply_to IS NULL)
     ORDER BY (apply_to = ?) DESC, effective_from DESC, id DESC LIMIT 1`,
    [cCode, currCode, asOf, sec, sec]
  );
  const r = rows[0];
  if (!r) return null;
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    ...r,
    fee_fixed_minor: n(r.fee_fixed_minor),
    fee_bps: n(r.fee_bps),
    tax_bps: n(r.tax_bps),
    tax_inclusive: !!r.tax_inclusive,
    apply_to: r.apply_to || 'ALL',
    show_fee_at_checkout: r.show_fee_at_checkout !== 0,
    is_active: r.is_active !== 0
  };
}

/**
 * Calculates customer fee and tax from a fee rule and pre-fee amount.
 * Returns amounts in major currency units (e.g. Rupees).
 */
function calculateCustomerFee(rule, amountMajor) {
  const base = Math.max(0, Number(amountMajor || 0));
  if (!rule || rule.fee_type === 'NONE' || rule.is_active === false) {
    return {
      serviceFee: 0,
      serviceFeeTax: 0,
      totalCustomerFee: 0,
      totalPayable: base,
      showFeeAtCheckout: true,
      feeRuleId: null,
      feeRuleSnapshot: null
    };
  }

  let fee = 0;
  if (rule.fee_type === 'FIXED') {
    // fee_fixed_minor is in minor currency units (paise/cents)
    fee = (Number(rule.fee_fixed_minor) || 0) / 100;
  } else if (rule.fee_type === 'PERCENT') {
    // fee_bps in basis points (100 bps = 1%)
    fee = (base * (Number(rule.fee_bps) || 0)) / 10000;
  }
  fee = Math.round(fee * 100) / 100;

  let tax = 0;
  if (rule.tax_bps && fee > 0) {
    tax = (fee * Number(rule.tax_bps)) / 10000;
    tax = Math.round(tax * 100) / 100;
  }

  const showFee = rule.show_fee_at_checkout !== 0 && rule.show_fee_at_checkout !== false;
  const totalCustomerFee = Math.round((fee + tax) * 100) / 100;
  const totalPayable = Math.round((base + totalCustomerFee) * 100) / 100;

  const snapshot = {
    id: rule.id,
    fee_type: rule.fee_type,
    fee_fixed_minor: rule.fee_fixed_minor,
    fee_bps: rule.fee_bps,
    tax_bps: rule.tax_bps,
    tax_inclusive: rule.tax_inclusive,
    apply_to: rule.apply_to || 'ALL',
    show_fee_at_checkout: showFee,
    calculated_at: new Date().toISOString()
  };

  return {
    serviceFee: fee,
    serviceFeeTax: tax,
    totalCustomerFee,
    totalPayable,
    showFeeAtCheckout: showFee,
    feeRuleId: rule.id,
    feeRuleSnapshot: JSON.stringify(snapshot)
  };
}

async function publishFeeRule({ countryCode, currencyCode, input, adminId }) {
  const country = String(countryCode || '').toUpperCase(), currency = String(currencyCode || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(currency)) throw new pricing.PricingConfigError('country_code and currency_code are required');
  const md = await minorDigitsFor(currency);
  const feeType = String(input.fee_type || 'NONE').toUpperCase();
  if (!['NONE', 'FIXED', 'PERCENT'].includes(feeType)) throw new pricing.PricingConfigError('fee_type must be NONE, FIXED or PERCENT');
  const rule = { fee_type: feeType, fee_fixed_minor: null, fee_bps: null, tax_bps: null, tax_inclusive: !!input.tax_inclusive };
  if (feeType === 'FIXED') rule.fee_fixed_minor = pricing.toMinor(input.fee_fixed, md);
  if (feeType === 'PERCENT') rule.fee_bps = pctToBps(input.fee_percent, 'fee_percent');
  if (feeType !== 'NONE') {
    if (!has(input.tax_percent)) throw new pricing.PricingConfigError('tax_percent is required for a fee rule — enter 0 if this fee carries no tax. No rate is ever assumed.');
    rule.tax_bps = pctToBps(input.tax_percent, 'tax_percent');
  }
  const refundPolicy = String(input.refund_fee_policy || 'NON_REFUNDABLE').toUpperCase();
  if (!['NON_REFUNDABLE', 'REFUNDABLE'].includes(refundPolicy)) throw new pricing.PricingConfigError('refund_fee_policy must be NON_REFUNDABLE or REFUNDABLE');
  let effectiveFrom = new Date();
  if (has(input.effective_from)) {
    effectiveFrom = new Date(input.effective_from);
    if (Number.isNaN(effectiveFrom.getTime())) throw new pricing.PricingConfigError('effective_from is not a valid date');
    if (effectiveFrom.getTime() < Date.now() - 60 * 1000) throw new pricing.PricingConfigError('effective_from cannot be in the past');
    if (effectiveFrom.getTime() < Date.now()) effectiveFrom = new Date();
  }
  if (!has(input.note) || String(input.note).trim().length < 3) throw new pricing.PricingConfigError('A note is required for every fee/tax change');
  const applyTo = ['ALL', 'VENUE', 'ACTIVITY'].includes(String(input.apply_to || '').toUpperCase()) 
    ? String(input.apply_to).toUpperCase() 
    : 'ALL';
  const showFeeAtCheckout = input.show_fee_at_checkout === false || input.show_fee_at_checkout === 0 ? 0 : 1;
  const isActive = input.is_active === false || input.is_active === 0 ? 0 : 1;

  const [ins] = await pool.query(
    `INSERT INTO platform_fee_rules 
      (country_code, currency_code, fee_type, fee_fixed_minor, fee_bps, tax_bps, tax_inclusive, refund_fee_policy, coupon_applies_before_fee, effective_from, created_by, note, apply_to, show_fee_at_checkout, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [country, currency, rule.fee_type, rule.fee_fixed_minor, rule.fee_bps, rule.tax_bps, rule.tax_inclusive, refundPolicy, input.coupon_applies_before_fee === false ? 0 : 1, effectiveFrom, adminId || null, String(input.note).trim().slice(0, 500), applyTo, showFeeAtCheckout, isActive]
  );
  const [[row]] = await pool.query('SELECT * FROM platform_fee_rules WHERE id = ?', [ins.insertId]);
  return row;
}

async function listFeeRules() {
  const [rows] = await pool.query('SELECT r.*, a.username AS admin_name FROM platform_fee_rules r LEFT JOIN admins a ON a.id = r.created_by ORDER BY r.country_code, r.currency_code, r.effective_from DESC, r.id DESC LIMIT 200');
  return rows;
}

module.exports = {
  ymdToday, minorDigitsFor, legacyConfigFromTurf, getEffectiveConfig, validateForSettlement, listHistory, buildConfigFromInput, publishConfig,
  ensureCycle, cycleTotals, refreshCycleStatus, subscriptionOverview,
  getActiveFeeRule, calculateCustomerFee, publishFeeRule, listFeeRules,
};
