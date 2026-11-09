// Request C backend tests: overlap-safe availability, venue lock + concurrent booking/blocking, 24-hour slot route,
// 8-hour/10% cancellation arithmetic, automatic refund when a paid slot was lost. Needs a THROWAWAY *_test database.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const db = require('./helpers/testDb');

let availability; let lock; let cancellation; let conflictRefund;
test.before(async () => {
  await db.setup();
  const q = (s) => db.pool.query(s).catch(() => {});
  for (const c of ['is_deleted TINYINT DEFAULT 0', 'open_time VARCHAR(8) NULL', 'close_time VARCHAR(8) NULL', 'slot_duration INT DEFAULT 60', "time_format VARCHAR(4) DEFAULT '12h'",
    'advance_percent INT DEFAULT 100', 'price_per_hour DECIMAL(10,2) DEFAULT 1000', 'markup_type VARCHAR(10) NULL', 'markup_value DECIMAL(10,2) DEFAULT 0', 'slug VARCHAR(100) NULL',
    'early_morning_price DECIMAL(10,2) NULL', 'morning_price DECIMAL(10,2) NULL', 'afternoon_price DECIMAL(10,2) NULL', 'evening_price DECIMAL(10,2) NULL', 'default_price DECIMAL(10,2) NULL',
    "timezone VARCHAR(60) DEFAULT 'Asia/Kolkata'", 'is_24_hours TINYINT(1) NOT NULL DEFAULT 0']) await q(`ALTER TABLE turfs ADD COLUMN ${c}`);
  await q('ALTER TABLE blocked_slots ADD COLUMN reason VARCHAR(100) NULL');
  await q('ALTER TABLE bookings ADD COLUMN user_id INT NULL');
  await q('ALTER TABLE bookings ADD COLUMN payment_type VARCHAR(20) NULL');
  await q('CREATE TABLE IF NOT EXISTS blocked_slots (id INT AUTO_INCREMENT PRIMARY KEY, turf_id INT, court_id INT NULL, block_date DATE, time_slot VARCHAR(40), reason VARCHAR(100) NULL)');
  await q('CREATE TABLE IF NOT EXISTS special_pricing (id INT AUTO_INCREMENT PRIMARY KEY, turf_id INT, court_id INT NULL, time_slot VARCHAR(40), special_price DECIMAL(10,2), offer_percentage INT NULL, offer_label VARCHAR(50) NULL, specific_date DATE NULL, day_of_week INT NULL, is_active BOOLEAN DEFAULT TRUE)');
  await q('CREATE TABLE IF NOT EXISTS day_wise_pricing (id INT AUTO_INCREMENT PRIMARY KEY, turf_id INT, court_id INT NULL, day_of_week VARCHAR(12), early_morning_price DECIMAL(10,2) NULL, morning_price DECIMAL(10,2) NULL, afternoon_price DECIMAL(10,2) NULL, evening_price DECIMAL(10,2) NULL)');
  await q('CREATE TABLE IF NOT EXISTS settings (id INT AUTO_INCREMENT PRIMARY KEY, setting_key VARCHAR(60), setting_value VARCHAR(100))');
  await q('CREATE TABLE IF NOT EXISTS courts (id INT AUTO_INCREMENT PRIMARY KEY, turf_id INT, price_per_hour DECIMAL(10,2), open_time VARCHAR(8), close_time VARCHAR(8), slot_duration INT, time_format VARCHAR(4), advance_percent INT, markup_type VARCHAR(10), markup_value DECIMAL(10,2), early_morning_price DECIMAL(10,2), morning_price DECIMAL(10,2), afternoon_price DECIMAL(10,2), evening_price DECIMAL(10,2), default_price DECIMAL(10,2), is_24_hours TINYINT(1) DEFAULT 0)');
  await q('DROP TABLE IF EXISTS refunds');
  await db.pool.query(`CREATE TABLE refunds (id INT AUTO_INCREMENT PRIMARY KEY, refund_code VARCHAR(40), booking_type VARCHAR(20), booking_id INT, payment_id VARCHAR(64), user_id INT NULL, owner_id INT NULL, venue_id INT NULL,
    venue_name VARCHAR(100) NULL, country_code VARCHAR(2) NULL, business_type VARCHAR(20) NULL, original_amount_minor BIGINT, amount_paid_minor BIGINT, cancellation_fee_minor BIGINT, refund_amount_minor BIGINT,
    currency_code VARCHAR(3), refund_reason VARCHAR(255) NULL, cancelled_by VARCHAR(10), cancellation_type VARCHAR(40), refund_status VARCHAR(30), gateway_payment_id VARCHAR(64) NULL, gateway_refund_id VARCHAR(64) NULL,
    idempotency_key VARCHAR(150) UNIQUE, policy_version INT NULL, policy_window_hours INT NULL, policy_fee_percent DECIMAL(5,2) NULL, attempts INT DEFAULT 0, failure_reason VARCHAR(255) NULL,
    processed_at DATETIME NULL, completed_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  availability = require('../services/availabilityService'); lock = require('../services/slotLock');
  cancellation = require('../services/cancellation'); conflictRefund = require('../services/conflictRefund');
});
test.beforeEach(async () => { await db.reset(); for (const t of ['blocked_slots', 'special_pricing', 'day_wise_pricing', 'courts', 'refunds']) await db.pool.query(`DELETE FROM ${t}`); });
test.after(async () => { await db.pool.end(); });

const book = (turf, slot, { date = '2099-01-01', status = 'confirmed', pay = 'success', court = null } = {}) => db.pool.query(
  'INSERT INTO bookings (turf_id, amount, original_price, razorpay_order_id, payment_status, status, customer_name, booking_date, time_slot, court_id) VALUES (?, 1000, 1000, ?, ?, ?, ?, ?, ?, ?)',
  [turf, `o_${Math.random()}`, pay, status, 'Cust', date, slot, court]).then(([r]) => r.insertId);

test('availability: 12h vs 24h labels and 30 vs 60 minute slots clash; neighbours do not', async () => {
  const t = await db.seedTurf(); await book(t, '6:00 PM - 7:00 PM');
  const chk = (slot) => availability.checkSingleSlotAvailability({ turfId: t, date: '2099-01-01', timeSlot: slot });
  assert.equal((await chk('18:00 - 19:00')).reason, 'BOOKED');
  assert.equal((await chk('6:30 PM - 7:00 PM')).reason, 'BOOKED');
  assert.equal((await chk('5:00 PM - 6:00 PM')).available, true);
  assert.equal((await chk('7:00 PM - 8:00 PM')).available, true);
  await db.pool.query("INSERT INTO blocked_slots (turf_id, block_date, time_slot) VALUES (?, '2099-01-01', '9:00 PM - 10:00 PM')", [t]);
  assert.equal((await chk('21:00 - 22:00')).reason, 'BLOCKED');
  assert.equal((await chk('11:30 PM - 12:30 AM')).available, true);
});
test('availability: a booking crossing midnight clashes with the after-midnight slot; cancelled/expired holds do not', async () => {
  const t = await db.seedTurf(); await book(t, '11:30 PM - 12:30 AM'); await book(t, '3:00 PM - 4:00 PM', { status: 'cancelled' });
  const chk = (slot) => availability.checkSingleSlotAvailability({ turfId: t, date: '2099-01-01', timeSlot: slot });
  assert.equal((await chk('12:00 AM - 1:00 AM')).reason, 'BOOKED');
  assert.equal((await chk('3:00 PM - 4:00 PM')).available, true);
  await db.pool.query("INSERT INTO bookings (turf_id, amount, payment_status, status, customer_name, booking_date, time_slot, created_at) VALUES (?, 10, 'pending', 'pending', 'x', '2099-01-01', '1:00 PM - 2:00 PM', NOW() - INTERVAL 10 MINUTE)", [t]);
  assert.equal((await chk('1:00 PM - 2:00 PM')).available, true, 'a hold older than 4 minutes is released');
});

test('CONCURRENCY: 12 simultaneous bookings of one slot -> exactly one wins, the rest get a clean conflict', async () => {
  const t = await db.seedTurf();
  const attempt = async (i) => {
    if (!(await lock.acquireSlotLock(t, null, '2099-01-01', 20))) return 'busy';
    try {
      const r = await availability.checkSingleSlotAvailability({ turfId: t, date: '2099-01-01', timeSlot: '8:00 PM - 9:00 PM' });
      if (!r.available) return 'conflict';
      await new Promise((ok) => setTimeout(ok, 15));             // widen the race window
      await book(t, '8:00 PM - 9:00 PM'); return 'won';
    } finally { await lock.releaseSlotLock(t); }
  };
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => attempt(i)));
  assert.equal(results.filter((r) => r === 'won').length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r === 'conflict').length, 11);
  const [[n]] = await db.pool.query("SELECT COUNT(*) n FROM bookings WHERE turf_id = ? AND time_slot = '8:00 PM - 9:00 PM'", [t]); assert.equal(n.n, 1);
});
test('CONCURRENCY: owner block vs customer booking of the same slot -> never both', async () => {
  const t = await db.seedTurf();
  const slot = '7:00 PM - 8:00 PM';
  const withLock = async (fn) => { if (!(await lock.acquireSlotLock(t, null, '2099-01-01', 20))) return 'busy'; try { return await fn(); } finally { await lock.releaseSlotLock(t); } };
  const customer = () => withLock(async () => { const r = await availability.checkSingleSlotAvailability({ turfId: t, date: '2099-01-01', timeSlot: slot }); if (!r.available) return 'conflict'; await book(t, slot); return 'booked'; });
  const owner = () => withLock(async () => { const r = await availability.checkSingleSlotAvailability({ turfId: t, date: '2099-01-01', timeSlot: slot }); if (!r.available) return 'conflict'; await db.pool.query("INSERT INTO blocked_slots (turf_id, block_date, time_slot) VALUES (?, '2099-01-01', ?)", [t, slot]); return 'blocked'; });
  for (let round = 0; round < 5; round++) {
    await db.pool.query('DELETE FROM bookings'); await db.pool.query('DELETE FROM blocked_slots');
    const res = await Promise.all([customer(), owner(), customer(), owner()]);
    assert.equal(res.filter((r) => r === 'booked' || r === 'blocked').length, 1, JSON.stringify(res));
  }
});
test('lock is released on the SAME connection: a second request can take it straight after', async () => {
  const t = await db.seedTurf();
  assert.equal(await lock.acquireSlotLock(t, 5, 'd', 2), true); await lock.releaseSlotLock(t);
  const start = Date.now(); assert.equal(await lock.acquireSlotLock(t, 9, 'd', 2), true); await lock.releaseSlotLock(t);
  assert.ok(Date.now() - start < 1500, 'no 5-second stall from a leaked lock');
});

test('slots route: 24-hour venue returns 24 slots with ranges; limited hours stay limited; past slots use the venue timezone', async () => {
  const router = require('../routes/turfs'); const app = express(); app.use('/api/turfs', router);
  const t24 = await db.seedTurf({ name: 'Night Turf', open_time: '09:00', close_time: '17:00', is_24_hours: 1, slug: 'night' });
  const res = await request(app).get(`/api/turfs/${t24}/slots?date=2099-01-01`); assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.slots.length, 24); assert.equal(res.body.is24Hours, true);
  assert.equal(res.body.slots[0].time, '12:00 AM - 1:00 AM'); assert.equal(res.body.slots[23].time, '11:00 PM - 12:00 AM'); assert.equal(res.body.slots[23].endMin, 1440);
  const tl = await db.seedTurf({ name: 'Day Turf', open_time: '06:00', close_time: '22:00', slug: 'day' });
  const r2 = await request(app).get(`/api/turfs/${tl}/slots?date=2099-01-01`); assert.equal(r2.body.slots.length, 16); assert.equal(r2.body.is24Hours, false);
  await book(t24, '12:00 AM - 1:00 AM');
  const r3 = await request(app).get(`/api/turfs/${t24}/slots?date=2099-01-01`);
  assert.equal(r3.body.slots[0].status, 'booked'); assert.equal(r3.body.slots[1].status, 'available');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Kiritimati' });
  await db.pool.query("UPDATE turfs SET timezone = 'Pacific/Kiritimati' WHERE id = ?", [t24]);
  const r4 = await request(app).get(`/api/turfs/${t24}/slots?date=${today}`);
  assert.ok(r4.body.slots.length < 24 && r4.body.slots.length >= 0, 'slots that already started in the venue timezone are hidden');
});

const ctxFor = (startInHours, over = {}) => ({
  type: 'turf', bookingId: 1, status: 'confirmed', currency: 'INR', totalMinor: 100000, paidMinor: 100000, startEpoch: Date.now() + startInHours * 3600000, redeemedQty: 0, participants: [],
  policy: { version: 9, windowHours: 8, feePercent: 10, customerRefundEnabled: true, cancellationEnabled: true, ownerRefundPercent: 100 }, ...over,
});
test('cancellation: INR 1000 booked >8h ahead -> refund 900, retain 100', () => {
  const d = cancellation.evaluate(ctxFor(24), { actor: 'customer', now: Date.now() });
  assert.equal(d.canCancel, true); assert.equal(d.refundAmountMinor, 90000); assert.equal(d.cancellationFeeMinor, 10000);
});
test('cancellation: exactly 8 hours is inclusive; one minute inside is blocked and explains why', () => {
  const now = 1_800_000_000_000;
  const exact = cancellation.evaluate({ ...ctxFor(0), startEpoch: now + 8 * 3600000 }, { actor: 'customer', now });
  assert.equal(exact.canCancel, true); assert.equal(exact.refundAmountMinor, 90000);
  const inside = cancellation.evaluate({ ...ctxFor(0), startEpoch: now + 8 * 3600000 - 60000 }, { actor: 'customer', now });
  assert.equal(inside.canCancel, false); assert.equal(inside.code, 'TOO_LATE'); assert.match(inside.message, /8 hours/);
  const forced = cancellation.evaluate({ ...ctxFor(0), startEpoch: now + 3600000 }, { actor: 'customer', now, acceptNoRefund: true });
  assert.equal(forced.canCancel, false, 'confirming "no refund" no longer lets a customer cancel inside the window');
  const started = cancellation.evaluate({ ...ctxFor(0), startEpoch: now - 1000 }, { actor: 'customer', now });
  assert.equal(started.canCancel, false);
});
test('cancellation: advance payment never refunds more than was paid; owner/admin exception paths unchanged', () => {
  const adv = cancellation.evaluate(ctxFor(24, { paidMinor: 5000 }), { actor: 'customer' });
  assert.equal(adv.refundAmountMinor, 0, 'paid 50 of a 1000 total: 10% fee (100) exceeds the 50 paid, so the refund is 0, never negative'); assert.ok(adv.refundAmountMinor <= 5000);
  const adv2 = cancellation.evaluate(ctxFor(24, { paidMinor: 50000 }), { actor: 'customer' });
  assert.equal(adv2.refundAmountMinor, 40000); assert.equal(adv2.cancellationFeeMinor, 10000);
  const owner = cancellation.evaluate(ctxFor(1), { actor: 'owner' }); assert.equal(owner.canCancel, true); assert.equal(owner.refundAmountMinor, 100000);
  const admin = cancellation.evaluate(ctxFor(1), { actor: 'admin' }); assert.equal(admin.canCancel, true);
  const view = cancellation.toView(cancellation.evaluate(ctxFor(24), { actor: 'customer' }), { venueName: 'V', countryCode: 'IN', tz: 'Asia/Kolkata', participants: [], startEpoch: ctxFor(24).startEpoch });
  assert.equal(view.refund_percent, 90); assert.ok(view.cancel_cutoff_at && view.policy_text.includes('8 hours'));
});

test('paid-but-conflicted payment is refunded in full exactly once (idempotent)', async () => {
  const t = await db.seedTurf(); const id = await book(t, '6:00 PM - 7:00 PM', { status: 'cancelled', pay: 'failed' });
  const a = await conflictRefund.refundConflictedPayment({ bookingIds: [id], paymentId: 'pay_conflict1' });
  assert.equal(a.attempted, true, JSON.stringify(a));
  const b = await conflictRefund.refundConflictedPayment({ bookingIds: [id], paymentId: 'pay_conflict1' });
  const [rows] = await db.pool.query('SELECT refund_amount_minor, refund_status, cancellation_fee_minor FROM refunds WHERE payment_id = ?', ['pay_conflict1']);
  assert.equal(rows.length, 1, 'one ledger row per booking+payment'); assert.equal(Number(rows[0].refund_amount_minor), 100000); assert.equal(Number(rows[0].cancellation_fee_minor), 0);
  assert.ok(['REFUND_COMPLETED', 'REFUND_INITIATED', 'REFUND_FAILED', 'REFUND_PENDING', 'REFUND_PROCESSING'].includes(rows[0].refund_status), rows[0].refund_status);
  assert.equal(b.refunds.length <= 1, true);
});

test('users: /me pagination is opt-in and stable; account deletion anonymises, refuses with upcoming bookings', async () => {
  const jwt = require('jsonwebtoken');
  await db.pool.query('CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), email VARCHAR(150), password_hash VARCHAR(100) NULL, google_id VARCHAR(100) NULL, profile_pic VARCHAR(200) NULL, push_token VARCHAR(200) NULL, phone VARCHAR(20) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  for (const c of ['phone VARCHAR(20) NULL', 'push_token VARCHAR(200) NULL', 'google_id VARCHAR(100) NULL', 'profile_pic VARCHAR(200) NULL', 'password_hash VARCHAR(100) NULL']) await db.pool.query(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  await db.pool.query('DELETE FROM users');
  const [u] = await db.pool.query("INSERT INTO users (name, email, password_hash, phone, push_token) VALUES ('Ann', 'ann@x.test', 'hash', '999', 'tok')");
  const token = jwt.sign({ id: u.insertId }, process.env.JWT_SECRET || 'your_jwt_secret_key');
  const app = express(); app.use(express.json()); app.use('/api/users', require('../routes/users'));
  const t = await db.seedTurf({ name: 'T' });
  for (let i = 0; i < 5; i++) await db.pool.query("INSERT INTO bookings (turf_id, user_id, amount, payment_status, status, customer_name, booking_date, time_slot) VALUES (?, ?, 10, 'success', 'confirmed', 'Ann', '2099-01-01', ?)", [t, u.insertId, `${i + 1}:00 PM - ${i + 2}:00 PM`]);
  const auth = { Authorization: `Bearer ${token}` };
  const all = await request(app).get('/api/users/me').set(auth); assert.equal(all.body.bookings.length, 5); assert.equal(all.body.pagination, undefined);
  const p1 = await request(app).get('/api/users/me?page=1&limit=2').set(auth); assert.equal(p1.body.bookings.length, 2); assert.equal(p1.body.pagination.has_more, true);
  const p3 = await request(app).get('/api/users/me?page=3&limit=2').set(auth); assert.equal(p3.body.bookings.length, 1); assert.equal(p3.body.pagination.has_more, false);
  const ids = [...p1.body.bookings, ...(await request(app).get('/api/users/me?page=2&limit=2').set(auth)).body.bookings, ...p3.body.bookings].map((b) => b.id);
  assert.equal(new Set(ids).size, 5, 'no duplicates or gaps across pages');
  assert.equal((await request(app).delete('/api/users/me').set(auth).send({})).status, 400);
  const blocked = await request(app).delete('/api/users/me').set(auth).send({ confirm: 'DELETE' }); assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'UPCOMING_BOOKINGS');
  await db.pool.query("UPDATE bookings SET status = 'cancelled' WHERE user_id = ?", [u.insertId]);
  const ok = await request(app).delete('/api/users/me').set(auth).send({ confirm: 'DELETE' }); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const [[row]] = await db.pool.query('SELECT * FROM users WHERE id = ?', [u.insertId]);
  assert.equal(row.name, 'Deleted user'); assert.ok(row.email.endsWith('@deleted.invalid')); assert.equal(row.password_hash, null); assert.equal(row.phone, null); assert.equal(row.push_token, null);
  const [[kept]] = await db.pool.query('SELECT COUNT(*) n FROM bookings WHERE user_id = ?', [u.insertId]); assert.equal(kept.n, 5, 'booking records are retained');
});
