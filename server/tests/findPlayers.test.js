// Request E: Find Players payment sharing, coupons, invite link + join/pay. Fake Razorpay + a THROWAWAY *_test database.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
process.env.REFUND_GATEWAY = 'simulated';

// ---- fake gateway: orders are created locally, payments are whatever the test says Razorpay reports
const rp = { payments: {}, orderSeq: 0, fetchError: null };
const fakePath = require.resolve('razorpay');
class FakeRazorpay {
  constructor() { this.orders = { create: async () => ({ id: `order_${++rp.orderSeq}` }) }; this.payments = { fetch: async (id) => rp.payments[id] }; }
  static validateWebhookSignature(body, sig, secret) { return crypto.createHmac('sha256', secret).update(body).digest('hex') === sig; }
}
require.cache[fakePath] = { id: fakePath, filename: fakePath, loaded: true, exports: FakeRazorpay };
const providerPath = require.resolve('../services/routeProvider');
require.cache[providerPath] = { id: providerPath, filename: providerPath, loaded: true, exports: {
  fetchPayment: async (id) => { if (rp.fetchError) throw rp.fetchError; if (!rp.payments[id]) throw new Error('no such payment'); return rp.payments[id]; },
  listTransfers: async () => [], fetchAccount: async () => ({ status: 'activated' }), createTransfer: async () => ({ id: 'trf_1', simulated: true }),
} };
const subPath = require.resolve('../services/subscriptionService');
const realSub = require(subPath);
require.cache[subPath].exports = { ...realSub, activateByOrder: async () => ({ notFound: true }), reportPaymentFailed: async () => ({ notFound: true }) };

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('./helpers/testDb');
const { splitAmount } = require('../services/playerSplit');
const { publicWebBase, inviteUrl } = require('../services/publicUrl');

let app; let turf;
const q = (s, p) => db.pool.query(s, p);
const qq = (s) => db.pool.query(s).catch(() => {});
const tok = (id) => ({ Authorization: `Bearer ${jwt.sign({ id, role: 'user' }, process.env.JWT_SECRET || 'your_jwt_secret_key')}` });
const sign = (order, pay) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${order}|${pay}`).digest('hex');
const captured = (order, minor, id) => { rp.payments[id] = { id, order_id: order, status: 'captured', amount: minor, currency: 'INR' }; };

test.before(async () => {
  await db.setup();
  for (const c of ['is_deleted TINYINT DEFAULT 0', 'open_time VARCHAR(8) NULL', 'close_time VARCHAR(8) NULL', 'slot_duration INT DEFAULT 60', "time_format VARCHAR(4) DEFAULT '12h'",
    'advance_percent INT DEFAULT 100', 'price_per_hour DECIMAL(10,2) DEFAULT 1000', 'markup_type VARCHAR(10) NULL', 'markup_value DECIMAL(10,2) DEFAULT 0', 'slug VARCHAR(100) NULL',
    'early_morning_price DECIMAL(10,2) NULL', 'morning_price DECIMAL(10,2) NULL', 'afternoon_price DECIMAL(10,2) NULL', 'evening_price DECIMAL(10,2) NULL', 'default_price DECIMAL(10,2) NULL',
    "timezone VARCHAR(60) DEFAULT 'Asia/Kolkata'", 'is_24_hours TINYINT(1) NOT NULL DEFAULT 0', 'sport_type VARCHAR(40) NULL', 'address VARCHAR(200) NULL', 'images TEXT NULL',
    'latitude DOUBLE NULL', 'longitude DOUBLE NULL', 'location VARCHAR(100) NULL']) await qq(`ALTER TABLE turfs ADD COLUMN ${c}`);
  for (const c of ['user_id INT NULL', 'payment_type VARCHAR(20) NULL', 'discount_amount DECIMAL(10,2) DEFAULT 0', 'markup_amount DECIMAL(10,2) DEFAULT 0', 'coupon_code VARCHAR(40) NULL', 'currency_code VARCHAR(3) NULL',
    'need_players TINYINT DEFAULT 0', 'players_needed INT DEFAULT 0', 'contribution_amount DECIMAL(10,2) DEFAULT 0', 'sport_type VARCHAR(40) NULL', 'match_type VARCHAR(20) NULL', 'skill_level VARCHAR(20) NULL',
    'contact_phone VARCHAR(30) NULL', 'note VARCHAR(500) NULL', 'match_request_id INT NULL', 'player_request_created TINYINT DEFAULT 0', 'cancelled_by VARCHAR(10) NULL', 'cancel_reason VARCHAR(255) NULL', 'cancelled_at DATETIME NULL']) await qq(`ALTER TABLE bookings ADD COLUMN ${c}`);
  await qq('CREATE TABLE IF NOT EXISTS blocked_slots (id INT AUTO_INCREMENT PRIMARY KEY, turf_id INT, court_id INT NULL, block_date DATE, time_slot VARCHAR(40), reason VARCHAR(100) NULL)');
  await qq('CREATE TABLE IF NOT EXISTS special_pricing (id INT AUTO_INCREMENT PRIMARY KEY, turf_id INT, court_id INT NULL, time_slot VARCHAR(40), special_price DECIMAL(10,2), offer_percentage INT NULL, offer_label VARCHAR(50) NULL, specific_date DATE NULL, day_of_week INT NULL, is_active BOOLEAN DEFAULT TRUE)');
  await qq('CREATE TABLE IF NOT EXISTS day_wise_pricing (id INT AUTO_INCREMENT PRIMARY KEY, turf_id INT, court_id INT NULL, day_of_week VARCHAR(12), early_morning_price DECIMAL(10,2) NULL, morning_price DECIMAL(10,2) NULL, afternoon_price DECIMAL(10,2) NULL, evening_price DECIMAL(10,2) NULL)');
  await qq('CREATE TABLE IF NOT EXISTS settings (id INT AUTO_INCREMENT PRIMARY KEY, setting_key VARCHAR(60), setting_value VARCHAR(100))');
  await qq('CREATE TABLE IF NOT EXISTS courts (id INT AUTO_INCREMENT PRIMARY KEY, turf_id INT, price_per_hour DECIMAL(10,2), open_time VARCHAR(8), close_time VARCHAR(8), slot_duration INT, time_format VARCHAR(4), advance_percent INT, markup_type VARCHAR(10), markup_value DECIMAL(10,2), early_morning_price DECIMAL(10,2), morning_price DECIMAL(10,2), afternoon_price DECIMAL(10,2), evening_price DECIMAL(10,2), default_price DECIMAL(10,2), is_24_hours TINYINT(1) DEFAULT 0, sport_type VARCHAR(40) NULL, approval_status VARCHAR(20) NULL, is_active BOOLEAN DEFAULT TRUE)');
  await qq('CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), email VARCHAR(150), karma_points INT DEFAULT 0, phone VARCHAR(20) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  await qq('CREATE TABLE IF NOT EXISTS coupons (id INT AUTO_INCREMENT PRIMARY KEY, turf_id INT, court_id INT NULL, code VARCHAR(30), discount_type VARCHAR(12), discount_value DECIMAL(10,2), min_booking_amount DECIMAL(10,2) DEFAULT 0, max_discount_cap DECIMAL(10,2) NULL, valid_from DATE NULL, valid_until DATE NULL, expiry_date DATE NULL, max_uses INT NULL, used_count INT DEFAULT 0, per_user_limit INT NULL, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  await qq('CREATE TABLE IF NOT EXISTS admin_coupons (id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(30), label VARCHAR(100) NULL, discount_type VARCHAR(12), discount_value DECIMAL(10,2), min_booking_amount DECIMAL(10,2) DEFAULT 0, max_discount_cap DECIMAL(10,2) NULL, valid_from DATE NULL, valid_until DATE NULL, max_uses INT NULL, used_count INT DEFAULT 0, per_user_limit INT NULL, applicable_sport VARCHAR(30) DEFAULT \'all\', is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  await qq("ALTER TABLE admin_coupons ADD COLUMN applicable_sport VARCHAR(30) DEFAULT 'all'");
  await qq("ALTER TABLE admin_coupons ADD COLUMN per_user_limit INT NULL");
  await qq('ALTER TABLE users ADD COLUMN karma_points INT DEFAULT 0');
  await qq('CREATE TABLE IF NOT EXISTS payment_configs (id INT AUTO_INCREMENT PRIMARY KEY, country_code VARCHAR(2), currency_code VARCHAR(3), payment_provider VARCHAR(20), payment_methods TEXT NULL, enabled BOOLEAN DEFAULT FALSE, notes VARCHAR(200) NULL)');
  await qq('CREATE TABLE IF NOT EXISTS coupon_usages (id INT AUTO_INCREMENT PRIMARY KEY, coupon_id INT, booking_id INT, user_id INT NULL, customer_email VARCHAR(150), customer_phone VARCHAR(30), discount_amount DECIMAL(10,2))');
  await qq('CREATE TABLE IF NOT EXISTS admin_coupon_usages (id INT AUTO_INCREMENT PRIMARY KEY, coupon_id INT, booking_id INT, user_id INT NULL, customer_email VARCHAR(150), customer_phone VARCHAR(30), discount_amount DECIMAL(10,2))');
  await qq('DROP TABLE IF EXISTS player_requests'); await qq('DROP TABLE IF EXISTS match_players');
  await qq(`CREATE TABLE player_requests (id INT AUTO_INCREMENT PRIMARY KEY, host_id INT, turf_id INT, court_id INT NULL, sport_type VARCHAR(40), match_type VARCHAR(20), match_date DATE, match_time TIME, total_slots INT, filled_slots INT DEFAULT 1,
    roles_needed TEXT NULL, skill_level VARCHAR(20), advance_amount DECIMAL(10,2) DEFAULT 0, split_amount DECIMAL(10,2) DEFAULT 0, visibility_radius INT, latitude DOUBLE NULL, longitude DOUBLE NULL, share_token VARCHAR(64), booking_time_slot VARCHAR(120),
    contact_phone VARCHAR(30), contribution_amount DECIMAL(10,2) DEFAULT 0, booking_total_amount DECIMAL(10,2) DEFAULT 0, note VARCHAR(500), status VARCHAR(20) DEFAULT 'open', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await qq(`CREATE TABLE match_players (id INT AUTO_INCREMENT PRIMARY KEY, match_id INT, user_id INT, role VARCHAR(40) NULL, payment_type VARCHAR(20), payment_status VARCHAR(20), status VARCHAR(20), joined_at DATETIME,
    amount_paid DECIMAL(10,2) DEFAULT 0, razorpay_order_id VARCHAR(64) NULL, razorpay_payment_id VARCHAR(64) NULL, razorpay_signature VARCHAR(128) NULL)`);
  for (const c of ['reserved_until DATETIME NULL', 'confirmed_at DATETIME NULL']) await qq(`ALTER TABLE match_players ADD COLUMN ${c}`);
  await qq('CREATE UNIQUE INDEX idx_mp_pay ON match_players (razorpay_payment_id)');
  await qq('DROP TABLE IF EXISTS refunds');
  await q(`CREATE TABLE refunds (id INT AUTO_INCREMENT PRIMARY KEY, refund_code VARCHAR(40), booking_type VARCHAR(20), booking_id INT, payment_id VARCHAR(64), user_id INT NULL, owner_id INT NULL, venue_id INT NULL,
    venue_name VARCHAR(100) NULL, country_code VARCHAR(2) NULL, business_type VARCHAR(20) NULL, original_amount_minor BIGINT, amount_paid_minor BIGINT, cancellation_fee_minor BIGINT, refund_amount_minor BIGINT,
    currency_code VARCHAR(3), refund_reason VARCHAR(255) NULL, cancelled_by VARCHAR(10), cancellation_type VARCHAR(40), refund_status VARCHAR(30), gateway_payment_id VARCHAR(64) NULL, gateway_refund_id VARCHAR(64) NULL,
    idempotency_key VARCHAR(150) UNIQUE, policy_version INT NULL, policy_window_hours INT NULL, policy_fee_percent DECIMAL(5,2) NULL, attempts INT DEFAULT 0, failure_reason VARCHAR(255) NULL,
    processed_at DATETIME NULL, completed_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  app = express();
  app.use((req, res, next) => (req.path.endsWith('/webhook') ? next() : express.json()(req, res, next)));
  app.use('/api/bookings', require('../routes/bookings'));
  app.use('/api/match-requests', require('../routes/match-requests'));
  app.use('/api/coupons', require('../routes/coupons'));
});
test.beforeEach(async () => {
  await db.reset();
  for (const t of ['blocked_slots', 'special_pricing', 'day_wise_pricing', 'courts', 'refunds', 'users', 'coupons', 'admin_coupons', 'coupon_usages', 'admin_coupon_usages', 'player_requests', 'match_players', 'settings']) await q(`DELETE FROM ${t}`);
  await q('DELETE FROM payment_configs'); await q("INSERT INTO payment_configs (country_code, currency_code, payment_provider, enabled) VALUES ('IN', 'INR', 'razorpay', TRUE)");
  await q("INSERT INTO settings (setting_key, setting_value) VALUES ('service_fee', '0'), ('service_fee_type', 'fixed')");
  turf = await db.seedTurf({ name: 'Arena One' });
  await q("UPDATE turfs SET price_per_hour = 1000, default_price = 1000, advance_percent = 50, open_time = '06:00', close_time = '23:00', sport_type = 'Cricket', address = 'MG Road' WHERE id = ?", [turf]);
  for (const n of ['Host', 'Anu', 'Ben', 'Cara', 'Dev']) { const [r] = await q('INSERT INTO users (name, email, phone) VALUES (?, ?, ?)', [`${n} Surname`, `${n.toLowerCase()}@x.test`, '99999']); U[n.toLowerCase()] = r.insertId; }
  rp.payments = {}; rp.fetchError = null;
});
test.after(async () => { await db.pool.end(); });

const U = {};
const price = (extra = {}) => request(app).post('/api/bookings/calculate-price').send({ turf_id: turf, booking_date: '2099-01-01', time_slots: ['6:00 PM - 7:00 PM'], ...extra });
const coupon = (f = {}) => q("INSERT INTO coupons (turf_id, code, discount_type, discount_value, is_active) VALUES (?, 'RAYYAN', 'flat', 100, TRUE)", [turf]).then(async ([r]) => { for (const [k, v] of Object.entries(f)) await q(`UPDATE coupons SET ${k} = ? WHERE id = ?`, [v, r.insertId]); return r.insertId; });

// create a Find Players booking and confirm the host's payment; returns the match request + token
async function hostMatch({ players = 4, couponCode = null } = {}) {
  const b = await request(app).post('/api/bookings').set(tok(U.host)).send({
    turf_id: turf, customer_name: 'Host', customer_phone: '99999', customer_email: 'host@x.test', booking_date: '2099-01-01', time_slots: ['6:00 PM - 7:00 PM'], coupon_code: couponCode,
    need_players: true, players_needed: players, contribution_amount: 1, payment_option: 'advance', sport_type: 'Cricket' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const pay = `pay_host${Math.random().toString(36).slice(2, 8)}`;
  captured(b.body.order_id, Math.round(b.body.amount * 100), pay);
  const v = await request(app).post('/api/bookings/verify').send({ booking_id: b.body.booking_id, razorpay_order_id: b.body.order_id, razorpay_payment_id: pay, razorpay_signature: sign(b.body.order_id, pay) });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const [[m]] = await q('SELECT * FROM player_requests ORDER BY id DESC LIMIT 1');
  return { booking: b.body, match: m };
}
const join = async (matchId, user, opts = {}) => {
  const o = await request(app).post(`/api/match-requests/${matchId}/join/create-order`).set(tok(user)).send({ payment_option: 'full', ...opts });
  return o;
};
const pay = async (o, user, payId, { minor, status = 'captured' } = {}) => {
  rp.payments[payId] = { id: payId, order_id: o.body.order_id, status, amount: minor ?? Math.round(o.body.amount * 100), currency: 'INR' };
  return request(app).post('/api/match-requests/join/verify').set(tok(user)).send({ match_player_id: o.body.match_player_id, razorpay_order_id: o.body.order_id, razorpay_payment_id: payId, razorpay_signature: sign(o.body.order_id, payId) });
};

// ----------------------------------------------------------------------------------------------------------- 1. split maths
test('split: host + players share the FINAL amount equally; shares add up exactly (minor units)', () => {
  const a = splitAmount({ totalMajor: 1000, playersNeeded: 4 });
  assert.equal(a.participants, 5); assert.equal(a.playerShare, 200); assert.equal(a.hostShare, 200);
  const b = splitAmount({ totalMajor: 900, playersNeeded: 4 }); assert.equal(b.playerShare, 180);
  const c = splitAmount({ totalMajor: 1000, playersNeeded: 2 });                       // 1000 / 3 = 333.33…
  assert.equal(c.playerShareMinor, 33333); assert.equal(c.hostShareMinor, 33334); assert.equal(c.hostShareMinor + 2 * c.playerShareMinor, c.totalMinor);
  for (const [t, n] of [[999.99, 7], [1, 3], [0.05, 4], [12345.67, 11]]) { const s = splitAmount({ totalMajor: t, playersNeeded: n }); assert.equal(s.hostShareMinor + n * s.playerShareMinor, s.totalMinor); assert.ok(s.hostShareMinor - s.playerShareMinor < n + 1); }
  assert.equal(splitAmount({ totalMajor: 1000, playersNeeded: 0 }).active, false);
  const jpy = splitAmount({ totalMajor: 1000, playersNeeded: 2, currency: 'JPY' }); assert.equal(jpy.playerShareMinor, 333); assert.equal(jpy.hostShareMinor, 334);
});
test('invite url never uses localhost / LAN in production', () => {
  const keep = { n: process.env.NODE_ENV, c: process.env.CLIENT_URL, p: process.env.PUBLIC_WEB_URL };
  process.env.NODE_ENV = 'production'; delete process.env.PUBLIC_WEB_URL;
  process.env.CLIENT_URL = 'http://192.168.1.80:5173'; assert.equal(publicWebBase(), 'https://bookarena.in');
  process.env.CLIENT_URL = 'http://localhost:5173'; assert.equal(publicWebBase(), 'https://bookarena.in');
  process.env.CLIENT_URL = 'https://app.example.com/'; assert.equal(inviteUrl('abc123xyz'), 'https://app.example.com/match-request/abc123xyz');
  process.env.PUBLIC_WEB_URL = 'https://bookarena.in'; assert.equal(publicWebBase(), 'https://bookarena.in');
  process.env.NODE_ENV = keep.n; if (keep.c === undefined) delete process.env.CLIENT_URL; else process.env.CLIENT_URL = keep.c; if (keep.p === undefined) delete process.env.PUBLIC_WEB_URL; else process.env.PUBLIC_WEB_URL = keep.p;
});

// ------------------------------------------------------------------------------------- 2. Find Players disables advance
test('normal booking keeps advance; Find Players turns it off and splits the final amount', async () => {
  const n = await price({ payment_option: 'advance' });
  assert.equal(n.body.paymentType, 'advance'); assert.equal(n.body.advanceAmount, 500); assert.equal(n.body.advanceDisabled, false);
  const f = await price({ payment_option: 'advance', need_players: true, players_needed: 4, contribution_amount: 999 });
  assert.equal(f.body.advanceDisabled, true); assert.equal(f.body.paymentType, 'full'); assert.equal(f.body.pendingBalance, 0);
  assert.equal(f.body.contributionAmount, 200, 'client-supplied contribution is ignored'); assert.equal(f.body.hostSplitShare, 200); assert.equal(f.body.finalAmount, 200); assert.equal(f.body.advanceAmount, 200);
  assert.equal(f.body.participants, 5);
  const off = await price({ payment_option: 'advance', need_players: false });
  assert.equal(off.body.paymentType, 'advance', 'turning Find Players off restores the normal options');
});

// ------------------------------------------------------------------------------------------------------ 3. coupons
test('coupon: discount is backend-calculated and the split uses the discounted total', async () => {
  await coupon();
  const r = await price({ coupon_code: 'rayyan', need_players: true, players_needed: 4 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.discountAmount, 100); assert.equal(r.body.originalFinalAmount, 900); assert.equal(r.body.contributionAmount, 180); assert.equal(r.body.finalAmount, 180); assert.equal(r.body.participants, 5);
  const plain = await price({ coupon_code: 'RAYYAN' }); assert.equal(plain.body.finalAmount, 900); assert.equal(plain.body.discountAmount, 100);
  const removed = await price({ need_players: true, players_needed: 4 }); assert.equal(removed.body.contributionAmount, 200, 'removing the coupon restores the full share');
});
test('coupon: invalid / expired / inactive / below-minimum / used-up are refused with a clear message', async () => {
  assert.match((await price({ coupon_code: 'NOPE' })).body.error, /Invalid coupon/);
  const id = await coupon({ valid_until: '2000-01-01' }); assert.match((await price({ coupon_code: 'RAYYAN' })).body.error, /expired/);
  await q('UPDATE coupons SET valid_until = NULL, valid_from = ? WHERE id = ?', ['2999-01-01', id]); assert.match((await price({ coupon_code: 'RAYYAN' })).body.error, /not active yet/);
  await q('UPDATE coupons SET valid_from = NULL, min_booking_amount = 5000 WHERE id = ?', [id]); assert.match((await price({ coupon_code: 'RAYYAN' })).body.error, /Minimum booking amount/);
  await q('UPDATE coupons SET min_booking_amount = 0, max_uses = 1, used_count = 1 WHERE id = ?', [id]); assert.match((await price({ coupon_code: 'RAYYAN' })).body.error, /usage limit/);
  await q('UPDATE coupons SET max_uses = NULL, is_active = FALSE WHERE id = ?', [id]); assert.match((await price({ coupon_code: 'RAYYAN' })).body.error, /Invalid coupon/);
});
test('coupon: per-user limit follows the SIGNED-IN user, not a client-supplied user_id; percentage honours the cap', async () => {
  const id = await coupon({ per_user_limit: 1 });
  await q("INSERT INTO coupon_usages (coupon_id, booking_id, user_id, customer_email, customer_phone, discount_amount) VALUES (?, 1, ?, 'x', 'y', 100)", [id, U.anu]);
  const spoof = await request(app).post('/api/bookings/calculate-price').set(tok(U.anu)).send({ turf_id: turf, booking_date: '2099-01-01', time_slots: ['6:00 PM - 7:00 PM'], coupon_code: 'RAYYAN', user_id: 999 });
  assert.match(spoof.body.error, /usage limit/, 'pretending to be another user does not help');
  const other = await request(app).post('/api/bookings/calculate-price').set(tok(U.ben)).send({ turf_id: turf, booking_date: '2099-01-01', time_slots: ['6:00 PM - 7:00 PM'], coupon_code: 'RAYYAN' });
  assert.equal(other.body.discountAmount, 100);
  await q("UPDATE coupons SET discount_type = 'percentage', discount_value = 50, max_discount_cap = 120, per_user_limit = NULL WHERE id = ?", [id]);
  assert.equal((await price({ coupon_code: 'RAYYAN' })).body.discountAmount, 120);
});
test('offers list: active coupons with validity, minimum, cap and both field spellings', async () => {
  await coupon({ min_booking_amount: 500, max_discount_cap: 150, valid_until: '2099-12-31' });
  await q("INSERT INTO admin_coupons (code, label, discount_type, discount_value) VALUES ('WELCOME', 'Welcome offer', 'percentage', 10)");
  await q("INSERT INTO coupons (turf_id, code, discount_type, discount_value, is_active) VALUES (?, 'OLD', 'flat', 10, FALSE)", [turf]);
  const r = await request(app).get(`/api/coupons/turf/${turf}`);
  const codes = r.body.coupons.map((c) => c.code).sort(); assert.deepEqual(codes, ['RAYYAN', 'WELCOME']);
  const c = r.body.coupons.find((x) => x.code === 'RAYYAN');
  assert.equal(c.discount_type, 'flat'); assert.equal(c.discount_value, 100); assert.equal(c.discountValue, 100); assert.equal(c.minBookingAmount, 500); assert.equal(c.maxDiscountCap, 150); assert.equal(c.validUntil, '2099-12-31');
  assert.equal(r.body.coupons.find((x) => x.code === 'WELCOME').label, 'Welcome offer');
});

// ------------------------------------------------------------------------------------- 4. booking creates the invite
test('Find Players booking: host pays full share, invite carries the post-coupon total and share', async () => {
  await coupon();
  const { booking, match } = await hostMatch({ couponCode: 'RAYYAN' });
  assert.equal(booking.paymentType, 'full'); assert.equal(booking.amount, 180); assert.equal(booking.pendingBalance, 0);
  assert.equal(Number(match.booking_total_amount), 900); assert.equal(Number(match.contribution_amount), 180); assert.equal(match.total_slots, 5); assert.equal(match.filled_slots, 1);
  assert.ok(/^[0-9a-f]{32}$/.test(match.share_token), 'unpredictable 128-bit token');
  const [[b]] = await q('SELECT payment_type, advance_amount, pending_balance, amount FROM bookings ORDER BY id DESC LIMIT 1');
  assert.equal(b.payment_type, 'full'); assert.equal(Number(b.pending_balance), 0);
});

// --------------------------------------------------------------------------------------------- 5. invitation endpoint
test('invitation: shows real match data, no private data, canonical url, correct spots', async () => {
  const { match } = await hostMatch();
  const r = await request(app).get(`/api/match-requests/public/${match.share_token}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const raw = JSON.stringify(r.body);
  assert.ok(!/contact_phone|latitude|longitude|host@x\.test|99999/.test(raw), 'no phone / email / coordinates');
  assert.equal(r.body.match.host_name, 'Host', 'first name only'); assert.equal(r.body.invite.state, 'open'); assert.equal(r.body.invite.remaining_spots, 4); assert.equal(r.body.invite.capacity, 5);
  assert.equal(r.body.invite.share_amount, 200); assert.equal(r.body.invite.total_amount, 1000); assert.equal(r.body.invite.confirmed_participants, 1);
  assert.equal(r.body.invite.invite_url, `${publicWebBase()}/match-request/${match.share_token}`); assert.equal(r.body.match.turf_name, 'Arena One');
  assert.equal((await request(app).get('/api/match-requests/public/not-a-token')).status, 404);
  assert.equal((await request(app).get(`/api/match-requests/public/${'a'.repeat(32)}`)).status, 404);
});

// -------------------------------------------------------------------------------------- 6. join + pay (verified only)
test('join: opening the link / starting checkout takes no permanent spot; only a verified payment does', async () => {
  const { match } = await hostMatch();
  const o = await join(match.id, U.anu); assert.equal(o.status, 200, JSON.stringify(o.body)); assert.equal(o.body.amount, 200);
  let [[m]] = await q('SELECT filled_slots FROM player_requests WHERE id = ?', [match.id]); assert.equal(m.filled_slots, 1, 'checkout alone does not fill a spot');
  const other = await request(app).get(`/api/match-requests/public/${match.share_token}`).set(tok(U.ben)); assert.equal(other.body.invite.remaining_spots, 3, 'but it is held for the payer for a few minutes');
  assert.equal(other.body.invite.reserved_spots, 1);

  const bad = await request(app).post('/api/match-requests/join/verify').set(tok(U.anu)).send({ match_player_id: o.body.match_player_id, razorpay_order_id: o.body.order_id, razorpay_payment_id: 'pay_x', razorpay_signature: 'forged' });
  assert.equal(bad.status, 400); [[m]] = await q('SELECT filled_slots FROM player_requests WHERE id = ?', [match.id]); assert.equal(m.filled_slots, 1);
  const notCaptured = await pay(o, U.anu, 'pay_auth1', { status: 'authorized' }); assert.equal(notCaptured.status, 409); assert.equal(notCaptured.body.pending, true);
  assert.equal((await q('SELECT payment_status FROM match_players WHERE id = ?', [o.body.match_player_id]))[0][0].payment_status, 'pending', 'not captured -> not paid');
  const short = await pay(o, U.anu, 'pay_short1', { minor: 5000 }); assert.equal(short.status, 400);
  assert.equal((await q('SELECT payment_status FROM match_players WHERE id = ?', [o.body.match_player_id]))[0][0].payment_status, 'pending', 'underpayment -> not paid');

  const ok = await pay(o, U.anu, 'pay_good1'); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.success, true);
  [[m]] = await q('SELECT filled_slots, status FROM player_requests WHERE id = ?', [match.id]); assert.equal(m.filled_slots, 2); assert.equal(m.status, 'open');
  const inv = await request(app).get(`/api/match-requests/public/${match.share_token}`).set(tok(U.anu));
  assert.equal(inv.body.invite.confirmed_participants, 2); assert.equal(inv.body.invite.remaining_spots, 3); assert.equal(inv.body.invite.my_status.payment_status, 'paid'); assert.equal(inv.body.invite.can_join, false);
  assert.deepEqual(inv.body.players.map((p) => p.user_name), ['Anu']);

  // idempotent: a second tap / replay changes nothing
  const again = await pay(o, U.anu, 'pay_good1'); assert.equal(again.status, 200); assert.equal(again.body.alreadyPaid, true);
  [[m]] = await q('SELECT filled_slots FROM player_requests WHERE id = ?', [match.id]); assert.equal(m.filled_slots, 2);
  assert.equal((await join(match.id, U.anu)).status, 409, 'the same user cannot join twice');
  assert.equal((await join(match.id, U.host)).status, 400, 'the host is never counted twice');

  // receipt (paid) and host view
  const rc = await request(app).get(`/api/match-requests/receipt/${o.body.match_player_id}`).set(tok(U.anu));
  assert.equal(rc.status, 200); assert.equal(rc.body.receipt.state, 'paid'); assert.equal(rc.body.receipt.amount, 200); assert.equal(rc.body.receipt.transaction_reference, 'pay_good1'); assert.equal(rc.body.receipt.venue, 'Arena One'); assert.ok(rc.body.receipt.confirmed_at);
  assert.equal((await request(app).get(`/api/match-requests/receipt/${o.body.match_player_id}`).set(tok(U.ben))).status, 404, "someone else's receipt is not readable");
  const hs = await request(app).get(`/api/match-requests/${match.id}/host-summary`).set(tok(U.host)); assert.equal(hs.status, 200);
  assert.equal(hs.body.confirmed_participants, 2); assert.equal(hs.body.remaining_spots, 3); assert.equal(hs.body.amount_collected_from_players, 200); assert.equal(hs.body.amount_outstanding, 600); assert.equal(hs.body.share_amount, 200);
  assert.equal(hs.body.participants.length, 2); assert.equal(hs.body.participants[0].role, 'Host');
  assert.equal((await request(app).get(`/api/match-requests/${match.id}/host-summary`).set(tok(U.anu))).status, 403);
});
test('pending acknowledgement is labelled pending, never "paid"', async () => {
  const { match } = await hostMatch(); const o = await join(match.id, U.anu);
  const rc = await request(app).get(`/api/match-requests/receipt/${o.body.match_player_id}`).set(tok(U.anu));
  assert.equal(rc.body.receipt.state, 'pending'); assert.match(rc.body.receipt.label, /pending/i); assert.equal(rc.body.receipt.transaction_reference, null); assert.equal(rc.body.receipt.confirmed_at, null);
});
test('coupon share on the receipt: allocated discount per participant', async () => {
  await coupon(); const { match } = await hostMatch({ couponCode: 'RAYYAN' }); const o = await join(match.id, U.anu); await pay(o, U.anu, 'pay_cp1');
  const rc = await request(app).get(`/api/match-requests/receipt/${o.body.match_player_id}`).set(tok(U.anu));
  assert.equal(rc.body.receipt.amount, 180); assert.equal(rc.body.receipt.coupon_code, 'RAYYAN'); assert.equal(rc.body.receipt.discount_allocated, 20);
});

// ------------------------------------------------------------------------------------- 7. last spot, races, refunds
test('last spot: a second payer is held back, then told it is full; capacity is never exceeded', async () => {
  const { match } = await hostMatch({ players: 1 });                 // host + 1 = 2 slots
  const a = await join(match.id, U.anu); assert.equal(a.status, 200);
  const b = await join(match.id, U.ben); assert.equal(b.status, 409); assert.equal(b.body.code, 'spot_held');
  assert.equal((await pay(a, U.anu, 'pay_last1')).status, 200);
  const c = await join(match.id, U.ben); assert.equal(c.status, 409); assert.equal(c.body.code, 'full');
  const [[m]] = await q('SELECT filled_slots, total_slots, status FROM player_requests WHERE id = ?', [match.id]); assert.equal(m.filled_slots, 2); assert.equal(m.status, 'full');
  const inv = await request(app).get(`/api/match-requests/public/${match.share_token}`); assert.equal(inv.body.invite.state, 'full'); assert.equal(inv.body.invite.can_join, false);
});
test('two payers for the last spot (reservation expired): first verified payment wins, the other is refunded in full', async () => {
  const { match } = await hostMatch({ players: 1 });
  const a = await join(match.id, U.anu);
  await q('UPDATE match_players SET reserved_until = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [a.body.match_player_id]);   // Anu dawdled past the hold
  const b = await join(match.id, U.ben); assert.equal(b.status, 200, 'an expired hold no longer blocks others');
  assert.equal((await pay(b, U.ben, 'pay_ben001')).status, 200);
  const late = await pay(a, U.anu, 'pay_anu001'); assert.equal(late.status, 409); assert.equal(late.body.refunded, true);
  const [[row]] = await q('SELECT payment_status, status FROM match_players WHERE id = ?', [a.body.match_player_id]); assert.equal(row.payment_status, 'failed'); assert.equal(row.status, 'rejected');
  const [[m]] = await q('SELECT filled_slots FROM player_requests WHERE id = ?', [match.id]); assert.equal(m.filled_slots, 2, 'never over capacity');
  const [rf] = await q('SELECT * FROM refunds WHERE payment_id = ?', ['pay_anu001']); assert.equal(rf.length, 1); assert.equal(Number(rf[0].refund_amount_minor), 100000 / 2); assert.equal(rf[0].user_id, U.anu);
});
test('the same payment cannot be credited to two join records', async () => {
  const { match } = await hostMatch(); const a = await join(match.id, U.anu); const b = await join(match.id, U.ben);
  assert.equal((await pay(a, U.anu, 'pay_once01')).status, 200);
  rp.payments.pay_once01 = { id: 'pay_once01', order_id: b.body.order_id, status: 'captured', amount: 20000, currency: 'INR' };
  const r = await request(app).post('/api/match-requests/join/verify').set(tok(U.ben)).send({ match_player_id: b.body.match_player_id, razorpay_order_id: b.body.order_id, razorpay_payment_id: 'pay_once01', razorpay_signature: sign(b.body.order_id, 'pay_once01') });
  assert.equal(r.status, 409); assert.equal((await q('SELECT payment_status FROM match_players WHERE id = ?', [b.body.match_player_id]))[0][0].payment_status, 'pending');
  const wrongOrder = await request(app).post('/api/match-requests/join/verify').set(tok(U.ben)).send({ match_player_id: b.body.match_player_id, razorpay_order_id: a.body.order_id, razorpay_payment_id: 'pay_x2', razorpay_signature: sign(a.body.order_id, 'pay_x2') });
  assert.equal(wrongOrder.status, 400, "someone else's order cannot be attached to my join record");
  rp.payments.pay_once01.order_id = a.body.order_id;
  const stranger = await request(app).post('/api/match-requests/join/verify').set(tok(U.cara)).send({ match_player_id: a.body.match_player_id, razorpay_order_id: a.body.order_id, razorpay_payment_id: 'pay_once01', razorpay_signature: sign(a.body.order_id, 'pay_once01') });
  assert.equal(stranger.status, 403);
});
test('a second, different payment on an already-paid join is refunded, not kept', async () => {
  const { match } = await hostMatch(); const a = await join(match.id, U.anu); await pay(a, U.anu, 'pay_first01');
  const dup = await pay(a, U.anu, 'pay_dupe001'); assert.equal(dup.status, 200); assert.equal(dup.body.alreadyPaid, true);
  assert.equal((await q('SELECT * FROM refunds WHERE payment_id = ?', ['pay_dupe001']))[0].length, 1);
  assert.equal((await q('SELECT filled_slots FROM player_requests WHERE id = ?', [match.id]))[0][0].filled_slots, 2);
});

// -------------------------------------------------------------------------------------------- 8. closed invitations
test('cancelled / started / ended / full invitations cannot be joined and explain why', async () => {
  const { match } = await hostMatch();
  await q("UPDATE player_requests SET status = 'cancelled' WHERE id = ?", [match.id]);
  let inv = await request(app).get(`/api/match-requests/public/${match.share_token}`); assert.equal(inv.body.invite.state, 'cancelled'); assert.equal(inv.body.invite.can_join, false); assert.match(inv.body.invite.message, /cancel/i);
  let j = await join(match.id, U.anu); assert.equal(j.status, 400); assert.equal(j.body.code, 'cancelled');
  await q("UPDATE player_requests SET status = 'open', match_date = '2000-01-01' WHERE id = ?", [match.id]);
  inv = await request(app).get(`/api/match-requests/public/${match.share_token}`); assert.equal(inv.body.invite.state, 'completed');
  j = await join(match.id, U.anu); assert.equal(j.status, 400); assert.equal(j.body.code, 'completed');
  const today = new Date().toISOString().slice(0, 10);
  await q("UPDATE player_requests SET match_date = ?, match_time = '00:00:00', booking_time_slot = '12:00 AM - 11:59 PM' WHERE id = ?", [today, match.id]);
  inv = await request(app).get(`/api/match-requests/public/${match.share_token}`); assert.equal(inv.body.invite.state, 'expired');
  j = await join(match.id, U.anu); assert.equal(j.status, 400); assert.equal(j.body.code, 'expired');
});
test('a payment that lands after the host cancelled is refunded, never credited', async () => {
  const { match } = await hostMatch(); const a = await join(match.id, U.anu);
  await q("UPDATE player_requests SET status = 'cancelled' WHERE id = ?", [match.id]);
  const r = await pay(a, U.anu, 'pay_after01'); assert.equal(r.status, 409); assert.equal(r.body.refunded, true);
  assert.equal((await q('SELECT payment_status FROM match_players WHERE id = ?', [a.body.match_player_id]))[0][0].payment_status, 'failed');
  assert.equal((await q('SELECT * FROM refunds WHERE payment_id = ?', ['pay_after01']))[0].length, 1);
});

// ----------------------------------------------------------------------------------------------------- 9. webhook
const webhook = (event) => { const body = JSON.stringify(event); return request(app).post('/api/bookings/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex')).send(body); };
const capturedEvent = (order, minor, id) => ({ event: 'payment.captured', payload: { payment: { entity: { id, order_id: order, amount: minor, currency: 'INR', status: 'captured' } } } });
test('webhook confirms a player whose app died after paying; verify afterwards is a no-op', async () => {
  const { match } = await hostMatch(); const a = await join(match.id, U.anu);
  assert.equal((await webhook(capturedEvent(a.body.order_id, 20000, 'pay_wh0001'))).status, 200);
  assert.equal((await q('SELECT payment_status FROM match_players WHERE id = ?', [a.body.match_player_id]))[0][0].payment_status, 'paid');
  assert.equal((await q('SELECT filled_slots FROM player_requests WHERE id = ?', [match.id]))[0][0].filled_slots, 2);
  await webhook(capturedEvent(a.body.order_id, 20000, 'pay_wh0001'));            // redelivered
  const v = await pay(a, U.anu, 'pay_wh0001'); assert.equal(v.body.alreadyPaid, true);
  assert.equal((await q('SELECT filled_slots FROM player_requests WHERE id = ?', [match.id]))[0][0].filled_slots, 2, 'credited exactly once');
});
test('webhook with a bad signature changes nothing', async () => {
  const { match } = await hostMatch(); const a = await join(match.id, U.anu);
  const body = JSON.stringify(capturedEvent(a.body.order_id, 20000, 'pay_forge1'));
  const r = await request(app).post('/api/bookings/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', 'nope').send(body);
  assert.equal(r.status, 400); assert.equal((await q('SELECT payment_status FROM match_players WHERE id = ?', [a.body.match_player_id]))[0][0].payment_status, 'pending');
});

// ------------------------------------------------------------------------------------------------ 10. hosted checkout
test('hosted payment page (Expo Go): verifies without a login using the same checks; closing it releases the held spot', async () => {
  const { match } = await hostMatch(); const a = await join(match.id, U.anu); const b = await join(match.id, U.ben);
  const hv = (o, payId, sig) => request(app).post('/api/match-requests/join/hosted/verify').send({ booking_id: o.body.match_player_id, razorpay_order_id: o.body.order_id, razorpay_payment_id: payId, razorpay_signature: sig ?? sign(o.body.order_id, payId) });
  rp.payments.pay_host_a = { id: 'pay_host_a', order_id: a.body.order_id, status: 'captured', amount: 20000, currency: 'INR' };
  assert.equal((await hv(a, 'pay_host_a', 'forged')).status, 400);
  assert.equal((await q('SELECT payment_status FROM match_players WHERE id = ?', [a.body.match_player_id]))[0][0].payment_status, 'pending');
  const ok = await hv(a, 'pay_host_a'); assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.success, true);
  assert.equal((await q('SELECT filled_slots FROM player_requests WHERE id = ?', [match.id]))[0][0].filled_slots, 2);
  assert.equal((await hv(a, 'pay_host_a')).body.alreadyPaid, true);
  // the order id in the payment must be the join record's own order
  rp.payments.pay_host_x = { id: 'pay_host_x', order_id: a.body.order_id, status: 'captured', amount: 20000, currency: 'INR' };
  const cross = await request(app).post('/api/match-requests/join/hosted/verify').send({ booking_id: b.body.match_player_id, razorpay_order_id: a.body.order_id, razorpay_payment_id: 'pay_host_x', razorpay_signature: sign(a.body.order_id, 'pay_host_x') });
  assert.equal(cross.status, 400);
  // cancel: hold released immediately, a paid row is untouched
  const before = await request(app).get(`/api/match-requests/public/${match.share_token}`); assert.equal(before.body.invite.reserved_spots, 1);
  await request(app).post('/api/match-requests/join/hosted/cancel').send({ booking_id: b.body.match_player_id });
  await request(app).post('/api/match-requests/join/hosted/cancel').send({ booking_id: a.body.match_player_id });
  const after = await request(app).get(`/api/match-requests/public/${match.share_token}`); assert.equal(after.body.invite.reserved_spots, 0); assert.equal(after.body.invite.remaining_spots, 3);
  assert.equal((await q('SELECT payment_status FROM match_players WHERE id = ?', [a.body.match_player_id]))[0][0].payment_status, 'paid');
});
