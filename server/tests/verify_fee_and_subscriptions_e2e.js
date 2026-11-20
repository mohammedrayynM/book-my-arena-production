// End-to-end verification script for Issue 1 and Issue 2
const billingConfig = require('../services/billingConfig');
const subscriptionReservations = require('../services/subscriptionReservations');

async function testIssue1FeeCalculation() {
  console.log('\n--- TEST SUITE 1: Admin-Controlled Platform Fee Calculation Base ---');

  // Rule 1: FULL booking amount base
  const ruleFull = {
    id: 9991,
    fee_type: 'PERCENT',
    fee_bps: 500, // 5%
    tax_bps: 500, // 5% on fee
    is_active: 1,
    calculation_base: 'FULL'
  };

  // Rule 2: ONLINE payment amount only base
  const ruleOnline = {
    id: 9992,
    fee_type: 'PERCENT',
    fee_bps: 500, // 5%
    tax_bps: 500, // 5% on fee
    is_active: 1,
    calculation_base: 'ONLINE'
  };

  const fullAmount = 1000;
  const advanceAmount = 300; // 30% advance

  // Test with ruleFull
  const calcFull = billingConfig.calculateCustomerFee(ruleFull, fullAmount, advanceAmount);
  console.log('Rule: FULL booking amount base');
  console.log('  Base = ₹1000, Advance = ₹300');
  console.log(`  Service Fee: ₹${calcFull.serviceFee} (Expected: 50)`);
  console.log(`  Service Fee Tax: ₹${calcFull.serviceFeeTax} (Expected: 2.5)`);
  console.log(`  Total Customer Fee: ₹${calcFull.totalCustomerFee} (Expected: 52.5)`);
  
  if (calcFull.serviceFee !== 50 || calcFull.serviceFeeTax !== 2.5) {
    throw new Error(`FAIL: calcFull expected 50 and 2.5, got ${calcFull.serviceFee} and ${calcFull.serviceFeeTax}`);
  }
  console.log('  ✓ Pass: Full base correctly calculates fee on ₹1,000');

  // Test with ruleOnline
  const calcOnline = billingConfig.calculateCustomerFee(ruleOnline, fullAmount, advanceAmount);
  console.log('Rule: ONLINE payment amount only base');
  console.log('  Base = ₹1000, Online Amount = ₹300');
  console.log(`  Service Fee: ₹${calcOnline.serviceFee} (Expected: 15)`);
  console.log(`  Service Fee Tax: ₹${calcOnline.serviceFeeTax} (Expected: 0.75)`);
  console.log(`  Total Customer Fee: ₹${calcOnline.totalCustomerFee} (Expected: 15.75)`);

  if (calcOnline.serviceFee !== 15 || calcOnline.serviceFeeTax !== 0.75) {
    throw new Error(`FAIL: calcOnline expected 15 and 0.75, got ${calcOnline.serviceFee} and ${calcOnline.serviceFeeTax}`);
  }
  console.log('  ✓ Pass: Online base correctly calculates fee on ₹300 online advance');

  // Test full payment with ruleOnline (when payment is full, online = full)
  const calcOnlineFullPayment = billingConfig.calculateCustomerFee(ruleOnline, fullAmount, fullAmount);
  console.log('Rule: ONLINE with full payment (online = full)');
  console.log(`  Service Fee: ₹${calcOnlineFullPayment.serviceFee} (Expected: 50)`);
  if (calcOnlineFullPayment.serviceFee !== 50) {
    throw new Error(`FAIL: calcOnlineFullPayment expected 50, got ${calcOnlineFullPayment.serviceFee}`);
  }
  console.log('  ✓ Pass: Online base with 100% online payment correctly equals full amount fee');
}

async function testIssue2Subscriptions() {
  console.log('\n--- TEST SUITE 2: Multi-Member Subscriptions & Slot Blocking ---');

  // Verify time helpers and slot overlap math
  const startMins = subscriptionReservations.toMinutes('06:00');
  const endMins = subscriptionReservations.toMinutes('07:00');
  console.log(`Time parsing: 06:00 -> ${startMins} mins, 07:00 -> ${endMins} mins`);
  if (startMins !== 360 || endMins !== 420) {
    throw new Error('FAIL: Time parsing mismatch');
  }

  // Overlap test: slot from 06:00 to 07:00
  const overlaps1 = subscriptionReservations.overlaps(360, 420, 360, 420); // exact match
  const overlaps2 = subscriptionReservations.overlaps(360, 420, 390, 450); // partial overlap
  const overlaps3 = subscriptionReservations.overlaps(360, 420, 420, 480); // adjacent, no overlap
  console.log(`Overlap checks: exact=${overlaps1}, partial=${overlaps2}, adjacent=${overlaps3}`);
  if (!overlaps1 || !overlaps2 || overlaps3) {
    throw new Error('FAIL: Overlap math mismatch');
  }
  console.log('  ✓ Pass: Overlap math correctly identifies reserved slot boundaries');

  // Verify date math: calendar months clamp
  const clamped1 = subscriptionReservations.addMonthsClamped('2026-01-31', 1);
  console.log(`Clamped add month: 2026-01-31 + 1 month = ${clamped1} (Expected: 2026-02-28)`);
  if (clamped1 !== '2026-02-28') {
    throw new Error(`FAIL: Expected 2026-02-28, got ${clamped1}`);
  }
  console.log('  ✓ Pass: Month calculation accurately respects calendar month boundaries');
}

async function main() {
  try {
    await testIssue1FeeCalculation();
    await testIssue2Subscriptions();
    console.log('\n========================================');
    console.log('🎉 ALL TEST SUITES PASSED SUCCESSFULLY!');
    console.log('========================================\n');
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message);
    process.exit(1);
  }
}

main();
