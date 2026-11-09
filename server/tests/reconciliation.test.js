// Admin Payment-ID lookup & reconciliation, against a THROWAWAY database with a fake Razorpay.
const test = require('node:test');
const assert = require('node:assert/strict');

const gw = { payments: {}, transfers: {}, created: [], failNext: false, listFails: false };
const fake = {
  fetchPayment: async (id) => { if (!gw.payments[id]) { const e = new Error('nf'); e.statusCode = 400; throw e; } return gw.payments[id]; },
  listTransfers: async (id) => { if (gw.listFails) throw new Error('x'); return gw.transfers[id] || []; },
  fetchAccount: async () => ({ status: 'activated' }),
  createTransfer: async (p) => { if (gw.failNext) { gw.failNext = false; throw new Error('gateway down'); } gw.created.push(p); return { id: `trf_${gw.created.length}`, simulated: true }; },
};
const providerPath = require.resolve('../services/routeProvider');
require.cache[providerPath] = { id: providerPath, filename: providerPath, loaded: true, exports: fake };

const db = require('./helpers/testDb');
const rec = require('../services/paymentReconciliation');

test.before(async () => { await db.setup(); await db.pool.query('CREATE TABLE IF NOT EXISTS refunds (id INT AUTO_INCREMENT PRIMARY KEY, refund_status VARCHAR(30), refund_amount_minor BIGINT, gateway_refund_id VARCHAR(64), gateway_payment_id VARCHAR(64), payment_id VARCHAR(64))'); });
test.beforeEach(async () => { await db.reset(); await db.pool.query('DELETE FROM refunds'); gw.payments = {}; gw.transfers = {}; gw.created = []; gw.failNext = false; gw.listFails = false; });
test.after(async () => { await db.pool.end(); });

const payment = (id, order, amount, extra = {}) => ({ id, order_id: order, status: 'captured', amount, currency: 'INR', amount_refunded: 0, created_at: 1700000000, method: 'upi', ...extra });
async function paidBooking(turf, { amount = 1000, order = 'order_r', pay = 'pay_AAAAAAAA01', paymentId = pay } = {}) {
  const [b] = await db.pool.query("INSERT INTO bookings (turf_id, amount, original_price, razorpay_order_id, payment_id, payment_status, status, customer_name) VALUES (?, ?, ?, ?, ?, 'success', 'confirmed', 'C')", [turf, amount, amount, order, paymentId]);
  return b.insertId;
}

test('input validation and unknown payments', async () => {
  assert.equal((await rec.inspectPayment('nonsense')).status, 400);
  assert.equal((await rec.inspectPayment("pay_'; DROP TABLE bookings;--")).status, 400);
  assert.equal((await rec.inspectPayment('pay_DOESNOTEXIST1')).status, 404);
});

test('payment with no booking: shown, but no action possible', async () => {
  gw.payments.pay_ORPHAN00001 = payment('pay_ORPHAN00001', 'order_x', 5000);
  const v = await rec.inspectPayment('pay_ORPHAN00001');
  assert.equal(v.matched, false); assert.equal(v.action.type, 'none');
});

test('eligible payment: one confirmed transfer to THIS venue\'s account, second attempt refused, fully audited', async () => {
  const t = await db.seedTurf(); const other = await db.seedTurf(); await db.routeOn(t, 'acc_THISVENUE001'); await db.routeOn(other, 'acc_OTHERVENUE01');
  await paidBooking(t); gw.payments.pay_AAAAAAAA01 = payment('pay_AAAAAAAA01', 'order_r', 100000);
  const v = await rec.inspectPayment('pay_AAAAAAAA01');
  assert.equal(v.action.type, 'create_transfer'); assert.equal(v.action.target_account, 'acc_THISVENUE001'); assert.equal(v.action.amount_minor, 95000);
  assert.equal(v.expected.source, 'recomputed');

  const wrong = await rec.reconcilePayment({ paymentId: 'pay_AAAAAAAA01', adminId: 1, confirmPaymentId: 'pay_BBBBBBBB02' });
  assert.equal(wrong.status, 400); assert.equal(gw.created.length, 0);

  const ok = await rec.reconcilePayment({ paymentId: 'pay_AAAAAAAA01', adminId: 7, confirmPaymentId: 'pay_AAAAAAAA01' });
  assert.equal(ok.result.status, 'SUCCESS'); assert.equal(ok.result.source, 'admin_reconcile'); assert.equal(Number(ok.result.reconciled_by), 7);
  assert.equal(gw.created.length, 1); assert.equal(gw.created[0].linkedAccountId, 'acc_THISVENUE001'); assert.equal(gw.created[0].amountPaise, 95000);
  assert.equal(ok.view.action.type, 'none');

  const again = await rec.reconcilePayment({ paymentId: 'pay_AAAAAAAA01', adminId: 7, confirmPaymentId: 'pay_AAAAAAAA01' });
  assert.equal(again.status, 409); assert.match(again.error, /already been transferred/); assert.equal(gw.created.length, 1);
  const [audit] = await db.pool.query('SELECT outcome FROM admin_payment_actions ORDER BY id');
  assert.deepEqual(audit.map((a) => a.outcome), ['SUCCESS', 'REFUSED']);
});

test('a transfer that already exists at Razorpay but not in the ledger is never duplicated', async () => {
  const t = await db.seedTurf(); await db.routeOn(t); await paidBooking(t);
  gw.payments.pay_AAAAAAAA01 = payment('pay_AAAAAAAA01', 'order_r', 100000);
  gw.transfers.pay_AAAAAAAA01 = [{ id: 'trf_real1', recipient: 'acc_TESTACCOUNT01', amount: 95000, status: 'processed' }];
  const v = await rec.inspectPayment('pay_AAAAAAAA01');
  assert.equal(v.action.type, 'none'); assert.ok(v.issues.some((i) => /does not know about/.test(i)));
  assert.equal((await rec.reconcilePayment({ paymentId: 'pay_AAAAAAAA01', adminId: 1, confirmPaymentId: 'pay_AAAAAAAA01' })).status, 409);
  assert.equal(gw.created.length, 0);
});

test('ineligible payments offer no action: not captured, wrong amount, venue not approved, Route off', async () => {
  const t = await db.seedTurf(); await db.routeOn(t); await paidBooking(t);
  gw.payments.pay_AAAAAAAA01 = payment('pay_AAAAAAAA01', 'order_r', 100000, { status: 'authorized' });
  assert.equal((await rec.inspectPayment('pay_AAAAAAAA01')).action.type, 'none');
  gw.payments.pay_AAAAAAAA01 = payment('pay_AAAAAAAA01', 'order_r', 4000);
  assert.match((await rec.inspectPayment('pay_AAAAAAAA01')).action.reason, /Captured 4000/);
  gw.payments.pay_AAAAAAAA01 = payment('pay_AAAAAAAA01', 'order_r', 100000);
  await db.pool.query("UPDATE turfs SET approval_status = 'REJECTED' WHERE id = ?", [t]);
  assert.match((await rec.inspectPayment('pay_AAAAAAAA01')).action.reason, /approval status/);
  await db.pool.query("UPDATE turfs SET approval_status = 'APPROVED', route_enabled = false WHERE id = ?", [t]);
  assert.match((await rec.inspectPayment('pay_AAAAAAAA01')).action.reason, /not enabled/);
  assert.equal(gw.created.length, 0);
});

test('a refunded payment is not transferred', async () => {
  const t = await db.seedTurf(); await db.routeOn(t); await paidBooking(t);
  gw.payments.pay_AAAAAAAA01 = payment('pay_AAAAAAAA01', 'order_r', 100000);
  await db.pool.query("INSERT INTO refunds (refund_status, refund_amount_minor, gateway_payment_id, payment_id) VALUES ('REFUND_COMPLETED', 100000, 'pay_AAAAAAAA01', 'pay_AAAAAAAA01')");
  assert.match((await rec.inspectPayment('pay_AAAAAAAA01')).action.reason, /refund/);
});

test('RETRY_REQUIRED is retried once; FAILED-for-config is reprocessed after the fix, keeping history', async () => {
  const t = await db.seedTurf(); await db.routeOn(t); await paidBooking(t);
  gw.payments.pay_AAAAAAAA01 = payment('pay_AAAAAAAA01', 'order_r', 100000);
  const routeSplit = require('../services/routeSplit');
  const [[b]] = await db.pool.query('SELECT id FROM bookings LIMIT 1');
  gw.failNext = true;
  const first = await routeSplit.processSplitTransfer({ paymentId: 'pay_AAAAAAAA01', orderId: 'order_r', bookingIds: [b.id] });
  assert.equal(first.status, 'RETRY_REQUIRED');
  const v = await rec.inspectPayment('pay_AAAAAAAA01'); assert.equal(v.action.type, 'retry_transfer');
  const done = await rec.reconcilePayment({ paymentId: 'pay_AAAAAAAA01', adminId: 2, confirmPaymentId: 'pay_AAAAAAAA01' });
  assert.equal(done.result.status, 'SUCCESS'); assert.equal(gw.created.length, 1);

  // second payment: first attempt FAILED because no linked account; admin fixes the account; reprocess
  await paidBooking(t, { order: 'order_2', pay: 'pay_CCCCCCCC03' });
  gw.payments.pay_CCCCCCCC03 = payment('pay_CCCCCCCC03', 'order_2', 100000);
  await db.pool.query('UPDATE turfs SET route_linked_account_id = NULL WHERE id = ?', [t]);
  const [[b2]] = await db.pool.query("SELECT id FROM bookings WHERE razorpay_order_id = 'order_2'");
  const failed = await routeSplit.processSplitTransfer({ paymentId: 'pay_CCCCCCCC03', orderId: 'order_2', bookingIds: [b2.id] });
  assert.equal(failed.status, 'FAILED');
  await db.pool.query("UPDATE turfs SET route_linked_account_id = 'acc_FIXEDACCT001' WHERE id = ?", [t]);
  const v2 = await rec.inspectPayment('pay_CCCCCCCC03'); assert.equal(v2.action.type, 'reprocess');
  const fixed = await rec.reconcilePayment({ paymentId: 'pay_CCCCCCCC03', adminId: 2, confirmPaymentId: 'pay_CCCCCCCC03' });
  assert.equal(fixed.result.status, 'SUCCESS'); assert.equal(gw.created[1].linkedAccountId, 'acc_FIXEDACCT001');
  const [rows] = await db.pool.query("SELECT status FROM route_split_transfers WHERE razorpay_payment_id = 'pay_CCCCCCCC03' ORDER BY id");
  assert.deepEqual(rows.map((r) => r.status), ['SUPERSEDED', 'SUCCESS']);
});
