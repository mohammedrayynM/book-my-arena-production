// Request F: tournament creation, admin-controlled pricing/offers, and creation-fee payment verification.
// Fake Razorpay + a THROWAWAY *_test database (tests/helpers/testDb refuses anything not ending in _test).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';

// ---- fake gateway ------------------------------------------------------------------------------------------
const rp = { payments: {}, orderSeq: 0, orders: {} };
const fakePath = require.resolve('razorpay');
class FakeRazorpay {
  constructor() {
    this.orders = { create: async (o) => { const id = `order_t${++rp.orderSeq}`; rp.orders[id] = o; return { id, ...o }; } };
    this.payments = { fetch: async (id) => rp.payments[id] };
  }
}
require.cache[fakePath] = { id: fakePath, filename: fakePath, loaded: true, exports: FakeRazorpay };
const providerPath = require.resolve('../services/routeProvider');
require.cache[providerPath] = { id: providerPath, filename: providerPath, loaded: true, exports: {
  fetchPayment: async (id) => { if (!rp.payments[id]) throw new Error('no such payment'); return rp.payments[id]; },
  listTransfers: async () => [], fetchAccount: async () => ({ status: 'activated' }), createTransfer: async () => ({ id: 'trf_1' }),
} };

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('./helpers/testDb');

let app;
const q = (s, p) => db.pool.query(s, p);
const qq = (s, p) => db.pool.query(s, p).catch(() => {});
const SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';
const userTok = (id) => ({ Authorization: `Bearer ${jwt.sign({ id, email: 'u@x.test' }, SECRET)}` });
const adminTok = (id) => ({ Authorization: `Bearer ${jwt.sign({ id, role: 'admin' }, SECRET)}` });
const sign = (order, pay) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${order}|${pay}`).digest('hex');
const captured = (order, rupees, id) => { rp.payments[id] = { id, order_id: order, status: 'captured', amount: Math.round(rupees * 100), currency: 'INR' }; };

const U = {};
const DATES = { start_date: '2099-03-01', end_date: '2099-03-02', reg_open_date: '2099-01-01', reg_close_date: '2099-02-01' };
const createBody = (extra = {}) => ({ name: 'Spring Cup', sport: 'Cricket', format_type: 'Knockout', max_teams: 8, ...DATES, ...extra });
const create = (tokenId, extra = {}) => request(app).post('/api/tournaments').set(userTok(tokenId)).send(createBody(extra));

test.before(async () => {
  await db.setup();
  await qq('CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), email VARCHAR(150), karma_points INT DEFAULT 0, phone VARCHAR(20) NULL, profile_pic VARCHAR(500) NULL)');
  await qq('ALTER TABLE admins ADD COLUMN name VARCHAR(100) NULL');
  await require('../migrate_tournaments')();
  for (const m of ['migrate_tournament_registrations', 'migrate_sponsors', 'migrate_tournament_plans',
    'migrate_tournament_analytics', 'migrate_tournament_host_type', 'migrate_tournament_venue',
    'migrate_live_match', 'migrate_tournament_config']) await require(`../${m}`)();

  app = express();
  app.use(express.json());
  app.use('/api/tournaments', require('../routes/tournaments'));
  app.use('/api/tournaments', require('../routes/tournament-management'));
  app.use('/api/admin-tournaments', require('../routes/admin-tournaments'));
});

test.beforeEach(async () => {
  for (const t of ['tournament_offer_redemptions', 'tournament_offers', 'tournament_fee_payments', 'tournament_settings_audit',
    'tournament_teams', 'tournament_participants', 'tournament_fixtures', 'tournament_announcements', 'tournaments', 'users', 'admins']) await qq(`DELETE FROM ${t}`);
  await q('UPDATE tournament_settings SET fee_amount = 0, is_active = 1, creation_enabled = 1, min_duration_days = 1, max_duration_days = 30, allowed_formats = NULL, allowed_sports = NULL, disabled_message = NULL');
  for (const n of ['Host', 'Rival']) { const [r] = await q('INSERT INTO users (name, email) VALUES (?, ?)', [n, `${n.toLowerCase()}@x.test`]); U[n.toLowerCase()] = r.insertId; }
  const [a] = await q("INSERT INTO admins (username) VALUES ('root')"); U.admin = a.insertId;
  rp.payments = {}; rp.orders = {};
});
test.after(async () => { await db.pool.end(); });

const setFee = (amount, extra = {}) => request(app).post('/api/admin-tournaments/settings').set(adminTok(U.admin))
  .send({ fee_amount: amount, is_active: amount > 0, ...extra });
const addOffer = (o = {}) => request(app).post('/api/admin-tournaments/offers').set(adminTok(U.admin))
  .send({ code: 'LAUNCH50', title: 'Launch offer', discount_type: 'percentage', discount_value: 50, ...o });

// ───────────────────────────── creation ─────────────────────────────
test('a signed-in user can create a tournament and gets a real id, slug and join token', async () => {
  const res = await create(U.host);
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.tournament_id > 0);
  assert.match(res.body.slug, /^spring-cup-[0-9a-f]{6}$/);
  assert.match(res.body.join_token, /^[0-9a-f]{32}$/);
  const [[row]] = await q('SELECT * FROM tournaments WHERE id = ?', [res.body.tournament_id]);
  assert.equal(row.owner_id, U.host);
  assert.equal(row.owner_type, 'user');
  assert.equal(row.status, 'REGISTRATION_OPEN'); // free to create -> published straight away
});

test('the created tournament is readable by its slug and by its id', async () => {
  const made = await create(U.host);
  for (const key of [made.body.slug, made.body.tournament_id]) {
    const res = await request(app).get(`/api/tournaments/${key}`);
    assert.equal(res.status, 200, `lookup by ${key}`);
    assert.equal(res.body.tournament.name, 'Spring Cup');
  }
});

test('creation without a token is 401, not 404', async () => {
  const res = await request(app).post('/api/tournaments').send(createBody());
  assert.equal(res.status, 401);
});

test('invalid input is a 400 with a usable message, and nothing is written', async () => {
  const cases = [
    [{ name: '' }, /name is required/i],
    [{ sport: '' }, /sport is required/i],
    [{ start_date: '2099-03-05', end_date: '2099-03-01' }, /.+/],
    [{ visibility: 'SECRET' }, /PUBLIC or PRIVATE/],
  ];
  for (const [patch, re] of cases) {
    const res = await create(U.host, patch);
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.match(res.body.error, re);
  }
  const [[{ n }]] = await q('SELECT COUNT(*) AS n FROM tournaments');
  assert.equal(n, 0);
});

// ───────────────────────────── admin-controlled configuration ─────────────────────────────
test('only an admin can read or change tournament settings', async () => {
  assert.equal((await request(app).get('/api/admin-tournaments/settings')).status, 401);
  assert.equal((await request(app).get('/api/admin-tournaments/settings').set(userTok(U.host))).status, 403);
  assert.equal((await request(app).get('/api/admin-tournaments/settings').set(adminTok(U.admin))).status, 200);
});

test('the fee the host sees comes from the admin settings, and admins are never charged', async () => {
  await setFee(500);
  const cfg = await request(app).get('/api/tournaments/creation-config').set(userTok(U.host));
  assert.equal(cfg.body.fee_amount, 500);
  assert.equal(cfg.body.fee_required, true);
  assert.equal(cfg.body.currency, 'INR');

  const adminCfg = await request(app).get('/api/tournaments/creation-config')
    .set({ Authorization: `Bearer ${jwt.sign({ id: U.admin, role: 'admin' }, SECRET)}` });
  assert.equal(adminCfg.body.fee_amount, 0);
});

test('a paid tournament is created as a DRAFT with a payment order, not published', async () => {
  await setFee(500);
  const res = await create(U.host);
  assert.equal(res.body.fee_required, true);
  assert.equal(res.body.fee_amount, 500);
  assert.ok(res.body.razorpay_order_id);
  const [[row]] = await q('SELECT status, is_paid_to_admin FROM tournaments WHERE id = ?', [res.body.tournament_id]);
  assert.equal(row.status, 'DRAFT');
  assert.equal(Number(row.is_paid_to_admin), 0);
  const [[led]] = await q('SELECT * FROM tournament_fee_payments WHERE tournament_id = ?', [res.body.tournament_id]);
  assert.equal(led.status, 'created');
  assert.equal(Number(led.amount), 500);
});

test('creation is free again as soon as the admin switches the fee off', async () => {
  await setFee(500);
  await setFee(0);
  const res = await create(U.host);
  assert.equal(res.body.fee_required, false);
  const [[row]] = await q('SELECT status FROM tournaments WHERE id = ?', [res.body.tournament_id]);
  assert.equal(row.status, 'REGISTRATION_OPEN');
});

test('the admin can close tournament creation, and the message is shown to hosts', async () => {
  await request(app).post('/api/admin-tournaments/settings').set(adminTok(U.admin))
    .send({ creation_enabled: false, disabled_message: 'Back on Monday' });
  const res = await create(U.host);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Back on Monday');
  const cfg = await request(app).get('/api/tournaments/creation-config').set(userTok(U.host));
  assert.equal(cfg.body.creation_enabled, false);
});

test('duration limits set by the admin are enforced on the backend', async () => {
  await request(app).post('/api/admin-tournaments/settings').set(adminTok(U.admin)).send({ min_duration_days: 2, max_duration_days: 3 });
  const tooShort = await create(U.host, { start_date: '2099-03-01', end_date: '2099-03-01' });
  assert.equal(tooShort.status, 400);
  assert.match(tooShort.body.error, /at least 2 day/);
  const tooLong = await create(U.host, { start_date: '2099-03-01', end_date: '2099-03-10' });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /at most 3 day/);
  assert.equal((await create(U.host, { start_date: '2099-03-01', end_date: '2099-03-02' })).status, 200);
});

test('a format the admin did not allow is rejected', async () => {
  await request(app).post('/api/admin-tournaments/settings').set(adminTok(U.admin)).send({ allowed_formats: ['Round Robin'] });
  const res = await create(U.host, { format_type: 'Knockout' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Allowed formats: Round Robin/);
  assert.equal((await create(U.host, { format_type: 'Round Robin' })).status, 200);
});

test('every settings change is written to the audit history', async () => {
  await setFee(300);
  await setFee(700);
  const res = await request(app).get('/api/admin-tournaments/settings/audit').set(adminTok(U.admin));
  assert.equal(res.status, 200);
  assert.ok(res.body.history.length >= 2);
  assert.equal(res.body.history[0].entity, 'settings');
  assert.equal(JSON.parse(res.body.history[0].after_json).fee_amount, 700);
});

test('changing the fee later does not rewrite what an earlier host was charged', async () => {
  await setFee(500);
  const made = await create(U.host);
  await setFee(1200);
  const [[led]] = await q('SELECT amount FROM tournament_fee_payments WHERE tournament_id = ?', [made.body.tournament_id]);
  assert.equal(Number(led.amount), 500);
});

// ───────────────────────────── offers ─────────────────────────────
test('offers are listed on the creation config only while they are live', async () => {
  await setFee(1000);
  await addOffer();
  let cfg = await request(app).get('/api/tournaments/creation-config').set(userTok(U.host));
  assert.equal(cfg.body.offers.length, 1);
  assert.equal(cfg.body.offers[0].code, 'LAUNCH50');
  assert.equal(cfg.body.offers[0].display_text, '50% OFF');

  await q("UPDATE tournament_offers SET valid_until = '2000-01-01'");
  cfg = await request(app).get('/api/tournaments/creation-config').set(userTok(U.host));
  assert.equal(cfg.body.offers.length, 0);
});

test('the backend computes the discount and the payable total', async () => {
  await setFee(1000);
  await addOffer(); // 50%
  const res = await request(app).post('/api/tournaments/creation-fee/quote').set(userTok(U.host)).send({ coupon_code: 'LAUNCH50' });
  assert.equal(res.body.success, true);
  assert.equal(res.body.fee_amount, 1000);
  assert.equal(res.body.discount_amount, 500);
  assert.equal(res.body.payable_amount, 500);
});

test('a percentage discount is capped by max_discount', async () => {
  await setFee(1000);
  await addOffer({ discount_value: 50, max_discount: 200 });
  const res = await request(app).post('/api/tournaments/creation-fee/quote').set(userTok(U.host)).send({ coupon_code: 'LAUNCH50' });
  assert.equal(res.body.discount_amount, 200);
  assert.equal(res.body.payable_amount, 800);
});

test('invalid, expired, not-yet-valid, inactive and below-minimum coupons each explain themselves', async () => {
  await setFee(1000);
  const quote = (code) => request(app).post('/api/tournaments/creation-fee/quote').set(userTok(U.host)).send({ coupon_code: code });

  assert.match((await quote('NOPE')).body.error, /does not exist/i);

  await addOffer({ code: 'EXPIRED', valid_until: '2000-01-01' });
  assert.match((await quote('EXPIRED')).body.error, /expired/i);

  await addOffer({ code: 'FUTURE', valid_from: '2099-01-01' });
  assert.match((await quote('FUTURE')).body.error, /not valid yet/i);

  await addOffer({ code: 'OFF', is_active: false });
  assert.match((await quote('OFF')).body.error, /no longer active/i);

  await addOffer({ code: 'BIGSPEND', min_amount: 5000 });
  assert.match((await quote('BIGSPEND')).body.error, /at least 5000/);
});

test('a client cannot invent its own discount: only the coupon code is read from the request', async () => {
  await setFee(1000);
  const res = await create(U.host, { discount_amount: 999, fee_amount: 1, payable_amount: 1 });
  assert.equal(res.body.fee_amount, 1000);
  const [[led]] = await q('SELECT * FROM tournament_fee_payments WHERE tournament_id = ?', [res.body.tournament_id]);
  assert.equal(Number(led.amount), 1000);
  assert.equal(Number(led.discount_amount), 0);
});

test('creating with a coupon charges the discounted amount and records the code', async () => {
  await setFee(1000);
  await addOffer();
  const res = await create(U.host, { coupon_code: 'LAUNCH50' });
  assert.equal(res.body.fee_amount, 500);
  assert.equal(res.body.discount_amount, 500);
  const [[led]] = await q('SELECT * FROM tournament_fee_payments WHERE tournament_id = ?', [res.body.tournament_id]);
  assert.equal(led.offer_code, 'LAUNCH50');
  assert.equal(Number(led.amount), 500);
  assert.equal(Number(rp.orders[res.body.razorpay_order_id].amount), 50000); // minor units
});

test('creating with a coupon that is not valid fails with 400 and creates nothing', async () => {
  await setFee(1000);
  const res = await create(U.host, { coupon_code: 'NOPE' });
  assert.equal(res.status, 400);
  const [[{ n }]] = await q('SELECT COUNT(*) AS n FROM tournaments');
  assert.equal(n, 0);
});

// ───────────────────────────── payment verification ─────────────────────────────
test('a valid payment publishes the tournament and writes a receipt', async () => {
  await setFee(500);
  const made = await create(U.host);
  const order = made.body.razorpay_order_id;
  captured(order, 500, 'pay_ok');
  const res = await request(app).post(`/api/tournaments/${made.body.tournament_id}/verify-creation-fee`).set(userTok(U.host))
    .send({ razorpay_order_id: order, razorpay_payment_id: 'pay_ok', razorpay_signature: sign(order, 'pay_ok') });
  assert.equal(res.status, 200);
  assert.equal(res.body.receipt.status, 'PAID');
  assert.equal(res.body.receipt.amount, 500);
  const [[row]] = await q('SELECT status, is_paid_to_admin FROM tournaments WHERE id = ?', [made.body.tournament_id]);
  assert.equal(row.status, 'REGISTRATION_OPEN');
  assert.equal(Number(row.is_paid_to_admin), 1);
});

test('a missing or wrong signature never publishes the tournament', async () => {
  await setFee(500);
  for (const sig of [undefined, 'deadbeef']) {
    const made = await create(U.host);
    const order = made.body.razorpay_order_id;
    captured(order, 500, 'pay_x');
    const res = await request(app).post(`/api/tournaments/${made.body.tournament_id}/verify-creation-fee`).set(userTok(U.host))
      .send({ razorpay_order_id: order, razorpay_payment_id: 'pay_x', razorpay_signature: sig });
    assert.equal(res.status, 400, `signature=${sig}`);
    const [[row]] = await q('SELECT status, is_paid_to_admin FROM tournaments WHERE id = ?', [made.body.tournament_id]);
    assert.equal(row.status, 'DRAFT');
    assert.equal(Number(row.is_paid_to_admin), 0);
  }
});

test('a payment the gateway did not capture is refused', async () => {
  await setFee(500);
  const made = await create(U.host);
  const order = made.body.razorpay_order_id;
  rp.payments.pay_fail = { id: 'pay_fail', order_id: order, status: 'failed', amount: 50000, currency: 'INR' };
  const res = await request(app).post(`/api/tournaments/${made.body.tournament_id}/verify-creation-fee`).set(userTok(U.host))
    .send({ razorpay_order_id: order, razorpay_payment_id: 'pay_fail', razorpay_signature: sign(order, 'pay_fail') });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /failed/);
  const [[led]] = await q('SELECT status FROM tournament_fee_payments WHERE tournament_id = ?', [made.body.tournament_id]);
  assert.equal(led.status, 'failed');
});

test('a payment for somebody else\'s order cannot publish this tournament', async () => {
  await setFee(500);
  const mine = await create(U.host);
  const theirs = await create(U.rival);
  captured(theirs.body.razorpay_order_id, 500, 'pay_other');
  const res = await request(app).post(`/api/tournaments/${mine.body.tournament_id}/verify-creation-fee`).set(userTok(U.host))
    .send({ razorpay_order_id: theirs.body.razorpay_order_id, razorpay_payment_id: 'pay_other', razorpay_signature: sign(theirs.body.razorpay_order_id, 'pay_other') });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /different order/);
});

test('paying less than the fee is refused', async () => {
  await setFee(500);
  const made = await create(U.host);
  const order = made.body.razorpay_order_id;
  captured(order, 100, 'pay_short');
  const res = await request(app).post(`/api/tournaments/${made.body.tournament_id}/verify-creation-fee`).set(userTok(U.host))
    .send({ razorpay_order_id: order, razorpay_payment_id: 'pay_short', razorpay_signature: sign(order, 'pay_short') });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /less than/);
});

test('verifying the same payment twice charges and credits it only once', async () => {
  await setFee(1000);
  await addOffer(); // 50% -> 500 payable
  const made = await create(U.host, { coupon_code: 'LAUNCH50' });
  const order = made.body.razorpay_order_id;
  captured(order, 500, 'pay_twice');
  const body = { razorpay_order_id: order, razorpay_payment_id: 'pay_twice', razorpay_signature: sign(order, 'pay_twice') };
  const first = await request(app).post(`/api/tournaments/${made.body.tournament_id}/verify-creation-fee`).set(userTok(U.host)).send(body);
  const second = await request(app).post(`/api/tournaments/${made.body.tournament_id}/verify-creation-fee`).set(userTok(U.host)).send(body);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.match(second.body.message, /already verified/i);
  const [[paid]] = await q("SELECT COUNT(*) AS n FROM tournament_fee_payments WHERE tournament_id = ? AND status = 'paid'", [made.body.tournament_id]);
  assert.equal(paid.n, 1);
  const [[offer]] = await q('SELECT used_count FROM tournament_offers WHERE code = ?', ['LAUNCH50']);
  assert.equal(offer.used_count, 1); // the coupon was consumed exactly once
});

test('a host cannot verify a payment for a tournament that is not theirs', async () => {
  await setFee(500);
  const made = await create(U.host);
  const order = made.body.razorpay_order_id;
  captured(order, 500, 'pay_steal');
  const res = await request(app).post(`/api/tournaments/${made.body.tournament_id}/verify-creation-fee`).set(userTok(U.rival))
    .send({ razorpay_order_id: order, razorpay_payment_id: 'pay_steal', razorpay_signature: sign(order, 'pay_steal') });
  assert.equal(res.status, 404);
});

test('a coupon with a per-user limit cannot be used twice by the same host', async () => {
  await setFee(1000);
  await addOffer({ per_user_limit: 1 });
  const first = await create(U.host, { coupon_code: 'LAUNCH50' });
  const order = first.body.razorpay_order_id;
  captured(order, 500, 'pay_c1');
  await request(app).post(`/api/tournaments/${first.body.tournament_id}/verify-creation-fee`).set(userTok(U.host))
    .send({ razorpay_order_id: order, razorpay_payment_id: 'pay_c1', razorpay_signature: sign(order, 'pay_c1') });

  const again = await request(app).post('/api/tournaments/creation-fee/quote').set(userTok(U.host)).send({ coupon_code: 'LAUNCH50' });
  assert.match(again.body.error, /already used/i);
  assert.equal((await create(U.host, { coupon_code: 'LAUNCH50' })).status, 400);
});

test('a coupon that has reached max_uses stops applying', async () => {
  await setFee(1000);
  await addOffer({ max_uses: 1 });
  const first = await create(U.host, { coupon_code: 'LAUNCH50' });
  const order = first.body.razorpay_order_id;
  captured(order, 500, 'pay_m1');
  await request(app).post(`/api/tournaments/${first.body.tournament_id}/verify-creation-fee`).set(userTok(U.host))
    .send({ razorpay_order_id: order, razorpay_payment_id: 'pay_m1', razorpay_signature: sign(order, 'pay_m1') });

  const res = await request(app).post('/api/tournaments/creation-fee/quote').set(userTok(U.rival)).send({ coupon_code: 'LAUNCH50' });
  assert.match(res.body.error, /fully used/i);
});

test('admin reconciliation shows what was collected, discounted and still pending', async () => {
  await setFee(1000);
  await addOffer();
  const paidT = await create(U.host, { coupon_code: 'LAUNCH50' });
  captured(paidT.body.razorpay_order_id, 500, 'pay_rec');
  await request(app).post(`/api/tournaments/${paidT.body.tournament_id}/verify-creation-fee`).set(userTok(U.host))
    .send({ razorpay_order_id: paidT.body.razorpay_order_id, razorpay_payment_id: 'pay_rec', razorpay_signature: sign(paidT.body.razorpay_order_id, 'pay_rec') });
  await create(U.rival); // left unpaid

  const res = await request(app).get('/api/admin-tournaments/payments').set(adminTok(U.admin));
  assert.equal(res.status, 200);
  assert.equal(Number(res.body.totals.collected), 500);
  assert.equal(Number(res.body.totals.pending), 1000);
  assert.equal(Number(res.body.totals.discounts_given), 500);
  assert.equal((await request(app).get('/api/admin-tournaments/payments').set(userTok(U.host))).status, 403);
});

// ───────────────────────────── other tournament actions ─────────────────────────────
test('team and announcement input is validated with a 400 instead of failing with a 500', async () => {
  const made = await create(U.host);
  const id = made.body.tournament_id;
  const team = await request(app).post(`/api/tournaments/${id}/teams`).set(userTok(U.host)).send({});
  assert.equal(team.status, 400);
  assert.match(team.body.error, /Team name is required/);
  const ann = await request(app).post(`/api/tournaments/${id}/announcements`).set(userTok(U.host)).send({ title: 'Hi' });
  assert.equal(ann.status, 400);
  assert.match(ann.body.error, /content is required/i);
});

test('a non-host cannot add teams to a tournament they do not own', async () => {
  const made = await create(U.host);
  const res = await request(app).post(`/api/tournaments/${made.body.tournament_id}/teams`).set(userTok(U.rival)).send({ name: 'Intruders' });
  assert.equal(res.status, 403);
});

// ───────────────────────────── invitation link, QR target and team approval ─────────────────────────────
const { tournamentInviteUrl, publicWebBase } = require('../services/publicUrl');

const invite = (token, asUser) => {
  const r = request(app).get(`/api/tournaments/join/${token}`);
  return asUser ? r.set(userTok(asUser)) : r;
};
const tokenOf = async (id) => (await q('SELECT join_token FROM tournaments WHERE id = ?', [id]))[0][0].join_token;

test('every tournament gets an unpredictable invitation token and a production URL', async () => {
  const a = await create(U.host);
  const b = await create(U.host, { name: 'Autumn Cup' });
  assert.match(a.body.join_token, /^[0-9a-f]{32}$/);
  assert.notEqual(a.body.join_token, b.body.join_token);
  assert.equal(a.body.invite_url, `${publicWebBase()}/tournaments/join/${a.body.join_token}`);
  assert.match(a.body.invite_url, /^https:\/\//);
  assert.doesNotMatch(a.body.invite_url, /localhost|127\.|192\.168\./);
});

test('the invitation shows the tournament details a team needs to decide', async () => {
  const made = await create(U.host, { venue: 'MG Arena', location: 'Pune', entry_fee: 250, max_teams: 4, players_per_team: 7 });
  const res = await invite(await tokenOf(made.body.tournament_id));
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'open');
  assert.equal(res.body.can_register, true);
  const t = res.body.tournament;
  assert.equal(t.name, 'Spring Cup');
  assert.equal(t.sport, 'Cricket');
  assert.equal(t.venue, 'MG Arena');
  assert.equal(t.entry_fee, 250);
  assert.equal(t.max_teams, 4);
  assert.equal(t.players_per_team, 7);
  assert.equal(t.spots_left, 4);
  assert.equal(t.host_name, 'Host');
  assert.equal(String(t.reg_close_date).slice(0, 10), '2099-02-01');
});

test('the invitation never exposes the host\'s payment data or the token itself', async () => {
  await setFee(500);
  const made = await create(U.host);
  const res = await invite(await tokenOf(made.body.tournament_id));
  const body = JSON.stringify(res.body);
  for (const leak of ['join_token', 'razorpay_order_id', 'razorpay_payment_id', 'is_paid_to_admin', 'owner_id']) {
    assert.ok(!body.includes(`"${leak}"`), `invite leaked ${leak}`);
  }
});

test('the QR code and the link point at the same invitation', async () => {
  const made = await create(U.host);
  const token = await tokenOf(made.body.tournament_id);
  // The QR encodes exactly the invite_url string, so resolving that URL's token must find this tournament.
  const url = tournamentInviteUrl(token);
  const fromUrl = url.split('/tournaments/join/')[1];
  const res = await invite(fromUrl);
  assert.equal(res.body.tournament.id, made.body.tournament_id);
});

test('a bad token is 404 and never reveals whether it nearly matched', async () => {
  assert.equal((await invite('0'.repeat(32))).status, 404);
  assert.equal((await invite('short')).status, 404);
  assert.equal((await invite('../../etc/passwd')).status, 404);
});

test('the invitation reflects cancelled, completed, full, closed and disabled tournaments', async () => {
  const cases = [
    ["UPDATE tournaments SET status = 'CANCELLED' WHERE id = ?", 'cancelled'],
    ["UPDATE tournaments SET status = 'COMPLETED' WHERE id = ?", 'completed'],
    ["UPDATE tournaments SET join_link_active = false WHERE id = ?", 'disabled'],
    ["UPDATE tournaments SET reg_close_date = '2000-01-01' WHERE id = ?", 'closed'],
  ];
  for (const [sql, expected] of cases) {
    const made = await create(U.host);
    await q(sql, [made.body.tournament_id]);
    const res = await invite(await tokenOf(made.body.tournament_id));
    assert.equal(res.body.state, expected, sql);
    assert.equal(res.body.can_register, false);
    assert.ok(res.body.message);
  }
});

test('a full tournament says so instead of letting another team register', async () => {
  const made = await create(U.host, { max_teams: 1 });
  const id = made.body.tournament_id;
  await request(app).post(`/api/tournaments/${id}/teams`).set(userTok(U.host)).send({ name: 'Only Team' });
  const res = await invite(await tokenOf(id));
  assert.equal(res.body.state, 'full');
  assert.equal(res.body.tournament.spots_left, 0);
  const reg = await request(app).post(`/api/tournaments/${id}/register`).set(userTok(U.rival)).send({ team_name: 'Late Team' });
  assert.equal(reg.status, 400);
  assert.match(reg.body.error, /maximum number of teams/i);
});

test('a free tournament registration creates a team that waits for the host when approval is required', async () => {
  const made = await create(U.host, { entry_fee: 0, host_approval_required: true });
  const id = made.body.tournament_id;
  const reg = await request(app).post(`/api/tournaments/${id}/register`).set(userTok(U.rival)).send({ team_name: 'Challengers' });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.requires_payment, false);
  const [[p]] = await q('SELECT status FROM tournament_participants WHERE tournament_id = ? AND user_id = ?', [id, U.rival]);
  assert.equal(p.status, 'PENDING');

  const list = await request(app).get(`/api/tournaments/${id}/participants`).set(userTok(U.host));
  assert.equal(list.status, 200);
  assert.ok(JSON.stringify(list.body).includes('PENDING'));
});

test('the host can approve a pending team, and only the host can', async () => {
  const made = await create(U.host, { host_approval_required: true });
  const id = made.body.tournament_id;
  await request(app).post(`/api/tournaments/${id}/register`).set(userTok(U.rival)).send({ team_name: 'Challengers' });
  const [[p]] = await q('SELECT id FROM tournament_participants WHERE tournament_id = ?', [id]);

  const asStranger = await request(app).patch(`/api/tournaments/${id}/participants/${p.id}`).set(userTok(U.rival)).send({ status: 'APPROVED' });
  assert.equal(asStranger.status, 403);

  const asHost = await request(app).patch(`/api/tournaments/${id}/participants/${p.id}`).set(userTok(U.host)).send({ status: 'APPROVED' });
  assert.equal(asHost.status, 200);
  const [[after]] = await q('SELECT status FROM tournament_participants WHERE id = ?', [p.id]);
  assert.equal(after.status, 'APPROVED');
});

test('a rejected team is recorded as rejected rather than deleted', async () => {
  const made = await create(U.host, { host_approval_required: true });
  const id = made.body.tournament_id;
  await request(app).post(`/api/tournaments/${id}/register`).set(userTok(U.rival)).send({ team_name: 'Challengers' });
  const [[p]] = await q('SELECT id FROM tournament_participants WHERE tournament_id = ?', [id]);
  const res = await request(app).patch(`/api/tournaments/${id}/participants/${p.id}`).set(userTok(U.host)).send({ status: 'REJECTED' });
  assert.equal(res.status, 200);
  const [[after]] = await q('SELECT status FROM tournament_participants WHERE id = ?', [p.id]);
  assert.equal(after.status, 'REJECTED');
});

test('the same user cannot register twice for the same tournament', async () => {
  const made = await create(U.host);
  const id = made.body.tournament_id;
  const first = await request(app).post(`/api/tournaments/${id}/register`).set(userTok(U.rival)).send({ team_name: 'Challengers' });
  assert.equal(first.status, 200);
  const second = await request(app).post(`/api/tournaments/${id}/register`).set(userTok(U.rival)).send({ team_name: 'Challengers Again' });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already have a/i);
});

test('two teams cannot register under the same name', async () => {
  const made = await create(U.host);
  const id = made.body.tournament_id;
  await request(app).post(`/api/tournaments/${id}/register`).set(userTok(U.rival)).send({ team_name: 'Twins' });
  const [r2] = await q('INSERT INTO users (name, email) VALUES (?, ?)', ['Third', 't@x.test']);
  const dupe = await request(app).post(`/api/tournaments/${id}/register`).set(userTok(r2.insertId)).send({ team_name: 'twins' });
  assert.equal(dupe.status, 400);
  assert.match(dupe.body.error, /already registered/i);
});

test('registration is refused once a tournament is cancelled or completed', async () => {
  for (const status of ['CANCELLED', 'COMPLETED']) {
    const made = await create(U.host);
    await q('UPDATE tournaments SET status = ? WHERE id = ?', [status, made.body.tournament_id]);
    const res = await request(app).post(`/api/tournaments/${made.body.tournament_id}/register`).set(userTok(U.rival)).send({ team_name: 'Late' });
    assert.equal(res.status, 400, status);
  }
});

test('a signed-in viewer sees their own registration on the invite, and nobody else\'s', async () => {
  const made = await create(U.host);
  const id = made.body.tournament_id;
  await request(app).post(`/api/tournaments/${id}/register`).set(userTok(U.rival)).send({ team_name: 'Challengers' });
  const token = await tokenOf(id);

  const mine = await invite(token, U.rival);
  assert.ok(mine.body.my_registration);
  assert.equal(mine.body.my_registration.team_name, 'Challengers');
  assert.equal(mine.body.can_register, false);

  const [other] = await q('INSERT INTO users (name, email) VALUES (?, ?)', ['Nosy', 'n@x.test']);
  const theirs = await invite(token, other.insertId);
  assert.equal(theirs.body.my_registration, null);
  assert.ok(!JSON.stringify(theirs.body).includes('Challengers'));
});

test('the host can turn the invitation link off and regenerate it, which retires the old one', async () => {
  const made = await create(U.host);
  const id = made.body.tournament_id;
  const oldToken = await tokenOf(id);

  const off = await request(app).patch(`/api/tournaments/${id}/toggle-link`).set(userTok(U.host)).send({ active: false });
  assert.equal(off.status, 200);
  assert.equal((await invite(oldToken)).body.state, 'disabled');

  await request(app).patch(`/api/tournaments/${id}/toggle-link`).set(userTok(U.host)).send({ active: true });
  const regen = await request(app).post(`/api/tournaments/${id}/regenerate-token`).set(userTok(U.host)).send({});
  assert.equal(regen.status, 200);
  assert.notEqual(regen.body.join_token, oldToken);
  assert.equal(regen.body.invite_url, `${publicWebBase()}/tournaments/join/${regen.body.join_token}`);
  assert.equal((await invite(oldToken)).status, 404);
  assert.equal((await invite(regen.body.join_token)).status, 200);
});

test('the host sees the invite URL on their own tournament, and a stranger cannot read it', async () => {
  const made = await create(U.host);
  const mine = await request(app).get(`/api/tournaments/host/${made.body.tournament_id}`).set(userTok(U.host));
  assert.equal(mine.status, 200);
  assert.equal(mine.body.tournament.invite_url, made.body.invite_url);
  const theirs = await request(app).get(`/api/tournaments/host/${made.body.tournament_id}`).set(userTok(U.rival));
  assert.equal(theirs.status, 404);
});
