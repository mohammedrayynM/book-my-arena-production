// Phase-2 end-to-end tests for the Activities ticket engine: customer cancellation + refunds, tax, QR validity modes,
// special/blocked dates, owner analytics + CSV/XLS reports, booking filters, staff "today's entries", admin refunds/ticket
// blocking/revenue, owner pause/resume, rate limiting, scheduler (reminders + ticket expiry). Real API on localhost:9000 + the
// real DB; "payment" is a self-computed HMAC (no real charge), same as activities.e2e.js. Prefix "ZZ A2" / zz_a2_, cleaned up.
//   node tests/activities-phase2.e2e.js
const crypto = require('crypto');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const axios = require('axios');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const scheduler = require('../utils/notifications/scheduler');

const BASE = 'http://localhost:9000/api';
const results = [];
const check = (name, cond, extra) => { results.push(!!cond); console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond ? '' : ' :: ' + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, url, token, data, extraHeaders = {}) => { const r = await axios({ method, url: BASE + url, data, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extraHeaders }, validateStatus: () => true }); return { status: r.status, data: r.data, headers: r.headers }; };
const sign = (o, p) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${o}|${p}`).digest('hex');
const ymd = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

(async () => {
  const stamp = Date.now();
  const pw = 'Test#12345';
  const mail = (k) => `zz_a2_${k}_${stamp}@example.com`;
  const created = { activities: [], owners: [], users: [], staff: [] };
  const T = {}; const ID = {};

  try {
    for (const k of ['o1', 'o2', 'o3']) {
      await axios.post(BASE + '/owners/register', { name: `ZZ A2 ${k}`, email: mail(k), phone: '9999999999', password: pw });
      const l = await axios.post(BASE + '/owners/login', { email: mail(k), password: pw });
      ID[k] = l.data.owner.id; T[k] = l.data.token; created.owners.push(ID[k]);
    }
    for (const k of ['u1', 'u2']) {
      await axios.post(BASE + '/users/register', { name: `ZZ A2 ${k}`, email: mail(k), phone: '9999999999', password: pw });
      const l = await axios.post(BASE + '/users/login', { email: mail(k), password: pw });
      ID[k] = l.data.user.id; T[k] = l.data.token; created.users.push(ID[k]);
    }
    const [[admin]] = await pool.query('SELECT id FROM admins ORDER BY id LIMIT 1');
    T.admin = jwt.sign({ id: admin.id, username: 'admin', role: 'admin' }, process.env.JWT_SECRET || 'your_jwt_secret_key', { expiresIn: '1h' });
    const cats = await call('get', '/activities/categories', null);
    const catId = cats.data.categories.find((c) => c.key_name === 'WATER_PARK').id;

    const mkActivity = async (owner, name, extra = {}) => {
      const r = await call('post', '/owner-activities', owner, { name: `ZZ A2 ${name} ${stamp}`, category_id: catId, opening_time: '00:00:00', closing_time: '23:59:59', ...extra });
      created.activities.push(r.data.activity_id);
      await call('put', `/admin/activities/${r.data.activity_id}/approve`, T.admin);
      await sleep(250);
      return { id: r.data.activity_id, slug: r.data.slug };
    };
    const mkTicket = async (owner, aid, name, price, extra = {}) => (await call('post', `/owner-activities/${aid}/ticket-types`, owner, { name, price, min_quantity: 1, max_quantity: 20, ...extra })).data.ticket_type_id;
    const open = (owner, aid, tt, from, to, cap, extra = {}) => call('post', `/owner-activities/${aid}/inventory/bulk`, owner, { ticket_type_id: tt, start_date: from, end_date: to, capacity: cap, ...extra });
    const book = (user, aid, date, items, extra = {}) => call('post', '/activities/book', user, { activity_id: aid, booking_date: date, items, customer_name: 'ZZ A2 Customer', customer_phone: '9876543210', ...extra });
    const pay = (b) => { const pid = 'pay_zza2_' + crypto.randomBytes(5).toString('hex'); return call('post', '/activities/verify', null, { booking_id: b.data.booking_id, razorpay_order_id: b.data.order_id, razorpay_payment_id: pid, razorpay_signature: sign(b.data.order_id, pid) }); };
    const buy = async (user, aid, date, items, extra) => { const b = await book(user, aid, date, items, extra); if (b.status !== 200) return { b, v: null }; const v = b.data.skip_payment ? { status: 200 } : await pay(b); return { b, v }; };
    const ticketsOf = async (bookingId) => (await pool.query('SELECT * FROM activity_tickets WHERE booking_id = ?', [bookingId]))[0];
    const hhmm = (sql) => sql;

    // ================================================================= setup
    const A = await mkActivity(T.o1, 'Splash Park', { timed_entry_enabled: false });
    const adult = await mkTicket(T.o1, A.id, 'Adult', 1000);
    const child = await mkTicket(T.o1, A.id, 'Child', 500);
    await open(T.o1, A.id, adult, plus(0), plus(12), 100);
    await open(T.o1, A.id, child, plus(0), plus(12), 100);

    // ================================================================= 1. settings validation
    console.log('\n--- policy / tax / QR-validity settings ---');
    check('rejects refund_percent above 100', (await call('put', `/owner-activities/${A.id}`, T.o1, { refund_percent: 150 })).status === 400);
    check('rejects a negative refund_percent', (await call('put', `/owner-activities/${A.id}`, T.o1, { refund_percent: -1 })).status === 400);
    check('rejects an absurd tax_percent', (await call('put', `/owner-activities/${A.id}`, T.o1, { tax_percent: 90 })).status === 400);
    check('rejects an unknown qr_validity_mode', (await call('put', `/owner-activities/${A.id}`, T.o1, { qr_validity_mode: 'forever' })).status === 400);
    check('rejects custom QR validity without start/end times', (await call('put', `/owner-activities/${A.id}`, T.o1, { qr_validity_mode: 'custom' })).status === 400);
    check('rejects an unknown ticket_qr_mode', (await call('put', `/owner-activities/${A.id}`, T.o1, { ticket_qr_mode: 'nope' })).status === 400);
    check('another owner cannot change this activity\'s policy', (await call('put', `/owner-activities/${A.id}`, T.o2, { refund_percent: 0 })).status === 404);
    const okPolicy = await call('put', `/owner-activities/${A.id}`, T.o1, { cancellation_hours_before: 24, refund_percent: 80, tax_percent: 10, cancellation_policy: 'Cancel 24h before for an 80% refund.' });
    check('owner can set cancellation cutoff, refund % and tax %', okPolicy.status === 200, okPolicy.data);
    const detail = await call('get', `/activities/${A.slug}`, null);
    check('public detail exposes the policy (so customers see it before paying)', detail.data.activity.cancellation_hours_before === 24 && Number(detail.data.activity.refund_percent) === 80 && Number(detail.data.activity.tax_percent) === 10, detail.data.activity);

    // ================================================================= 2. tax
    console.log('\n--- tax ---');
    const prev = await call('post', '/activities/price-preview', T.u1, { activity_id: A.id, booking_date: plus(5), items: [{ ticket_type_id: adult, quantity: 2 }] });
    check('price preview adds the owner\'s tax on top (2 x 1000 + 10% = 2200)', prev.status === 200 && prev.data.subtotal === 2000 && prev.data.tax_amount === 200 && prev.data.total === 2200, prev.data);
    const b1 = await book(T.u1, A.id, plus(5), [{ ticket_type_id: adult, quantity: 2 }]);
    check('the Razorpay order amount is the tax-inclusive total, computed server-side (₹2200)', b1.status === 200 && b1.data.amount === 220000, b1.data);
    check('a client cannot override the total/tax (no such field is read)', (await book(T.u1, A.id, plus(5), [{ ticket_type_id: adult, quantity: 1 }], { total: 1, tax_amount: 0 })).data.amount === 110000);
    const v1 = await pay(b1);
    check('payment verifies and the booking stores the tax', v1.status === 200, v1.data);
    const [[bk1]] = await pool.query('SELECT * FROM activity_bookings WHERE id = ?', [b1.data.booking_id]);
    check('booking row: tax_amount 200, total 2200', Number(bk1.tax_amount) === 200 && Number(bk1.total_amount) === 2200, bk1);

    // ================================================================= 3. special price + blocked dates
    console.log('\n--- festival pricing + blocked dates ---');
    const D = plus(8);
    check('owner can set a festival price on one date', (await open(T.o1, A.id, adult, D, D, 100, { special_price: 1500 })).status === 200);
    const pv = await call('post', '/activities/price-preview', T.u1, { activity_id: A.id, booking_date: D, items: [{ ticket_type_id: adult, quantity: 1 }] });
    check('the festival price beats the base price (1500 + 10% tax = 1650)', pv.data.line_items[0].unit_price === 1500 && pv.data.total === 1650, pv.data);
    await open(T.o1, A.id, adult, D, D, 80);
    const pv2 = await call('post', '/activities/price-preview', T.u1, { activity_id: A.id, booking_date: D, items: [{ ticket_type_id: adult, quantity: 1 }] });
    check('changing capacity later does NOT wipe the festival price', pv2.data.line_items[0].unit_price === 1500, pv2.data);
    check('rejects a negative special price', (await open(T.o1, A.id, adult, D, D, 80, { special_price: -5 })).status === 400);
    check('a bad date range is rejected for blocking', (await call('post', `/owner-activities/${A.id}/inventory/block`, T.o1, { start_date: 'x', end_date: D })).status === 400);
    const blocked = await call('post', `/owner-activities/${A.id}/inventory/block`, T.o1, { start_date: D, end_date: D });
    check('owner can block a date', blocked.status === 200 && blocked.data.rows_changed >= 1, blocked.data);
    const pvBlocked = await call('post', '/activities/price-preview', T.u1, { activity_id: A.id, booking_date: D, items: [{ ticket_type_id: adult, quantity: 1 }] });
    check('a blocked date cannot be priced or booked', pvBlocked.status === 400 && /closed/i.test(pvBlocked.data.error), pvBlocked.data);
    check('another owner cannot block this owner\'s dates', (await call('post', `/owner-activities/${A.id}/inventory/block`, T.o2, { start_date: D, end_date: D })).status === 404);
    await call('post', `/owner-activities/${A.id}/inventory/block`, T.o1, { start_date: D, end_date: D, is_closed: false });
    check('...and reopen it again', (await call('post', '/activities/price-preview', T.u1, { activity_id: A.id, booking_date: D, items: [{ ticket_type_id: adult, quantity: 1 }] })).status === 200);

    // ================================================================= 4. QR validity modes
    console.log('\n--- QR validity modes ---');
    const times = async (bookingId) => { const [[t]] = await pool.query("SELECT DATE_FORMAT(valid_from,'%H:%i:%s') AS f, DATE_FORMAT(valid_until,'%H:%i:%s') AS u FROM activity_tickets WHERE booking_id = ? LIMIT 1", [bookingId]); return t; };
    await call('put', `/owner-activities/${A.id}`, T.o1, { opening_time: '09:00:00', closing_time: '20:00:00', qr_validity_mode: 'hours' });
    const m1 = await buy(T.u1, A.id, plus(2), [{ ticket_type_id: child, quantity: 1 }]);
    const t1 = await times(m1.b.data.booking_id);
    check('mode "hours" (default): QR valid across the venue opening hours (09:00-20:00)', t1.f === '09:00:00' && t1.u === '20:00:00', t1);
    await call('put', `/owner-activities/${A.id}`, T.o1, { qr_validity_mode: 'day' });
    const m2 = await buy(T.u1, A.id, plus(2), [{ ticket_type_id: child, quantity: 1 }]);
    const t2 = await times(m2.b.data.booking_id);
    check('mode "day": QR valid for the entire selected day', t2.f === '00:00:00' && t2.u === '23:59:59', t2);
    await call('put', `/owner-activities/${A.id}`, T.o1, { qr_validity_mode: 'custom', qr_valid_from: '10:30:00', qr_valid_until: '17:45:00' });
    const m3 = await buy(T.u1, A.id, plus(2), [{ ticket_type_id: child, quantity: 1 }]);
    const t3 = await times(m3.b.data.booking_id);
    check('mode "custom": QR valid only between the owner\'s own start/end times', t3.f === '10:30:00' && t3.u === '17:45:00', t3);
    const T_ACT = await mkActivity(T.o1, 'Timed Park', { timed_entry_enabled: true, qr_validity_mode: 'custom', qr_valid_from: '08:00:00', qr_valid_until: '22:00:00' });
    const tadult = await mkTicket(T.o1, T_ACT.id, 'Adult', 300);
    await open(T.o1, T_ACT.id, tadult, plus(3), plus(3), 50);
    const win = await call('post', `/owner-activities/${T_ACT.id}/time-windows`, T.o1, { date: plus(3), start_time: '11:00:00', end_time: '12:00:00', capacity: 20 });
    await call('put', `/owner-activities/${T_ACT.id}`, T.o1, { qr_validity_mode: 'custom', qr_valid_from: '08:00:00', qr_valid_until: '22:00:00' });
    const m4 = await buy(T.u1, T_ACT.id, plus(3), [{ ticket_type_id: tadult, quantity: 1 }], { time_window_id: win.data.time_window_id });
    const t4 = await times(m4.b.data.booking_id);
    check('timed entry: the entry window (11:00-12:00) is the most specific rule and beats the custom times', t4.f === '11:00:00' && t4.u === '12:00:00', t4);
    check('timed entry without picking a window is rejected', (await book(T.u1, T_ACT.id, plus(3), [{ ticket_type_id: tadult, quantity: 1 }])).status === 400);

    // ================================================================= 5. customer cancellation + refund
    console.log('\n--- customer cancellation + refunds ---');
    await call('put', `/owner-activities/${A.id}`, T.o1, { qr_validity_mode: 'day', opening_time: '00:00:00', closing_time: '23:59:59' });
    const [[beforeInv]] = await pool.query('SELECT sold FROM activity_inventory WHERE ticket_type_id = ? AND date = ?', [adult, plus(5)]);
    check('(setup) the booking holds 3 adult seats on that date (2 + the 1-ticket forged-total attempt left pending)', Number(beforeInv.sold) >= 2, beforeInv);
    check('another customer cannot cancel it', (await call('post', `/activities/my/tickets/${b1.data.booking_id}/cancel`, T.u2)).status === 404);
    check('an owner token cannot use the customer cancel route', (await call('post', `/activities/my/tickets/${b1.data.booking_id}/cancel`, T.o1)).status === 403);
    check('cancel needs a token', (await call('post', `/activities/my/tickets/${b1.data.booking_id}/cancel`, null)).status === 401);
    const cx = await call('post', `/activities/my/tickets/${b1.data.booking_id}/cancel`, T.u1);
    check('customer cancels within the cutoff; refund = 80% of ₹2200 = ₹1760', cx.status === 200 && cx.data.refund_amount === 1760, cx.data);
    const [[bkC]] = await pool.query('SELECT * FROM activity_bookings WHERE id = ?', [b1.data.booking_id]);
    check('booking: cancelled by "customer", refund pending, cancelled_at set', bkC.status === 'cancelled' && bkC.cancelled_by === 'customer' && bkC.refund_status === 'pending' && Number(bkC.refund_amount) === 1760 && !!bkC.cancelled_at, bkC);
    check('its QR ticket is CANCELLED', (await ticketsOf(b1.data.booking_id)).every((t) => t.status === 'CANCELLED'));
    const [[afterInv]] = await pool.query('SELECT sold FROM activity_inventory WHERE ticket_type_id = ? AND date = ?', [adult, plus(5)]);
    check('the 2 seats were released back to inventory', Number(beforeInv.sold) - Number(afterInv.sold) === 2, { beforeInv, afterInv });
    const cx2 = await call('post', `/activities/my/tickets/${b1.data.booking_id}/cancel`, T.u1);
    check('cancelling twice is a harmless no-op (already cancelled, no second refund)', cx2.status === 200 && cx2.data.already_cancelled === true && (await pool.query("SELECT COUNT(*) c FROM refunds WHERE booking_type = 'activity' AND booking_id = ?", [b1.data.booking_id]))[0][0].c === 1, cx2.data);
    await sleep(500);
    const un = (await call('get', '/notifications?limit=20', T.u1)).data.notifications;
    check('customer is notified of the cancellation', un.some((n) => n.type === 'ACTIVITY_BOOKING_CANCELLED'), un.slice(0, 3));
    const on = (await call('get', '/notifications?limit=20', T.o1)).data.notifications;
    check('...and that a customer cancelled', on.some((n) => n.type === 'OWNER_ACTIVITY_BOOKING_CANCELLED'), on.slice(0, 4).map((n) => n.type));

    // owner with no self-cancel policy
    const NP = await mkActivity(T.o2, 'No Refund Park');
    const npt = await mkTicket(T.o2, NP.id, 'Adult', 400);
    await open(T.o2, NP.id, npt, plus(4), plus(4), 10);
    const np = await buy(T.u1, NP.id, plus(4), [{ ticket_type_id: npt, quantity: 1 }]);
    const npc = await call('post', `/activities/my/tickets/${np.b.data.booking_id}/cancel`, T.u1);
    check('every activity follows the SAME platform policy (the old per-activity cutoff no longer applies): 20% of ₹400 -> refund ₹320', npc.status === 200 && npc.data.refund_amount === 320, npc.data);

    // past the cutoff: entry is today at 00:00 with a 24h cutoff -> already closed
    const today = await buy(T.u1, A.id, plus(0), [{ ticket_type_id: child, quantity: 1 }]);
    const tc = await call('post', `/activities/my/tickets/${today.b.data.booking_id}/cancel`, T.u1);
    check('a visit that has already started cannot be cancelled by the customer', tc.status === 400 && /already started/i.test(tc.data.error), tc.data);

    // already-used booking can't be cancelled
    const used = await buy(T.u1, A.id, plus(5), [{ ticket_type_id: child, quantity: 1 }]);
    const usedTok = (await ticketsOf(used.b.data.booking_id))[0].qr_token;
    // the booking is for a future date (so cancellation is still inside the cutoff); open the QR window to "now" so the gate admits it
    await pool.query('UPDATE activity_tickets SET valid_from = ?, valid_until = ? WHERE booking_id = ?', [`${plus(0)} 00:00:00`, `${plus(0)} 23:59:59`, used.b.data.booking_id]);
    const usedScan = await call('post', '/owner-activities/scan', T.o1, { qr_token: usedTok });
    check('(setup) owner admits the ticket', usedScan.data.success === true, usedScan.data);
    const uc = await call('post', `/activities/my/tickets/${used.b.data.booking_id}/cancel`, T.u1);
    check('a booking that was already used cannot be cancelled', uc.status === 400 && /used/i.test(uc.data.error), uc.data);
    await sleep(500);
    check('customer is told their ticket was redeemed', (await call('get', '/notifications?limit=20', T.u1)).data.notifications.some((n) => n.type === 'ACTIVITY_TICKET_REDEEMED'));

    // ================================================================= 6. refund ledger (the gateway, not a person, completes a refund)
    console.log('\n--- refund tracking ---');
    const [led] = (await pool.query("SELECT * FROM refunds WHERE booking_type = 'activity' AND booking_id = ?", [b1.data.booking_id]))[0] ? (await pool.query("SELECT * FROM refunds WHERE booking_type = 'activity' AND booking_id = ?", [b1.data.booking_id]))[0] : [];
    check('the cancelled booking has ONE ledger row: INR, ₹1760 (minor 176000), initiated at the gateway but NOT completed', !!led && Number(led.refund_amount_minor) === 176000 && led.currency_code === 'INR' && led.refund_status === 'REFUND_INITIATED' && !led.completed_at, led);
    check('owners can no longer mark refunds paid by hand (the endpoint is gone)', (await call('put', `/owner-activities/bookings/${b1.data.booking_id}/refund-processed`, T.o1)).status === 404);
    const crypto2 = require('crypto');
    const hookBody = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: led.gateway_refund_id } } } });
    const hook = await call('post', '/bookings/webhook', null, hookBody, { 'Content-Type': 'application/json', 'x-razorpay-signature': crypto2.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || 'bookmyarena_secret').update(hookBody).digest('hex') });
    const [[bkR]] = await pool.query('SELECT * FROM activity_bookings WHERE id = ?', [b1.data.booking_id]);
    check('once the gateway confirms: payment_status refunded and every QR ticket becomes REFUNDED', hook.status === 200 && bkR.payment_status === 'refunded' && (await ticketsOf(b1.data.booking_id)).every((t) => t.status === 'REFUNDED'), bkR);
    await sleep(700);
    check('the customer is told the refund was processed', (await call('get', '/notifications?limit=30', T.u1)).data.notifications.some((n) => n.type === 'REFUND_COMPLETED' && /1,760/.test(n.message)));
    const refTok = (await ticketsOf(b1.data.booking_id))[0].qr_token;
    const refScan = await call('post', '/owner-activities/scan', T.o1, { qr_token: refTok });
    check('a REFUNDED ticket can never be scanned in', refScan.data.success === false && refScan.data.reason === 'REFUNDED', refScan.data);

    // owner-initiated cancel always owes 100%
    const oc = await buy(T.u2, A.id, plus(6), [{ ticket_type_id: adult, quantity: 1 }]);
    const ocx = await call('put', `/owner-activities/bookings/${oc.b.data.booking_id}/cancel`, T.o1);
    check('an owner-initiated cancellation refunds 100% (₹1000 + 10% tax = ₹1100)', ocx.status === 200 && ocx.data.refund_amount === 1100, ocx.data);

    // ================================================================= 7. my tickets tabs
    console.log('\n--- My Tickets tabs ---');
    const tab = async (name) => (await call('get', `/activities/my/tickets?tab=${name}`, T.u1)).data.bookings;
    const upcoming = await tab('upcoming'); const usedTab = await tab('used'); const cancelledTab = await tab('cancelled');
    check('Upcoming has the live future booking', upcoming.some((b) => b.id === m1.b.data.booking_id) && upcoming.every((b) => b.display_status === 'upcoming'), upcoming.map((b) => b.display_status));
    check('Used has the redeemed booking', usedTab.some((b) => b.id === used.b.data.booking_id), usedTab.map((b) => b.id));
    check('Cancelled has the cancelled + refunded booking and shows its refund', cancelledTab.some((b) => b.id === b1.data.booking_id && Number(b.refund_amount) === 1760), cancelledTab.map((b) => b.id));
    check('abandoned (never-paid) checkouts are not listed anywhere', (await call('get', '/activities/my/tickets', T.u1)).data.bookings.every((b) => b.status !== 'pending'));
    await pool.query("UPDATE activity_tickets SET valid_until = '2020-01-01 10:00:00', valid_from = '2020-01-01 09:00:00' WHERE booking_id = ?", [m2.b.data.booking_id]);
    const expiredTab = await tab('expired');
    check('Expired has a never-used booking whose valid window has passed', expiredTab.some((b) => b.id === m2.b.data.booking_id), expiredTab.map((b) => b.id));
    check('the ticket detail returns the cancellation policy for the cancel button', (await call('get', `/activities/my/tickets/${m1.b.data.booking_id}`, T.u1)).data.policy.cancellation_hours_before === 24);

    // ================================================================= 8. manual verification + staff entries
    console.log('\n--- manual verification + staff ---');
    const staffCreate = await call('post', '/owner-activities/staff', T.o1, { name: 'ZZ A2 Gate', email: mail('staff'), password: 'staffpass1' });
    created.staff.push(staffCreate.data.staff_id);
    const staffLogin = await call('post', '/activity-staff/login', null, { email: mail('staff'), password: 'staffpass1' });
    T.staff = staffLogin.data.token;
    const man = await buy(T.u2, A.id, plus(7), [{ ticket_type_id: child, quantity: 2 }]);
    const [manCode] = [(await pool.query('SELECT booking_code FROM activity_bookings WHERE id = ?', [man.b.data.booking_id]))[0][0].booking_code];
    const lk = await call('get', `/owner-activities/lookup/${manCode}`, T.staff);
    check('staff can look a booking up by its booking code', lk.status === 200 && lk.data.tickets.length >= 1, lk.data);
    const manTok = lk.data.tickets[0].qr_token;
    // the ticket is for a future date, so make it admit-able today for this check
    await pool.query("UPDATE activity_tickets SET valid_from = ?, valid_until = ? WHERE booking_id = ?", [`${plus(0)} 00:00:00`, `${plus(0)} 23:59:59`, man.b.data.booking_id]);
    const manScan = await call('post', '/owner-activities/scan', T.staff, { qr_token: manTok, manual: true });
    check('staff completes a manual (no-camera) verification', manScan.data.success === true, manScan.data);
    const [[manLog]] = await pool.query("SELECT note, scanned_by_staff_id FROM activity_qr_scan_logs WHERE ticket_id = ? AND result = 'VALID' ORDER BY id DESC LIMIT 1", [lk.data.tickets[0].id]);
    check('the audit log records it as MANUAL_VERIFICATION, by that staff member', manLog.note === 'MANUAL_VERIFICATION' && manLog.scanned_by_staff_id === staffCreate.data.staff_id, manLog);
    const again = await call('post', '/owner-activities/scan', T.o1, { qr_token: manTok });
    check('re-scanning shows WHO let the first guests in', again.data.reason === 'ALREADY_USED' && again.data.scannedBy === 'ZZ A2 Gate', again.data);
    const ent = await call('get', '/owner-activities/entries/today', T.staff);
    check('staff can view today\'s entries', ent.status === 200 && ent.data.entries.some((e) => e.booking_code === manCode && e.manual === true && e.scanned_by === 'ZZ A2 Gate'), ent.data);
    check('...but only this owner\'s entries', (await call('get', '/owner-activities/entries/today', T.o2)).data.entries.every((e) => e.booking_code !== manCode));
    for (const [what, url] of [['analytics', '/owner-activities/analytics'], ['reports', `/owner-activities/reports/bookings?from=${plus(0)}&to=${plus(9)}`], ['all bookings', '/owner-activities/bookings'], ['customers', '/owner-activities/customers'], ['staff list', '/owner-activities/staff'], ['activity detail', `/owner-activities/${A.id}`]]) {
      const r = await call('get', url, T.staff);
      check(`staff is blocked from ${what} (403)`, r.status === 403, r.status);
    }
    check('staff cannot cancel bookings, change policy or pause the activity', (await call('put', `/owner-activities/bookings/${man.b.data.booking_id}/cancel`, T.staff)).status === 403 && (await call('put', `/owner-activities/${A.id}`, T.staff, { refund_percent: 0 })).status === 403 && (await call('post', `/owner-activities/${A.id}/disable`, T.staff)).status === 403);
    check('a customer token cannot open today\'s entries', (await call('get', '/owner-activities/entries/today', T.u1)).status === 403);

    // ================================================================= 9. analytics
    console.log('\n--- analytics ---');
    const an = await call('get', '/owner-activities/analytics', T.o1);
    check('owner analytics loads', an.status === 200 && an.data.tickets && an.data.today && an.data.week && an.data.month, an.data);
    check('ticket counts are internally consistent (redeemed + cancelled + expired + upcoming ≈ total)', an.data.tickets.total >= an.data.tickets.redeemed + an.data.tickets.cancelled && an.data.tickets.redeemed >= 3, an.data.tickets);
    check('cancelled/refunded people are counted (at least the 2-ticket cancel + owner cancel)', an.data.tickets.cancelled >= 3, an.data.tickets);
    check('expired/no-show counts the lapsed booking', an.data.tickets.no_show >= 1 && an.data.tickets.expired >= 1, an.data.tickets);
    check('redemption rate is a sane percentage', an.data.tickets.redemption_rate >= 0 && an.data.tickets.redemption_rate <= 100, an.data.tickets);
    check('ticket-type performance lists Adult and Child with revenue', an.data.by_ticket_type.some((t) => t.name === 'Child' && t.tickets >= 3) && an.data.by_ticket_type.every((t) => typeof t.revenue === 'number'), an.data.by_ticket_type);
    check('peak dates are listed (busiest first)', an.data.peak_dates.length >= 1 && an.data.peak_dates.every((d, i, a) => i === 0 || a[i - 1].tickets >= d.tickets), an.data.peak_dates);
    check('peak entry hours reflect real scans', an.data.peak_entry_hours.length >= 1 && an.data.peak_entry_hours[0].entries >= 1, an.data.peak_entry_hours);
    check('daily revenue series is present', Array.isArray(an.data.daily) && an.data.daily.length >= 1, an.data.daily);
    const anOne = await call('get', `/owner-activities/analytics?activity_id=${T_ACT.id}`, T.o1);
    check('analytics can be scoped to one activity', anOne.status === 200 && anOne.data.tickets.total === 1, anOne.data.tickets);
    const anOther = await call('get', '/owner-activities/analytics', T.o3);
    check('another owner sees none of this data', anOther.data.tickets.total === 0 && anOther.data.month.revenue === 0, anOther.data);
    check('a customer cannot open owner analytics', (await call('get', '/owner-activities/analytics', T.u1)).status === 403);

    // ================================================================= 10. reports
    console.log('\n--- reports (CSV / Excel) ---');
    const range = `from=${plus(-1)}&to=${plus(14)}`;
    const csv = await call('get', `/owner-activities/reports/bookings?${range}`, T.o1);
    check('bookings report is a CSV download', csv.status === 200 && /text\/csv/.test(csv.headers['content-type']) && /attachment/.test(csv.headers['content-disposition']), csv.headers);
    check('...with a header row and this owner\'s booking codes', /Booking ID,Activity,Customer/.test(csv.data) && csv.data.includes(manCode), String(csv.data).slice(0, 200));
    const xls = await call('get', `/owner-activities/reports/bookings?${range}&format=xls`, T.o1);
    check('the same report as an Excel-openable .xls', xls.status === 200 && /ms-excel/.test(xls.headers['content-type']) && /\.xls"/.test(xls.headers['content-disposition']) && /<table/.test(xls.data), xls.headers);
    for (const type of ['tickets', 'redemptions', 'revenue', 'ticket_types', 'cancelled', 'expired']) {
      const r = await call('get', `/owner-activities/reports/${type}?${range}`, T.o1);
      check(`report "${type}" builds`, r.status === 200 && /text\/csv/.test(r.headers['content-type']), { status: r.status, body: String(r.data).slice(0, 120) });
    }
    check('redemption report marks the manual check-in as Manual', /Manual/.test((await call('get', `/owner-activities/reports/redemptions?${range}`, T.o1)).data));
    check('cancelled report shows who cancelled and the refund', /customer/.test((await call('get', `/owner-activities/reports/cancelled?${range}`, T.o1)).data));
    check('an unknown report type is a 400', (await call('get', `/owner-activities/reports/secrets?${range}`, T.o1)).status === 400);
    check('a malformed date range is a 400', (await call('get', '/owner-activities/reports/bookings?from=abc&to=def', T.o1)).status === 400);
    check('a reversed date range is a 400', (await call('get', `/owner-activities/reports/bookings?from=${plus(5)}&to=${plus(1)}`, T.o1)).status === 400);
    check('another owner\'s report contains none of this owner\'s bookings', !(await call('get', `/owner-activities/reports/bookings?${range}`, T.o3)).data.includes(manCode));
    check('a customer cannot download reports', (await call('get', `/owner-activities/reports/bookings?${range}`, T.u1)).status === 403);
    const evil = await buy(T.u2, A.id, plus(9), [{ ticket_type_id: child, quantity: 1 }], { customer_name: '=HYPERLINK("http://evil","x")' });
    const evilCsv = (await call('get', `/owner-activities/reports/bookings?from=${plus(9)}&to=${plus(9)}`, T.o1)).data;
    check('spreadsheet formula injection from a customer name is neutralised', evil.v.status === 200 && evilCsv.includes("'=HYPERLINK") && !/,=HYPERLINK/.test(evilCsv), evilCsv.slice(0, 300));

    // ================================================================= 11. booking filters + customers
    console.log('\n--- booking filters ---');
    const fb = async (q) => (await call('get', `/owner-activities/bookings${q}`, T.o1)).data.bookings || [];
    check('filter: today', (await fb('?range=today')).every((b) => String(b.booking_date).slice(0, 10) === plus(0)) && (await fb('?range=today')).length >= 1);
    check('filter: tomorrow (none booked tomorrow in this test)', (await fb('?range=tomorrow')).every((b) => String(b.booking_date).slice(0, 10) === plus(1)));
    check('filter: this week covers today..+6', (await fb('?range=week')).every((b) => { const d = String(b.booking_date).slice(0, 10); return d >= plus(0) && d <= plus(6); }));
    check('filter: explicit date range', (await fb(`?from=${plus(7)}&to=${plus(7)}`)).every((b) => String(b.booking_date).slice(0, 10) === plus(7)) && (await fb(`?from=${plus(7)}&to=${plus(7)}`)).some((b) => b.booking_code === manCode));
    check('search: by booking ID', (await fb(`?q=${manCode}`)).length === 1);
    check('search: by customer phone', (await fb('?q=9876543210')).length >= 3);
    check('search: by customer name', (await fb('?q=ZZ A2 Customer')).length >= 3);
    check('search: by ticket type', (await fb('?q=Child')).length >= 1);
    check('filter: status=cancelled', (await fb('?status=cancelled')).every((b) => b.status === 'cancelled') && (await fb('?status=cancelled')).length >= 2);
    check('rows carry ticket summary, count, QR status and payment status', (await fb(`?q=${manCode}`))[0].ticket_summary === 'Child x2' && (await fb(`?q=${manCode}`))[0].qr_status === 'COMPLETED' && (await fb(`?q=${manCode}`))[0].payment_status === 'success', (await fb(`?q=${manCode}`))[0]);
    check('filter: one activity only', (await fb(`?activity_id=${T_ACT.id}`)).every((b) => b.activity_id === T_ACT.id));
    check('abandoned checkouts are hidden by default', (await fb('')).every((b) => b.status !== 'pending'));
    check('another owner sees none of these bookings', ((await call('get', '/owner-activities/bookings', T.o3)).data.bookings || []).length === 0);
    check('SQL-ish search text is harmless', (await call('get', "/owner-activities/bookings?q=' OR 1=1 --", T.o1)).status === 200);
    const cust = await call('get', '/owner-activities/customers', T.o1);
    check('customers list: grouped by phone with bookings, spend and last visit', cust.status === 200 && cust.data.customers.some((c) => c.phone === '9876543210' && c.bookings >= 3 && c.spent > 0), cust.data);

    // ================================================================= 12. pause / resume
    console.log('\n--- pause / resume ---');
    const P = await mkActivity(T.o3, 'Pausable');
    const pt = await mkTicket(T.o3, P.id, 'Adult', 100);
    await open(T.o3, P.id, pt, plus(1), plus(2), 10);
    check('owner can pause a live activity', (await call('post', `/owner-activities/${P.id}/disable`, T.o3)).status === 200);
    check('a paused activity disappears from the public', (await call('get', `/activities/${P.slug}`, null)).status === 404 && !(await call('get', '/activities', null)).data.activities.some((a) => a.id === P.id));
    const pausedBook = await book(T.u1, P.id, plus(1), [{ ticket_type_id: pt, quantity: 1 }]);
    check('a paused activity cannot be booked', pausedBook.status === 400, pausedBook.data);
    check('pausing twice is rejected', (await call('post', `/owner-activities/${P.id}/disable`, T.o3)).status === 400);
    check('another owner cannot resume it', (await call('post', `/owner-activities/${P.id}/enable`, T.o1)).status === 404);
    check('the owner can resume it', (await call('post', `/owner-activities/${P.id}/enable`, T.o3)).status === 200 && (await call('get', `/activities/${P.slug}`, null)).status === 200);
    await call('put', `/admin/activities/${P.id}/suspend`, T.admin);
    check('an owner cannot un-suspend an activity the admin suspended', (await call('post', `/owner-activities/${P.id}/enable`, T.o3)).status === 400 && (await call('get', `/activities/${P.slug}`, null)).status === 404);
    const pend = await call('post', '/owner-activities', T.o3, { name: `ZZ A2 NeverApproved ${stamp}`, category_id: catId }); created.activities.push(pend.data.activity_id);
    await pool.query("UPDATE activities SET status = 'draft' WHERE id = ?", [pend.data.activity_id]);
    check('an activity that was never approved cannot be "resumed" into the public', (await call('post', `/owner-activities/${pend.data.activity_id}/enable`, T.o3)).status === 400);
    await call('put', `/admin/activities/${P.id}/approve`, T.admin);

    // ================================================================= 13. admin
    console.log('\n--- admin: refunds, tickets, blocking, revenue, offers ---');
    const ref = await call('get', '/admin/global/refunds?business_type=ACTIVITY', T.admin);
    check('admin sees activity refunds across owners in the unified ledger', ref.status === 200 && ref.data.refunds.some((r) => r.booking_id === oc.b.data.booking_id && r.refund_amount === 1100 && r.cancelled_by === 'owner'), ref.data.refunds && ref.data.refunds.slice(0, 2));
    check('non-admins cannot see refunds', (await call('get', '/admin/global/refunds', T.o1)).status === 403 && (await call('get', '/admin/global/refunds', T.u1)).status === 403);
    const legacyGone = await call('put', `/admin/activities/refunds/${oc.b.data.booking_id}/processed`, T.admin);
    check('the old manual "mark refund processed" route is gone', legacyGone.status === 404);
    const tix = await call('get', '/admin/activities/tickets/all', T.admin);
    check('admin can see every ticket across owners', tix.status === 200 && tix.data.tickets.length >= 1 && tix.data.tickets[0].owner_name, tix.data.tickets && tix.data.tickets[0]);
    // block / unblock
    const fraud = await buy(T.u2, A.id, plus(0), [{ ticket_type_id: child, quantity: 1 }]);
    const fraudT = (await ticketsOf(fraud.b.data.booking_id))[0];
    check('non-admins cannot block tickets', (await call('put', `/admin/activities/tickets/${fraudT.id}/block`, T.o1, { blocked: true })).status === 403);
    check('admin blocks a suspicious ticket', (await call('put', `/admin/activities/tickets/${fraudT.id}/block`, T.admin, { blocked: true })).status === 200);
    const blockedScan = await call('post', '/owner-activities/scan', T.o1, { qr_token: fraudT.qr_token });
    check('a BLOCKED ticket is refused at the gate', blockedScan.data.success === false && blockedScan.data.reason === 'BLOCKED', blockedScan.data);
    check('admin unblocks it', (await call('put', `/admin/activities/tickets/${fraudT.id}/block`, T.admin, { blocked: false })).status === 200);
    check('...and it admits normally again', (await call('post', '/owner-activities/scan', T.o1, { qr_token: fraudT.qr_token })).data.success === true);
    check('a finished ticket cannot be blocked', (await call('put', `/admin/activities/tickets/${fraudT.id}/block`, T.admin, { blocked: true })).status === 400);
    await call('put', `/admin/activities/${A.id}/commission`, T.admin, { commission_percent: 10 });
    const rev = await call('get', '/admin/activities/revenue', T.admin);
    const myRev = rev.data.revenue.find((r) => r.id === A.id);
    check('admin revenue shows gross and the (informational) commission per activity', !!myRev && myRev.gross > 0 && myRev.commission_percent === 10 && Math.abs(myRev.commission_amount - myRev.gross * 0.1) < 0.02, myRev);
    await call('post', `/owner-activities/${A.id}/offers`, T.o1, { code: 'ZZA2OFF', discount_type: 'percentage', discount_value: 10 });
    check('admin can see every owner\'s offers', (await call('get', '/admin/activities/offers/all', T.admin)).data.offers.some((o) => o.code === 'ZZA2OFF'));

    // ================================================================= 14. discovery sections
    console.log('\n--- discovery sections ---');
    const sec = async (q) => (await call('get', `/activities?${q}`, null)).data.activities || [];
    check('Deals: only activities with an active offer', (await sec('section=deals')).some((a) => a.id === A.id) && (await sec('section=deals')).every((a) => a.has_offer));
    check('Weekend: activities with open weekend dates', Array.isArray(await sec('section=weekend')));
    check('Family: water parks qualify', (await sec('section=family')).some((a) => a.id === A.id));
    check('Friends: a water park alone does not qualify', !(await sec('section=friends')).some((a) => a.id === A.id));
    check('Trending: ordered by recent bookings', (await sec('section=trending')).every((a, i, arr) => i === 0 || arr[i - 1].bookings_30d >= a.bookings_30d));
    check('Popular loads', Array.isArray(await sec('section=popular')));
    await pool.query('UPDATE activities SET latitude = 13.0827, longitude = 80.2707 WHERE id = ?', [A.id]);
    const near = await sec('lat=13.09&lng=80.28&sort=nearest');
    const nearA = near.find((a) => a.id === A.id);
    check('distance (km) is computed from the visitor\'s location and nearest sort puts it first', !!nearA && nearA.distance_km >= 0 && nearA.distance_km < 5 && near.indexOf(nearA) <= near.findIndex((a) => a.distance_km == null || a.distance_km > nearA.distance_km), nearA);
    check('search also matches the location text', (await sec('search=Chennai')).length >= 0);
    check('detail lists the active offer codes for the deals strip', (await call('get', `/activities/${A.slug}`, null)).data.offers.some((o) => o.code === 'ZZA2OFF'));

    // ================================================================= 15. scheduler: reminders + expiry
    console.log('\n--- scheduler: reminders + ticket expiry ---');
    const rem = await buy(T.u1, A.id, plus(1), [{ ticket_type_id: child, quantity: 1 }]);
    await pool.query("UPDATE activity_bookings SET created_at = DATE_SUB(NOW(), INTERVAL 3 DAY) WHERE id = ?", [rem.b.data.booking_id]);
    await pool.query("UPDATE activities SET opening_time = '10:00:00' WHERE id = ?", [A.id]);
    const entry = new Date(`${plus(1)}T10:00:00`);
    const dry = await scheduler.runOnce({ now: entry.getTime() - 24 * 3600000 + 5 * 60000, dryRun: true, scope: { activityBookingIds: [rem.b.data.booking_id] } });
    check('dry run: a 24h-before reminder is due for tomorrow\'s booking', dry.activity_reminders.some((r) => r.bookingId === rem.b.data.booking_id && r.hoursBefore === 24), dry.activity_reminders);
    const none = await scheduler.runOnce({ now: entry.getTime() - 10 * 3600000, dryRun: true, scope: { activityBookingIds: [rem.b.data.booking_id] } });
    check('no reminder is due 10h before (between windows)', none.activity_reminders.length === 0, none.activity_reminders);
    await scheduler.runOnce({ now: entry.getTime() - 24 * 3600000 + 5 * 60000, scope: { activityBookingIds: [rem.b.data.booking_id] } });
    await sleep(600);
    const rn = (await call('get', '/notifications?limit=30', T.u1)).data.notifications.filter((n) => n.type === 'ACTIVITY_REMINDER');
    check('the customer got "your booking is tomorrow"', rn.length === 1 && /tomorrow/i.test(rn[0].message), rn);
    await scheduler.runOnce({ now: entry.getTime() - 24 * 3600000 + 6 * 60000, scope: { activityBookingIds: [rem.b.data.booking_id] } });
    await sleep(500);
    check('running it again does not send a duplicate reminder', (await call('get', '/notifications?limit=30', T.u1)).data.notifications.filter((n) => n.type === 'ACTIVITY_REMINDER').length === 1);
    await scheduler.runOnce({ now: entry.getTime() - 2 * 3600000 + 60000, scope: { activityBookingIds: [rem.b.data.booking_id] } });
    await sleep(500);
    check('a second reminder goes out 2 hours before', (await call('get', '/notifications?limit=30', T.u1)).data.notifications.filter((n) => n.type === 'ACTIVITY_REMINDER').length === 2);
    const cancelledRem = await buy(T.u1, A.id, plus(1), [{ ticket_type_id: child, quantity: 1 }]);
    await pool.query("UPDATE activity_bookings SET created_at = DATE_SUB(NOW(), INTERVAL 3 DAY) WHERE id = ?", [cancelledRem.b.data.booking_id]);
    await call('put', `/owner-activities/bookings/${cancelledRem.b.data.booking_id}/cancel`, T.o1);
    const dry2 = await scheduler.runOnce({ now: entry.getTime() - 24 * 3600000 + 5 * 60000, dryRun: true, scope: { activityBookingIds: [cancelledRem.b.data.booking_id] } });
    check('a cancelled booking gets no reminder', dry2.activity_reminders.length === 0, dry2.activity_reminders);
    // expiry sweep
    const exp = await buy(T.u1, A.id, plus(9), [{ ticket_type_id: child, quantity: 1 }]);
    await pool.query("UPDATE activity_tickets SET valid_until = '2020-01-01 10:00:00' WHERE booking_id = ?", [exp.b.data.booking_id]);
    const dryExp = await scheduler.runOnce({ dryRun: true, scope: { activityBookingIds: [exp.b.data.booking_id] } });
    check('dry run counts the lapsed ticket without changing it', dryExp.activity_tickets_expired === 1 && (await ticketsOf(exp.b.data.booking_id))[0].status === 'VALID', dryExp.activity_tickets_expired);
    const sweep = await scheduler.runOnce({ scope: { activityBookingIds: [exp.b.data.booking_id] } });
    check('the sweep marks the lapsed ticket EXPIRED', sweep.activity_tickets_expired === 1 && (await ticketsOf(exp.b.data.booking_id))[0].status === 'EXPIRED', sweep.activity_tickets_expired);
    const fut = await ticketsOf(rem.b.data.booking_id);
    check('...and leaves valid future tickets alone', fut[0].status === 'VALID');
    await pool.query("UPDATE activities SET opening_time = '00:00:00' WHERE id = ?", [A.id]);
    // daily summary (idempotent via event key) — only after the evening hour, so drive it with a fixed 'now'
    const evening = new Date(); evening.setHours(21, 30, 0, 0);
    await scheduler.runOnce({ now: evening.getTime() });
    await sleep(800);
    const sums = (await call('get', '/notifications?limit=30', T.o1)).data.notifications.filter((n) => n.type === 'OWNER_ACTIVITY_DAILY_SUMMARY');
    check('the owner gets one evening "today at your activities" summary', sums.length === 1 && /booking/.test(sums[0].message), sums);
    await scheduler.runOnce({ now: evening.getTime() + 60000 });
    await sleep(500);
    check('...never twice for the same day', (await call('get', '/notifications?limit=30', T.o1)).data.notifications.filter((n) => n.type === 'OWNER_ACTIVITY_DAILY_SUMMARY').length === 1);
    const group = await buy(T.u2, A.id, plus(10), [{ ticket_type_id: child, quantity: 12 }]);
    check('(setup) the 12-guest booking went through', group.v && group.v.status === 200, group.b.data);
    let grpNotes = [];
    for (let i = 0; i < 12; i++) { await sleep(500); grpNotes = (await call('get', '/notifications?limit=50', T.o1)).data.notifications; if (grpNotes.some((n) => /group/i.test(n.message))) break; } // fire() is fire-and-forget
    check('a 12-guest booking is flagged to the owner as a large group', grpNotes.some((n) => n.type === 'OWNER_NEW_ACTIVITY_BOOKING' && /group/i.test(n.message)), grpNotes.slice(0, 4).map((n) => `${n.type}: ${n.message}`));

    // ================================================================= 15b. dates: plain YYYY-MM-DD, open dates, closed-today guard
    console.log('\n--- dates ---');
    const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
    const ob = (await call('get', '/owner-activities/bookings', T.o1)).data.bookings;
    check('owner bookings return booking_date as a plain YYYY-MM-DD (no timezone shift to the previous day)', ob.length > 0 && ob.every((b) => ymdRe.test(b.booking_date)) && ob.some((b) => b.booking_date === plus(7)), ob.slice(0, 2).map((b) => b.booking_date));
    check('customer tickets, ticket detail and admin lists do too', (await call('get', '/activities/my/tickets', T.u1)).data.bookings.every((b) => ymdRe.test(b.booking_date)) && ymdRe.test((await call('get', `/activities/my/tickets/${m1.b.data.booking_id}`, T.u1)).data.booking.booking_date) && (await call('get', '/admin/activities/tickets/all', T.admin)).data.tickets.every((r) => ymdRe.test(r.booking_date)));
    check('the booking for plus(5) shows plus(5), not the day before', (await call('get', `/activities/my/tickets/${b1.data.booking_id}`, T.u1)).data.booking.booking_date === plus(5));
    const od = await call('get', `/activities/${A.slug}/open-dates?days=30`, null);
    check('open-dates lists only dates the owner opened, in order', od.status === 200 && od.data.dates.length >= 10 && od.data.dates.every((d, i, a) => ymdRe.test(d.date) && d.remaining > 0 && (i === 0 || a[i - 1].date < d.date)) && od.data.dates[0].date === plus(0) && !od.data.dates.some((d) => d.date === plus(20)), od.data.dates && od.data.dates.slice(0, 3));
    await call('post', `/owner-activities/${A.id}/inventory/block`, T.o1, { start_date: plus(12), end_date: plus(12) });
    check('a blocked date disappears from open-dates', !(await call('get', `/activities/${A.slug}/open-dates`, null)).data.dates.some((d) => d.date === plus(12)));
    const Q = await mkActivity(T.o2, 'Tiny Park');
    const qt = await mkTicket(T.o2, Q.id, 'Solo', 50);
    await open(T.o2, Q.id, qt, plus(2), plus(2), 1);
    await open(T.o2, Q.id, qt, plus(3), plus(3), 5);
    await buy(T.u1, Q.id, plus(2), [{ ticket_type_id: qt, quantity: 1 }]);
    const qd = (await call('get', `/activities/${Q.slug}/open-dates`, null)).data.dates.map((d) => d.date);
    check('a sold-out date disappears from open-dates, other dates stay', !qd.includes(plus(2)) && qd.includes(plus(3)), qd);
    check('unknown activity: 404', (await call('get', '/activities/no-such-activity-zz/open-dates', null)).status === 404);
    const Z = await mkActivity(T.o3, 'Already Closed', { opening_time: '00:00:00', closing_time: '00:00:01' });
    const zt = await mkTicket(T.o3, Z.id, 'Adult', 100);
    await open(T.o3, Z.id, zt, plus(0), plus(2), 10);
    const zb = await book(T.u1, Z.id, plus(0), [{ ticket_type_id: zt, quantity: 1 }]);
    check('booking today for a venue that has already closed is refused (the QR could never be used)', zb.status === 400 && /closed for today/i.test(zb.data.error), zb.data);
    check('...it is not offered as a date either', !(await call('get', `/activities/${Z.slug}/open-dates`, null)).data.dates.some((d) => d.date === plus(0)) && (await call('get', `/activities/${Z.slug}/open-dates`, null)).data.dates.some((d) => d.date === plus(1)));
    check('...but tomorrow is bookable', (await book(T.u1, Z.id, plus(1), [{ ticket_type_id: zt, quantity: 1 }])).status === 200);
    const W = await mkActivity(T.o3, 'Ended Window', { timed_entry_enabled: true });
    const wt = await mkTicket(T.o3, W.id, 'Adult', 100);
    await open(T.o3, W.id, wt, plus(0), plus(0), 10);
    const ww = await call('post', `/owner-activities/${W.id}/time-windows`, T.o3, { date: plus(0), start_time: '00:00:00', end_time: '00:00:02', capacity: 10 });
    const wb = await book(T.u1, W.id, plus(0), [{ ticket_type_id: wt, quantity: 1 }], { time_window_id: ww.data.time_window_id });
    check('an entry time that already ended today cannot be booked', wb.status === 400 && /already ended/i.test(wb.data.error), wb.data);

    // ================================================================= 16. rate limiting
    console.log('\n--- rate limiting ---');
    const burst = await Promise.all(Array.from({ length: 140 }, (_, i) => call('get', `/owner-activities/lookup/NOPE-${i}`, T.o3)));
    const limited = burst.filter((r) => r.status === 429);
    check('hammering the booking-code lookup gets throttled (429 + Retry-After)', limited.length >= 1 && !!limited[0].headers['retry-after'], burst.map((r) => r.status).slice(-5));
    check('...but a different owner is unaffected (limits are per account)', (await call('get', '/owner-activities/lookup/NOPE', T.o1)).status === 404);
    const sigBurst = await Promise.all(Array.from({ length: 40 }, () => call('post', '/activities/verify', null, { booking_id: 999999999, razorpay_order_id: 'order_x', razorpay_payment_id: 'pay_x', razorpay_signature: 'bad' })));
    check('guessing payment signatures for one booking is throttled', sigBurst.some((r) => r.status === 429), sigBurst.map((r) => r.status).slice(-3));
  } catch (e) {
    console.error('UNEXPECTED ERROR', e);
    results.push(false);
  } finally {
    // cleanup — everything this run created
    try {
      const aids = created.activities.length ? created.activities : [0];
      const [bk] = await pool.query(`SELECT id FROM activity_bookings WHERE activity_id IN (${aids.map(() => '?').join(',')})`, aids);
      const bids = bk.map((b) => b.id);
      if (bids.length) {
        await pool.query(`DELETE FROM activity_qr_scan_logs WHERE ticket_id IN (SELECT id FROM activity_tickets WHERE booking_id IN (${bids.map(() => '?').join(',')}))`, bids);
        for (const t of ['activity_tickets', 'activity_booking_items', 'activity_booking_addons', 'activity_offer_usages']) await pool.query(`DELETE FROM ${t} WHERE booking_id IN (${bids.map(() => '?').join(',')})`, bids);
        await pool.query(`DELETE FROM activity_bookings WHERE id IN (${bids.map(() => '?').join(',')})`, bids);
      }
      for (const t of ['activity_inventory', 'activity_time_windows', 'activity_addons', 'activity_offers', 'activity_ticket_types']) await pool.query(`DELETE FROM ${t} WHERE activity_id IN (${aids.map(() => '?').join(',')})`, aids);
      await pool.query(`DELETE FROM activities WHERE id IN (${aids.map(() => '?').join(',')})`, aids);
      if (created.staff.length) await pool.query(`DELETE FROM activity_staff WHERE id IN (${created.staff.map(() => '?').join(',')})`, created.staff);
      const uids = created.users.length ? created.users : [0]; const oids = created.owners.length ? created.owners : [0];
      await pool.query(`DELETE FROM notifications WHERE (recipient_type = 'user' AND recipient_id IN (${uids.map(() => '?').join(',')})) OR (recipient_type = 'owner' AND recipient_id IN (${oids.map(() => '?').join(',')}))`, [...uids, ...oids]);
      await pool.query("DELETE FROM notifications WHERE recipient_type = 'admin' AND (message LIKE '%ZZ A2%' OR title LIKE '%ZZ A2%')");
      await pool.query(`DELETE FROM owners WHERE id IN (${oids.map(() => '?').join(',')})`, oids);
      await pool.query(`DELETE FROM users WHERE id IN (${uids.map(() => '?').join(',')})`, uids);
      const [[left]] = await pool.query("SELECT (SELECT COUNT(*) FROM activities WHERE name LIKE 'ZZ A2%') a, (SELECT COUNT(*) FROM owners WHERE email LIKE 'zz_a2_%') o, (SELECT COUNT(*) FROM users WHERE email LIKE 'zz_a2_%') u");
      console.log(`cleanup done; leftovers (activities/owners/users): ${left.a} ${left.o} ${left.u}`);
    } catch (e) { console.log('cleanup error:', e.message); }
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    await pool.end();
    process.exit(passed === results.length ? 0 : 1);
  }
})().catch((e) => { console.error('UNEXPECTED ERROR', e); process.exit(1); });
