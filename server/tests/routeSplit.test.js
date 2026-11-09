// Integration tests against a THROWAWAY database (see tests/helpers/testDb.js). Razorpay is replaced by a fake provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---- fake Razorpay provider, installed before routeSplit loads ----
const calls = { transfers: [] };
let failNext = false;
const fake = {
  createTransfer: async (p) => {
    if (failNext) { failNext = false; throw new Error('gateway down'); }
    calls.transfers.push(p);
    return { id: `trf_${calls.transfers.length}`, simulated: true };
  },
  fetchPayment: async () => ({}), listTransfers: async () => [], fetchAccount: async () => ({ status: 'activated' }),
};
const providerPath = require.resolve('../services/routeProvider');
require.cache[providerPath] = { id: providerPath, filename: providerPath, loaded: true, exports: fake };

const db = require('./helpers/testDb');
const routeSplit = require('../services/routeSplit');
const billing = require('../services/billingConfig');

test.before(async () => { await db.setup(); });
test.beforeEach(async () => { await db.reset(); calls.transfers.length = 0; failNext = false; });
test.after(async () => { await db.pool.end(); });

const admin = async () => (await db.pool.query("INSERT INTO admins (username) VALUES ('root')"))[0].insertId;

test('percentage: unconfigured turf uses legacy 5%, owner share goes to THAT turf\'s account', async () => {
  const a = await db.seedTurf({ name: 'A' }); const b = await db.seedTurf({ name: 'B' });
  await db.routeOn(a, 'acc_AAAAAAAAAA01'); await db.routeOn(b, 'acc_BBBBBBBBBB01');
  const bk = await db.seedBooking(a, { amount: 1000, order: 'order_a' });
  const r = await routeSplit.processSplitTransfer({ paymentId: 'pay_1', orderId: 'order_a', bookingIds: [bk] });
  assert.equal(r.status, 'SUCCESS');
  assert.equal(calls.transfers.length, 1);
  assert.equal(calls.transfers[0].linkedAccountId, 'acc_AAAAAAAAAA01'); // never turf B's account
  assert.equal(calls.transfers[0].amountPaise, 95000);
  assert.equal(Number(r.platform_amount), 50);
  assert.equal(r.billing_model, 'PERCENTAGE');
});

test('duplicate verify/webhook for the same payment creates exactly one transfer', async () => {
  const t = await db.seedTurf(); await db.routeOn(t);
  const bk = await db.seedBooking(t, { amount: 500 });
  const [r1, r2, r3] = await Promise.all([1, 2, 3].map(() => routeSplit.processSplitTransfer({ paymentId: 'pay_dup', bookingIds: [bk] })));
  assert.equal(calls.transfers.length, 1);
  const [[c]] = await db.pool.query("SELECT COUNT(*) AS c FROM route_split_transfers WHERE razorpay_payment_id = 'pay_dup'");
  assert.equal(Number(c.c), 1);
  assert.ok([r1, r2, r3].every((r) => r.razorpay_payment_id === 'pay_dup'));
});

test('a booking id from another turf cannot be mixed into one payment', async () => {
  const a = await db.seedTurf(); const b = await db.seedTurf(); await db.routeOn(a); await db.routeOn(b);
  const [x, y] = [await db.seedBooking(a), await db.seedBooking(b)];
  const r = await routeSplit.processSplitTransfer({ paymentId: 'pay_mix', bookingIds: [x, y] });
  assert.match(r.error, /more than one turf/);
  assert.equal(calls.transfers.length, 0);
});

test('order id that does not belong to the bookings is refused', async () => {
  const t = await db.seedTurf(); await db.routeOn(t);
  const bk = await db.seedBooking(t, { order: 'order_real' });
  const r = await routeSplit.processSplitTransfer({ paymentId: 'pay_x', orderId: 'order_other', bookingIds: [bk] });
  assert.match(r.error, /do not belong/);
  assert.equal(calls.transfers.length, 0);
});

test('route disabled: no ledger row, no transfer', async () => {
  const t = await db.seedTurf(); const bk = await db.seedBooking(t);
  const r = await routeSplit.processSplitTransfer({ paymentId: 'pay_off', bookingIds: [bk] });
  assert.equal(r.skipped, 'route_disabled');
  const [[c]] = await db.pool.query('SELECT COUNT(*) AS c FROM route_split_transfers');
  assert.equal(Number(c.c), 0);
});

test('captured amount from Razorpay that disagrees with the booking is refused (no transfer)', async () => {
  const t = await db.seedTurf(); await db.routeOn(t);
  const bk = await db.seedBooking(t, { amount: 1000 });
  const r = await routeSplit.processSplitTransfer({ paymentId: 'pay_cheap', bookingIds: [bk], capturedMinor: 100, currency: 'INR' });
  assert.equal(r.status, 'FAILED'); assert.match(r.error_message, /does not match/);
  assert.equal(calls.transfers.length, 0);
});

test('advance payment: split is computed on the advance actually captured', async () => {
  const t = await db.seedTurf(); await db.routeOn(t);
  const bk = await db.seedBooking(t, { amount: 1000, advance: 300 });
  const r = await routeSplit.processSplitTransfer({ paymentId: 'pay_adv', bookingIds: [bk], capturedMinor: 30000, currency: 'INR' });
  assert.equal(r.status, 'SUCCESS');
  assert.equal(calls.transfers[0].amountPaise, 28500);
  assert.equal(Number(r.captured_minor), 30000);
});

test('non-INR venue is never sent to Route (INR-only API)', async () => {
  const t = await db.seedTurf({ currency_code: 'AED', country_code: 'AE' }); await db.routeOn(t);
  const bk = await db.seedBooking(t);
  const r = await routeSplit.processSplitTransfer({ paymentId: 'pay_aed', bookingIds: [bk] });
  assert.equal(r.status, 'FAILED'); assert.match(r.error_message, /INR-only/);
  assert.equal(calls.transfers.length, 0);
});

test('gateway failure leaves a RETRY_REQUIRED row; retry transfers once; second retry is refused', async () => {
  const t = await db.seedTurf(); await db.routeOn(t);
  const bk = await db.seedBooking(t, { amount: 1000 });
  failNext = true;
  const r = await routeSplit.processSplitTransfer({ paymentId: 'pay_retry', bookingIds: [bk] });
  assert.equal(r.status, 'RETRY_REQUIRED');
  const ok = await routeSplit.retryTransferRecord(r.id);
  assert.equal(ok.record.status, 'SUCCESS');
  assert.equal(calls.transfers.length, 1);
  const again = await routeSplit.retryTransferRecord(r.id);
  assert.match(again.error, /already been transferred/);
  assert.equal(calls.transfers.length, 1);
});

test('flat fee model from a published config version, snapshot stored on the transfer', async () => {
  const t = await db.seedTurf(); await db.routeOn(t); const adminId = await admin();
  const cfg = await billing.publishConfig({ turfId: t, adminId, reason: 'onboarding', input: { billing_model: 'FLAT', flat_fee: '30' } });
  const bk = await db.seedBooking(t, { amount: 1000 });
  const r = await routeSplit.processSplitTransfer({ paymentId: 'pay_flat', bookingIds: [bk] });
  assert.equal(r.status, 'SUCCESS');
  assert.equal(calls.transfers[0].amountPaise, 97000);
  assert.equal(Number(r.platform_fee_minor), 3000);
  assert.equal(r.config_history_id, cfg.id);
  const snap = JSON.parse(r.config_snapshot);
  assert.equal(snap.config.billing_model, 'FLAT');
});

test('changing the config later does not change a past transfer; new config applies to new payments', async () => {
  const t = await db.seedTurf(); await db.routeOn(t); const adminId = await admin();
  await billing.publishConfig({ turfId: t, adminId, reason: 'first version', input: { billing_model: 'PERCENTAGE', commission_percent: '5' } });
  const bk1 = await db.seedBooking(t, { amount: 1000, order: 'o1' });
  const r1 = await routeSplit.processSplitTransfer({ paymentId: 'pay_h1', bookingIds: [bk1] });
  await billing.publishConfig({ turfId: t, adminId, reason: 'second version', input: { billing_model: 'PERCENTAGE', commission_percent: '10' } });
  const [[stored]] = await db.pool.query('SELECT platform_fee_minor FROM route_split_transfers WHERE id = ?', [r1.id]);
  assert.equal(Number(stored.platform_fee_minor), 5000); // unchanged
  const bk2 = await db.seedBooking(t, { amount: 1000, order: 'o2' });
  const r2 = await routeSplit.processSplitTransfer({ paymentId: 'pay_h2', bookingIds: [bk2] });
  assert.equal(Number(r2.platform_fee_minor), 10000);
  const hist = await billing.listHistory(t);
  assert.deepEqual(hist.map((h) => h.version), [2, 1]);
});

test('subscription DEDUCT_FROM_PROCEEDS: deducts until the cycle is paid, once per payment', async () => {
  const t = await db.seedTurf(); await db.routeOn(t); const adminId = await admin();
  await billing.publishConfig({ turfId: t, adminId, reason: 'sub', input: { billing_model: 'SUBSCRIPTION', subscription_amount: '799', subscription_period: 'MONTHLY', subscription_policy: 'DEDUCT_FROM_PROCEEDS', subscription_start_date: '2020-01-15' } });
  const b1 = await db.seedBooking(t, { amount: 500, order: 'o1' });
  const r1 = await routeSplit.processSplitTransfer({ paymentId: 'pay_s1', bookingIds: [b1] });
  assert.equal(Number(r1.subscription_deduction_minor), 50000);
  assert.equal(r1.status, 'NOT_REQUIRED');              // owner share 0, nothing to transfer, and it does not claim a transfer happened
  assert.equal(calls.transfers.length, 0);

  const b2 = await db.seedBooking(t, { amount: 1000, order: 'o2' });
  const r2 = await routeSplit.processSplitTransfer({ paymentId: 'pay_s2', bookingIds: [b2] });
  assert.equal(Number(r2.subscription_deduction_minor), 29900); // only the remaining 299
  assert.equal(calls.transfers[0].amountPaise, 70100);

  await routeSplit.processSplitTransfer({ paymentId: 'pay_s2', bookingIds: [b2] }); // duplicate webhook
  const b3 = await db.seedBooking(t, { amount: 400, order: 'o3' });
  const r3 = await routeSplit.processSplitTransfer({ paymentId: 'pay_s3', bookingIds: [b3] });
  assert.equal(Number(r3.subscription_deduction_minor), 0);     // cycle already covered
  assert.equal(calls.transfers[1].amountPaise, 40000);

  const [[tot]] = await db.pool.query('SELECT SUM(amount_minor) AS s, COUNT(*) AS n FROM turf_subscription_deductions');
  assert.equal(Number(tot.s), 79900); assert.equal(Number(tot.n), 2);
  const [[cyc]] = await db.pool.query('SELECT status FROM turf_subscription_cycles WHERE turf_id = ?', [t]);
  assert.equal(cyc.status, 'PAID');
});

test('subscription SEPARATE policy never deducts from booking proceeds', async () => {
  const t = await db.seedTurf(); await db.routeOn(t); const adminId = await admin();
  await billing.publishConfig({ turfId: t, adminId, reason: 'sub', input: { billing_model: 'SUBSCRIPTION', subscription_amount: '799', subscription_period: 'MONTHLY', subscription_policy: 'SEPARATE', subscription_start_date: '2020-01-15' } });
  const b = await db.seedBooking(t, { amount: 500 });
  const r = await routeSplit.processSplitTransfer({ paymentId: 'pay_sep', bookingIds: [b] });
  assert.equal(Number(r.subscription_deduction_minor), 0);
  assert.equal(calls.transfers[0].amountPaise, 50000);
});

test('subscription that has not started yet deducts nothing', async () => {
  const t = await db.seedTurf(); await db.routeOn(t); const adminId = await admin();
  await billing.publishConfig({ turfId: t, adminId, reason: 'sub', input: { billing_model: 'SUBSCRIPTION', subscription_amount: '799', subscription_period: 'MONTHLY', subscription_policy: 'DEDUCT_FROM_PROCEEDS', subscription_start_date: '2999-01-01' } });
  const b = await db.seedBooking(t, { amount: 500 });
  const r = await routeSplit.processSplitTransfer({ paymentId: 'pay_future', bookingIds: [b] });
  assert.equal(Number(r.subscription_deduction_minor), 0);
  assert.equal(calls.transfers[0].amountPaise, 50000);
});

test('publishing an incompatible or incomplete configuration is rejected and nothing is stored', async () => {
  const t = await db.seedTurf(); const adminId = await admin();
  const bad = [
    { billing_model: 'PERCENTAGE', commission_percent: '5', flat_fee: '30' },
    { billing_model: 'FLAT', flat_fee: '30', subscription_amount: '100' },
    { billing_model: 'SUBSCRIPTION', subscription_amount: '100' },
    { billing_model: 'PERCENTAGE', commission_percent: '5', tax_mode: 'EXCLUSIVE' },
    { billing_model: 'PERCENTAGE', commission_percent: '150' },
    { billing_model: 'PERCENTAGE', commission_percent: '5', effective_from: '2001-01-01' },
  ];
  for (const input of bad) await assert.rejects(() => billing.publishConfig({ turfId: t, adminId, reason: 'x1x', input }), /Invalid billing|past|tax|required/i);
  await assert.rejects(() => billing.publishConfig({ turfId: t, adminId, reason: '', input: { billing_model: 'PERCENTAGE', commission_percent: '5' } }), /reason/i);
  const [[c]] = await db.pool.query('SELECT COUNT(*) AS c FROM turf_billing_config_history');
  assert.equal(Number(c.c), 0);
});

test('a turf with a subscription model but no amount fails loudly instead of assuming 799', async () => {
  const t = await db.seedTurf({ billing_model: 'MONTHLY', monthly_subscription_amount: 0 }); await db.routeOn(t);
  const b = await db.seedBooking(t, { amount: 500 });
  const r = await routeSplit.processSplitTransfer({ paymentId: 'pay_noamt', bookingIds: [b] });
  assert.equal(r.status, 'FAILED'); assert.match(r.error_message, /Billing configuration problem/);
  assert.equal(calls.transfers.length, 0);
});
