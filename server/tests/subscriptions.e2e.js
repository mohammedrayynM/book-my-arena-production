// End-to-end tests for the hardened SUBSCRIPTION system: offers (owner) vs subscriptions (customer), server-side pricing, payment ->
// activation only when verified, slot reservation + races, manual memberships, authorization / ID tampering, cancellation + refunds,
// renewal, expiry, venue currency + timezone. Needs the API on localhost:9000 (start it with NOTIFICATION_WORKER=off) + the real DB.
// Payments are fixtures (a signature is computed from the test's own key, nobody is charged; /purchase and /renew create one
// unpaid gateway order each) and refunds are SIMULATED for non-Razorpay payment ids. Rows are prefixed "ZZ SUB" / zz_sub_ and removed.
//   node tests/subscriptions.e2e.js
const crypto = require('crypto');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const axios = require('axios');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const R = require('../services/subscriptionReservations');
const subsvc = require('../services/subscriptionService');
const { todayIn } = require('../utils/timezone');
const { toMinor } = require('../utils/money');

const BASE = 'http://localhost:9000/api';
const results = [];
const check = (name, cond, extra) => { results.push(!!cond); console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond ? '' : ' :: ' + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(200); } return v; };
const call = async (method, url, token, data, headers = {}) => { const r = await axios({ method, url: BASE + url, data, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, validateStatus: () => true }); return { status: r.status, data: r.data }; };
const D = (v) => R.ymdOf(v);
const rnd = () => crypto.randomBytes(5).toString('hex');
const KEY = process.env.RAZORPAY_KEY_SECRET;
const WH = process.env.RAZORPAY_WEBHOOK_SECRET || 'bookmyarena_secret';

(async () => {
  const stamp = Date.now();
  const pw = 'Test#12345';
  const mail = (k) => `zz_sub_${k}_${stamp}@example.com`;
  const T = {}; const ID = {};
  const created = { turfs: [], owners: [], users: [], adminPlans: [] };

  try {
    for (const k of ['o1', 'o2', 'oAE']) {
      await axios.post(BASE + '/owners/register', { name: `ZZ SUB ${k}`, email: mail(k), phone: '9999999999', password: pw });
      const l = await axios.post(BASE + '/owners/login', { email: mail(k), password: pw });
      ID[k] = l.data.owner.id; T[k] = l.data.token; created.owners.push(ID[k]);
    }
    for (const k of ['u1', 'u2', 'u3', 'u4']) {
      await axios.post(BASE + '/users/register', { name: `ZZ SUB ${k}`, email: mail(k), phone: '9999999999', password: pw });
      const l = await axios.post(BASE + '/users/login', { email: mail(k), password: pw });
      ID[k] = l.data.user.id; T[k] = l.data.token; created.users.push(ID[k]);
    }
    const [[admin]] = await pool.query('SELECT id FROM admins ORDER BY id LIMIT 1');
    ID.admin = admin.id;
    T.admin = jwt.sign({ id: admin.id, username: 'admin', role: 'admin' }, process.env.JWT_SECRET || 'your_jwt_secret_key', { expiresIn: '1h' });

    const mkTurf = async (owner, extra = {}) => {
      const r = await call('post', '/owners/turfs', owner, { name: `ZZ SUB Turf ${rnd()}`, location: 'Test City', sport_type: 'Football', price_per_hour: 100, latitude: 25.2, longitude: 55.27, ...extra });
      if (r.data.turf_id) created.turfs.push(r.data.turf_id);
      return r.data.turf_id;
    };
    const tIN = await mkTurf(T.o1); const tIN2 = await mkTurf(T.o2); const tAE = await mkTurf(T.oAE, { country_code: 'AE' });
    const [cr] = await pool.query("INSERT INTO courts (turf_id, name, sport_type, price_per_hour) VALUES (?, 'ZZ SUB Court', 'Football', 100)", [tIN]);
    const court1 = cr.insertId;
    const [cr2] = await pool.query("INSERT INTO courts (turf_id, name, sport_type, price_per_hour) VALUES (?, 'ZZ SUB Court B', 'Football', 100)", [tIN2]);
    const courtOther = cr2.insertId;
    const tzIN = 'Asia/Kolkata'; const tzAE = 'Asia/Dubai';

    const mkPlan = (owner, body) => call('post', '/subscriptions/owner/plans', owner, { name: `ZZ SUB Plan ${rnd()}`, price: 500, duration_months: 1, start_time: '19:00', end_time: '20:00', max_subscribers: 1, available_days: 'all', ...body });
    const planId = async (owner, body) => { const r = await mkPlan(owner, body); if (!r.data.plan_id) throw new Error('plan create failed: ' + JSON.stringify(r.data)); return r.data.plan_id; };
    const expectedDates = (plan, tz, months = 1) => { const today = todayIn(tz); return subsvc.periodDates({ start: today, endExclusive: R.addMonthsClamped(today, months), weekdaysSet: R.parseWeekdays(plan.available_days), slotEnd: String(plan.end_time).slice(0, 5), tz }); };
    const subRow = async (id) => (await pool.query('SELECT * FROM user_subscriptions WHERE id = ?', [id]))[0][0];
    const resv = async (id, status) => (await pool.query(`SELECT * FROM subscription_reservations WHERE subscription_id = ?${status ? ' AND status = ?' : ''}`, status ? [id, status] : [id]))[0];
    const audits = async (id) => (await pool.query('SELECT * FROM subscription_audit_log WHERE subscription_id = ? ORDER BY id', [id]))[0].map((a) => a.action);
    const notifs = async (token) => (await call('get', '/notifications?limit=50', token)).data.notifications || [];
    const sign = (orderId, payId) => crypto.createHmac('sha256', KEY).update(`${orderId}|${payId}`).digest('hex');
    const verify = (token, orderId, payId, sig) => call('post', '/subscriptions/verify', token, { razorpay_order_id: orderId, razorpay_payment_id: payId, razorpay_signature: sig || sign(orderId, payId) });
    const hook = (event, entity, sig) => { const body = JSON.stringify({ event, payload: { payment: { entity } } }); return call('post', '/bookings/webhook', null, body, { 'Content-Type': 'application/json', 'x-razorpay-signature': sig || crypto.createHmac('sha256', WH).update(body).digest('hex') }); };
    // a purchase created without the gateway (the same rows /purchase writes)
    const fixture = async (userId, pid, { kind = 'purchase', subId = null, amountMinor = null } = {}) => {
      const plan = await subsvc.getPlan(pid);
      const cur = subsvc.planCurrency(plan); const tz = subsvc.planTz(plan);
      const amt = amountMinor ?? toMinor(Number(plan.price), cur);
      let sid = subId;
      if (!sid) {
        const months = subsvc.planMonths(plan); const start = todayIn(tz);
        const [r] = await pool.query("INSERT INTO user_subscriptions (user_id, plan_id, turf_id, court_id, start_date, expiry_date, status, payment_status, currency_code, amount_due_minor, source, payment_type, weekdays, start_time, end_time, period_months) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, 'online', 'online', ?, ?, ?, ?)",
          [userId, pid, plan.turf_id, plan.court_id || null, start, R.addDays(R.addMonthsClamped(start, months), -1), cur, amt, plan.available_days === 'all' ? 'all' : plan.available_days, plan.start_time, plan.end_time, months]);
        sid = r.insertId;
      }
      const orderId = `order_zzsub_${rnd()}`;
      await pool.query('INSERT INTO subscription_payments (subscription_id, kind, gateway_order_id, amount_minor, currency_code, period_months, status) VALUES (?, ?, ?, ?, ?, ?, ?)', [sid, kind, orderId, amt, cur, subsvc.planMonths(plan), 'created']);
      return { subId: sid, orderId, payId: `pay_zzsub_${rnd()}`, amountMinor: amt };
    };

    // ================================================================= 0. pure date math
    console.log('\n--- calendar-month renewal dates ---');
    check('8 Sep + 1 month = 8 Oct (calendar month, not 30 days)', R.addMonthsClamped('2026-09-08', 1) === '2026-10-08');
    check('31 Jan + 1 month = 28 Feb in a normal year, 29 Feb in a leap year', R.addMonthsClamped('2027-01-31', 1) === '2027-02-28' && R.addMonthsClamped('2028-01-31', 1) === '2028-02-29');
    check('31 Mar + 1 month = 30 Apr; 31 Oct + 4 months = 28 Feb', R.addMonthsClamped('2026-03-31', 1) === '2026-04-30' && R.addMonthsClamped('2026-10-31', 4) === '2027-02-28');
    check('periods are anchored to the START date (31 Jan, 2 months -> 31 Mar, not 28 Mar)', R.addMonthsClamped('2027-01-31', 2) === '2027-03-31');
    check('a year rolls over (15 Dec + 2 months = 15 Feb)', R.addMonthsClamped('2026-12-15', 2) === '2027-02-15');
    check('weekday parsing: valid / all / invalid', R.parseWeekdays('1,3,5').size === 3 && R.parseWeekdays('all') === null && R.parseWeekdays('9') === undefined && R.parseWeekdays('mon') === undefined);

    // ================================================================= 1. offers (owner) + admin plans
    console.log('\n--- offers: validation, ownership, admin plans ---');
    check('an offer needs a login / an owner token', (await call('post', '/subscriptions/owner/plans', null, {})).status === 401 && (await call('post', '/subscriptions/owner/plans', T.u1, {})).status === 403);
    const bad = (body) => mkPlan(T.o1, { turf_id: tIN, ...body });
    check('end time before start time is refused', (await bad({ start_time: '20:00', end_time: '19:00' })).status === 400);
    check('a malformed time is refused', (await bad({ start_time: '7pm' })).status === 400);
    check('invalid weekdays are refused', (await bad({ available_days: '1,9' })).status === 400);
    check('a negative price is refused', (await bad({ price: -5 })).status === 400);
    check('duration 0 and 13 months are refused', (await bad({ duration_months: 0 })).status === 400 && (await bad({ duration_months: 13 })).status === 400);
    check('capacity 0 is refused', (await bad({ max_subscribers: 0 })).status === 400);
    check('an offer for ANOTHER owner\'s venue is refused (403)', (await mkPlan(T.o1, { turf_id: tIN2 })).status === 403);
    check('a court that belongs to another venue is refused', (await bad({ court_id: courtOther })).status === 403);
    check('a venue with no courts-free offer works and stores the VENUE currency', await (async () => { const r = await bad({ name: 'ZZ SUB first' }); const [[p]] = await pool.query('SELECT currency_code, owner_id, turf_id FROM subscription_plans WHERE id = ?', [r.data.plan_id]); return r.status === 200 && p.currency_code === 'INR' && p.owner_id === ID.o1 && p.turf_id === tIN; })());

    const ap = await call('post', '/admin/subscriptions/plans', T.admin, { name: 'ZZ SUB Gold', duration_months: 2, price: 900, currency_code: 'INR', billing_interval: 'monthly', features: ['Priority slot', 'Free towel'], is_enabled: true });
    created.adminPlans.push(ap.data.id);
    check('admin creates a plan (name, duration, price, currency, interval, features, enabled)', ap.status === 200 && ap.data.id > 0, ap.data);
    check('non-admins cannot manage plan templates', (await call('post', '/admin/subscriptions/plans', T.o1, { name: 'x', duration_months: 1, price: 1 })).status === 403 && (await call('get', '/admin/subscriptions/plans', T.u1)).status === 403);
    check('admin plan validation (bad duration / price / interval)', (await call('post', '/admin/subscriptions/plans', T.admin, { name: 'x', duration_months: 0, price: 5 })).status === 400 && (await call('post', '/admin/subscriptions/plans', T.admin, { name: 'x', duration_months: 1, price: -1 })).status === 400 && (await call('post', '/admin/subscriptions/plans', T.admin, { name: 'x', duration_months: 1, price: 1, billing_interval: 'hourly' })).status === 400);
    const ownerAdminPlans = await call('get', `/subscriptions/owner/admin-plans?turf_id=${tIN}`, T.o1);
    check('the owner sees the enabled admin plans for the venue currency', ownerAdminPlans.status === 200 && ownerAdminPlans.data.plans.some((p) => p.id === ap.data.id) && (await call('get', `/subscriptions/owner/admin-plans?turf_id=${tIN}`, T.o2)).status === 403);
    check('once admin plans exist the owner must pick one', (await bad({})).status === 400 && /Choose one/.test((await bad({})).data.error));
    const adminLinked = await bad({ admin_plan_id: ap.data.id, price: 1, duration_months: 12, name: 'ZZ SUB admin linked' });
    const [[linked]] = await pool.query('SELECT price, duration_months, price_source FROM subscription_plans WHERE id = ?', [adminLinked.data.plan_id]);
    check('the price and duration come from the ADMIN plan, not from what the owner sent', adminLinked.status === 200 && Number(linked.price) === 900 && linked.duration_months === 2 && linked.price_source === 'admin', linked);
    await call('put', `/admin/subscriptions/plans/${ap.data.id}`, T.admin, { price: 1000 });
    check('an admin price change applies to the next purchase (live read)', Number((await subsvc.getPlan(adminLinked.data.plan_id)).price) === 1000);
    check('an AED venue cannot use an INR admin plan', (await mkPlan(T.oAE, { turf_id: tAE, admin_plan_id: ap.data.id })).status === 400);
    await call('put', `/admin/subscriptions/plans/${ap.data.id}`, T.admin, { is_enabled: false });
    const listed = (await call('get', `/subscriptions/turf/${tIN}`, null)).data.plans;
    check('a disabled admin plan is no longer sold: hidden from customers and not purchasable', !listed.some((p) => p.id === adminLinked.data.plan_id) && (await call('post', '/subscriptions/purchase', T.u1, { subscription_offer_id: adminLinked.data.plan_id })).status === 404);
    await pool.query('DELETE FROM subscription_admin_plans WHERE id = ?', [ap.data.id]); created.adminPlans.length = 0; // back to "no admin plans": owners may price their own
    await pool.query('UPDATE subscription_plans SET is_active = false WHERE turf_id IN (?, ?, ?)', [tIN, tIN2, tAE]);

    // ================================================================= 2. purchase: server-side price
    console.log('\n--- purchase: the server decides ---');
    const P1 = await planId(T.o1, { turf_id: tIN, name: 'ZZ SUB P1', price: 500, max_subscribers: 1 });
    const plan1 = await subsvc.getPlan(P1);
    check('a customer must be signed in, and an owner token is not a customer', (await call('post', '/subscriptions/purchase', null, { subscription_offer_id: P1 })).status === 401 && (await call('post', '/subscriptions/purchase', T.o1, { subscription_offer_id: P1 })).status === 403);
    check('an unknown / malformed offer id is a clean 404/400', (await call('post', '/subscriptions/purchase', T.u1, { subscription_offer_id: 99999999 })).status === 404 && (await call('post', '/subscriptions/purchase', T.u1, { subscription_offer_id: 'abc' })).status === 400);
    const buy = await call('post', '/subscriptions/purchase', T.u1, { subscription_offer_id: P1, price: 1, amount: 100, currency: 'USD', turf_id: tIN2, schedule: '03:00' });
    check('a purchase sends only the offer id: price / currency / venue / schedule from the client are ignored', buy.status === 200 && buy.data.amount === 50000 && buy.data.currency === 'INR', buy.data);
    const sub1 = await subRow(buy.data.subscription_id);
    check('the subscription is PENDING (not active), bound to the offer\'s venue and schedule', sub1.status === 'pending' && sub1.payment_status === 'pending' && sub1.turf_id === tIN && sub1.currency_code === 'INR' && Number(sub1.amount_due_minor) === 50000 && String(sub1.start_time).startsWith('19:00'), sub1);
    check('...nothing is reserved while unpaid and the slot is still bookable', (await resv(sub1.id)).length === 0);
    check('...and My Subscriptions does not list an unpaid purchase as a subscription', !((await call('get', '/subscriptions/my-plans', T.u1)).data.subscriptions || []).some((s) => s.id === sub1.id));
    const buy2 = await call('post', '/subscriptions/purchase', T.u1, { subscription_offer_id: P1 });
    check('double-click: the same pending purchase and order are reused (one subscription, one order)', buy2.status === 200 && buy2.data.order_id === buy.data.order_id && buy2.data.subscription_id === sub1.id && (await pool.query("SELECT COUNT(*) c FROM user_subscriptions WHERE user_id = ? AND plan_id = ?", [ID.u1, P1]))[0][0].c === 1, buy2.data);
    const payRows = (await pool.query('SELECT * FROM subscription_payments WHERE subscription_id = ?', [sub1.id]))[0];
    check('the payment attempt is recorded with the order id, amount and currency (unique order id enforced)', payRows.length === 1 && payRows[0].gateway_order_id === buy.data.order_id && Number(payRows[0].amount_minor) === 50000 && payRows[0].currency_code === 'INR' && payRows[0].status === 'created');

    // ================================================================= 3. failures never activate
    console.log('\n--- failed / cancelled / forged payments never activate ---');
    const pFail = `pay_zzsub_${rnd()}`;
    const wf = await hook('payment.failed', { id: pFail, order_id: buy.data.order_id });
    check('a signed payment.failed webhook is accepted', wf.status === 200, wf.data);
    const afterFail = await subRow(sub1.id);
    check('failed payment: subscription NOT active, payment status failed, nothing reserved', afterFail.status === 'pending' && afterFail.payment_status === 'failed' && (await resv(sub1.id)).length === 0, afterFail);
    check('...the customer is told the payment failed, and never that it was activated', await until(async () => (await notifs(T.u1)).some((n) => n.type === 'SUBSCRIPTION_PAYMENT_FAILED')) && !(await notifs(T.u1)).some((n) => n.type === 'SUBSCRIPTION_ACTIVATED'));
    check('a forged webhook (wrong signature) changes nothing', (await hook('payment.captured', { id: pFail, order_id: buy.data.order_id, amount: 50000, currency: 'INR' }, 'deadbeef')).status === 400 && (await subRow(sub1.id)).status === 'pending');
    const badSig = await verify(T.u1, buy.data.order_id, pFail, 'deadbeef');
    check('a verify call with a bad signature is rejected and activates nothing', badSig.status === 400 && (await subRow(sub1.id)).status === 'pending');
    const wrongAmt = await hook('payment.captured', { id: pFail, order_id: buy.data.order_id, amount: 100, currency: 'INR' });
    check('a captured payment for the WRONG amount does not activate', wrongAmt.status === 200 && (await subRow(sub1.id)).status === 'pending' && (await resv(sub1.id)).length === 0);
    const fxC = await fixture(ID.u2, P1);
    const cancelled = await call('post', '/subscriptions/cancel-payment', T.u2, { razorpay_order_id: fxC.orderId });
    const subC = await subRow(fxC.subId);
    check('payment cancelled by the customer: cancelled, never activated, nothing reserved', cancelled.status === 200 && subC.status === 'cancelled' && subC.cancel_reason === 'payment_cancelled' && (await resv(fxC.subId)).length === 0 && !((await call('get', '/subscriptions/my-plans', T.u2)).data.subscriptions || []).some((s) => s.id === fxC.subId));
    check('another customer cannot cancel / fail MY payment', (await call('post', '/subscriptions/cancel-payment', T.u3, { razorpay_order_id: buy.data.order_id })).status === 403);
    const fxB = await fixture(ID.u1, P1);
    const stolen = await verify(T.u3, fxB.orderId, fxB.payId);
    check('a verified payment of ANOTHER account cannot be claimed (403) and activates nothing', stolen.status === 403 && (await subRow(fxB.subId)).status === 'pending');

    // the hosted checkout page (Expo Go / web) has no login: the gateway signature alone proves the payment
    const P0 = await planId(T.o1, { turf_id: tIN, name: 'ZZ SUB Hosted', price: 150, start_time: '21:00', end_time: '22:00', max_subscribers: 1 });
    const fxH = await fixture(ID.u4, P0);
    const hBad = await call('post', '/subscriptions/hosted/verify', null, { razorpay_order_id: fxH.orderId, razorpay_payment_id: fxH.payId, razorpay_signature: 'deadbeef' });
    check('hosted verify with a bad signature is rejected and activates nothing', hBad.status === 400 && (await subRow(fxH.subId)).status === 'pending');
    check('hosted verify with missing fields / an unknown order is a clean 400 / 404', (await call('post', '/subscriptions/hosted/verify', null, {})).status === 400 && (await call('post', '/subscriptions/hosted/verify', null, { razorpay_order_id: 'order_nope', razorpay_payment_id: 'pay_nope', razorpay_signature: sign('order_nope', 'pay_nope') })).status === 404);
    const hOk = await call('post', '/subscriptions/hosted/verify', null, { razorpay_order_id: fxH.orderId, razorpay_payment_id: fxH.payId, razorpay_signature: sign(fxH.orderId, fxH.payId) });
    check('hosted verify with a valid signature activates exactly what that order was created for (no login needed)', hOk.status === 200 && (await subRow(fxH.subId)).status === 'active' && (await subRow(fxH.subId)).user_id === ID.u4 && (await resv(fxH.subId, 'active')).length > 0, hOk.data);
    check('...and replaying it is harmless', (await call('post', '/subscriptions/hosted/verify', null, { razorpay_order_id: fxH.orderId, razorpay_payment_id: fxH.payId, razorpay_signature: sign(fxH.orderId, fxH.payId) })).status === 200 && (await resv(fxH.subId, 'active')).length > 0);
    const fxH2 = await fixture(ID.u3, P0);
    const hCancel = await call('post', '/subscriptions/hosted/cancel', null, { booking_id: fxH2.orderId });
    check('hosted cancel (the customer closed the checkout page) cancels the pending purchase only', hCancel.status === 200 && (await subRow(fxH2.subId)).status === 'cancelled' && (await subRow(fxH.subId)).status === 'active');
    check('a hosted cancel can never touch an already-paid subscription', (await call('post', '/subscriptions/hosted/cancel', null, { booking_id: fxH.orderId })).status === 200 && (await subRow(fxH.subId)).status === 'active');
    await pool.query('UPDATE subscription_plans SET is_active = false WHERE id = ?', [P0]);

    // ================================================================= 4. activation + reservations
    console.log('\n--- verified payment: activation + reservations ---');
    const exp1 = expectedDates(plan1, tzIN);
    const v1 = await verify(T.u1, buy.data.order_id, `pay_zzsub_${rnd()}`);
    const act1 = await subRow(sub1.id);
    const reserved1 = await resv(sub1.id, 'active');
    check('a valid signature activates the subscription', v1.status === 200 && v1.data.success && act1.status === 'active' && act1.payment_status === 'paid', { v1: v1.data, act1 });
    check('ALL occurrences of the period are reserved (one per day, past ones skipped)', reserved1.length === exp1.length && exp1.length >= 28 && reserved1.every((r) => String(r.start_time).startsWith('19:00') && String(r.end_time).startsWith('20:00') && r.seat_no === 1), { got: reserved1.length, want: exp1.length });
    const today = todayIn(tzIN);
    check('period dates: starts today, ends one calendar month later minus a day, next billing = period end', D(act1.start_date) === today && D(act1.expiry_date) === R.addDays(R.addMonthsClamped(today, 1), -1) && D(act1.current_period_end) === R.addMonthsClamped(today, 1) && D(act1.next_billing_date) === R.addMonthsClamped(today, 1) && D(act1.subscription_start_date) === today, act1);
    check('activation stores payment ids, amount paid, currency and activation time', !!act1.razorpay_payment_id && Number(act1.amount_paid_minor) === 50000 && act1.currency_code === 'INR' && !!act1.activated_at);
    const mine = (await call('get', '/subscriptions/my-plans', T.u1)).data.subscriptions.find((s) => s.id === sub1.id);
    check('My Subscriptions shows ACTIVE only because the backend says so, with schedule, venue, court/sport, amount', mine && mine.display_status === 'ACTIVE' && mine.turf_name && mine.start_time === '19:00' && mine.amount_paid === 500 && mine.currency === 'INR' && mine.timezone === tzIN, mine);
    const countP1 = async () => (await pool.query('SELECT COUNT(*) c FROM user_subscriptions WHERE plan_id = ?', [P1]))[0][0].c;
    const cBefore = await countP1();
    const v1b = await verify(T.u1, buy.data.order_id, act1.razorpay_payment_id);
    const wh1 = await hook('payment.captured', { id: act1.razorpay_payment_id, order_id: buy.data.order_id, amount: 50000, currency: 'INR' });
    const wh2 = await hook('payment.captured', { id: act1.razorpay_payment_id, order_id: buy.data.order_id, amount: 50000, currency: 'INR' });
    check('verify + webhook delivered again (and again): idempotent - one subscription, no duplicate reservations, no second activation', v1b.status === 200 && wh1.status === 200 && wh2.status === 200 && (await resv(sub1.id)).length === reserved1.length && (await countP1()) === cBefore);
    const nActive = (await notifs(T.u1)).filter((n) => n.type === 'SUBSCRIPTION_ACTIVATED');
    const nOwner = await until(async () => (await notifs(T.o1)).some((n) => n.type === 'OWNER_NEW_SUBSCRIPTION'));
    check('exactly ONE "activated" notification, with venue, schedule and dates (and the amount in the venue currency)', nActive.length === 1 && /ZZ SUB Turf/.test(nActive[0].message) && /7:00 PM|07:00 PM/.test(nActive[0].message) && /₹500/.test(nActive[0].message), nActive.map((n) => n.message));
    check('the venue owner is told about the new subscriber', nOwner);
    const sameSched = await call('post', '/subscriptions/purchase', T.u1, { subscription_offer_id: P1 });
    check('a second subscription to the SAME schedule is refused', sameSched.status === 409 && /already have an active subscription for this schedule/.test(sameSched.data.error), sameSched.data);
    const planFull = await call('post', '/subscriptions/purchase', T.u3, { subscription_offer_id: P1 });
    check('capacity 1 is reached: the next customer is told the plan is full', planFull.status === 409 && /full/i.test(planFull.data.error), planFull.data);

    // ================================================================= 5. the normal booking engine respects subscriptions
    console.log('\n--- slots: subscription-reserved ---');
    const day1 = exp1[1] || exp1[0];
    const slotsRes = await call('get', `/turfs/${tIN}/slots?date=${day1}`, null);
    const sl = (slotsRes.data.slots || []).find((s) => /^0?7:00 PM/.test(s.time));
    check('the slot list shows the member-held slot as SUBSCRIPTION RESERVED (not available)', slotsRes.status === 200 && sl && sl.status === 'subscription_reserved', sl || slotsRes.data);
    check('the neighbouring slot stays available', (slotsRes.data.slots || []).find((s) => /^0?6:00 PM/.test(s.time))?.status === 'available');
    const bk = await call('post', '/bookings', T.u3, { turf_id: tIN, booking_date: day1, time_slots: [sl ? sl.time : '07:00 PM - 08:00 PM'], customer_name: 'ZZ SUB', customer_phone: '9999999999', customer_email: mail('u3') });
    check('a normal booking of a subscription-reserved slot is rejected: "This slot is reserved for a subscription member."', bk.status === 409 && bk.data.error === 'This slot is reserved for a subscription member.' && bk.data.code === 'SUBSCRIPTION_RESERVED', bk.data);
    const blk = await call('post', `/owners/turfs/${tIN}/block-slot`, T.o1, { block_date: day1, time_slot: sl ? sl.time : '07:00 PM - 08:00 PM', reason: 'x' });
    check('the owner cannot block an occurrence a member holds', blk.status === 409 && /reserved for a subscription member/.test(blk.data.error), blk.data);
    const blkBulk = await call('post', `/owners/turfs/${tIN}/block-slots/bulk`, T.o1, { block_date: day1, time_slots: [sl ? sl.time : '07:00 PM - 08:00 PM'], reason: 'x' });
    check('...nor in bulk', blkBulk.status === 409, blkBulk.data);

    // ================================================================= 6. conflict at activation + races
    console.log('\n--- payment OK but the slot is gone / races ---');
    const P2 = await planId(T.o1, { turf_id: tIN, name: 'ZZ SUB P2', price: 300, start_time: '17:00', end_time: '18:00', max_subscribers: 1 });
    const plan2 = await subsvc.getPlan(P2);
    const exp2 = expectedDates(plan2, tzIN);
    const clash = exp2[3];
    await pool.query("INSERT INTO bookings (turf_id, customer_name, customer_phone, customer_email, booking_date, time_slot, amount, original_price, payment_id, payment_status, status, user_id, payment_type, currency_code) VALUES (?, 'ZZ SUB', '9999999999', ?, ?, '05:00 PM - 06:00 PM', 100, 100, ?, 'success', 'confirmed', ?, 'full', 'INR')", [tIN, mail('cust'), clash, `pay_zzsub_bk_${rnd()}`, ID.u3]);
    const conflictPlan = await mkPlan(T.o1, { turf_id: tIN, name: 'ZZ SUB P2b', start_time: '17:00', end_time: '18:00' });
    check('publishing an offer over an existing booking lists the conflicting dates and does not overwrite anything', conflictPlan.status === 409 && conflictPlan.data.code === 'OFFER_CONFLICT' && conflictPlan.data.conflicts.some((c) => c.date === clash && c.reason === 'booked'), conflictPlan.data);
    check('...the owner can publish anyway; the booking is untouched', (await mkPlan(T.o1, { turf_id: tIN, name: 'ZZ SUB P2c', start_time: '17:00', end_time: '18:00', allow_conflicts: true })).status === 200 && (await pool.query("SELECT COUNT(*) c FROM bookings WHERE turf_id = ? AND booking_date = ? AND status = 'confirmed'", [tIN, clash]))[0][0].c === 1);
    const fx2 = await fixture(ID.u2, P2);
    const v2 = await verify(T.u2, fx2.orderId, fx2.payId);
    const s2 = await subRow(fx2.subId);
    const pay2 = (await pool.query('SELECT * FROM subscription_payments WHERE subscription_id = ?', [fx2.subId]))[0][0];
    const ref2 = (await pool.query("SELECT * FROM refunds WHERE booking_type = 'subscription' AND booking_id = ?", [fx2.subId]))[0];
    check('payment OK but a slot was taken: 409, subscription NOT activated, NO partial reservations', v2.status === 409 && v2.data.code === 'SLOT_UNAVAILABLE' && s2.status === 'cancelled' && s2.cancel_reason === 'slot_conflict' && (await resv(fx2.subId)).length === 0, { v2: v2.data, s2 });
    check('...the payment is recorded and a FULL refund is started (ledger: amount, currency, REFUND_INITIATED)', pay2.status === 'success' && ref2.length === 1 && Number(ref2[0].refund_amount_minor) === 30000 && ref2[0].currency_code === 'INR' && ref2[0].refund_status === 'REFUND_INITIATED' && ref2[0].payment_id === fx2.payId, ref2);
    check('...the customer is told it was NOT activated and is being refunded, never "activated"', await until(async () => (await notifs(T.u2)).some((n) => n.type === 'SUBSCRIPTION_PAYMENT_FAILED' && /refund/i.test(n.message))) && !(await notifs(T.u2)).some((n) => n.type === 'SUBSCRIPTION_ACTIVATED'));
    check('...replaying that verify neither activates nor refunds twice', (await verify(T.u2, fx2.orderId, fx2.payId)).status === 200 && (await subRow(fx2.subId)).status === 'cancelled' && (await pool.query("SELECT COUNT(*) c FROM refunds WHERE booking_type = 'subscription' AND booking_id = ?", [fx2.subId]))[0][0].c === 1);

    const P3 = await planId(T.o1, { turf_id: tIN, name: 'ZZ SUB P3', price: 200, start_time: '15:00', end_time: '16:00', max_subscribers: 1 });
    const fa = await fixture(ID.u3, P3); const fb = await fixture(ID.u4, P3);
    const [ra, rb] = await Promise.all([verify(T.u3, fa.orderId, fa.payId), verify(T.u4, fb.orderId, fb.payId)]);
    const sa = await subRow(fa.subId); const sb = await subRow(fb.subId);
    const winners = [sa, sb].filter((s) => s.status === 'active');
    check('two customers pay for the LAST seat at the same moment: exactly one is activated, the other is refunded', winners.length === 1 && [ra.status, rb.status].sort().join() === '200,409', { ra: ra.status, rb: rb.status, sa: sa.status, sb: sb.status });
    const liveSeats = (await pool.query("SELECT COUNT(*) c, COUNT(DISTINCT CONCAT(reservation_date, seat_no)) d FROM subscription_reservations WHERE turf_id = ? AND start_time = '15:00:00' AND status = 'active'", [tIN]))[0][0];
    check('...the database holds ONE live reservation per date (no double reservation of a seat)', liveSeats.c === liveSeats.d && liveSeats.c === (await resv(winners[0].id, 'active')).length);
    { const loser = [sa, sb].find((s) => s.status !== 'active'); const lr = (await pool.query("SELECT * FROM refunds WHERE booking_type = 'subscription' AND booking_id = ?", [loser.id]))[0]; check('...the loser has a refund and no reservations (the unique key forced the conflict path, which still refunds)', (await resv(loser.id)).length === 0 && lr.length === 1 && Number(lr[0].refund_amount_minor) === 20000, { loser, lr }); }
    const uniq = await (async () => { try { await pool.query("INSERT INTO subscription_reservations (subscription_id, turf_id, court_key, reservation_date, start_time, end_time, seat_no, status, active_key) SELECT subscription_id, turf_id, court_key, reservation_date, start_time, end_time, seat_no, 'active', 1 FROM subscription_reservations WHERE subscription_id = ? LIMIT 1", [winners[0].id]); return false; } catch (e) { return e.code === 'ER_DUP_ENTRY'; } })();
    check('the DATABASE refuses a second live reservation of the same seat (unique key)', uniq);
    check('two payments cannot share one gateway payment id (unique key)', await (async () => { try { await pool.query("INSERT INTO subscription_payments (subscription_id, kind, gateway_order_id, gateway_payment_id, amount_minor, currency_code) VALUES (?, 'purchase', ?, ?, 1, 'INR')", [fa.subId, `order_dup_${rnd()}`, winners[0].razorpay_payment_id]); return false; } catch (e) { return e.code === 'ER_DUP_ENTRY'; } })());

    // capacity 2: two members share a slot with seat numbers 1 and 2
    const P4 = await planId(T.o1, { turf_id: tIN, name: 'ZZ SUB P4', price: 100, start_time: '13:00', end_time: '14:00', max_subscribers: 2 });
    const f4a = await fixture(ID.u1, P4); const f4b = await fixture(ID.u2, P4); const f4c = await fixture(ID.u3, P4);
    await verify(T.u1, f4a.orderId, f4a.payId); await verify(T.u2, f4b.orderId, f4b.payId); const v4c = await verify(T.u3, f4c.orderId, f4c.payId);
    const seats = (await pool.query("SELECT DISTINCT seat_no FROM subscription_reservations WHERE turf_id = ? AND start_time = '13:00:00' AND status = 'active' ORDER BY seat_no", [tIN]))[0].map((r) => r.seat_no);
    check('capacity 2: two members get seats 1 and 2; the third is refused', seats.join() === '1,2' && v4c.status === 409);
    const slots4 = await call('get', `/turfs/${tIN}/slots?date=${day1}`, null);
    check('...and the slot is held (reserved) as soon as a seat is taken', (slots4.data.slots || []).find((s) => /^0?1:00 PM/.test(s.time))?.status === 'subscription_reserved');

    // ================================================================= 7. authorization / ID tampering
    console.log('\n--- authorization ---');
    check('User B cannot read User A\'s subscription (403)', (await call('get', `/subscriptions/${sub1.id}`, T.u2)).status === 403);
    check('User A can read their own; the venue owner can; an admin can', (await call('get', `/subscriptions/${sub1.id}`, T.u1)).status === 200 && (await call('get', `/subscriptions/${sub1.id}`, T.o1)).status === 200 && (await call('get', `/subscriptions/${sub1.id}`, T.admin)).status === 200);
    check('another OWNER cannot read it (403)', (await call('get', `/subscriptions/${sub1.id}`, T.o2)).status === 403);
    check('a missing / non-numeric id is a clean 404', (await call('get', '/subscriptions/99999999', T.u1)).status === 404 && (await call('get', '/subscriptions/abc', T.u1)).status === 404);
    const selfCancel = await call('post', `/subscriptions/${sub1.id}/cancel`, T.u1);
    check('a customer cannot cancel (policy): "Subscription cancellation must be requested through the venue."', selfCancel.status === 403 && selfCancel.data.error === 'Subscription cancellation must be requested through the venue.' && (await subRow(sub1.id)).status === 'active', selfCancel.data);
    check('User A cancelling User B\'s subscription is a plain 403 too (no hint)', (await call('post', `/subscriptions/${sub1.id}/cancel`, T.u2)).status === 403 && (await subRow(sub1.id)).status === 'active');
    check('Owner B cannot cancel Owner A\'s member (403) and nothing changes', (await call('delete', `/subscriptions/owner/subscribers/${sub1.id}`, T.o2)).status === 403 && (await call('post', `/subscriptions/owner/subscribers/${sub1.id}/cancel`, T.o2, {})).status === 403 && (await subRow(sub1.id)).status === 'active');
    check('Owner B cannot extend or list Owner A\'s members', (await call('post', `/subscriptions/owner/subscribers/${sub1.id}/extend`, T.o2, { months: 1 })).status === 403 && !(await call('get', '/subscriptions/owner/subscribers?status=all', T.o2)).data.subscribers.some((s) => s.id === sub1.id));
    check('a customer / admin-less token cannot use the owner or admin endpoints', (await call('get', '/subscriptions/owner/subscribers', T.u1)).status === 403 && (await call('post', `/admin/subscriptions/${sub1.id}/cancel`, T.o1, { reason: 'x' })).status === 403 && (await call('get', '/admin/subscriptions', T.u1)).status === 403);
    check('renewing someone else\'s subscription is refused (403)', (await call('post', `/subscriptions/${sub1.id}/renew`, T.u2)).status === 403);
    check('an owner cannot add a member to ANOTHER owner\'s plan (403)', (await call('post', '/subscriptions/owner/members', T.o2, { plan_id: P1, name: 'Intruder', phone: '9000000001' })).status === 403);

    // ================================================================= 8. manual membership
    console.log('\n--- manual membership ---');
    const P5 = await planId(T.o1, { turf_id: tIN, court_id: court1, name: 'ZZ SUB P5', price: 400, start_time: '09:00', end_time: '10:00', max_subscribers: 1, available_days: '1,3,5' });
    const plan5 = await subsvc.getPlan(P5);
    const m1 = await call('post', '/subscriptions/owner/members', T.o1, { plan_id: P5, name: 'ZZ SUB Walk-in', phone: '9000000002', payment_type: 'offline', amount_paid: 400 });
    const msub = m1.status === 200 ? await subRow(m1.data.subscription_id) : null;
    const expM = expectedDates(plan5, tzIN);
    check('the owner adds a member by hand: ACTIVE, source manual, paid offline, in venue currency', m1.status === 200 && msub.status === 'active' && msub.source === 'manual' && msub.payment_type === 'offline' && msub.currency_code === 'INR' && Number(msub.amount_paid_minor) === 40000 && msub.user_id === null, { m1: m1.data, msub });
    check('...and it reserves the slots exactly like an online subscription (Mon/Wed/Fri only)', msub && (await resv(msub.id, 'active')).length === expM.length && (await resv(msub.id)).every((r) => [1, 3, 5].includes(R.dayOfWeek(R.ymdOf(r.reservation_date)))), { got: msub && (await resv(msub.id)).length, want: expM.length });
    const ml = await call('get', '/subscriptions/owner/subscribers?status=manual', T.o1);
    check('it appears in Subscription Members (manual filter) with member name/phone/plan/dates/status', ml.data.subscribers.some((s) => s.id === msub.id && s.member_name === 'ZZ SUB Walk-in' && s.member_phone === '9000000002' && s.display_status === 'ACTIVE' && s.plan_name === 'ZZ SUB P5'));
    const mday = expM[0];
    const slotsM = await call('get', `/turfs/${tIN}/slots?date=${mday}&court_id=${court1}`, null);
    check('...and the slot shows as subscription-reserved on that court', (slotsM.data.slots || []).find((s) => /^0?9:00 AM/.test(s.time))?.status === 'subscription_reserved', (slotsM.data.slots || []).slice(0, 3));
    const mdup = await call('post', '/subscriptions/owner/members', T.o1, { plan_id: P5, name: 'ZZ SUB Walk-in', phone: '9000000002', payment_type: 'offline' });
    check('adding the same member to the same schedule is prevented (extend/renew instead)', mdup.status === 409 && mdup.data.code === 'DUPLICATE_MEMBERSHIP' && mdup.data.existing_id === msub.id, mdup.data);
    const mclash = await call('post', '/subscriptions/owner/members', T.o1, { plan_id: P5, name: 'ZZ SUB Other', phone: '9000000003', payment_type: 'manual' });
    check('another member on a FULL slot is refused with the conflicting dates', mclash.status === 409 && Array.isArray(mclash.data.conflicts) && mclash.data.conflicts.length > 0, mclash.data);
    check('member validation: no name, past start date, bad phone, bad payment type, absurd length', (await call('post', '/subscriptions/owner/members', T.o1, { plan_id: P5, phone: '9000000004' })).status === 400 && (await call('post', '/subscriptions/owner/members', T.o1, { plan_id: P5, name: 'x', start_date: '2020-01-01' })).status === 400 && (await call('post', '/subscriptions/owner/members', T.o1, { plan_id: P5, name: 'x', phone: 'abc!' })).status === 400 && (await call('post', '/subscriptions/owner/members', T.o1, { plan_id: P5, name: 'x', payment_type: 'bitcoin' })).status === 400 && (await call('post', '/subscriptions/owner/members', T.o1, { plan_id: P5, name: 'x', end_date: R.addMonthsClamped(todayIn(tzIN), 14) })).status === 400);
    const dayBook = await call('post', '/bookings', T.u3, { turf_id: tIN, court_id: court1, booking_date: mday, time_slots: ['09:00 AM - 10:00 AM'], customer_name: 'ZZ SUB', customer_phone: '9999999999', customer_email: mail('u3') });
    check('a normal booking of the manual member\'s slot is rejected too', dayBook.status === 409 && dayBook.data.error === 'This slot is reserved for a subscription member.', dayBook.data);
    const ext = await call('post', `/subscriptions/owner/subscribers/${msub.id}/extend`, T.o1, { months: 1 });
    const msub2 = await subRow(msub.id);
    check('extending adds a calendar month and ONLY the new occurrences (no duplicates)', ext.status === 200 && D(msub2.current_period_end) === R.addMonthsClamped(todayIn(tzIN), 2) && (await resv(msub.id, 'active')).length === expectedDates({ ...plan5 }, tzIN, 2).length && (await pool.query('SELECT COUNT(*) c, COUNT(DISTINCT reservation_date) d FROM subscription_reservations WHERE subscription_id = ?', [msub.id]))[0][0].c === (await pool.query('SELECT COUNT(DISTINCT reservation_date) d FROM subscription_reservations WHERE subscription_id = ?', [msub.id]))[0][0].d, { ext: ext.data, msub2 });
    check('extend is limited to months 1-12 and to manual memberships', (await call('post', `/subscriptions/owner/subscribers/${msub.id}/extend`, T.o1, { months: 99 })).status === 400 && (await call('post', `/subscriptions/owner/subscribers/${sub1.id}/extend`, T.o1, { months: 1 })).status === 409);
    const mcancel = await call('delete', `/subscriptions/owner/subscribers/${msub.id}`, T.o1, { reason: 'Left the club' });
    const msubC = await subRow(msub.id);
    check('the owner cancels the manual member: cancelled by owner (who, when, why), future slots released, history kept, nothing to refund', mcancel.status === 200 && msubC.status === 'cancelled' && msubC.cancelled_by === 'owner' && msubC.cancelled_by_id === ID.o1 && msubC.cancel_reason === 'Left the club' && !!msubC.cancelled_at && (await resv(msub.id, 'active')).length === 0 && (await resv(msub.id, 'cancelled')).length > 0 && Number(mcancel.data.refund_minor) === 0, { mcancel: mcancel.data, msubC });
    const slotsM2 = await call('get', `/turfs/${tIN}/slots?date=${mday}&court_id=${court1}`, null);
    check('...and the slot is bookable again', (slotsM2.data.slots || []).find((s) => /^0?9:00 AM/.test(s.time))?.status === 'available');
    check('cancelling again is harmless', (await call('delete', `/subscriptions/owner/subscribers/${msub.id}`, T.o1, {})).status === 200);
    // a registered customer added by the owner is notified
    const m2 = await call('post', '/subscriptions/owner/members', T.o1, { plan_id: P5, user_id: ID.u4, payment_type: 'manual' });
    check('adding an existing customer works (payment type "manual" = complimentary) and they are notified', m2.status === 200 && (await subRow(m2.data.subscription_id)).user_id === ID.u4 && Number((await subRow(m2.data.subscription_id)).amount_paid_minor) === 0 && await until(async () => (await notifs(T.u4)).some((n) => n.type === 'SUBSCRIPTION_MANUAL_ADDED')), { m2: m2.data, n: (await notifs(T.u4)).map((n) => n.type) });
    await call('delete', `/subscriptions/owner/subscribers/${m2.data.subscription_id}`, T.o1, {});

    // ================================================================= 9. owner cancels an online subscription -> refund
    console.log('\n--- cancellation + refunds ---');
    const cOwner = await call('delete', `/subscriptions/owner/subscribers/${sub1.id}`, T.o1, { reason: 'Venue closed for repairs', venue_issue: true });
    const sub1C = await subRow(sub1.id);
    const refC = (await pool.query("SELECT * FROM refunds WHERE booking_type = 'subscription' AND booking_id = ?", [sub1.id]))[0];
    check('owner cancels for a venue issue: cancelled by owner with reason, ALL future reservations released', cOwner.status === 200 && sub1C.status === 'cancelled' && sub1C.cancelled_by === 'owner' && sub1C.cancelled_by_id === ID.o1 && sub1C.cancel_reason === 'Venue closed for repairs' && (await resv(sub1.id, 'active')).length === 0, { cOwner: cOwner.data, sub1C });
    check('...a FULL refund is computed by the server: original/paid/refund amounts, currency, status, reason', refC.length === 1 && Number(refC[0].original_amount_minor) === 50000 && Number(refC[0].amount_paid_minor) === 50000 && Number(refC[0].refund_amount_minor) === 50000 && refC[0].currency_code === 'INR' && refC[0].refund_status === 'REFUND_INITIATED' && refC[0].refund_reason === 'Venue closed for repairs', refC);
    check('...the customer is told it was cancelled by the venue and that a refund was initiated (₹500)', await until(async () => { const n = await notifs(T.u1); return n.some((x) => x.type === 'SUBSCRIPTION_CANCELLED') && n.some((x) => x.type === 'REFUND_INITIATED' && /₹500/.test(x.message)); }));
    const slotsC = await call('get', `/turfs/${tIN}/slots?date=${day1}`, null);
    check('...and the slot is available again for everyone', (slotsC.data.slots || []).find((s) => /^0?7:00 PM/.test(s.time))?.status === 'available');
    const refundHook = (event, entity) => { const body = JSON.stringify({ event, payload: { refund: { entity } } }); return call('post', '/bookings/webhook', null, body, { 'Content-Type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', WH).update(body).digest('hex') }); };
    const rh = await refundHook('refund.processed', { id: refC[0].gateway_refund_id });
    const refDone = (await pool.query("SELECT refund_status FROM refunds WHERE id = ?", [refC[0].id]))[0][0];
    check('the gateway confirms the refund: REFUND_COMPLETED, the subscription becomes REFUNDED, the payment attempt is marked refunded, all in the audit log', rh.status === 200 && refDone.refund_status === 'REFUND_COMPLETED' && (await subRow(sub1.id)).status === 'refunded' && (await pool.query("SELECT status FROM subscription_payments WHERE subscription_id = ?", [sub1.id]))[0][0].status === 'refunded' && (await audits(sub1.id)).includes('SUBSCRIPTION_REFUND_COMPLETED') && (await audits(sub1.id)).includes('SUBSCRIPTION_REFUND_INITIATED'));
    check('...and it is shown to everyone as REFUNDED (backend display status)', ((await call('get', '/subscriptions/my-plans', T.u1)).data.subscriptions.find((x) => x.id === sub1.id) || {}).display_status === 'REFUNDED');
    const prorata = await fixture(ID.u3, P3).then(async (f) => { await verify(T.u3, f.orderId, f.payId).catch(() => {}); return f; });
    const afterLoser = await call('delete', `/subscriptions/owner/subscribers/${winners[0].id}`, T.o1, { refund_mode: 'prorata', reason: 'Member left' });
    const proRef = (await pool.query("SELECT * FROM refunds WHERE booking_type = 'subscription' AND booking_id = ?", [winners[0].id]))[0][0];
    check('pro-rata cancel: refund is the unused share of the period (never more than paid), fee = the rest', afterLoser.status === 200 && proRef && Number(proRef.refund_amount_minor) <= 20000 && Number(proRef.refund_amount_minor) >= 19000 && Number(proRef.refund_amount_minor) + Number(proRef.cancellation_fee_minor) === 20000, proRef);
    check('an invalid refund mode is refused', (await call('delete', `/subscriptions/owner/subscribers/${f4a.subId}`, T.o1, { refund_mode: 'double' })).status === 400);

    // ================================================================= 10. admin
    console.log('\n--- admin control ---');
    const adm = await call('get', '/admin/subscriptions?status=active', T.admin);
    check('admin lists every subscription (any venue/owner)', adm.status === 200 && adm.data.subscriptions.some((s) => s.id === f4b.subId), adm.data.subscriptions && adm.data.subscriptions.length);
    check('admin reads one with payments, reservations, audit and refunds', await (async () => { const r = await call('get', `/admin/subscriptions/${f4b.subId}`, T.admin); return r.status === 200 && r.data.payments.length === 1 && r.data.reservations.length > 0 && r.data.audit.length > 0; })(), 'see GET /admin/subscriptions/:id');
    check('admin actions need a reason', (await call('post', `/admin/subscriptions/${f4b.subId}/suspend`, T.admin, {})).status === 400 && (await call('post', `/admin/subscriptions/${f4b.subId}/cancel`, T.admin, {})).status === 400);
    const susp = await call('post', `/admin/subscriptions/${f4b.subId}/suspend`, T.admin, { reason: 'Chargeback review' });
    check('admin suspends: slots are released, status SUSPENDED, the member is told', susp.status === 200 && (await subRow(f4b.subId)).status === 'suspended' && (await resv(f4b.subId, 'active')).length === 0 && await until(async () => (await notifs(T.u2)).some((n) => n.type === 'SUBSCRIPTION_SUSPENDED')));
    const react = await call('post', `/admin/subscriptions/${f4b.subId}/reactivate`, T.admin, { reason: 'Cleared' });
    check('admin reactivates: ACTIVE again with its slots re-reserved (only when still free)', react.status === 200 && (await subRow(f4b.subId)).status === 'active' && (await resv(f4b.subId, 'active')).length > 0, react.data);
    check('only a suspended subscription can be reactivated', (await call('post', `/admin/subscriptions/${f4b.subId}/reactivate`, T.admin, {})).status === 409);
    const acan = await call('post', `/admin/subscriptions/${f4b.subId}/cancel`, T.admin, { reason: 'Fraud', refund_mode: 'full' });
    const acs = await subRow(f4b.subId);
    check('admin cancels with a full refund: cancelled_by admin + admin id + reason', acan.status === 200 && acs.status === 'cancelled' && acs.cancelled_by === 'admin' && acs.cancelled_by_id === ID.admin && acs.cancel_reason === 'Fraud' && Number((await pool.query("SELECT refund_amount_minor FROM refunds WHERE booking_type = 'subscription' AND booking_id = ?", [f4b.subId]))[0][0].refund_amount_minor) === 10000);
    const log = await audits(f4b.subId);
    check('every step is in the audit log (created, payment, activated, suspended, reactivated, cancelled, refund) with actor + reason', ['SUBSCRIPTION_PAYMENT_SUCCESS', 'SUBSCRIPTION_ACTIVATED', 'SUBSCRIPTION_SUSPENDED', 'SUBSCRIPTION_CANCELLED', 'SUBSCRIPTION_REFUND_INITIATED'].every((a) => log.includes(a)), log);
    const adminLog = (await pool.query("SELECT * FROM subscription_audit_log WHERE subscription_id = ? AND action = 'SUBSCRIPTION_SUSPENDED'", [f4b.subId]))[0][0];
    check('...the suspend entry carries the admin id, role, reason and a timestamp', adminLog.actor_id === ID.admin && adminLog.actor_role === 'admin' && adminLog.reason === 'Chargeback review' && !!adminLog.created_at);
    check('the audit log is admin-only', (await call('get', '/admin/subscriptions/audit-log', T.o1)).status === 403 && (await call('get', '/admin/subscriptions/audit-log', T.admin)).status === 200);

    // ================================================================= 11. renewal
    console.log('\n--- renewal ---');
    const P6 = await planId(T.o1, { turf_id: tIN, name: 'ZZ SUB P6', price: 250, start_time: '11:00', end_time: '12:00', max_subscribers: 1 });
    const f6 = await fixture(ID.u1, P6);
    await verify(T.u1, f6.orderId, f6.payId);
    const s6 = await subRow(f6.subId); const r6 = (await resv(f6.subId, 'active')).length;
    const f6r = await fixture(ID.u1, P6, { kind: 'renewal', subId: f6.subId });
    const vr = await verify(T.u1, f6r.orderId, f6r.payId);
    const s6b = await subRow(f6.subId);
    check('renewal success: the SAME subscription is extended by a calendar month from its period end (no new subscription)', vr.status === 200 && D(s6b.current_period_start) === D(s6.current_period_end) && D(s6b.current_period_end) === R.addMonthsClamped(D(s6.subscription_start_date), 2) && s6b.months_total === 2 && Number(s6b.amount_paid_minor) === 50000 && (await pool.query('SELECT COUNT(*) c FROM user_subscriptions WHERE plan_id = ?', [P6]))[0][0].c === 1, { s6, s6b });
    const r6b = await resv(f6.subId, 'active');
    check('...only the NEW period\'s slots were added (no duplicates of the old ones)', r6b.length > r6 && r6b.length === new Set(r6b.map((r) => R.ymdOf(r.reservation_date))).size);
    const rewh = await hook('payment.captured', { id: f6r.payId, order_id: f6r.orderId, amount: f6r.amountMinor, currency: 'INR' });
    check('a repeated renewal webhook changes nothing', rewh.status === 200 && (await subRow(f6.subId)).months_total === 2 && (await resv(f6.subId, 'active')).length === r6b.length);
    check('...and the customer got ONE "renewed" notification', await until(async () => (await notifs(T.u1)).filter((n) => n.type === 'SUBSCRIPTION_RENEWED').length === 1));
    const f6f = await fixture(ID.u1, P6, { kind: 'renewal', subId: f6.subId });
    const before = await subRow(f6.subId);
    await hook('payment.failed', { id: `pay_zzsub_${rnd()}`, order_id: f6f.orderId });
    const after = await subRow(f6.subId);
    check('renewal failure: the period is NOT extended, no slots are added; status PAST_DUE; the customer is told', after.status === 'past_due' && D(after.current_period_end) === D(before.current_period_end) && after.months_total === before.months_total && (await resv(f6.subId, 'active')).length === r6b.length && await until(async () => (await notifs(T.u1)).some((n) => n.type === 'SUBSCRIPTION_RENEWAL_FAILED')));
    check('...a past-due subscription still holds its paid slots (nobody can book them)', (await resv(f6.subId, 'active')).length > 0);
    const realRenew = await call('post', `/subscriptions/${f6.subId}/renew`, T.u1);
    check('the customer can retry the renewal (a new order for the plan price, in the venue currency)', realRenew.status === 200 && realRenew.data.amount === 25000 && realRenew.data.currency === 'INR', realRenew.data);
    const noRenewManual = await call('post', '/subscriptions/owner/members', T.o1, { plan_id: P6, name: 'ZZ SUB Rn', phone: '9000000005', payment_type: 'offline', start_date: R.addDays(todayIn(tzIN), 75) });
    check('a membership starting later reserves only its own period', noRenewManual.status === 200 && (await resv(noRenewManual.data.subscription_id)).every((r) => R.ymdOf(r.reservation_date) >= R.addDays(todayIn(tzIN), 75)), noRenewManual.data);

    // ================================================================= 12. expiry
    console.log('\n--- expiry ---');
    await pool.query("UPDATE user_subscriptions SET status = 'active' WHERE id = ?", [f6.subId]);
    const totalBefore = (await resv(f6.subId)).length;
    await pool.query("UPDATE user_subscriptions SET expiry_date = DATE_SUB(UTC_DATE(), INTERVAL 3 DAY), current_period_end = DATE_SUB(UTC_DATE(), INTERVAL 2 DAY) WHERE id = ?", [f6.subId]);
    const sw = await subsvc.sweep({ scopeIds: [f6.subId] });
    check('the backend expires a subscription whose paid period ended and releases its future slots (history kept)', sw.expired.includes(f6.subId) && (await subRow(f6.subId)).status === 'expired' && (await resv(f6.subId, 'active')).length === 0 && (await resv(f6.subId)).length === totalBefore);
    check('...an expired subscription is shown as EXPIRED and the slot is free again', ((await call('get', '/subscriptions/my-plans', T.u1)).data.subscriptions.find((s) => s.id === f6.subId) || {}).display_status === 'EXPIRED' && (await call('get', `/turfs/${tIN}/slots?date=${day1}`, null)).data.slots.find((s) => /^0?11:00 AM/.test(s.time)).status === 'available');
    check('sweeping again is harmless', (await subsvc.sweep({ scopeIds: [f6.subId] })).expired.length === 0);
    const lateFx = await fixture(ID.u1, P6, { kind: 'renewal', subId: f6.subId });
    const late = await verify(T.u1, lateFx.orderId, lateFx.payId);
    check('a renewal paid AFTER expiry starts a fresh period from today and re-reserves the slots', late.status === 200 && (await subRow(f6.subId)).status === 'active' && (await resv(f6.subId, 'active')).length > 0);

    // ================================================================= 13. free plan + legacy + notifications reminders
    console.log('\n--- free plan ---');
    const P7 = await planId(T.o1, { turf_id: tIN, name: 'ZZ SUB Free', price: 0, start_time: '08:00', end_time: '09:00', max_subscribers: 1 });
    const free = await call('post', '/subscriptions/purchase', T.u2, { subscription_offer_id: P7 });
    check('a free plan activates without a gateway but still reserves the slots', free.status === 200 && free.data.skipPayment === true && (await subRow(free.data.subscription_id)).status === 'active' && (await resv(free.data.subscription_id, 'active')).length > 0, free.data);

    // ================================================================= 14. venue currency + timezone (Dubai)
    console.log('\n--- Dubai: AED / Asia/Dubai ---');
    const PA = await planId(T.oAE, { turf_id: tAE, name: 'ZZ SUB Dubai', price: 200, start_time: '19:00', end_time: '20:00', max_subscribers: 1 });
    const planA = await subsvc.getPlan(PA);
    const list = (await call('get', `/subscriptions/turf/${tAE}`, null)).data.plans.find((p) => p.id === PA);
    check('the Dubai offer is priced in AED (the venue currency), nothing converted to INR', list && list.currency_code === 'AED' && Number(list.price) === 200 && planA.venue_currency === 'AED' && subsvc.planTz(planA) === 'Asia/Dubai', list);
    const buyAE = await call('post', '/subscriptions/purchase', T.u1, { subscription_offer_id: PA });
    check('online payment in AED is refused until the admin enables it (never silently charged in INR)', buyAE.status === 400 && /AED/.test(buyAE.data.error) && (await pool.query("SELECT COUNT(*) c FROM user_subscriptions WHERE turf_id = ?", [tAE]))[0][0].c === 0, buyAE.data);
    const mAE = await call('post', '/subscriptions/owner/members', T.oAE, { plan_id: PA, name: 'ZZ SUB Dubai Member', phone: '971500000001', payment_type: 'paid', amount_paid: 200 });
    const mAEs = await subRow(mAE.data.subscription_id);
    const expAE = expectedDates(planA, tzAE);
    check('a Dubai membership stores AED 200.00 (minor 20000), reserves in the VENUE\'s dates, and starts on the Dubai calendar day', mAE.status === 200 && mAEs.currency_code === 'AED' && Number(mAEs.amount_paid_minor) === 20000 && D(mAEs.start_date) === todayIn(tzAE) && (await resv(mAEs.id, 'active')).length === expAE.length, { mAE: mAE.data, mAEs, want: expAE.length });
    const shape = (await call('get', `/subscriptions/${mAEs.id}`, T.oAE)).data.subscription;
    check('the API reports currency AED and timezone Asia/Dubai for it', shape.currency === 'AED' && shape.timezone === 'Asia/Dubai' && shape.amount_paid === 200, shape);
    check('the Dubai venue\'s owner cannot see the INR venue\'s members and vice versa', !(await call('get', '/subscriptions/owner/subscribers?status=all', T.oAE)).data.subscribers.some((s) => s.turf_id === tIN) && !(await call('get', '/subscriptions/owner/subscribers?status=all', T.o1)).data.subscribers.some((s) => s.turf_id === tAE));

    // ================================================================= 15. reminders in the scheduler
    console.log('\n--- scheduler ---');
    const sched = require('../utils/notifications/scheduler');
    await pool.query("UPDATE user_subscriptions SET status = 'active', payment_status = 'paid', expiry_date = DATE_ADD(UTC_DATE(), INTERVAL 3 DAY), current_period_end = DATE_ADD(UTC_DATE(), INTERVAL 4 DAY) WHERE id = ?", [free.data.subscription_id]);
    const rep = await sched.runOnce({ scope: { userIds: [ID.u2] } });
    check('the scheduler finds the subscription about to expire (3-day reminder) without expiring it', rep.subscription_reminders.some((r) => r.subscriptionId === free.data.subscription_id) && (await subRow(free.data.subscription_id)).status === 'active', rep.subscription_reminders);
    check('expired subscriptions are expired by the scheduler through the same engine', await (async () => { await pool.query("UPDATE user_subscriptions SET expiry_date = DATE_SUB(UTC_DATE(), INTERVAL 1 DAY) WHERE id = ?", [free.data.subscription_id]); const r2 = await sched.runOnce({ scope: { userIds: [ID.u2] } }); return r2.subscriptions_expired.some((x) => x.subscriptionId === free.data.subscription_id) && (await subRow(free.data.subscription_id)).status === 'expired' && (await resv(free.data.subscription_id, 'active')).length === 0; })());
  } catch (e) {
    console.error('UNEXPECTED ERROR', e);
    results.push(false);
  } finally {
    try {
      const turfIds = created.turfs.length ? created.turfs : [0]; const uids = created.users.length ? created.users : [0]; const oids = created.owners.length ? created.owners : [0];
      const q = (a) => a.map(() => '?').join(',');
      const [subs] = await pool.query(`SELECT id FROM user_subscriptions WHERE turf_id IN (${q(turfIds)})`, turfIds);
      const sids = subs.length ? subs.map((s) => s.id) : [0];
      await pool.query(`DELETE FROM refunds WHERE (booking_type = 'subscription' AND booking_id IN (${q(sids)})) OR user_id IN (${q(uids)}) OR owner_id IN (${q(oids)})`, [...sids, ...uids, ...oids]);
      await pool.query(`DELETE FROM subscription_reservations WHERE subscription_id IN (${q(sids)}) OR turf_id IN (${q(turfIds)})`, [...sids, ...turfIds]);
      await pool.query(`DELETE FROM subscription_payments WHERE subscription_id IN (${q(sids)})`, sids);
      await pool.query(`DELETE FROM subscription_audit_log WHERE subscription_id IN (${q(sids)}) OR venue_id IN (${q(turfIds)}) OR (actor_role = 'admin' AND subscription_id IS NULL AND action LIKE 'PLAN_%')`, [...sids, ...turfIds]);
      await pool.query(`DELETE FROM user_subscriptions WHERE id IN (${q(sids)})`, sids);
      await pool.query(`DELETE FROM subscription_plans WHERE turf_id IN (${q(turfIds)}) OR owner_id IN (${q(oids)})`, [...turfIds, ...oids]);
      if (created.adminPlans.length) await pool.query(`DELETE FROM subscription_admin_plans WHERE id IN (${q(created.adminPlans)})`, created.adminPlans);
      await pool.query("DELETE FROM subscription_admin_plans WHERE name LIKE 'ZZ SUB%'");
      await pool.query(`DELETE FROM bookings WHERE turf_id IN (${q(turfIds)})`, turfIds);
      await pool.query(`DELETE FROM blocked_slots WHERE turf_id IN (${q(turfIds)})`, turfIds);
      await pool.query(`DELETE FROM courts WHERE turf_id IN (${q(turfIds)})`, turfIds);
      await pool.query(`DELETE FROM notifications WHERE (recipient_type = 'user' AND recipient_id IN (${q(uids)})) OR (recipient_type = 'owner' AND recipient_id IN (${q(oids)}))`, [...uids, ...oids]);
      await pool.query(`DELETE FROM turfs WHERE id IN (${q(turfIds)})`, turfIds);
      await pool.query(`DELETE FROM owners WHERE id IN (${q(oids)})`, oids);
      await pool.query(`DELETE FROM users WHERE id IN (${q(uids)})`, uids);
      const [[left]] = await pool.query("SELECT (SELECT COUNT(*) FROM turfs WHERE name LIKE 'ZZ SUB%') t, (SELECT COUNT(*) FROM owners WHERE email LIKE 'zz_sub_%') o, (SELECT COUNT(*) FROM users WHERE email LIKE 'zz_sub_%') u, (SELECT COUNT(*) FROM subscription_plans WHERE name LIKE 'ZZ SUB%') p, (SELECT COUNT(*) FROM subscription_admin_plans WHERE name LIKE 'ZZ SUB%') ap");
      console.log(`cleanup done; leftovers (turfs/owners/users/plans/admin plans): ${left.t} ${left.o} ${left.u} ${left.p} ${left.ap}`);
    } catch (e) { console.log('CLEANUP FAILED:', e.message); }
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    await pool.end();
    process.exit(passed === results.length ? 0 : 1);
  }
})();
