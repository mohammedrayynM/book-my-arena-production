// HTTP-level tests of the admin/owner billing APIs against a THROWAWAY database with a fake Razorpay.
process.env.JWT_SECRET = 'test-secret';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_x';
process.env.RAZORPAY_KEY_SECRET = 'rzp_secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const gw = { payments: {}, created: [], reversed: [] };
const fake = {
  fetchPayment: async (id) => { if (!gw.payments[id]) { const e = new Error('nf'); e.statusCode = 400; throw e; } return gw.payments[id]; },
  listTransfers: async () => [], fetchAccount: async () => ({ status: 'activated' }),
  createTransfer: async (p) => { gw.created.push(p); return { id: `trf_${gw.created.length}`, simulated: true }; },
  reverseTransfer: async (p) => { gw.reversed.push(p); return { id: `rev_${gw.reversed.length}`, simulated: true }; },
};
const providerPath = require.resolve('../services/routeProvider');
require.cache[providerPath] = { id: providerPath, filename: providerPath, loaded: true, exports: fake };

const express = require('express');
const request = require('supertest');
const db = require('./helpers/testDb');

let app; let adminId; let adminToken; let ownerToken; let ownerId;
test.before(async () => {
  await db.setup();
  await db.pool.query('CREATE TABLE IF NOT EXISTS settings (setting_key VARCHAR(100) PRIMARY KEY, setting_value VARCHAR(255))');
  await db.pool.query('DROP TABLE IF EXISTS refunds'); // another test file creates a narrower refunds table; start clean
  await db.pool.query('CREATE TABLE refunds (id INT AUTO_INCREMENT PRIMARY KEY, refund_code VARCHAR(40), refund_status VARCHAR(30), refund_amount_minor BIGINT, currency_code VARCHAR(3) DEFAULT \'INR\', gateway_refund_id VARCHAR(64), gateway_payment_id VARCHAR(64), payment_id VARCHAR(64), venue_id INT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  app = express(); app.use(express.json());
  app.use('/api/admin/billing', require('../routes/admin-billing'));
  app.use('/api/owner-billing', require('../routes/owner-billing'));
  app.use('/api/admin', require('../routes/admin'));
});
test.beforeEach(async () => {
  await db.reset(); await db.pool.query('DELETE FROM refunds'); gw.payments = {}; gw.created = []; gw.reversed = [];
  adminId = (await db.pool.query("INSERT INTO admins (username) VALUES ('root')"))[0].insertId;
  adminToken = jwt.sign({ id: adminId, username: 'root', role: 'admin' }, 'test-secret');
});
test.after(async () => { await db.pool.end(); });

const A = (r) => r.set('Authorization', `Bearer ${adminToken}`);
const ownerFor = async (turfId) => { const [[t]] = await db.pool.query('SELECT owner_id FROM turfs WHERE id = ?', [turfId]); return jwt.sign({ id: t.owner_id, role: 'owner' }, 'test-secret'); };

test('authorization: no token 401, owner 403, deleted admin 403', async () => {
  const t = await db.seedTurf();
  assert.equal((await request(app).get('/api/admin/billing/overview')).status, 401);
  const owner = await ownerFor(t);
  for (const [m, p] of [['get', '/api/admin/billing/overview'], ['put', `/api/admin/billing/turfs/${t}/billing-config`], ['post', '/api/admin/billing/fee-rules'], ['post', '/api/admin/billing/payments/reconcile']]) {
    assert.equal((await request(app)[m](p).set('Authorization', `Bearer ${owner}`).send({})).status, 403, `${m} ${p}`);
  }
  await db.pool.query('DELETE FROM admins');
  assert.equal((await A(request(app).get('/api/admin/billing/overview'))).status, 403);
});

test('overview: every metric has one honest definition', async () => {
  const t = await db.seedTurf({ name: 'Arena' }); await db.routeOn(t);
  await db.pool.query("UPDATE turfs SET approval_status = 'APPROVED' WHERE id = ?", [t]);
  await db.seedTurf({ name: 'Pending', approval_status: 'PENDING_APPROVAL' });
  // a Rs 1000 booking paid with a Rs 300 advance; 5% of the 300 is the platform's
  const b = await db.seedBooking(t, { amount: 1000, advance: 300, order: 'o1' });
  await db.pool.query("UPDATE bookings SET payment_id = 'pay_AAAAAAAA01' WHERE id = ?", [b]);
  const routeSplit = require('../services/routeSplit');
  const done = await routeSplit.processSplitTransfer({ paymentId: 'pay_AAAAAAAA01', orderId: 'o1', bookingIds: [b], capturedMinor: 30000, currency: 'INR' });
  assert.equal(done.status, 'SUCCESS');
  const res = await A(request(app).get('/api/admin/billing/overview'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.platform.venues_total, 2); assert.equal(res.body.platform.venues_pending, 1); assert.equal(res.body.platform.bookings_total, 1);
  const inr = res.body.by_currency.INR;
  assert.equal(inr.captured_payments_minor, 30000);           // advance captured, not booking value
  assert.equal(inr.gross_booking_value_minor, 100000);        // booking value is NOT platform revenue
  assert.equal(inr.platform_revenue_minor, 1500);             // 5% of the 300 actually captured
  assert.equal(inr.owner_eligible_minor, 28500);
  assert.equal(inr.completed_transfers_minor, 0);             // the transfer was SIMULATED (test mode): never counted as paid out
  assert.equal(inr.simulated_transfers_count, 1);
  assert.equal(inr.pending_transfers_minor, 0);
  assert.ok(res.body.definitions.completed_transfers);
  assert.ok(res.body.recent_bookings.length >= 1);
});

test('overview: pending/failed transfers and missing-transfer alerts are surfaced, not counted as paid', async () => {
  const t = await db.seedTurf(); await db.routeOn(t);
  const b = await db.seedBooking(t, { amount: 1000, order: 'o9' });
  await db.pool.query("UPDATE bookings SET payment_id = 'pay_NOTRANSFER01' WHERE id = ?", [b]);        // paid, Route on, no transfer row
  const res = await A(request(app).get('/api/admin/billing/overview'));
  assert.ok(res.body.alerts.some((a) => a.key === 'missing_transfer'));
  await db.pool.query("INSERT INTO route_split_transfers (turf_id, razorpay_payment_id, split_percentage, gross_amount, platform_amount, owner_amount, environment, status, idempotency_key, currency, captured_minor, owner_transfer_minor) VALUES (?, 'pay_R1', 5, 100, 5, 95, 'live', 'RETRY_REQUIRED', 'k1', 'INR', 10000, 9500)", [t]);
  const res2 = await A(request(app).get('/api/admin/billing/overview'));
  assert.equal(res2.body.by_currency.INR.pending_transfers_minor, 9500);
  assert.equal(res2.body.by_currency.INR.completed_transfers_minor, 0);
  assert.ok(res2.body.alerts.some((a) => a.key === 'retry_required'));
});

test('billing-config: validated, versioned, audited; incompatible combos rejected; owners cannot change it', async () => {
  const t = await db.seedTurf(); const url = `/api/admin/billing/turfs/${t}/billing-config`;
  const bad = [{ billing_model: 'PERCENTAGE', commission_percent: '5', flat_fee: '30', reason: 'oops' }, { billing_model: 'FLAT', flat_fee: '30', subscription_amount: '9', reason: 'oops' }, { billing_model: 'PERCENTAGE', commission_percent: '5' }];
  for (const body of bad) assert.equal((await A(request(app).put(url).send(body))).status, 400);
  const ok = await A(request(app).put(url).send({ billing_model: 'PERCENTAGE', commission_percent: '7.5', tax_mode: 'EXCLUSIVE', tax_percent: '18', reason: 'agreed with owner' }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.config.commission_bps, 750); assert.equal(ok.body.config.version, 1);
  const second = await A(request(app).put(url).send({ billing_model: 'FLAT', flat_fee: '30', reason: 'switching model' }));
  assert.equal(second.body.config.version, 2);
  const profile = await A(request(app).get(`/api/admin/billing/turfs/${t}/financial-profile`));
  assert.equal(profile.body.config.billing_model, 'FLAT'); assert.equal(profile.body.history.length, 2);
  assert.equal(JSON.parse((await db.pool.query('SELECT previous_snapshot FROM turf_billing_config_history WHERE version = 2'))[0][0].previous_snapshot).billing_model, 'PERCENTAGE');
  const [aud] = await db.pool.query("SELECT admin_id FROM route_audit_log WHERE action = 'billing_config'");
  assert.equal(aud.length, 2); assert.equal(Number(aud[0].admin_id), adminId);
  // legacy columns stay consistent with the live config
  const [[row]] = await db.pool.query('SELECT route_commission_type, route_flat_amount FROM turfs WHERE id = ?', [t]);
  assert.equal(row.route_commission_type, 'flat'); assert.equal(Number(row.route_flat_amount), 30);
  assert.equal((await request(app).put(url).set('Authorization', `Bearer ${await ownerFor(t)}`).send({ billing_model: 'FLAT', flat_fee: '1', reason: 'x1x' })).status, 403);
});

test('owner view is read-only and isolated to the owner\'s own venues', async () => {
  const mine = await db.seedTurf({ name: 'Mine' }); const theirs = await db.seedTurf({ name: 'Theirs' });
  await A(request(app).put(`/api/admin/billing/turfs/${mine}/billing-config`).send({ billing_model: 'PERCENTAGE', commission_percent: '5', reason: 'setup' }));
  const owner = await ownerFor(mine);
  const O = (r) => r.set('Authorization', `Bearer ${owner}`);
  const terms = await O(request(app).get(`/api/owner-billing/turfs/${mine}/terms`));
  assert.equal(terms.status, 200); assert.equal(terms.body.terms.commission_percent, 5); assert.equal(terms.body.read_only, true);
  assert.equal((await O(request(app).get(`/api/owner-billing/turfs/${theirs}/terms`))).status, 404);
  assert.equal((await O(request(app).get(`/api/owner-billing/turfs/${theirs}/statement`))).status, 404);
  for (const m of ['put', 'post', 'patch', 'delete']) assert.equal((await O(request(app)[m](`/api/owner-billing/turfs/${mine}/terms`).send({ commission_percent: '0' }))).status, 404);
  const list = await O(request(app).get('/api/owner-billing/turfs'));
  assert.deepEqual(list.body.turfs.map((x) => x.name), ['Mine']);
});

test('fee rules: tax rate is mandatory, past dates refused, history kept', async () => {
  const post = (b) => A(request(app).post('/api/admin/billing/fee-rules').send(b));
  assert.equal((await post({ country_code: 'IN', currency_code: 'INR', fee_type: 'FIXED', fee_fixed: '20', note: 'no tax given' })).status, 400);
  assert.equal((await post({ country_code: 'IN', currency_code: 'INR', fee_type: 'PERCENT', fee_percent: '3', tax_percent: '18', note: 'x', effective_from: '2001-01-01' })).status, 400);
  const ok = await post({ country_code: 'IN', currency_code: 'INR', fee_type: 'FIXED', fee_fixed: '20', tax_percent: '18', note: 'launch pricing' });
  assert.equal(ok.status, 200);
  await post({ country_code: 'IN', currency_code: 'INR', fee_type: 'NONE', note: 'promo: no fee' });
  const list = await A(request(app).get('/api/admin/billing/fee-rules'));
  assert.equal(list.body.rules.length, 2);
  const billing = require('../services/billingConfig');
  assert.equal((await billing.getActiveFeeRule('IN', 'INR')).fee_type, 'NONE');
});

test('payment lookup + reconcile over HTTP; confirmation phrase required; second attempt refused', async () => {
  const t = await db.seedTurf(); await db.routeOn(t, 'acc_THISVENUE001');
  const b = await db.seedBooking(t, { amount: 1000, order: 'order_h' }); await db.pool.query("UPDATE bookings SET payment_id = 'pay_HTTP0000001' WHERE id = ?", [b]);
  gw.payments.pay_HTTP0000001 = { id: 'pay_HTTP0000001', order_id: 'order_h', status: 'captured', amount: 100000, currency: 'INR', amount_refunded: 0 };
  assert.equal((await A(request(app).get('/api/admin/billing/payments/lookup?payment_id=bad'))).status, 400);
  const look = await A(request(app).get('/api/admin/billing/payments/lookup?payment_id=pay_HTTP0000001'));
  assert.equal(look.status, 200); assert.equal(look.body.action.type, 'create_transfer'); assert.equal(look.body.expected.ownerTransferMinor, 95000);
  assert.equal((await A(request(app).post('/api/admin/billing/payments/reconcile').send({ payment_id: 'pay_HTTP0000001', confirm_payment_id: 'nope' }))).status, 400);
  assert.equal(gw.created.length, 0);
  const done = await A(request(app).post('/api/admin/billing/payments/reconcile').send({ payment_id: 'pay_HTTP0000001', confirm_payment_id: 'pay_HTTP0000001' }));
  assert.equal(done.status, 200); assert.equal(done.body.result.status, 'SUCCESS'); assert.equal(done.body.result.simulated, true);
  assert.equal((await A(request(app).post('/api/admin/billing/payments/reconcile').send({ payment_id: 'pay_HTTP0000001', confirm_payment_id: 'pay_HTTP0000001' }))).status, 409);
  assert.equal(gw.created.length, 1);
  const actions = await A(request(app).get('/api/admin/billing/payments/actions'));
  assert.ok(actions.body.actions.length >= 3);
});

test('refund: owner share reversed once, pro-rata, only after typing the refund code', async () => {
  const t = await db.seedTurf(); await db.routeOn(t);
  const b = await db.seedBooking(t, { amount: 1000, order: 'o_r' }); await db.pool.query("UPDATE bookings SET payment_id = 'pay_REFUND00001' WHERE id = ?", [b]);
  await require('../services/routeSplit').processSplitTransfer({ paymentId: 'pay_REFUND00001', orderId: 'o_r', bookingIds: [b], capturedMinor: 100000, currency: 'INR' });
  const [r] = await db.pool.query("INSERT INTO refunds (refund_code, refund_status, refund_amount_minor, gateway_payment_id, payment_id) VALUES ('RF-1', 'REFUND_COMPLETED', 40000, 'pay_REFUND00001', 'pay_REFUND00001')");
  const url = `/api/admin/billing/refunds/${r.insertId}/reverse-transfer`;
  assert.equal((await A(request(app).post(url).send({ confirm_refund_code: 'wrong' }))).status, 400);
  const ok = await A(request(app).post(url).send({ confirm_refund_code: 'RF-1' }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.reversal.amount_minor, 38000); // 95% of 400.00
  assert.equal(ok.body.reversal.amount_minor + ok.body.reversal.platform_share_minor, 40000);
  assert.equal((await A(request(app).post(url).send({ confirm_refund_code: 'RF-1' }))).status, 409);
  assert.equal(gw.reversed.length, 1);
});

test('subscription SEPARATE: record a payment once per reference, never over the balance', async () => {
  const t = await db.seedTurf(); await db.routeOn(t);
  await A(request(app).put(`/api/admin/billing/turfs/${t}/billing-config`).send({ billing_model: 'SUBSCRIPTION', subscription_amount: '799', subscription_period: 'MONTHLY', subscription_policy: 'SEPARATE', subscription_start_date: '2020-01-15', reason: 'setup' }));
  const billing = require('../services/billingConfig'); const rs = require('../services/routeSplit');
  const turf = await rs.getRouteConfig(t); const cfg = await billing.getEffectiveConfig(turf);
  const conn = await db.pool.getConnection(); const cyc = await billing.ensureCycle(conn, t, cfg); conn.release();
  const url = `/api/admin/billing/turfs/${t}/subscription/cycles/${cyc.id}/record-payment`;
  assert.equal((await A(request(app).post(url).send({ amount: '500', reference: 'UPI-1' }))).status, 200);
  assert.equal((await A(request(app).post(url).send({ amount: '500', reference: 'UPI-1' }))).status, 409);   // same reference twice
  assert.equal((await A(request(app).post(url).send({ amount: '500', reference: 'UPI-2' }))).status, 400);   // only 299 left
  assert.equal((await A(request(app).post(url).send({ amount: '299', reference: 'UPI-3' }))).status, 200);
  const prof = await A(request(app).get(`/api/admin/billing/turfs/${t}/financial-profile`));
  assert.equal(prof.body.subscription.cycles[0].status, 'PAID');
});

test('new-bookings restriction: audited apply/remove is owner-visible and leaves billing accessible', async () => {
  const t = await db.seedTurf();
  await A(request(app).put(`/api/admin/billing/turfs/${t}/billing-config`).send({
    billing_model: 'SUBSCRIPTION', subscription_amount: '799', subscription_period: 'MONTHLY',
    subscription_policy: 'SEPARATE', subscription_start_date: '2020-01-15', grace_period_days: 0, reason: 'setup',
  }));
  const [[config]] = await db.pool.query('SELECT id FROM turf_billing_config_history WHERE turf_id = ? ORDER BY id DESC LIMIT 1', [t]);
  const [insertedCycle] = await db.pool.query(
    `INSERT INTO turf_subscription_cycles
      (turf_id, cycle_start, cycle_end, amount_minor, currency, policy, config_history_id, status)
     VALUES (?, '2020-01-15', '2020-02-15', 79900, 'INR', 'SEPARATE', ?, 'UNPAID')`,
    [t, config.id]
  );
  const url = `/api/admin/billing/turfs/${t}/restriction`;
  assert.equal((await A(request(app).post(url).send({ action: 'apply', cycle_id: insertedCycle.insertId, reason: 'x' }))).status, 400);

  const applied = await A(request(app).post(url).send({
    action: 'apply', cycle_id: insertedCycle.insertId, reason: 'Unpaid beyond grace period',
  }));
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.expected_impact, 'New bookings blocked; existing and confirmed bookings remain unchanged');
  const [audits] = await db.pool.query("SELECT id FROM route_audit_log WHERE turf_id = ? AND action = 'billing_restriction_apply'", [t]);
  assert.equal(audits.length, 1);

  const ownerBilling = await request(app).get('/api/owner-billing/overview').set('Authorization', `Bearer ${await ownerFor(t)}`);
  assert.equal(ownerBilling.status, 200, JSON.stringify(ownerBilling.body));
  const venueBilling = ownerBilling.body.venues.find((venue) => Number(venue.id) === Number(t)).billing;
  assert.equal(venueBilling.restriction.active.reason, 'Unpaid beyond grace period');
  assert.ok(venueBilling.subscription.cycles.length > 0);

  const removed = await A(request(app).post(url).send({ action: 'remove', reason: 'Owner paid the overdue amount' }));
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const [[history]] = await db.pool.query('SELECT active_turf_id, removed_by, removed_at, remove_reason FROM turf_billing_restrictions WHERE id = ?', [applied.body.restriction.id]);
  assert.equal(history.active_turf_id, null);
  assert.equal(Number(history.removed_by), adminId);
  assert.ok(history.removed_at);
  assert.equal(history.remove_reason, 'Owner paid the overdue amount');
  const [removalAudits] = await db.pool.query("SELECT id FROM route_audit_log WHERE turf_id = ? AND action = 'billing_restriction_remove'", [t]);
  assert.equal(removalAudits.length, 1);

  const [secondCycle] = await db.pool.query(
    `INSERT INTO turf_subscription_cycles
      (turf_id, cycle_start, cycle_end, amount_minor, currency, policy, config_history_id, status)
     VALUES (?, '2019-01-15', '2019-02-15', 79900, 'INR', 'SEPARATE', ?, 'UNPAID')`,
    [t, config.id]
  );
  assert.equal((await A(request(app).post(url).send({
    action: 'apply', cycle_id: secondCycle.insertId, reason: 'Second overdue billing cycle',
  }))).status, 200);
  const recorded = await A(request(app).post(`/api/admin/billing/turfs/${t}/subscription/cycles/${secondCycle.insertId}/record-payment`).send({
    amount: '799', reference: 'UPI-RESTRICTION-RELEASE',
  }));
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  const [[autoRemoved]] = await db.pool.query(
    `SELECT active_turf_id, removed_by, remove_reason FROM turf_billing_restrictions
     WHERE cycle_id = ? AND active_turf_id IS NULL ORDER BY id DESC LIMIT 1`,
    [secondCycle.insertId]
  );
  assert.equal(autoRemoved.active_turf_id, null);
  assert.equal(autoRemoved.removed_by, null);
  assert.equal(autoRemoved.remove_reason, 'Automatically removed after verified subscription payment');
});

test('legacy admin endpoints: partial billing PUT can no longer wipe fields; retired settings return 410; dashboard uses the ledger', async () => {
  const t = await db.seedTurf();
  const legacy = await A(request(app).put(`/api/admin/turfs/${t}/billing`).send({ billing_model: 'PERCENTAGE' })); // used to silently reset commission to 5
  assert.equal(legacy.status, 400);
  const ok = await A(request(app).put(`/api/admin/turfs/${t}/billing`).send({ billing_model: 'PERCENTAGE', commission_percentage: 8 }));
  assert.equal(ok.status, 200);
  assert.equal((await A(request(app).put('/api/admin/settings/commission').send({ commission_percent: 50 }))).status, 410);
  assert.equal((await A(request(app).put('/api/admin/settings/service-fee').send({ service_fee: 99 }))).status, 410);
  const dash = await A(request(app).get('/api/admin/dashboard'));
  assert.equal(dash.status, 200, JSON.stringify(dash.body)); assert.equal(dash.body.stats.platform_revenue, 0);
});
