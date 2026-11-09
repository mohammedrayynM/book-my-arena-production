// Route-level tests for POST /api/bookings/verify and /webhook with a FAKE Razorpay and a THROWAWAY database.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_x';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';

const rp = { payment: null, fetchError: null, orderPayments: [], orderPaymentsError: null, transfers: [] };
const fake = {
  fetchPayment: async () => { if (rp.fetchError) throw rp.fetchError; return rp.payment; },
  fetchOrderPayments: async () => { if (rp.orderPaymentsError) throw rp.orderPaymentsError; return rp.orderPayments; },
  listTransfers: async () => [], fetchAccount: async () => ({ status: 'activated' }),
  createTransfer: async (p) => { rp.transfers.push(p); return { id: `trf_${rp.transfers.length}`, simulated: true }; },
};
const providerPath = require.resolve('../services/routeProvider');
require.cache[providerPath] = { id: providerPath, filename: providerPath, loaded: true, exports: fake };

// the customer-subscription service has its own tables; these tests are about turf bookings, so say "not a subscription payment"
const subPath = require.resolve('../services/subscriptionService');
const realSub = require(subPath);
require.cache[subPath].exports = { ...realSub, activateByOrder: async () => ({ notFound: true }), reportPaymentFailed: async () => ({ notFound: true }) };

const express = require('express');
const request = require('supertest');
const db = require('./helpers/testDb');

let app;
test.before(async () => {
  await db.setup();
  await db.pool.query('CREATE TABLE IF NOT EXISTS blocked_slots (id INT AUTO_INCREMENT PRIMARY KEY, turf_id INT, court_id INT NULL, block_date DATE, time_slot VARCHAR(40))');
  const router = require('../routes/bookings');
  app = express();
  app.use((req, res, next) => (req.path.endsWith('/webhook') ? next() : express.json()(req, res, next)));
  app.use('/api/bookings', router);
});
test.beforeEach(async () => { await db.reset(); await db.pool.query('DELETE FROM blocked_slots'); rp.transfers.length = 0; rp.payment = null; rp.fetchError = null; rp.orderPayments = []; rp.orderPaymentsError = null; });
test.after(async () => { await db.pool.end(); });

const sign = (order, pay) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${order}|${pay}`).digest('hex');
const pending = async (turf, { amount = 1000, advance = null, order, slot = '18:00 - 19:00', date = '2099-01-01' }) => {
  const [b] = await db.pool.query(
    "INSERT INTO bookings (turf_id, amount, original_price, advance_amount, razorpay_order_id, payment_status, status, customer_name, booking_date, time_slot) VALUES (?, ?, ?, ?, ?, 'pending', 'pending', 'Cust', ?, ?)",
    [turf, amount, amount, advance, order, date, slot]
  );
  return b.insertId;
};
const state = async (id) => (await db.pool.query('SELECT payment_status, status, payment_id FROM bookings WHERE id = ?', [id]))[0][0];
const captured = (order, amountMinor, id = 'pay_ok') => ({ id, order_id: order, status: 'captured', amount: amountMinor, currency: 'INR' });
const webhook = (event, secret = 'whsec_test') => {
  const body = JSON.stringify(event);
  return request(app).post('/api/bookings/webhook').set('Content-Type', 'application/json')
    .set('x-razorpay-signature', crypto.createHmac('sha256', secret).update(body).digest('hex')).send(body);
};
const capturedEvent = (order, amountMinor, id = 'pay_wh') => ({ event: 'payment.captured', payload: { payment: { entity: { id, order_id: order, amount: amountMinor, currency: 'INR', status: 'captured' } } } });

test('happy path: signed + captured + right amount confirms the booking and creates exactly one split', async () => {
  const t = await db.seedTurf(); await db.routeOn(t);
  const b = await pending(t, { amount: 1000, order: 'order_1' });
  rp.payment = captured('order_1', 100000, 'pay_ok');
  const res = await request(app).post('/api/bookings/verify').send({ booking_id: String(b), razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_ok', razorpay_signature: sign('order_1', 'pay_ok') });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await state(b)).payment_status, 'success');
  assert.equal(rp.transfers.length, 1);
  assert.equal(rp.transfers[0].amountPaise, 95000);
  // customer taps twice / webhook also arrives: still one transfer
  const again = await request(app).post('/api/bookings/verify').send({ booking_id: String(b), razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_ok', razorpay_signature: sign('order_1', 'pay_ok') });
  assert.equal(again.status, 200); assert.equal(again.body.already_confirmed, true);
  await webhook(capturedEvent('order_1', 100000, 'pay_ok'));
  assert.equal(rp.transfers.length, 1);
});

test('EXPLOIT CLOSED: a cheap paid order cannot confirm someone else\'s booking', async () => {
  const t = await db.seedTurf(); await db.routeOn(t);
  const victim = await pending(t, { amount: 5000, order: 'order_victim', slot: '10:00 - 11:00' });
  const mine = await pending(t, { amount: 10, order: 'order_mine', slot: '11:00 - 12:00' });
  rp.payment = captured('order_mine', 1000, 'pay_mine');
  const res = await request(app).post('/api/bookings/verify').send({ booking_id: String(victim), razorpay_order_id: 'order_mine', razorpay_payment_id: 'pay_mine', razorpay_signature: sign('order_mine', 'pay_mine') });
  assert.equal(res.status, 400);
  assert.equal((await state(victim)).payment_status, 'pending');
  assert.equal(rp.transfers.length, 0);
  const mixed = await request(app).post('/api/bookings/verify').send({ booking_id: `${mine},${victim}`, razorpay_order_id: 'order_mine', razorpay_payment_id: 'pay_mine', razorpay_signature: sign('order_mine', 'pay_mine') });
  assert.equal(mixed.status, 400);
  assert.equal((await state(mine)).payment_status, 'pending');
});

test('EXPLOIT CLOSED: a forged signature cannot cancel a confirmed or someone else\'s pending booking', async () => {
  const t = await db.seedTurf();
  const confirmed = await db.seedBooking(t, { order: 'order_c' });
  const strangers = await pending(t, { order: 'order_s', slot: '12:00 - 13:00' });
  await request(app).post('/api/bookings/verify').send({ booking_id: `${confirmed},${strangers}`, razorpay_order_id: 'order_attacker', razorpay_payment_id: 'pay_x', razorpay_signature: 'bad' });
  assert.equal((await state(confirmed)).status, 'confirmed');
  assert.equal((await state(strangers)).status, 'pending');
  // An invalid signature is not proof that the customer abandoned checkout.
  await request(app).post('/api/bookings/verify').send({ booking_id: String(strangers), razorpay_order_id: 'order_s', razorpay_payment_id: 'pay_y', razorpay_signature: 'bad' });
  assert.equal((await state(strangers)).status, 'pending');
});

test('an authorized-but-not-captured payment does not confirm the booking', async () => {
  const t = await db.seedTurf(); await db.routeOn(t);
  const b = await pending(t, { order: 'order_a' });
  rp.payment = { id: 'pay_a', order_id: 'order_a', status: 'authorized', amount: 100000, currency: 'INR' };
  const res = await request(app).post('/api/bookings/verify').send({ booking_id: String(b), razorpay_order_id: 'order_a', razorpay_payment_id: 'pay_a', razorpay_signature: sign('order_a', 'pay_a') });
  assert.equal(res.status, 409); assert.equal(res.body.pending, true);
  assert.equal((await state(b)).payment_status, 'pending');
  assert.equal(rp.transfers.length, 0);
});

test('an underpayment is refused', async () => {
  const t = await db.seedTurf(); await db.routeOn(t);
  const b = await pending(t, { amount: 1000, order: 'order_u' });
  rp.payment = captured('order_u', 100, 'pay_u');
  const res = await request(app).post('/api/bookings/verify').send({ booking_id: String(b), razorpay_order_id: 'order_u', razorpay_payment_id: 'pay_u', razorpay_signature: sign('order_u', 'pay_u') });
  assert.equal(res.status, 400);
  assert.equal((await state(b)).payment_status, 'pending');
});

test('Razorpay unreachable: a valid signature leaves the booking pending until capture is verified', async () => {
  const t = await db.seedTurf();
  const b = await pending(t, { order: 'order_n' });
  rp.fetchError = new Error('network');
  const res = await request(app).post('/api/bookings/verify').send({ booking_id: String(b), razorpay_order_id: 'order_n', razorpay_payment_id: 'pay_n', razorpay_signature: sign('order_n', 'pay_n') });
  assert.equal(res.status, 503);
  assert.equal(res.body.pending, true);
  assert.equal((await state(b)).payment_status, 'pending');
});

test('webhook: bad signature rejected; good one confirms once; duplicates make one transfer', async () => {
  const t = await db.seedTurf(); await db.routeOn(t);
  const b = await pending(t, { amount: 1000, order: 'order_w' });
  const bad = await webhook(capturedEvent('order_w', 100000), 'wrong_secret');
  assert.equal(bad.status, 400);
  assert.equal((await state(b)).payment_status, 'pending');
  await Promise.all([1, 2, 3].map(() => webhook(capturedEvent('order_w', 100000, 'pay_wh'))));
  assert.equal((await state(b)).payment_status, 'success');
  assert.equal(rp.transfers.length, 1);
  const [[c]] = await db.pool.query('SELECT COUNT(*) AS c FROM route_split_transfers');
  assert.equal(Number(c.c), 1);
});

test('EXPLOIT CLOSED: webhook no longer confirms a stranger\'s pending booking that merely has the same amount', async () => {
  const t = await db.seedTurf();
  const stranger = await pending(t, { amount: 1000, order: 'order_stranger' });
  await webhook(capturedEvent('order_unknown', 100000, 'pay_other'));
  assert.equal((await state(stranger)).payment_status, 'pending');
});

test('webhook underpayment does not confirm', async () => {
  const t = await db.seedTurf();
  const b = await pending(t, { amount: 1000, order: 'order_wu' });
  await webhook(capturedEvent('order_wu', 500, 'pay_wu'));
  assert.equal((await state(b)).payment_status, 'pending');
});

test('webhook with no secret configured is refused (no public fallback secret)', async () => {
  const saved = process.env.RAZORPAY_WEBHOOK_SECRET; delete process.env.RAZORPAY_WEBHOOK_SECRET;
  try {
    const res = await request(app).post('/api/bookings/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', 'x').send('{}');
    assert.equal(res.status, 503);
  } finally { process.env.RAZORPAY_WEBHOOK_SECRET = saved; }
});
