// Amusement-park / activity ticket oversell test: 8 customers buy the last 3 tickets at the same moment.
// Needs the API on localhost:9000 against a TEST database + test/fake Razorpay (see doubleBooking.e2e.js).
//   node tests/activityOversell.e2e.js   (start the test server with: node -r ./tests/helpers/fakeRazorpay.js server.js)
const crypto = require('crypto'); const fs = require('fs');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const jwt = require('jsonwebtoken'); const pool = require('../config/db');
const BASE = process.env.TEST_API_BASE || 'http://localhost:9000/api';
let P = 0; let F = 0;
const check = (n, c, x) => { c ? P++ : F++; console.log(`${c ? 'PASS' : 'FAIL'} - ${n}${c ? '' : ` :: ${JSON.stringify(x)}`}`); };
const call = async (m, u, t, b) => { const r = await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch (e) { /* */ } return { status: r.status, data: d }; };
const sign = (o, p) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${o}|${p}`).digest('hex');
(async () => {
  const s = Date.now(); const today = new Date().toISOString().slice(0, 10); const made = { users: [], owner: null, act: null };
  try {
    const SECRET = process.env.JWT_SECRET;
    const [o] = await pool.query("INSERT INTO owners (name,email,phone,password_hash,business_types) VALUES ('ZZ OVS', ?, '9000000000', 'x', 'SPORTS,ACTIVITY')", [`zz_ovs_${s}@example.com`]).catch(() => pool.query("INSERT INTO owners (name,email,phone,password_hash) VALUES ('ZZ OVS', ?, '9000000000', 'x')", [`zz_ovs_${s}@example.com`]));
    made.owner = o.insertId; const OT = jwt.sign({ id: o.insertId, role: 'owner' }, SECRET);
    await call('PATCH', '/owners/business-types', OT, { business_types: ['SPORTS', 'ACTIVITY'] });
    const T = []; for (let i = 0; i < 8; i++) { const [u] = await pool.query('INSERT INTO users (name,email,phone) VALUES (?,?,?)', [`ZZ OVS ${i}`, `zz_ovs_${i}_${s}@example.com`, '9999999999']); made.users.push(u.insertId); T.push(jwt.sign({ id: u.insertId }, SECRET)); }
    const AT = jwt.sign({ id: 1, role: 'admin', username: 'admin' }, SECRET);
    const cats = await call('GET', '/activities/categories'); const cat = cats.data.categories[0];
    const cr = await call('POST', '/owner-activities', OT, { name: `ZZ OVS Park ${s}`, category_id: cat.id, location: 'Chennai', opening_time: '00:00:00', closing_time: '23:59:59' });
    const AID = cr.data.activity_id; made.act = AID; await call('PUT', `/admin/activities/${AID}/approve`, AT);
    const tt = await call('POST', `/owner-activities/${AID}/ticket-types`, OT, { name: 'Adult', price: 300, min_quantity: 1, max_quantity: 10 });
    const TT = tt.data.ticket_type_id || tt.data.id || (tt.data.ticket_type && tt.data.ticket_type.id);
    await pool.query("UPDATE activity_ticket_types SET approval_status = 'APPROVED', is_active = 1 WHERE activity_id = ?", [AID]);
    await call('POST', `/owner-activities/${AID}/inventory/bulk`, OT, { ticket_type_id: TT, start_date: today, end_date: today, capacity: 3 });

    const holds = await Promise.all(T.map((t) => call('POST', '/activities/book', t, { activity_id: AID, booking_date: today, items: [{ ticket_type_id: TT, quantity: 1 }], customer_name: 'ZZ OVS', customer_phone: '9999999999' })));
    const created = holds.map((h, i) => ({ h, t: T[i] })).filter((x) => x.h.status === 200 && x.h.data.order_id);
    const fakeFile = process.env.RZP_PAYMENTS_FILE || '/tmp/rzp_payments.json';
    const pays = await Promise.all(created.map(({ h, t }) => {
      const pid = `pay_zzovs_${crypto.randomBytes(5).toString('hex')}`;
      let m = {}; try { m = JSON.parse(fs.readFileSync(fakeFile, 'utf8')); } catch (e) { /* */ }
      m[h.data.order_id] = [{ id: pid, status: 'captured', amount: h.data.amount, currency: h.data.currency }]; fs.writeFileSync(fakeFile, JSON.stringify(m));
      return call('POST', '/activities/verify', t, { booking_id: h.data.booking_id, razorpay_order_id: h.data.order_id, razorpay_payment_id: pid, razorpay_signature: sign(h.data.order_id, pid) });
    }));
    const [[inv]] = await pool.query('SELECT capacity, sold FROM activity_inventory WHERE ticket_type_id = ? AND date = ?', [TT, today]);
    const [[conf]] = await pool.query("SELECT COUNT(*) AS n FROM activity_bookings WHERE activity_id = ? AND status = 'confirmed'", [AID]);
    const [[tix]] = await pool.query('SELECT COUNT(*) AS n FROM activity_tickets t JOIN activity_bookings b ON b.id = t.booking_id WHERE b.activity_id = ?', [AID]);
    console.log(`  ${holds.length} purchase attempts, ${created.length} payment orders, verify results: ${pays.map((p) => p.status).join(',')}`);
    check('8 simultaneous purchases of the last 3 tickets -> never more than 3 confirmed', Number(conf.n) <= 3 && Number(conf.n) >= 1, conf);
    check('inventory "sold" equals the confirmed tickets and never exceeds capacity', Number(inv.sold) === Number(conf.n) && inv.sold <= inv.capacity, inv);
    check('one QR ticket per confirmed booking, none for the losers', Number(tix.n) === Number(conf.n), tix);
    check('every losing buyer is told it sold out (409) instead of being charged silently', pays.filter((p) => p.status === 409).length === created.length - Number(conf.n), pays.map((p) => p.status));
  } catch (e) { F++; console.error(e); } finally {
    try {
      if (made.act) {
        await pool.query('DELETE t FROM activity_tickets t JOIN activity_bookings b ON b.id = t.booking_id WHERE b.activity_id = ?', [made.act]);
        await pool.query('DELETE i FROM activity_booking_items i JOIN activity_bookings b ON b.id = i.booking_id WHERE b.activity_id = ?', [made.act]);
        await pool.query('DELETE FROM activity_bookings WHERE activity_id = ?', [made.act]);
      }
    } catch (e) { console.warn('cleanup:', e.message); }
    console.log(`\n${P} passed, ${F} failed`); await pool.end(); process.exit(F ? 1 : 0);
  }
})();
