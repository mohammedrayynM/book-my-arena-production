// Run: node --test tests/pricing.test.js   (pure maths, no database needed)
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../services/pricing');

const pct = (bps, extra = {}) => ({ billing_model: 'PERCENTAGE', commission_bps: bps, ...extra });
const flat = (minor, extra = {}) => ({ billing_model: 'FLAT', flat_fee_minor: minor, ...extra });
const subs = (amount, policy, extra = {}) => ({ billing_model: 'SUBSCRIPTION', subscription_amount_minor: amount, subscription_policy: policy, ...extra });
const settle = (captured, config, extra = {}) => P.computeSettlement({ capturedMinor: captured, currency: 'INR', config, ...extra });

test('percentage: 5% of Rs 1000 = Rs 50, owner Rs 950', () => {
  const s = settle(100000, pct(500));
  assert.equal(s.platformFeeMinor, 5000);
  assert.equal(s.ownerTransferMinor, 95000);
  assert.equal(s.platformRetainedMinor + s.ownerTransferMinor, s.capturedMinor);
});

test('percentage rounds half up and never drifts', () => {
  // 7.5% of Rs 33.33 = 2.49975 -> 250 paise? basis 3333 * 750 / 10000 = 249.975 -> 250
  const s = settle(3333, pct(750));
  assert.equal(s.platformFeeMinor, 250);
  assert.equal(s.ownerTransferMinor, 3083);
});

test('flat fee Rs 30 on Rs 1000', () => {
  const s = settle(100000, flat(3000));
  assert.equal(s.platformFeeMinor, 3000);
  assert.equal(s.ownerTransferMinor, 97000);
});

test('flat fee larger than the payment is clamped, owner gets 0 and it is flagged', () => {
  const s = settle(2000, flat(3000));
  assert.equal(s.platformFeeMinor, 2000);
  assert.equal(s.ownerTransferMinor, 0);
  assert.ok(s.flags.includes('fee_clamped_to_basis'));
  assert.ok(s.flags.includes('owner_receives_nothing'));
});

test('min / max fee limits apply', () => {
  assert.equal(settle(10000, pct(100, { min_fee_minor: 500 })).platformFeeMinor, 500);
  assert.equal(settle(10000000, pct(1000, { max_fee_minor: 20000 })).platformFeeMinor, 20000);
});

test('subscription DEDUCT_FROM_PROCEEDS deducts only the outstanding amount', () => {
  const s = settle(100000, subs(79900, 'DEDUCT_FROM_PROCEEDS'), { subscriptionOutstandingMinor: 79900 });
  assert.equal(s.subscriptionDeductionMinor, 79900);
  assert.equal(s.ownerTransferMinor, 20100);
  const s2 = settle(100000, subs(79900, 'DEDUCT_FROM_PROCEEDS'), { subscriptionOutstandingMinor: 10000 });
  assert.equal(s2.subscriptionDeductionMinor, 10000);
  assert.equal(s2.ownerTransferMinor, 90000);
  const s3 = settle(5000, subs(79900, 'DEDUCT_FROM_PROCEEDS'), { subscriptionOutstandingMinor: 79900 });
  assert.equal(s3.subscriptionDeductionMinor, 5000); // never more than the booking
  assert.equal(s3.ownerTransferMinor, 0);
});

test('subscription SEPARATE never deducts from bookings', () => {
  const s = settle(100000, subs(79900, 'SEPARATE'), { subscriptionOutstandingMinor: 79900 });
  assert.equal(s.subscriptionDeductionMinor, 0);
  assert.equal(s.platformFeeMinor, 0);
  assert.equal(s.ownerTransferMinor, 100000);
});

test('tax EXCLUSIVE is charged to the owner on top of the fee', () => {
  const s = settle(100000, pct(500, { tax_mode: 'EXCLUSIVE', tax_bps: 1800 }));
  assert.equal(s.platformFeeMinor, 5000);
  assert.equal(s.taxOnPlatformFeeMinor, 900);
  assert.equal(s.ownerTransferMinor, 94100);
  assert.equal(s.taxLiabilityMinor, 900);
});

test('tax INCLUSIVE is carved out of the fee, owner pays only the fee', () => {
  const s = settle(100000, pct(500, { tax_mode: 'INCLUSIVE', tax_bps: 1800 }));
  assert.equal(s.platformFeeMinor, 5000);
  assert.equal(s.taxOnPlatformFeeMinor, 763); // 5000 - round(5000/1.18)=4237
  assert.equal(s.ownerTransferMinor, 95000);
  assert.equal(s.platformRevenueNetOfTaxMinor, 4237);
});

test('a tax mode without a rate is a configuration error, never an invented rate', () => {
  assert.throws(() => settle(100000, pct(500, { tax_mode: 'EXCLUSIVE' })), P.PricingConfigError);
});

test('incompatible billing fields are rejected (no double charging)', () => {
  assert.ok(P.validateConfig({ billing_model: 'PERCENTAGE', commission_bps: 500, flat_fee_minor: 3000 }).length > 0);
  assert.ok(P.validateConfig({ billing_model: 'FLAT', flat_fee_minor: 3000, commission_bps: 500 }).length > 0);
  assert.ok(P.validateConfig({ billing_model: 'FLAT', flat_fee_minor: 3000, subscription_amount_minor: 100 }).length > 0);
  assert.ok(P.validateConfig(subs(100, 'SEPARATE', { commission_bps: 500 })).length > 0);
  assert.ok(P.validateConfig(subs(100, undefined)).length > 0);
  assert.deepEqual(P.validateConfig(pct(500)), []);
  assert.throws(() => settle(100, { billing_model: 'PERCENTAGE', commission_bps: 500, flat_fee_minor: 5 }), P.PricingConfigError);
});

test('customer service fee is kept by the platform and never reduces what the owner is owed', () => {
  // booking Rs 1000 + fee Rs 20 + 18% tax on fee (Rs 3.60) => customer paid 1023.60; 5% commission on the Rs 1000 basis
  const fee = P.computeCustomerFee({ bookingMinor: 100000, rule: { fee_type: 'FIXED', fee_fixed_minor: 2000, tax_bps: 1800, tax_inclusive: false } });
  assert.deepEqual(fee, { customerFeeMinor: 2000, customerFeeTaxMinor: 360, customerPayableMinor: 102360 });
  const s = settle(fee.customerPayableMinor, pct(500), { customerFeeMinor: fee.customerFeeMinor, customerFeeTaxMinor: fee.customerFeeTaxMinor });
  assert.equal(s.basisMinor, 100000);
  assert.equal(s.platformFeeMinor, 5000);
  assert.equal(s.ownerTransferMinor, 95000);
  assert.equal(s.platformRetainedMinor, 2000 + 360 + 5000);
});

test('customer fee rule with no tax rate is an error', () => {
  assert.throws(() => P.computeCustomerFee({ bookingMinor: 100000, rule: { fee_type: 'FIXED', fee_fixed_minor: 2000 } }), P.PricingConfigError);
  assert.deepEqual(P.computeCustomerFee({ bookingMinor: 100000, rule: null }), { customerFeeMinor: 0, customerFeeTaxMinor: 0, customerPayableMinor: 100000 });
});

test('advance payment: settlement is computed on what was captured, not the full booking', () => {
  const s = settle(30000, pct(500)); // Rs 300 advance of a Rs 1000 booking
  assert.equal(s.platformFeeMinor, 1500);
  assert.equal(s.ownerTransferMinor, 28500);
});

test('refund reversal is pro-rata and sums exactly', () => {
  const s = settle(100000, pct(500));
  const r = P.computeRefundReversal({ settlement: s, refundMinor: 33333 });
  assert.equal(r.ownerReversalMinor + r.platformReversalMinor, 33333);
  assert.equal(r.ownerReversalMinor, Math.floor((95000 * 33333) / 100000));
  assert.throws(() => P.computeRefundReversal({ settlement: s, refundMinor: 100001 }), P.PricingConfigError);
});

test('toMinor is exact', () => {
  assert.equal(P.toMinor('1000'), 100000);
  assert.equal(P.toMinor('0.1') + P.toMinor('0.2'), 30);
  assert.equal(P.toMinor(19.99), 1999);
  assert.throws(() => P.toMinor('-5'), P.PricingConfigError);
  assert.throws(() => P.toMinor('1.234'), P.PricingConfigError);
  assert.equal(P.fromMinor(1999), 19.99);
});

test('invariant holds across many amounts and models', () => {
  const configs = [pct(0), pct(500), pct(10000), flat(0), flat(3000), pct(750, { tax_mode: 'EXCLUSIVE', tax_bps: 1800 }), pct(750, { tax_mode: 'INCLUSIVE', tax_bps: 1800 })];
  for (const cfg of configs) {
    for (let cap = 1; cap <= 250000; cap += 997) {
      const s = settle(cap, cfg);
      assert.equal(s.ownerTransferMinor + s.platformRetainedMinor, cap);
      assert.ok(s.ownerTransferMinor >= 0);
    }
  }
});
