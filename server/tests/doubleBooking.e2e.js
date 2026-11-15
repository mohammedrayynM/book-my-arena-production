// Double-booking / concurrency e2e suite. Needs the API on localhost:9000 against a TEST database (never production) and a
// test Razorpay key (orders are created; "payments" are simulated with a self-computed signature, as in the other e2e suites).
//   node tests/doubleBooking.e2e.js   (start the test server with: node -r ./tests/helpers/fakeRazorpay.js server.js)
// Creates its own owner, venue, court, customers (all prefixed "ZZ DBL") and removes its bookings at the end.
const crypto = require('crypto');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const BASE = process.env.TEST_API_BASE || 'http://localhost:9000/api';
const SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';
let pass = 0; let fail = 0;
const check = (name, cond, extra) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${cond ? '' : ` :: ${JSON.stringify(extra)}`}`); };
const call = async (method, path, token, body, headers = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let data = null; try { data = await r.json(); } catch (e) { /* not json */ }
  return { status: r.status, data };
};
const sign = (o, p) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${o}|${p}`).digest('hex');
const ymd = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  const s = Date.now();
  const made = { users: [], turf: null, owner: null, activity: null };
  try {
    // ------------------------------------------------------------------ fixtures
    const [o] = await pool.query("INSERT INTO owners (name,email,phone,password_hash) VALUES ('ZZ DBL Owner', ?, '9000000000', 'x')", [`zz_dbl_${s}@example.com`]);
    made.owner = o.insertId;
    const [t] = await pool.query("INSERT INTO turfs (name,location,sport_type,price_per_hour,owner_id,is_active,status,approval_status,open_time,close_time) VALUES (?, 'Chennai', 'Football', 500, ?, 1, 'ACTIVE', 'APPROVED', '06:00', '23:00')", [`ZZ DBL Turf ${s}`, o.insertId]);
    const TURF = t.insertId; made.turf = TURF;
    const [c] = await pool.query("INSERT INTO courts (turf_id,name,sport_type,price_per_hour,is_active,approval_status) VALUES (?, 'Court 1', 'Football', 500, 1, 'APPROVED')", [TURF]);
    const COURT = c.insertId;
    const U = [];
    for (let i = 0; i < 12; i++) {
      const [u] = await pool.query('INSERT INTO users (name,email,phone) VALUES (?,?,?)', [`ZZ DBL C${i}`, `zz_dbl_c${i}_${s}@example.com`, '9999999999']);
      made.users.push(u.insertId); U.push(jwt.sign({ id: u.insertId }, SECRET, { expiresIn: '1h' }));
    }
    const OWNER = jwt.sign({ id: o.insertId, role: 'owner' }, SECRET, { expiresIn: '1h' });
    const book = (tok, slot, date, extra = {}) => call('POST', '/bookings', tok, { turf_id: TURF, customer_name: 'ZZ DBL', customer_phone: '9999999999', customer_email: 'zz_dbl@example.com', booking_date: date, time_slots: [slot], ...extra });
    // the test Razorpay (tests use a fake gateway) reports a captured payment for the order; RZP_PAYMENTS_FILE is how the
    // local fake learns about it. Against a real test key, capture the payment in the Razorpay dashboard instead.
    const capture = (b, payId) => {
      const f = process.env.RZP_PAYMENTS_FILE || '/tmp/rzp_payments.json';
      let m = {}; try { m = JSON.parse(require('fs').readFileSync(f, 'utf8')); } catch (e) { /* new file */ }
      m[b.order_id] = [{ id: payId, status: 'captured', amount: Math.round(Number(b.amount) * 100), currency: b.currency || 'INR' }];
      require('fs').writeFileSync(f, JSON.stringify(m));
    };
    const pay = (tok, b, payId = `pay_zzdbl_${crypto.randomBytes(5).toString('hex')}`) => { capture(b, payId); return call('POST', '/bookings/verify', tok, { booking_id: b.booking_id, razorpay_order_id: b.order_id, razorpay_payment_id: payId, razorpay_signature: sign(b.order_id, payId) }); };
    const expire = (b) => pool.query("UPDATE bookings SET created_at = NOW() - INTERVAL 20 MINUTE WHERE id IN (?)", [String(b.booking_id).split(',').map(Number)]);
    const confirmedCount = async (date, labels) => (await pool.query(
      "SELECT COUNT(*) AS n FROM bookings WHERE turf_id = ? AND booking_date = ? AND time_slot IN (?) AND payment_status = 'success' AND status != 'cancelled'", [TURF, date, labels]))[0][0].n;

    // ------------------------------------------------------------------ 1. simultaneous booking (10 customers, same slot)
    console.log('\n--- 1. simultaneous booking ---');
    const D1 = ymd(3); const S1 = '10:00 AM - 11:00 AM';
    const r1 = await Promise.all(U.slice(0, 10).map((tok) => book(tok, S1, D1)));
    const ok1 = r1.filter((r) => r.status === 200 && r.data && r.data.booking_id);
    check('10 simultaneous requests for one slot -> exactly ONE hold is created', ok1.length === 1, r1.map((r) => r.status));
    check('every other customer gets 409 with a clear "already booked" message', r1.filter((r) => r.status === 409).length === 9 && r1.filter((r) => r.status === 409).every((r) => /already booked|not available|unavailable/i.test(r.data.error || '')), r1.filter((r) => r.status !== 200).map((r) => r.data && r.data.error));

    // ------------------------------------------------------------------ 2. court vs whole-venue at the same time
    console.log('\n--- 2. court booking vs whole-venue booking, simultaneous ---');
    const S2 = '12:00 PM - 1:00 PM';
    const r2 = await Promise.all(U.slice(0, 6).map((tok, i) => book(tok, S2, D1, i % 2 ? { court_id: COURT } : {})));
    check('whole-venue and court requests for the same hour -> exactly one wins', r2.filter((r) => r.status === 200).length === 1, r2.map((r) => r.status));

    // ------------------------------------------------------------------ 3. payment concurrency after a hold expired
    console.log('\n--- 3. two payments for one slot (first hold expired) ---');
    const S3 = '2:00 PM - 3:00 PM';
    const a3 = (await book(U[0], S3, D1)).data; await expire(a3);
    const b3r = await book(U[1], S3, D1);
    check('after the first hold expires, a second customer can hold the slot', b3r.status === 200, b3r);
    const b3 = b3r.data;
    const [p3a, p3b] = await Promise.all([pay(U[0], a3), pay(U[1], b3)]);
    check('both pay at the same moment -> exactly one confirmed booking for the slot', Number(await confirmedCount(D1, [S3])) === 1, { a: p3a.status, b: p3b.status });
    const loser3 = [p3a, p3b].find((r) => r.status !== 200);
    check('the other payment is answered 409 SLOT_CONFLICT_REFUNDED (auto-refund), not confirmed', loser3 && loser3.status === 409 && loser3.data.code === 'SLOT_CONFLICT_REFUNDED', [p3a, p3b].map((r) => [r.status, r.data && r.data.code]));

    // ------------------------------------------------------------------ 4. late payment vs a COURT booking (expired whole-venue hold)
    console.log('\n--- 4. late payment for a whole-venue hold after a court booking was paid ---');
    const S4 = '4:00 PM - 5:00 PM';
    const a4 = (await book(U[2], S4, D1)).data; await expire(a4);
    const b4 = (await book(U[3], S4, D1, { court_id: COURT })).data;
    const p4b = await pay(U[3], b4);
    const p4a = await pay(U[2], a4);
    const [[n4]] = await pool.query("SELECT COUNT(*) AS n FROM bookings WHERE turf_id = ? AND booking_date = ? AND time_slot = ? AND payment_status = 'success' AND status != 'cancelled'", [TURF, D1, S4]);
    check('court booking paid first is confirmed', p4b.status === 200, p4b);
    check('the late whole-venue payment is refused + refunded (no second booking on the same hour)', p4a.status === 409 && Number(n4.n) === 1, { status: p4a.status, data: p4a.data, confirmed: n4.n });

    // ------------------------------------------------------------------ 5. late payment vs an overlapping slot with a different label
    console.log('\n--- 5. late payment vs an overlapping slot written differently ---');
    const S5 = '6:00 PM - 7:00 PM';
    const a5 = (await book(U[4], S5, D1)).data; await expire(a5);
    // another booking confirmed meanwhile for 6:30-7:00 (e.g. after the venue switched to 30-minute slots)
    await pool.query("INSERT INTO bookings (turf_id, customer_name, customer_phone, booking_date, time_slot, amount, status, payment_status, user_id) VALUES (?, 'ZZ DBL other', '9', ?, '6:30 PM - 7:00 PM', 250, 'confirmed', 'success', ?)", [TURF, D1, made.users[5]]);
    const p5 = await pay(U[4], a5);
    check('a late payment for 6-7 PM is refused when 6:30-7 PM is already confirmed', p5.status === 409, { status: p5.status, data: p5.data });

    // ------------------------------------------------------------------ 6. owner blocking vs customer booking, simultaneous
    console.log('\n--- 6. owner block vs customer booking ---');
    const S6 = '8:00 PM - 9:00 PM';
    let both = 0; let one = 0;
    for (let i = 0; i < 5; i++) {
      const date = ymd(10 + i);
      const [bk, bl] = await Promise.all([book(U[6], S6, date), call('POST', `/owners/turfs/${TURF}/block-slot`, OWNER, { block_date: date, time_slot: S6, reason: 'test' })]);
      if (bk.status === 200 && bl.status === 200) both++;
      if ((bk.status === 200) !== (bl.status === 200)) one++;
    }
    check('5 rounds of block + book at the same instant: never both succeed, always exactly one', both === 0 && one === 5, { both, one });

    // ------------------------------------------------------------------ 7. subscription reservations
    console.log('\n--- 7. subscription-reserved slot ---');
    const D7 = ymd(20); const S7 = '7:00 AM - 8:00 AM';
    const [rs] = await pool.query("INSERT INTO subscription_reservations (subscription_id, turf_id, court_key, reservation_date, start_time, end_time, status, active_key) VALUES (999999, ?, 0, ?, '07:00:00', '08:00:00', 'active', 1)", [TURF, D7]);
    const b7 = await book(U[7], S7, D7);
    check('a slot held by an active subscription cannot be booked by another customer', b7.status === 409 && /subscription/i.test(b7.data.error || ''), b7);
    await pool.query("UPDATE subscription_reservations SET status = 'released', active_key = NULL WHERE id = ?", [rs.insertId]);
    const b7b = await book(U[7], S7, D7);
    check('once the subscription releases it (cancelled/expired), the slot is bookable again', b7b.status === 200, b7b);

    // ------------------------------------------------------------------ 8. webhook idempotency
    console.log('\n--- 8. webhook + verify for the same payment ---');
    const S8 = '9:00 AM - 10:00 AM';
    const a8 = (await book(U[8], S8, D1)).data;
    const PAY8 = `pay_zzdbl_${crypto.randomBytes(5).toString('hex')}`;
    const amt8 = (await pool.query('SELECT SUM(COALESCE(advance_amount, amount)) AS a, MAX(currency_code) AS c FROM bookings WHERE id IN (?)', [String(a8.booking_id).split(',').map(Number)]))[0][0];
    capture(a8, PAY8);
    const evt = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: PAY8, order_id: a8.order_id, amount: Math.round(Number(amt8.a) * 100), currency: amt8.c || 'INR', status: 'captured' } } } });
    const whSig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || '').update(evt).digest('hex');
    const [w1, w2, v8] = await Promise.all([
      call('POST', '/bookings/webhook', null, evt, { 'x-razorpay-signature': whSig }),
      call('POST', '/bookings/webhook', null, evt, { 'x-razorpay-signature': whSig }),
      pay(U[8], a8, PAY8),
    ]);
    const [[n8]] = await pool.query("SELECT COUNT(*) AS n, MAX(payment_id) AS p FROM bookings WHERE turf_id = ? AND booking_date = ? AND time_slot = ? AND payment_status = 'success' AND status != 'cancelled'", [TURF, D1, S8]);
    check('two webhook deliveries + the app verify for one payment -> one confirmed booking, same payment id', Number(n8.n) === 1 && n8.p === PAY8, { w1: w1.status, w2: w2.status, v: v8.status, n: n8.n });
  } catch (e) {
    fail++; console.error(e);
  } finally {
    try {
      if (made.turf) {
        await pool.query('DELETE FROM subscription_reservations WHERE turf_id = ?', [made.turf]);
        await pool.query('DELETE FROM blocked_slots WHERE turf_id = ?', [made.turf]);
        await pool.query('DELETE FROM bookings WHERE turf_id = ?', [made.turf]);
        await pool.query('DELETE FROM courts WHERE turf_id = ?', [made.turf]);
        await pool.query('DELETE FROM turfs WHERE id = ?', [made.turf]);
      }
      if (made.users.length) await pool.query('DELETE FROM users WHERE id IN (?)', [made.users]);
      if (made.owner) await pool.query('DELETE FROM owners WHERE id = ?', [made.owner]);
    } catch (e) { console.warn('cleanup:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end(); process.exit(fail ? 1 : 0);
  }
})();
