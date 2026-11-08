// The ONE place that turns "a customer paid X" into "the platform keeps A, the owner gets B".
//
// Everything here is pure (no DB, no network) and works in INTEGER MINOR UNITS (paise/cents) with percentages in basis
// points (1 bp = 0.01%), so there is no floating-point drift anywhere. Checkout, the Route transfer, the transfer ledger,
// owner statements, admin reports and refunds must all call this module instead of re-deriving the maths.
//
// ORDER OF OPERATIONS (documented, fixed):
//   1. captured            what Razorpay actually captured for this payment (never a client-supplied number)
//   2. - customerFee       platform service fee the customer paid ON TOP of the booking (platform keeps it)
//   3. - customerFeeTax    tax the customer paid on that fee (platform's tax liability, never the owner's)
//   4. = basis             the booking money that belongs to the owner before platform charges
//   5. platform charge on `basis` per the turf's ONE billing model:
//        PERCENTAGE    fee = round_half_up(basis * commission_bps / 10000)
//        FLAT          fee = flat_fee_minor
//        SUBSCRIPTION  fee = 0; if policy is DEDUCT_FROM_PROCEEDS, deduct min(outstanding subscription, basis);
//                      if policy is SEPARATE, nothing is deducted from bookings (it is billed on its own)
//      PERCENTAGE / FLAT fees are then clamped into [min_fee_minor, max_fee_minor] and never exceed `basis`.
//   6. tax on the platform charge, per the turf's tax_mode:
//        NONE       no tax
//        EXCLUSIVE  tax = round_half_up(fee * tax_bps / 10000) is charged to the owner IN ADDITION to the fee
//        INCLUSIVE  the fee already contains tax: tax = fee - round_half_up(fee * 10000 / (10000 + tax_bps))
//      If a tax mode other than NONE has no tax_bps, that is a configuration error — a rate is never invented.
//   7. owner transfer = captured - everything the platform retains. By construction
//        ownerTransferMinor + platformRetainedMinor === capturedMinor   (asserted below)

const MODELS = ['PERCENTAGE', 'FLAT', 'SUBSCRIPTION'];
const SUBSCRIPTION_POLICIES = ['SEPARATE', 'DEDUCT_FROM_PROCEEDS'];
const TAX_MODES = ['NONE', 'INCLUSIVE', 'EXCLUSIVE'];

class PricingConfigError extends Error {
  constructor(message, errors) { super(message); this.name = 'PricingConfigError'; this.errors = errors || [message]; }
}

const isInt = (n) => Number.isSafeInteger(n);
const nz = (v) => v !== null && v !== undefined && v !== '';

// round half up on non-negative integers: round(amount * bps / 10000)
function mulBps(amountMinor, bps) {
  return Math.floor((amountMinor * bps + 5000) / 10000);
}

// "123.45" | 123.45 -> 12345 (minor digits of the currency). Rejects NaN/negatives/too many decimals.
function toMinor(value, minorDigits = 2) {
  if (value === null || value === undefined || value === '') throw new PricingConfigError('amount is required');
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new PricingConfigError(`"${s}" is not a valid non-negative amount`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > minorDigits && /[1-9]/.test(frac.slice(minorDigits))) throw new PricingConfigError(`"${s}" has more than ${minorDigits} decimal places`);
  const padded = (frac + '0'.repeat(minorDigits)).slice(0, minorDigits);
  const out = Number(whole) * 10 ** minorDigits + Number(padded || 0);
  if (!isInt(out)) throw new PricingConfigError('amount is too large');
  return out;
}
const fromMinor = (minor, minorDigits = 2) => Number((minor / 10 ** minorDigits).toFixed(minorDigits));

/**
 * Checks ONE turf billing configuration. Returns an array of problems (empty = valid).
 * A configuration may only fill in the fields of its own model, so percentage + flat + subscription can never be
 * charged together by accident.
 */
function validateConfig(c) {
  const errors = [];
  if (!c || typeof c !== 'object') return ['configuration is required'];
  if (!MODELS.includes(c.billing_model)) errors.push(`billing_model must be one of ${MODELS.join(', ')}`);
  const bps = c.commission_bps, flat = c.flat_fee_minor, sub = c.subscription_amount_minor;

  if (c.billing_model === 'PERCENTAGE') {
    if (!isInt(bps) || bps < 0 || bps > 10000) errors.push('commission_bps must be an integer between 0 and 10000');
    if (nz(flat)) errors.push('flat_fee_minor must be empty for the PERCENTAGE model');
    if (nz(sub)) errors.push('subscription_amount_minor must be empty for the PERCENTAGE model');
  } else if (c.billing_model === 'FLAT') {
    if (!isInt(flat) || flat < 0) errors.push('flat_fee_minor must be a non-negative integer');
    if (nz(bps) && bps !== 0) errors.push('commission_bps must be empty for the FLAT model');
    if (nz(sub)) errors.push('subscription_amount_minor must be empty for the FLAT model');
  } else if (c.billing_model === 'SUBSCRIPTION') {
    if (!isInt(sub) || sub < 0) errors.push('subscription_amount_minor must be a non-negative integer');
    if (!SUBSCRIPTION_POLICIES.includes(c.subscription_policy)) errors.push(`subscription_policy must be one of ${SUBSCRIPTION_POLICIES.join(', ')}`);
    if (nz(bps) && bps !== 0) errors.push('commission_bps must be empty for the SUBSCRIPTION model');
    if (nz(flat)) errors.push('flat_fee_minor must be empty for the SUBSCRIPTION model');
  }
  if (c.billing_model !== 'SUBSCRIPTION' && nz(c.subscription_policy)) errors.push('subscription_policy only applies to the SUBSCRIPTION model');

  for (const k of ['min_fee_minor', 'max_fee_minor']) {
    if (nz(c[k])) {
      if (c.billing_model === 'SUBSCRIPTION') errors.push(`${k} does not apply to the SUBSCRIPTION model`);
      else if (!isInt(c[k]) || c[k] < 0) errors.push(`${k} must be a non-negative integer`);
    }
  }
  if (nz(c.min_fee_minor) && nz(c.max_fee_minor) && c.min_fee_minor > c.max_fee_minor) errors.push('min_fee_minor cannot exceed max_fee_minor');

  const taxMode = c.tax_mode || 'NONE';
  if (!TAX_MODES.includes(taxMode)) errors.push(`tax_mode must be one of ${TAX_MODES.join(', ')}`);
  else if (taxMode !== 'NONE' && !(isInt(c.tax_bps) && c.tax_bps >= 0 && c.tax_bps <= 10000)) errors.push('tax_bps (0-10000) is required when tax_mode is not NONE — no tax rate is ever assumed');
  if (taxMode === 'NONE' && nz(c.tax_bps) && c.tax_bps !== 0) errors.push('tax_bps must be empty when tax_mode is NONE');
  if (c.billing_model === 'SUBSCRIPTION' && taxMode !== 'NONE') errors.push('the subscription amount is tax-inclusive as configured; use tax_mode NONE for the SUBSCRIPTION model');
  return errors;
}

/**
 * @param {{ capturedMinor:number, currency:string, config:object, customerFeeMinor?:number, customerFeeTaxMinor?:number,
 *           subscriptionOutstandingMinor?:number }} p
 * @returns all amounts in minor units. Throws PricingConfigError on a bad configuration.
 */
function computeSettlement({ capturedMinor, currency, config, customerFeeMinor = 0, customerFeeTaxMinor = 0, subscriptionOutstandingMinor = 0 }) {
  if (!isInt(capturedMinor) || capturedMinor <= 0) throw new PricingConfigError('capturedMinor must be a positive integer');
  if (!currency) throw new PricingConfigError('currency is required');
  for (const [k, v] of Object.entries({ customerFeeMinor, customerFeeTaxMinor, subscriptionOutstandingMinor })) {
    if (!isInt(v) || v < 0) throw new PricingConfigError(`${k} must be a non-negative integer`);
  }
  const problems = validateConfig(config);
  if (problems.length) throw new PricingConfigError(`Invalid billing configuration: ${problems.join('; ')}`, problems);

  const flags = [];
  const customerRetained = customerFeeMinor + customerFeeTaxMinor;
  if (customerRetained > capturedMinor) throw new PricingConfigError('customer fee + tax exceed the captured amount');
  const basis = capturedMinor - customerRetained;

  let feeMinor = 0;
  let subscriptionDeductionMinor = 0;
  if (config.billing_model === 'PERCENTAGE') feeMinor = mulBps(basis, config.commission_bps);
  else if (config.billing_model === 'FLAT') feeMinor = config.flat_fee_minor;
  else if (config.subscription_policy === 'DEDUCT_FROM_PROCEEDS') subscriptionDeductionMinor = Math.min(subscriptionOutstandingMinor, basis);

  if (config.billing_model !== 'SUBSCRIPTION') {
    if (nz(config.min_fee_minor) && feeMinor < config.min_fee_minor) { feeMinor = config.min_fee_minor; flags.push('min_fee_applied'); }
    if (nz(config.max_fee_minor) && feeMinor > config.max_fee_minor) { feeMinor = config.max_fee_minor; flags.push('max_fee_applied'); }
    if (feeMinor > basis) { feeMinor = basis; flags.push('fee_clamped_to_basis'); }
  }

  const taxMode = config.tax_mode || 'NONE';
  let taxOnFeeMinor = 0;
  let ownerChargedTaxMinor = 0; // the part of the tax that is charged to the owner on top of the fee
  if (feeMinor > 0 && taxMode === 'EXCLUSIVE') {
    taxOnFeeMinor = mulBps(feeMinor, config.tax_bps);
    if (feeMinor + taxOnFeeMinor > basis) { taxOnFeeMinor = basis - feeMinor; flags.push('tax_clamped_to_basis'); }
    ownerChargedTaxMinor = taxOnFeeMinor;
  } else if (feeMinor > 0 && taxMode === 'INCLUSIVE') {
    taxOnFeeMinor = feeMinor - Math.round((feeMinor * 10000) / (10000 + config.tax_bps));
  }

  const platformRetainedMinor = customerRetained + feeMinor + ownerChargedTaxMinor + subscriptionDeductionMinor;
  const ownerTransferMinor = capturedMinor - platformRetainedMinor;
  if (ownerTransferMinor < 0 || ownerTransferMinor + platformRetainedMinor !== capturedMinor) throw new PricingConfigError('internal settlement mismatch');
  if (ownerTransferMinor === 0) flags.push('owner_receives_nothing');

  const taxOnCustomerFeeMinor = customerFeeTaxMinor;
  return {
    currency,
    capturedMinor,
    basisMinor: basis,
    billingModel: config.billing_model,
    customerFeeMinor,
    customerFeeTaxMinor: taxOnCustomerFeeMinor,
    platformFeeMinor: feeMinor,
    taxOnPlatformFeeMinor: taxOnFeeMinor,
    taxMode,
    subscriptionDeductionMinor,
    platformRetainedMinor,           // everything that stays with the platform, tax included
    // platform revenue excluding tax it must remit: customer fee + commission net of its tax + subscription deduction
    platformRevenueNetOfTaxMinor: customerFeeMinor + (feeMinor - (taxMode === 'INCLUSIVE' ? taxOnFeeMinor : 0)) + subscriptionDeductionMinor,
    taxLiabilityMinor: taxOnFeeMinor + taxOnCustomerFeeMinor,
    ownerTransferMinor,
    flags,
  };
}

/**
 * A refund of `refundMinor` out of a payment that was settled as `settlement`. The refund is shared pro-rata:
 * the owner gives back their share, the platform gives back the rest, and the two always sum to the refund.
 */
function computeRefundReversal({ settlement, refundMinor }) {
  if (!isInt(refundMinor) || refundMinor <= 0) throw new PricingConfigError('refundMinor must be a positive integer');
  if (refundMinor > settlement.capturedMinor) throw new PricingConfigError('refund exceeds the captured amount');
  const ownerShare = Math.floor((settlement.ownerTransferMinor * refundMinor) / settlement.capturedMinor);
  return { refundMinor, ownerReversalMinor: ownerShare, platformReversalMinor: refundMinor - ownerShare };
}

/**
 * The customer-facing platform service fee for a booking amount, from ONE fee rule row
 * ({ fee_type: 'NONE'|'FIXED'|'PERCENT', fee_fixed_minor, fee_bps, tax_bps, tax_inclusive }).
 * No rule => no fee (explicit "no fee configured"), never a guessed one.
 */
function computeCustomerFee({ bookingMinor, rule }) {
  if (!rule || rule.fee_type === 'NONE') return { customerFeeMinor: 0, customerFeeTaxMinor: 0, customerPayableMinor: bookingMinor };
  if (!isInt(bookingMinor) || bookingMinor < 0) throw new PricingConfigError('bookingMinor must be a non-negative integer');
  let base;
  if (rule.fee_type === 'FIXED') {
    if (!isInt(rule.fee_fixed_minor) || rule.fee_fixed_minor < 0) throw new PricingConfigError('fee rule has no valid fixed amount');
    base = rule.fee_fixed_minor;
  } else if (rule.fee_type === 'PERCENT') {
    if (!isInt(rule.fee_bps) || rule.fee_bps < 0 || rule.fee_bps > 10000) throw new PricingConfigError('fee rule has no valid percentage');
    base = mulBps(bookingMinor, rule.fee_bps);
  } else throw new PricingConfigError(`unknown fee_type "${rule.fee_type}"`);

  if (base === 0) return { customerFeeMinor: 0, customerFeeTaxMinor: 0, customerPayableMinor: bookingMinor };
  if (!nz(rule.tax_bps)) throw new PricingConfigError('This fee rule has no tax rate configured. Set tax_bps (use 0 if the fee is untaxed).');
  if (rule.tax_inclusive) {
    const net = Math.round((base * 10000) / (10000 + rule.tax_bps));
    return { customerFeeMinor: net, customerFeeTaxMinor: base - net, customerPayableMinor: bookingMinor + base };
  }
  const tax = mulBps(base, rule.tax_bps);
  return { customerFeeMinor: base, customerFeeTaxMinor: tax, customerPayableMinor: bookingMinor + base + tax };
}

module.exports = {
  MODELS, SUBSCRIPTION_POLICIES, TAX_MODES, PricingConfigError,
  mulBps, toMinor, fromMinor, validateConfig, computeSettlement, computeRefundReversal, computeCustomerFee,
};
