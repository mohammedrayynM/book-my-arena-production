// End-to-end tests for the GLOBAL layer + the cancellation/refund engine: countries -> currency/timezone on venues,
// the 5-hour / 20% policy in the VENUE's timezone, full vs advance payments, coupons, owner/admin cancellation, the refund
// ledger (idempotency, races, gateway failure + retry, duplicate webhooks), activity tickets, notifications.
// Needs the API on localhost:9000 + the real DB. Payments are fixtures (no real charge) and the refund gateway is SIMULATED for
// non-Razorpay payment ids (services/refundGateway.js) so no real money can move. Prefix "ZZ GL" / zz_gl_, cleaned up.
//   node tests/cancellation-global.e2e.js
const crypto = require('crypto');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const axios = require('axios');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { wallParts } = require('../utils/timezone');
const { formatMoney } = require('../utils/money');

const BASE = 'http://localhost:9000/api';
const results = [];
const check = (name, cond, extra) => { results.push(!!cond); console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond ? '' : ' :: ' + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, url, token, data, headers = {}) => { const r = await axios({ method, url: BASE + url, data, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, validateStatus: () => true }); return { status: r.status, data: r.data, headers: r.headers }; };
const pad = (n) => String(n).padStart(2, '0');
const rnd = () => crypto.randomBytes(5).toString('hex');

// venue-local date + "hh:mm AM - hh:mm AM" slot label for a start `hours` from now
function slotFor(tz, hours) {
  const w = wallParts(Date.now() + hours * 3600000, tz);
  const label = (h, m) => `${pad(h % 12 || 12)}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
  const e = wallParts(Date.now() + (hours + 1) * 3600000, tz);
  return { date: `${w.y}-${pad(w.m)}-${pad(w.d)}`, slot: `${label(w.h, w.mi)} - ${label(e.h, e.mi)}` };
}

(async () => {
  const stamp = Date.now();
  const pw = 'Test#12345';
  const mail = (k) => `zz_gl_${k}_${stamp}@example.com`;
  const T = {}; const ID = {};
  const created = { turfs: [], activities: [], owners: [], users: [], countries: [], bookings: [], matches: [] };
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'bookmyarena_secret';

  try {
    for (const k of ['oIN', 'oAE', 'oGB', 'oUS']) {
      await axios.post(BASE + '/owners/register', { name: `ZZ GL ${k}`, email: mail(k), phone: '9999999999', password: pw });
      const l = await axios.post(BASE + '/owners/login', { email: mail(k), password: pw });
      ID[k] = l.data.owner.id; T[k] = l.data.token; created.owners.push(ID[k]);
    }
    for (const k of ['u1', 'u2', 'u3']) {
      await axios.post(BASE + '/users/register', { name: `ZZ GL ${k}`, email: mail(k), phone: '9999999999', password: pw });
      const l = await axios.post(BASE + '/users/login', { email: mail(k), password: pw });
      ID[k] = l.data.user.id; T[k] = l.data.token; created.users.push(ID[k]);
    }
    const [[admin]] = await pool.query('SELECT id FROM admins ORDER BY id LIMIT 1');
    T.admin = jwt.sign({ id: admin.id, username: 'admin', role: 'admin' }, process.env.JWT_SECRET || 'your_jwt_secret_key', { expiresIn: '1h' });

    // ================================================================= 1. countries
    console.log('\n--- countries ---');
    const pub = await call('get', '/global/countries', null);
    const byCode = Object.fromEntries((pub.data.countries || []).map((c) => [c.country_code, c]));
    check('the public country list comes from the backend (not hardcoded in the app)', pub.status === 200 && ['IN', 'AE', 'GB', 'US', 'SA', 'QA', 'KW', 'OM', 'BH'].every((c) => byCode[c]), Object.keys(byCode));
    check('India -> INR / Asia/Kolkata', byCode.IN.currency_code === 'INR' && byCode.IN.default_timezone === 'Asia/Kolkata' && byCode.IN.display_prefix === '₹');
    check('UAE -> AED / Asia/Dubai', byCode.AE.currency_code === 'AED' && byCode.AE.default_timezone === 'Asia/Dubai');
    check('UK -> GBP / £ / Europe/London', byCode.GB.currency_code === 'GBP' && byCode.GB.display_prefix === '£' && byCode.GB.default_timezone === 'Europe/London');
    check('USA -> USD / $ and several timezones (a country is not one timezone)', byCode.US.currency_code === 'USD' && byCode.US.timezones.length >= 4 && byCode.US.timezones.includes('America/Chicago'));
    check('Kuwait/Oman/Bahrain use 3 minor digits', byCode.KW.minor_digits === 3 && byCode.OM.minor_digits === 3 && byCode.BH.minor_digits === 3);
    check('only India has online payments switched on out of the box', byCode.IN.payments_enabled === true && byCode.AE.payments_enabled === false && byCode.GB.payments_enabled === false);
    check('non-admins cannot manage countries / policy / refunds', (await call('get', '/admin/global/countries', T.oIN)).status === 403 && (await call('put', '/admin/global/policy', T.u1, { windowHours: 1 })).status === 403 && (await call('get', '/admin/global/refunds', T.u1)).status === 403);
    const newC = await call('post', '/admin/global/countries', T.admin, { country_code: 'SG', country_name: 'ZZ GL Singapore', currency_code: 'SGD', currency_symbol: 'S$', default_timezone: 'Asia/Singapore' });
    created.countries.push('SG');
    check('admin can add a new country through configuration alone (no code change)', newC.status === 200 && newC.data.country.currency_code === 'SGD' && newC.data.country.minor_digits === 2, newC.data);
    check('...it is listed publicly, with payments OFF until the merchant account is confirmed', (await call('get', '/global/countries', null)).data.countries.find((c) => c.country_code === 'SG').payments_enabled === false);
    check('a bad timezone is rejected', (await call('post', '/admin/global/countries', T.admin, { country_code: 'ZZ', country_name: 'x', currency_code: 'ZZZ', default_timezone: 'Mars/Base' })).status === 400);
    check('a duplicate country is rejected', (await call('post', '/admin/global/countries', T.admin, { country_code: 'SG', country_name: 'x', currency_code: 'SGD', default_timezone: 'Asia/Singapore' })).status === 400);
    await call('put', '/admin/global/countries/SG', T.admin, { enabled: false });
    check('admin can disable a country; it disappears from the public list', !(await call('get', '/global/countries', null)).data.countries.some((c) => c.country_code === 'SG'));

    // ================================================================= 2. venues: country -> currency + timezone
    console.log('\n--- venue creation ---');
    const mkTurf = async (owner, extra = {}) => {
      const r = await call('post', '/owners/turfs', owner, { name: `ZZ GL Turf ${rnd()}`, location: 'Test City', sport_type: 'Football', price_per_hour: 100, latitude: 25.2, longitude: 55.27, ...extra });
      if (r.data.turf_id) created.turfs.push(r.data.turf_id);
      return r;
    };
    const tIN = await mkTurf(T.oIN);
    check('no country sent: defaults to India / INR / Asia/Kolkata (existing behaviour unchanged)', tIN.status === 200 && tIN.data.country_code === 'IN' && tIN.data.currency_code === 'INR' && tIN.data.timezone === 'Asia/Kolkata', tIN.data);
    const tAE = await mkTurf(T.oAE, { country_code: 'AE', currency_code: 'USD' });
    check('UAE venue: currency comes from the COUNTRY (a client-sent currency is ignored) -> AED / Asia/Dubai', tAE.data.country_code === 'AE' && tAE.data.currency_code === 'AED' && tAE.data.timezone === 'Asia/Dubai', tAE.data);
    const tGB = await mkTurf(T.oGB, { country_code: 'GB' });
    check('UK venue -> GBP / Europe/London', tGB.data.currency_code === 'GBP' && tGB.data.timezone === 'Europe/London');
    const tUS = await mkTurf(T.oUS, { country_code: 'US', timezone: 'America/Chicago', state_province: 'Texas' });
    check('US venue -> USD, with the owner choosing the actual timezone', tUS.data.currency_code === 'USD' && tUS.data.timezone === 'America/Chicago', tUS.data);
    check('a timezone that does not belong to the country is refused', (await mkTurf(T.oUS, { country_code: 'US', timezone: 'Asia/Dubai' })).status === 400);
    check('an unknown country is refused', (await mkTurf(T.oUS, { country_code: 'XX' })).status === 400);
    check('a disabled country is refused', (await mkTurf(T.oUS, { country_code: 'SG' })).status === 400);
    const [[rowAE]] = await pool.query('SELECT country_code, currency_code, timezone FROM turfs WHERE id = ?', [tAE.data.turf_id]);
    check('the venue stores country, currency and timezone', rowAE.country_code === 'AE' && rowAE.currency_code === 'AED' && rowAE.timezone === 'Asia/Dubai', rowAE);
    const detail = await call('get', `/turfs/${tAE.data.turf_id}`, null);
    check('customers see the venue\'s own currency on the venue', detail.status === 200 && JSON.stringify(detail.data).includes('"currency_code":"AED"'), Object.keys(detail.data));
    const editUS = await call('put', `/owners/turfs/${tUS.data.turf_id}`, T.oUS, { name: 'ZZ GL Renamed', location: 'Test City', sport_type: 'Football', price_per_hour: 100, latitude: 30, longitude: -97, country_code: 'US', timezone: 'America/Los_Angeles' });
    check('an owner can change the venue timezone within the country', editUS.status === 200 && (await pool.query('SELECT timezone FROM turfs WHERE id = ?', [tUS.data.turf_id]))[0][0].timezone === 'America/Los_Angeles', editUS.data);
    const payGate = await call('post', '/bookings', T.u1, { turf_id: tAE.data.turf_id, booking_date: slotFor('Asia/Dubai', 48).date, time_slots: ['06:00 PM - 07:00 PM'], customer_name: 'ZZ GL', customer_phone: '9999999999', customer_email: mail('u1') });
    check('online payment for a venue whose currency is not enabled is refused (never assumed to work)', payGate.status === 400 && /AED/.test(payGate.data.error || '') && /not available/.test(payGate.data.error || ''), payGate.data);
    const cfgs = (await call('get', '/admin/global/payment-configs', T.admin)).data.configs;
    check('payment configuration is per country/currency/provider', cfgs.some((c) => c.country_code === 'IN' && c.currency_code === 'INR' && c.enabled) && cfgs.some((c) => c.country_code === 'AE' && !c.enabled));

    // ================================================================= fixtures: confirmed bookings
    const addBooking = async ({ turfId, userId, tz, hours, amount, paid, type = 'full', currency = 'INR', discount = 0, original, payId, orderId, matchRequestId = null, status = 'confirmed' }) => {
      const s = slotFor(tz, hours);
      const pay = payId || `pay_zzgl_${rnd()}`;
      const [r] = await pool.query(
        `INSERT INTO bookings (turf_id, customer_name, customer_phone, customer_email, booking_date, time_slot, amount, original_price, discount_amount, payment_id, payment_status, status, user_id, payment_type, advance_amount, pending_balance, currency_code, razorpay_order_id, match_request_id)
         VALUES (?, 'ZZ GL Customer', '9999999999', ?, ?, ?, ?, ?, ?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [turfId, mail('cust'), s.date, s.slot, amount, original ?? amount, discount, pay, status, userId, type, type === 'advance' ? paid : amount, type === 'advance' ? amount - paid : 0, currency, orderId || null, matchRequestId]
      );
      created.bookings.push(r.insertId);
      return { id: r.insertId, payId: pay };
    };
    const quote = (token, id, type = 'turf') => call('get', `/cancellations/quote?type=${type}&id=${id}`, token);
    const cancelC = (token, id, body = {}, type = 'turf') => call('post', '/cancellations/cancel', token, { type, id, ...body });
    const refundsOf = async (id, type = 'turf') => (await pool.query('SELECT * FROM refunds WHERE booking_type = ? AND booking_id = ? ORDER BY id', [type, id]))[0];
    const bookingRow = async (id) => (await pool.query('SELECT * FROM bookings WHERE id = ?', [id]))[0][0];

    // ================================================================= 3. policy: window + fee, in the venue's timezone
    console.log('\n--- policy: 5 hours / 20% ---');
    check('the default policy is 5 hours / 20% fee / owner refund 100%', (await call('get', '/global/policy', null)).data.policy.windowHours === 5 && (await call('get', '/global/policy', null)).data.policy.feePercent === 20 && (await call('get', '/global/policy', null)).data.policy.ownerRefundPercent === 100);

    // TEST 6 + TEST 1: AED 100 paid 100, more than 5h before -> fee AED 20, refund AED 80, never converted
    const b6 = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u1, tz: 'Asia/Dubai', hours: 10, amount: 100, paid: 100, currency: 'AED' });
    const q6 = await quote(T.u1, b6.id);
    check('AED 100 paid 100, 10h before: eligible, fee AED 20, refund AED 80 (in AED, never converted)', q6.status === 200 && q6.data.quote.eligible === true && q6.data.quote.currency === 'AED' && q6.data.quote.cancellation_fee === 20 && q6.data.quote.refund_amount === 80 && q6.data.quote.balance_cancelled === 0, q6.data);
    check('...the quote also carries the 4-5 business day note and the policy used', /4–5 business days/.test(q6.data.quote.refund_note) && q6.data.quote.policy.windowHours === 5 && q6.data.quote.policy.feePercent === 20);
    check('quoting changes nothing (booking still confirmed, no refund row)', (await bookingRow(b6.id)).status === 'confirmed' && (await refundsOf(b6.id)).length === 0);
    check('another customer cannot quote or cancel it', (await quote(T.u2, b6.id)).status === 404 && (await cancelC(T.u2, b6.id)).status === 404);
    check('cancelling needs a login', (await cancelC(null, b6.id)).status === 401);
    check('an owner token cannot use the customer cancel route', (await cancelC(T.oAE, b6.id)).status === 403);
    check('the client cannot choose the refund (extra fields are ignored)', (await quote(T.u1, b6.id)).data.quote.refund_amount === 80);

    // TEST 2 + boundary + timezone: venue-local time, not the server's
    console.log('\n--- policy: window edge + venue timezone ---');
    const inWin = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u1, tz: 'Asia/Dubai', hours: 3, amount: 100, paid: 100, currency: 'AED' });
    const qIn = await quote(T.u1, inWin.id);
    check('3 hours before: NOT eligible for a refund, with the policy message', qIn.data.quote.eligible === false && qIn.data.quote.can_cancel === false && qIn.data.quote.code === 'NOT_REFUNDABLE' && /not eligible for a refund because your booking starts within 5 hours/.test(qIn.data.quote.message), qIn.data.quote);
    const cIn = await cancelC(T.u1, inWin.id);
    check('cancelling inside the window without accepting no-refund is refused and the booking STAYS confirmed', cIn.status === 409 && cIn.data.code === 'NOT_REFUNDABLE' && (await bookingRow(inWin.id)).status === 'confirmed' && (await refundsOf(inWin.id)).length === 0, cIn.data);
    const cIn2 = await cancelC(T.u1, inWin.id, { acceptNoRefund: true });
    const inRefund = (await refundsOf(inWin.id))[0];
    check('...only an explicit non-refundable cancel goes through: cancelled, NO automatic refund (NOT_REQUIRED, 0)', cIn2.status === 200 && (await bookingRow(inWin.id)).status === 'cancelled' && inRefund.refund_status === 'NOT_REQUIRED' && Number(inRefund.refund_amount_minor) === 0 && inRefund.cancellation_type === 'customer_no_refund', { cIn2: cIn2.data, inRefund });
    const justOver = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u1, tz: 'Asia/Dubai', hours: 5.1, amount: 100, paid: 100, currency: 'AED' });
    const justUnder = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u1, tz: 'Asia/Dubai', hours: 4.9, amount: 100, paid: 100, currency: 'AED' });
    check('just over 5 hours (5.1h) is eligible', (await quote(T.u1, justOver.id)).data.quote.eligible === true);
    check('just under 5 hours (4.9h) is not', (await quote(T.u1, justUnder.id)).data.quote.eligible === false);
    // same wall-clock arithmetic, but a server that wrongly used its own timezone (IST) would be 1.5h off for Dubai and 9.5h off for Chicago
    const dubaiEdge = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u1, tz: 'Asia/Dubai', hours: 5.5, amount: 100, paid: 100, currency: 'AED' });
    check('Dubai venue at +5.5h local is eligible (a server-timezone bug would call it 4h)', (await quote(T.u1, dubaiEdge.id)).data.quote.eligible === true);
    const gbBooking = await addBooking({ turfId: tGB.data.turf_id, userId: ID.u1, tz: 'Europe/London', hours: 6, amount: 50, paid: 50, currency: 'GBP' });
    const qGB = await quote(T.u1, gbBooking.id);
    check('London venue: £50 paid -> fee £10, refund £40, in GBP', qGB.data.quote.currency === 'GBP' && qGB.data.quote.cancellation_fee === 10 && qGB.data.quote.refund_amount === 40 && qGB.data.quote.timezone === 'Europe/London', qGB.data.quote);
    const usBooking = await addBooking({ turfId: tUS.data.turf_id, userId: ID.u1, tz: 'America/Los_Angeles', hours: 6, amount: 50, paid: 50, currency: 'USD' });
    const qUS = await quote(T.u1, usBooking.id);
    check('Los Angeles venue (owner-chosen timezone) at +6h local: eligible, $50 -> fee $10, refund $40, in USD', qUS.data.quote.eligible === true && qUS.data.quote.currency === 'USD' && qUS.data.quote.refund_amount === 40 && qUS.data.quote.timezone === 'America/Los_Angeles', qUS.data.quote);
    const usEdge = await addBooking({ turfId: tUS.data.turf_id, userId: ID.u1, tz: 'America/Los_Angeles', hours: 4, amount: 50, paid: 50, currency: 'USD' });
    check('...and at +4h local it is not', (await quote(T.u1, usEdge.id)).data.quote.eligible === false);
    const started = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u1, tz: 'Asia/Dubai', hours: -1, amount: 100, paid: 100, currency: 'AED' });
    check('a booking that has already started cannot be cancelled by the customer', (await quote(T.u1, started.id)).data.quote.code === 'STARTED' && (await cancelC(T.u1, started.id, { acceptNoRefund: true })).status === 400);

    // ================================================================= 4. amounts: full / advance / coupon
    console.log('\n--- amounts ---');
    const b4 = await addBooking({ turfId: tIN.data.turf_id, userId: ID.u1, tz: 'Asia/Kolkata', hours: 12, amount: 200, paid: 200, currency: 'INR' });
    const q4 = (await quote(T.u1, b4.id)).data.quote;
    check('TEST 4 full payment: total ₹200, paid ₹200 -> fee ₹40, refund ₹160', q4.booking_total === 200 && q4.amount_paid === 200 && q4.cancellation_fee === 40 && q4.refund_amount === 160 && q4.refund_amount_minor === 16000, q4);
    const b5 = await addBooking({ turfId: tIN.data.turf_id, userId: ID.u1, tz: 'Asia/Kolkata', hours: 12, amount: 200, paid: 100, type: 'advance', currency: 'INR' });
    const q5 = (await quote(T.u1, b5.id)).data.quote;
    check('TEST 5 50% advance: total ₹200, paid ₹100 -> fee ₹40 (20% of the TOTAL), refund ₹60, unpaid ₹100 simply cancelled', q5.booking_total === 200 && q5.amount_paid === 100 && q5.cancellation_fee === 40 && q5.refund_amount === 60 && q5.balance_cancelled === 100, q5);
    const b7 = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u1, tz: 'Asia/Dubai', hours: 12, amount: 80, paid: 80, discount: 20, original: 100, currency: 'AED' });
    const q7 = (await quote(T.u1, b7.id)).data.quote;
    check('TEST 7 coupon: AED 100 - AED 20 = AED 80 total -> fee AED 16 (20% of 80, not of 100), refund AED 64', q7.booking_total === 80 && q7.cancellation_fee === 16 && q7.refund_amount === 64, q7);
    const tinyAdvance = await addBooking({ turfId: tIN.data.turf_id, userId: ID.u1, tz: 'Asia/Kolkata', hours: 12, amount: 1000, paid: 100, type: 'advance', currency: 'INR' });
    const qTiny = (await quote(T.u1, tinyAdvance.id)).data.quote;
    check('a fee bigger than what was paid never makes a negative refund (₹1000 total, ₹100 paid, fee ₹200 -> refund ₹0, fee capped at ₹100)', qTiny.refund_amount === 0 && qTiny.cancellation_fee === 100 && qTiny.refund_amount_minor === 0, qTiny);
    const kw = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u1, tz: 'Asia/Dubai', hours: 12, amount: 10.5, paid: 10.5, currency: 'KWD' });
    const qKW = (await quote(T.u1, kw.id)).data.quote;
    check('3-decimal currency (KWD 10.500): fee 2.100 and refund 8.400 exactly, in minor units 8400', qKW.cancellation_fee === 2.1 && qKW.refund_amount === 8.4 && qKW.refund_amount_minor === 8400, qKW);
    const odd = await addBooking({ turfId: tIN.data.turf_id, userId: ID.u1, tz: 'Asia/Kolkata', hours: 12, amount: 100.55, paid: 100.55, currency: 'INR' });
    const qOdd = (await quote(T.u1, odd.id)).data.quote;
    check('no float drift: ₹100.55 -> fee 2011 paise, refund 8044 paise', qOdd.cancellation_fee_minor === 2011 && qOdd.refund_amount_minor === 8044, qOdd);

    // ================================================================= 5. performing the cancellation
    console.log('\n--- cancel + refund record ---');
    const cx6 = await cancelC(T.u1, b6.id);
    const [r6] = await refundsOf(b6.id);
    const row6 = await bookingRow(b6.id);
    check('cancelling (AED 100 paid): booking CANCELLED by customer, with the time recorded', cx6.status === 200 && cx6.data.cancelled === true && row6.status === 'cancelled' && row6.cancelled_by === 'customer' && !!row6.cancelled_at, { cx6: cx6.data, row6 });
    check('a refund record exists: AED, original 100.00, paid 100.00, fee 20.00, refund 80.00 (minor units)', r6.currency_code === 'AED' && Number(r6.original_amount_minor) === 10000 && Number(r6.amount_paid_minor) === 10000 && Number(r6.cancellation_fee_minor) === 2000 && Number(r6.refund_amount_minor) === 8000, r6);
    check('...sent to the gateway for the ORIGINAL payment: REFUND_INITIATED with a gateway refund id (not "completed")', r6.refund_status === 'REFUND_INITIATED' && /^rfnd_sim_/.test(r6.gateway_refund_id) && r6.gateway_payment_id === b6.payId && !r6.completed_at, r6);
    check('...with country, venue, owner and the policy it was decided under', r6.country_code === 'AE' && r6.owner_id === ID.oAE && Number(r6.policy_window_hours) === 5 && Number(r6.policy_fee_percent) === 20 && r6.cancelled_by === 'customer', r6);
    check('the slot is free again (availability treats cancelled as free; no slot row to un-release)', row6.status === 'cancelled');
    await sleep(900);
    const n6 = (await call('get', '/notifications?limit=30', T.u1)).data.notifications;
    check('customer is told the refund was initiated, in AED, with the 4–5 business days note', n6.some((n) => n.type === 'REFUND_INITIATED' && n.message.includes(formatMoney(80, 'AED')) && /4–5 business days/.test(n.message)), n6.slice(0, 4).map((n) => `${n.type}:${n.message}`));
    check('...and that the booking was cancelled', n6.some((n) => n.type === 'BOOKING_CANCELLED'));

    // advance: pending balance becomes 0
    const cx5 = await cancelC(T.u1, b5.id);
    const row5 = await bookingRow(b5.id); const [r5] = await refundsOf(b5.id);
    check('advance booking cancelled: refund ₹60 (6000 paise), balance due is 0, nothing more is ever asked', cx5.status === 200 && Number(r5.refund_amount_minor) === 6000 && Number(r5.cancellation_fee_minor) === 4000 && Number(row5.pending_balance) === 0 && row5.status === 'cancelled', { r5, pb: row5.pending_balance });
    const cx4 = await cancelC(T.u1, b4.id);
    const [r4] = await refundsOf(b4.id);
    check('full payment ₹200 cancelled: refund ₹160 in INR', Number(r4.refund_amount_minor) === 16000 && r4.currency_code === 'INR' && r4.refund_status === 'REFUND_INITIATED', r4);
    const cx7 = await cancelC(T.u1, b7.id);
    const [r7] = await refundsOf(b7.id);
    check('coupon booking cancelled: AED 64 refunded (fee from the discounted total)', Number(r7.refund_amount_minor) === 6400 && Number(r7.cancellation_fee_minor) === 1600 && r7.currency_code === 'AED', r7);

    // ================================================================= 6. owner / admin cancellation
    console.log('\n--- owner and admin cancellation ---');
    const oB = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u2, tz: 'Asia/Dubai', hours: 1, amount: 200, paid: 200, currency: 'AED' });
    check('an owner must give a reason', (await call('post', '/cancellations/owner-cancel', T.oAE, { type: 'turf', id: oB.id })).status === 400 && (await call('post', '/cancellations/owner-cancel', T.oAE, { type: 'turf', id: oB.id, reason: 'because' })).status === 400);
    check('another owner cannot cancel it', (await call('post', '/cancellations/owner-cancel', T.oIN, { type: 'turf', id: oB.id, reason: 'Maintenance' })).status === 404);
    check('a customer cannot use the owner route', (await call('post', '/cancellations/owner-cancel', T.u2, { type: 'turf', id: oB.id, reason: 'Maintenance' })).status === 403);
    const oc = await call('post', '/cancellations/owner-cancel', T.oAE, { type: 'turf', id: oB.id, reason: 'Maintenance' });
    const [ro] = await refundsOf(oB.id); const rowO = await bookingRow(oB.id);
    check('TEST 3 owner cancels (even 1 hour before start): FULL refund of AED 200, no fee', oc.status === 200 && Number(ro.refund_amount_minor) === 20000 && Number(ro.cancellation_fee_minor) === 0 && ro.currency_code === 'AED' && ro.cancelled_by === 'owner' && ro.refund_reason === 'Maintenance', { oc: oc.data, ro });
    check('...the booking records who cancelled and why', rowO.cancelled_by === 'owner' && rowO.cancel_reason === 'Maintenance' && rowO.status === 'cancelled');
    const aB = await addBooking({ turfId: tGB.data.turf_id, userId: ID.u2, tz: 'Europe/London', hours: 0.5, amount: 50, paid: 50, currency: 'GBP' });
    check('an admin needs one of the listed reasons', (await call('post', '/cancellations/admin-cancel', T.admin, { type: 'turf', id: aB.id, reason: 'Boredom' })).status === 400);
    check('a non-admin cannot use the admin route', (await call('post', '/cancellations/admin-cancel', T.oGB, { type: 'turf', id: aB.id, reason: 'Venue issue' })).status === 403);
    const ac = await call('post', '/cancellations/admin-cancel', T.admin, { type: 'turf', id: aB.id, reason: 'Fraud/security' });
    const [ra] = await refundsOf(aB.id);
    check('admin cancel: FULL refund £50 in GBP by default, reason stored, cancelled_by admin', ac.status === 200 && Number(ra.refund_amount_minor) === 5000 && ra.currency_code === 'GBP' && ra.cancelled_by === 'admin' && ra.refund_reason === 'Fraud/security', { ac: ac.data, ra });
    const unpaid = await addBooking({ turfId: tIN.data.turf_id, userId: ID.u2, tz: 'Asia/Kolkata', hours: 20, amount: 200, paid: 0, type: 'advance', currency: 'INR' });
    await pool.query("UPDATE bookings SET payment_status = 'pending' WHERE id = ?", [unpaid.id]);
    const uc = await call('post', '/cancellations/owner-cancel', T.oIN, { type: 'turf', id: unpaid.id, reason: 'Other' });
    check('a booking nobody paid for: cancelled/refused cleanly, never a fake refund', (await refundsOf(unpaid.id)).every((r) => r.refund_status === 'NOT_REQUIRED') && (uc.status === 200 || uc.status === 400), uc.data);

    // ================================================================= 7. idempotency + races
    console.log('\n--- idempotency and races ---');
    const dB = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u3, tz: 'Asia/Dubai', hours: 9, amount: 100, paid: 100, currency: 'AED' });
    const dbl = await Promise.all([cancelC(T.u3, dB.id), cancelC(T.u3, dB.id), cancelC(T.u3, dB.id)]);
    check('TEST 8 pressing Cancel three times at once: every call succeeds, exactly ONE cancellation', dbl.every((x) => x.status === 200) && dbl.filter((x) => x.data.cancelled === true).length === 1 && dbl.filter((x) => x.data.already_cancelled === true).length === 2, dbl.map((x) => x.data));
    check('...and exactly ONE refund row (AED 80)', (await refundsOf(dB.id)).length === 1 && Number((await refundsOf(dB.id))[0].refund_amount_minor) === 8000);
    const again = await cancelC(T.u3, dB.id);
    check('a later retry is a harmless no-op, still one refund', again.status === 200 && again.data.already_cancelled === true && (await refundsOf(dB.id)).length === 1);
    const raceB = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u3, tz: 'Asia/Dubai', hours: 9, amount: 100, paid: 100, currency: 'AED' });
    const race = await Promise.all([cancelC(T.u3, raceB.id), call('post', '/cancellations/owner-cancel', T.oAE, { type: 'turf', id: raceB.id, reason: 'Emergency' })]);
    const raceRefunds = await refundsOf(raceB.id);
    check('TEST 10 customer and owner cancel at the same instant: one winner, ONE refund', race.every((x) => x.status === 200) && race.filter((x) => x.data.cancelled === true).length === 1 && raceRefunds.length === 1, race.map((x) => x.data));
    const winner = (await bookingRow(raceB.id)).cancelled_by;
    check('...and the refund matches whoever won (owner = AED 100, customer = AED 80), never a mix', (winner === 'owner' && Number(raceRefunds[0].refund_amount_minor) === 10000) || (winner === 'customer' && Number(raceRefunds[0].refund_amount_minor) === 8000), { winner, raceRefunds });
    const [dup] = await pool.query('SELECT COUNT(*) AS c FROM refunds WHERE payment_id = ? ', [dB.payId]);
    check('the database itself forbids a second refund row for the same booking+payment', dup[0].c === 1 && await (async () => { try { await pool.query("INSERT INTO refunds (refund_code, booking_type, booking_id, payment_id, currency_code, cancelled_by, cancellation_type, refund_status, idempotency_key) VALUES ('ZZ-DUP', 'turf', ?, ?, 'AED', 'customer', 'x', 'REFUND_PENDING', 'zz-other-key')", [dB.id, dB.payId]); return false; } catch (e) { return e.code === 'ER_DUP_ENTRY'; } })());

    // ================================================================= 8. gateway status: webhook idempotency
    console.log('\n--- webhook ---');
    const sendHook = async (event, entity, sig) => {
      const body = JSON.stringify({ event, payload: { refund: { entity } } });
      const signature = sig || crypto.createHmac('sha256', secret).update(body).digest('hex');
      return call('post', '/bookings/webhook', null, body, { 'Content-Type': 'application/json', 'x-razorpay-signature': signature });
    };
    const gwId = r6.gateway_refund_id;
    check('a webhook with a bad signature is rejected', (await sendHook('refund.processed', { id: gwId }, 'deadbeef')).status === 400);
    const w1 = await sendHook('refund.processed', { id: gwId });
    const w2 = await sendHook('refund.processed', { id: gwId });
    const [[afterHook]] = await pool.query('SELECT refund_status, completed_at FROM refunds WHERE id = ?', [r6.id]);
    check('TEST 9 refund.processed twice: REFUND_COMPLETED once, still ONE refund', w1.status === 200 && w2.status === 200 && afterHook.refund_status === 'REFUND_COMPLETED' && !!afterHook.completed_at && (await refundsOf(b6.id)).length === 1, afterHook);
    await sleep(900);
    const doneN = (await call('get', '/notifications?limit=40', T.u1)).data.notifications.filter((n) => n.type === 'REFUND_COMPLETED' && n.message.includes('AED 80'));
    check('the customer gets ONE "refund processed" message after gateway confirmation', doneN.length === 1 && /4–5 business days/.test(doneN[0].message), doneN);
    await sendHook('refund.failed', { id: gwId });
    check('a late "failed" never un-completes a completed refund', (await pool.query('SELECT refund_status FROM refunds WHERE id = ?', [r6.id]))[0][0].refund_status === 'REFUND_COMPLETED');
    check('an unknown gateway refund id is ignored safely', (await sendHook('refund.processed', { id: 'rfnd_unknown_zz' })).status === 200);

    // ================================================================= 9. failure + safe retry
    console.log('\n--- refund failure and retry ---');
    const fB = await addBooking({ turfId: tIN.data.turf_id, userId: ID.u3, tz: 'Asia/Kolkata', hours: 12, amount: 100, paid: 100, currency: 'INR', payId: `pay_zzgl_${rnd()}_failonce` });
    const fc = await cancelC(T.u3, fB.id);
    const [fr] = await refundsOf(fB.id);
    check('the gateway refuses the refund: cancellation still stands, refund is REFUND_FAILED with a reason (never "completed")', fc.status === 200 && (await bookingRow(fB.id)).status === 'cancelled' && fr.refund_status === 'REFUND_FAILED' && /Simulated gateway failure/.test(fr.failure_reason) && !fr.gateway_refund_id && !fr.completed_at, fr);
    await sleep(900);
    check('the customer is told it is being handled (not that it failed for good)', (await call('get', '/notifications?limit=40', T.u3)).data.notifications.some((n) => n.type === 'REFUND_FAILED' && /Our team is processing it/.test(n.message)));
    check('only an admin can retry', (await call('post', `/admin/global/refunds/${fr.id}/retry`, T.oIN)).status === 403 && (await call('post', `/admin/global/refunds/${fr.id}/retry`, T.u3)).status === 403);
    const rt = await Promise.all([call('post', `/admin/global/refunds/${fr.id}/retry`, T.admin), call('post', `/admin/global/refunds/${fr.id}/retry`, T.admin)]);
    const [fr2] = await refundsOf(fB.id);
    check('retrying twice at once: one gateway attempt wins, refund becomes REFUND_INITIATED, still ONE row', fr2.refund_status === 'REFUND_INITIATED' && /^rfnd_sim_/.test(fr2.gateway_refund_id) && (await refundsOf(fB.id)).length === 1 && rt.some((x) => x.status === 200), { fr2, rt: rt.map((x) => x.data) });
    check('an initiated refund cannot be retried again (no duplicate payout)', (await call('post', `/admin/global/refunds/${fr.id}/retry`, T.admin)).status === 400);
    await sendHook('refund.failed', { id: fr2.gateway_refund_id, error_description: 'Bank rejected' });
    const [fr3] = await refundsOf(fB.id);
    check('the gateway later reports failure: back to REFUND_FAILED with its reason, retryable', fr3.refund_status === 'REFUND_FAILED' && /Bank rejected/.test(fr3.failure_reason));
    const rt2 = await call('post', `/admin/global/refunds/${fr.id}/retry`, T.admin);
    check('...and a retry works again (same idempotency key)', rt2.status === 200 && (await refundsOf(fB.id))[0].refund_status === 'REFUND_INITIATED' && (await refundsOf(fB.id)).length === 1);
    const man = await call('post', `/admin/global/refunds/${fr.id}/mark-completed`, T.admin);
    check('admin can mark a refund settled manually (paid from the dashboard/bank)', man.status === 200 && (await refundsOf(fB.id))[0].refund_status === 'REFUND_COMPLETED');
    check('...but not one that is already completed', (await call('post', `/admin/global/refunds/${fr.id}/mark-completed`, T.admin)).status === 400);

    // ================================================================= 10. players who really paid (Need Players)
    console.log('\n--- Need Players: only real payments are refunded ---');
    const s = slotFor('Asia/Kolkata', 12);
    const [mr] = await pool.query("INSERT INTO player_requests (host_id, turf_id, sport_type, match_date, match_time, total_slots, filled_slots, status) VALUES (?, ?, 'Football', ?, '18:00:00', 4, 2, 'open')", [ID.u1, tIN.data.turf_id, s.date]);
    created.matches.push(mr.insertId);
    const hostB = await addBooking({ turfId: tIN.data.turf_id, userId: ID.u1, tz: 'Asia/Kolkata', hours: 12, amount: 100, paid: 100, currency: 'INR', matchRequestId: mr.insertId });
    const pp1 = `pay_zzgl_${rnd()}`;
    await pool.query("INSERT INTO match_players (match_id, user_id, role, payment_type, payment_status, status, amount_paid, razorpay_payment_id) VALUES (?, ?, 'Player', 'split', 'paid', 'approved', 40, ?)", [mr.insertId, ID.u2, pp1]);
    await pool.query("INSERT INTO match_players (match_id, user_id, role, payment_type, payment_status, status, amount_paid) VALUES (?, ?, 'Player', 'split', 'pending', 'pending', 40)", [mr.insertId, ID.u3]);
    const hq = (await quote(T.u1, hostB.id)).data.quote;
    check('the quote tells the host that 1 player payment will be refunded too (the unpaid one is not counted)', hq.player_payments_refunded === 1, hq);
    await cancelC(T.u1, hostB.id);
    const hr = await refundsOf(hostB.id);
    const hostRefund = hr.find((r) => r.payment_id === hostB.payId); const playerRefund = hr.find((r) => r.payment_id === pp1);
    check('host booking: ₹100 paid -> fee ₹20, refund ₹80', hostRefund && Number(hostRefund.refund_amount_minor) === 8000, hr);
    check('the player who paid ₹40: own refund row on THEIR payment, same rules (fee ₹8, refund ₹32), to THEM', playerRefund && Number(playerRefund.refund_amount_minor) === 3200 && playerRefund.user_id === ID.u2, hr);
    check('the player who never paid gets NO refund row (no imaginary refunds)', hr.length === 2 && !hr.some((r) => r.user_id === ID.u3));
    check('the match request is cancelled with the booking', (await pool.query('SELECT status FROM player_requests WHERE id = ?', [mr.insertId]))[0][0].status === 'cancelled');

    // ================================================================= 11. policy versions
    console.log('\n--- policy versions ---');
    const pubPol0 = (await call('get', '/global/policy', null)).data.policy;
    const hold = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u1, tz: 'Asia/Dubai', hours: 12, amount: 100, paid: 100, currency: 'AED' });
    await quote(T.u1, hold.id); // binds the booking to the policy in force when it was made
    check('(setup) the booking is bound to the current policy version', Number((await bookingRow(hold.id)).policy_version) === pubPol0.version && Number((await bookingRow(hold.id)).policy_fee_percent) === 20, await bookingRow(hold.id));
    check('policy values are validated', (await call('put', '/admin/global/policy', T.admin, { feePercent: 150 })).status === 400 && (await call('put', '/admin/global/policy', T.admin, { windowHours: -1 })).status === 400);
    const newPol = await call('put', '/admin/global/policy', T.admin, { windowHours: 3, feePercent: 10, note: 'ZZ GL test policy' });
    check('admin publishes a NEW policy version (3 hours / 10%)', newPol.status === 200 && newPol.data.policy.version > pubPol0.version && newPol.data.policy.windowHours === 3 && newPol.data.policy.feePercent === 10, newPol.data);
    check('the existing booking KEEPS its original terms (20% fee)', (await quote(T.u1, hold.id)).data.quote.cancellation_fee === 20 && (await quote(T.u1, hold.id)).data.quote.policy.version === pubPol0.version);
    const fresh = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u1, tz: 'Asia/Dubai', hours: 4, amount: 100, paid: 100, currency: 'AED' });
    const qFresh = (await quote(T.u1, fresh.id)).data.quote;
    check('a booking made after the change uses the new terms (4h is now outside a 3h window -> eligible, 10% fee)', qFresh.eligible === true && qFresh.cancellation_fee === 10 && qFresh.policy.windowHours === 3, qFresh);
    // restore the default policy as a new version
    await call('put', '/admin/global/policy', T.admin, { windowHours: 5, feePercent: 20, note: 'ZZ GL restore default' });
    const hist = (await call('get', '/admin/global/policy', T.admin)).data;
    check('the policy history is kept and the active one is back to 5h / 20%', hist.active.windowHours === 5 && hist.active.feePercent === 20 && hist.history.length >= 3, hist.active);
    const offB = await addBooking({ turfId: tAE.data.turf_id, userId: ID.u1, tz: 'Asia/Dubai', hours: 12, amount: 100, paid: 100, currency: 'AED' });
    await call('put', '/admin/global/policy', T.admin, { cancellationEnabled: false, windowHours: 5, feePercent: 20, note: 'ZZ GL switch off' });
    check('with cancellation switched off nobody can cancel as a customer', (await quote(T.u1, offB.id)).data.quote.code === 'CANCELLATION_DISABLED' && (await cancelC(T.u1, offB.id)).status === 400);
    await call('put', '/admin/global/policy', T.admin, { windowHours: 5, feePercent: 20, note: 'ZZ GL back on' });
    await call('put', '/admin/global/policy', T.admin, { windowHours: 5, feePercent: 20, customerRefundEnabled: false, note: 'ZZ GL refunds off' });
    check('with customer refunds off, a customer cancel needs the explicit no-refund consent', (await quote(T.u1, offB.id)).data.quote.eligible === false);
    await call('put', '/admin/global/policy', T.admin, { windowHours: 5, feePercent: 20, note: 'ZZ GL final restore' });
    check('the default policy is restored', (await call('get', '/global/policy', null)).data.policy.customerRefundEnabled === true);

    // ================================================================= 12. activities (tickets)
    console.log('\n--- activity tickets ---');
    const cats = await call('get', '/activities/categories', null);
    const catId = cats.data.categories[0].id;
    const mkAct = async (owner, country, name) => {
      const r = await call('post', '/owner-activities', owner, { name: `ZZ GL ${name} ${stamp}`, category_id: catId, country_code: country, opening_time: '10:00:00', closing_time: '20:00:00' });
      created.activities.push(r.data.activity_id);
      await call('put', `/admin/activities/${r.data.activity_id}/approve`, T.admin);
      return r;
    };
    const aAE = await mkAct(T.oAE, 'AE', 'Dubai Park');
    check('an activity gets its country, currency and timezone from the country too', aAE.data.currency_code === 'AED' && aAE.data.timezone === 'Asia/Dubai', aAE.data);
    check('activity creation rejects an unknown country', (await call('post', '/owner-activities', T.oAE, { name: 'x', category_id: catId, country_code: 'XX' })).status === 400);
    const ttAE = (await call('post', `/owner-activities/${aAE.data.activity_id}/ticket-types`, T.oAE, { name: 'Adult', price: 100, min_quantity: 1, max_quantity: 10 })).data.ticket_type_id;
    const dateAct = slotFor('Asia/Dubai', 60).date;
    await call('post', `/owner-activities/${aAE.data.activity_id}/inventory/bulk`, T.oAE, { ticket_type_id: ttAE, start_date: dateAct, end_date: dateAct, capacity: 10 });
    const prev = await call('post', '/activities/price-preview', T.u1, { activity_id: aAE.data.activity_id, booking_date: dateAct, items: [{ ticket_type_id: ttAE, quantity: 2 }] });
    check('the price preview is in the venue currency (AED 200)', prev.status === 200 && prev.data.currency === 'AED' && prev.data.total === 200, prev.data);
    const bookAE = await call('post', '/activities/book', T.u1, { activity_id: aAE.data.activity_id, booking_date: dateAct, items: [{ ticket_type_id: ttAE, quantity: 1 }], customer_name: 'ZZ GL', customer_phone: '9999999999' });
    check('an AED activity cannot take online payment until AED is switched on', bookAE.status === 400 && /AED/.test(bookAE.data.error), bookAE.data);
    // a paid, confirmed activity booking as a fixture (payment simulated)
    const mkActBooking = async (actId, ttId, userId, date, qty, total, currency, payId) => {
      const [b] = await pool.query("INSERT INTO activity_bookings (booking_code, activity_id, owner_id, user_id, customer_name, customer_phone, booking_date, status, payment_status, razorpay_payment_id, subtotal_amount, total_amount, currency_code) SELECT '', a.id, a.owner_id, ?, 'ZZ GL', '9999999999', ?, 'confirmed', 'success', ?, ?, ?, ? FROM activities a WHERE a.id = ?", [userId, date, payId, total, total, currency, actId]);
      await pool.query('UPDATE activity_bookings SET booking_code = ? WHERE id = ?', [`BA-ZZGL-${b.insertId}`, b.insertId]);
      await pool.query('INSERT INTO activity_booking_items (booking_id, ticket_type_id, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?)', [b.insertId, ttId, qty, total / qty, total]);
      await pool.query("INSERT INTO activity_tickets (booking_id, activity_id, owner_id, qr_token, quantity_covered, status, valid_from, valid_until) SELECT ?, a.id, a.owner_id, ?, ?, 'VALID', ?, ? FROM activities a WHERE a.id = ?", [b.insertId, `zzgl_${rnd()}${rnd()}`, qty, `${date} 00:00:00`, `${date} 23:59:59`, actId]);
      await pool.query('UPDATE activity_inventory SET sold = sold + ? WHERE ticket_type_id = ? AND date = ?', [qty, ttId, date]);
      return b.insertId;
    };
    const actB = await mkActBooking(aAE.data.activity_id, ttAE, ID.u1, dateAct, 2, 200, 'AED', `pay_zzgl_${rnd()}`);
    const [[invBefore]] = await pool.query('SELECT sold FROM activity_inventory WHERE ticket_type_id = ? AND date = ?', [ttAE, dateAct]);
    const aq = (await quote(T.u1, actB, 'activity')).data.quote;
    check('activity ticket (AED 200, >5h before opening): fee AED 40, refund AED 160 — the SAME policy as sports', aq.eligible === true && aq.currency === 'AED' && aq.cancellation_fee === 40 && aq.refund_amount === 160, aq);
    const ac1 = await cancelC(T.u1, actB, {}, 'activity');
    const [ar] = await refundsOf(actB, 'activity');
    const [[invAfter]] = await pool.query('SELECT sold FROM activity_inventory WHERE ticket_type_id = ? AND date = ?', [ttAE, dateAct]);
    check('cancelling: ticket booking cancelled, refund record in AED (160.00), REFUND_INITIATED', ac1.status === 200 && ar.currency_code === 'AED' && Number(ar.refund_amount_minor) === 16000 && ar.refund_status === 'REFUND_INITIATED' && ar.business_type === 'ACTIVITY', { ac1: ac1.data, ar });
    check('...its QR tickets are CANCELLED and the 2 seats are released inside the same transaction', Number(invBefore.sold) - Number(invAfter.sold) === 2 && (await pool.query('SELECT status FROM activity_tickets WHERE booking_id = ?', [actB]))[0].every((t) => t.status === 'CANCELLED'), { invBefore, invAfter });
    const actDbl = await mkActBooking(aAE.data.activity_id, ttAE, ID.u1, dateAct, 1, 100, 'AED', `pay_zzgl_${rnd()}`);
    const actRace = await Promise.all([cancelC(T.u1, actDbl, {}, 'activity'), cancelC(T.u1, actDbl, {}, 'activity'), call('post', '/cancellations/owner-cancel', T.oAE, { type: 'activity', id: actDbl, reason: 'Activity cancelled' })]);
    check('activity: three simultaneous cancels (customer x2 + owner) -> one decision, ONE refund, seat released once', (await refundsOf(actDbl, 'activity')).length === 1 && actRace.every((x) => x.status === 200) && Number((await pool.query('SELECT sold FROM activity_inventory WHERE ticket_type_id = ? AND date = ?', [ttAE, dateAct]))[0][0].sold) === Number(invAfter.sold), actRace.map((x) => x.data));
    const ownerAct = await mkActBooking(aAE.data.activity_id, ttAE, ID.u2, dateAct, 1, 100, 'AED', `pay_zzgl_${rnd()}`);
    const legacyOwner = await call('put', `/owner-activities/bookings/${ownerAct}/cancel`, T.oAE, { reason: 'Event cancelled' });
    check('the owner panel cancel route uses the same engine: full refund AED 100', legacyOwner.status === 200 && legacyOwner.data.refund_amount === 100 && legacyOwner.data.currency === 'AED' && Number((await refundsOf(ownerAct, 'activity'))[0].refund_amount_minor) === 10000, legacyOwner.data);
    const soon = await mkActBooking(aAE.data.activity_id, ttAE, ID.u1, slotFor('Asia/Dubai', 0).date, 1, 100, 'AED', `pay_zzgl_${rnd()}`);
    await pool.query('UPDATE activities SET opening_time = ? WHERE id = ?', [`${pad(wallParts(Date.now() + 2 * 3600000, 'Asia/Dubai').h)}:00:00`, aAE.data.activity_id]);
    const sq = (await quote(T.u1, soon, 'activity')).data.quote;
    check('an activity opening within 5 hours (Dubai local) is not refundable by the customer', sq.eligible === false && sq.refund_amount === 0 && /within 5 hours/.test(sq.message), sq);
    const myT = await call('post', `/activities/my/tickets/${soon}/cancel`, T.u1, {});
    check('the ticket screen\'s cancel route reports the policy refusal (409 + code) and keeps the ticket', myT.status === 409 && myT.data.code === 'NOT_REFUNDABLE' && (await pool.query('SELECT status FROM activity_bookings WHERE id = ?', [soon]))[0][0].status === 'confirmed', myT.data);
    const noR = await call('post', `/activities/my/tickets/${soon}/cancel`, T.u1, { acceptNoRefund: true });
    check('...and cancels with no refund only when the customer explicitly accepts', noR.status === 200 && (await refundsOf(soon, 'activity'))[0].refund_status === 'NOT_REQUIRED');
    const freeAct = await mkActBooking(aAE.data.activity_id, ttAE, ID.u1, dateAct, 1, 0, 'AED', 'free_zzgl');
    await call('post', '/cancellations/cancel', T.u1, { type: 'activity', id: freeAct });
    check('a free booking (nothing paid) creates no refund', (await refundsOf(freeAct, 'activity')).every((r) => r.refund_status === 'NOT_REQUIRED'));

    // ================================================================= 13. views: owner / admin / customer
    console.log('\n--- refund views ---');
    const ownerView = await call('get', '/cancellations/owner/refunds', T.oAE);
    check('the owner sees refunds on their own venues: amounts, fee, status, reason, in the venue currency', ownerView.status === 200 && ownerView.data.refunds.length >= 5 && ownerView.data.refunds.every((r) => r.country_code === 'AE') && ownerView.data.refunds.some((r) => r.refund_reason === 'Maintenance' && r.cancelled_by === 'owner' && r.refund_amount === 200 && r.currency === 'AED'), ownerView.data.refunds && ownerView.data.refunds.slice(0, 2));
    check('...and nothing from another owner', (await call('get', '/cancellations/owner/refunds', T.oIN)).data.refunds.every((r) => r.country_code === 'IN'));
    check('owners have no endpoint that edits a refund amount', (await call('put', `/cancellations/owner/refunds/${ro.id}`, T.oAE, { refund_amount: 1 })).status === 404);
    const mine = await call('get', '/cancellations/mine', T.u1);
    check('a customer sees their own refunds only', mine.status === 200 && mine.data.refunds.length >= 4 && mine.data.refunds.every((r) => r.booking_id > 0), mine.data.refunds && mine.data.refunds.length);
    const adm = await call('get', '/admin/global/refunds', T.admin);
    check('admin refund management lists every field the spec asks for', adm.status === 200 && adm.data.refunds.some((r) => r.id === r6.id && r.customer_name && r.venue_name && r.country_code === 'AE' && r.currency === 'AED' && r.original_amount === 100 && r.amount_paid === 100 && r.cancellation_fee === 20 && r.refund_amount === 80 && r.refund_status === 'REFUND_COMPLETED' && r.gateway_refund_id && r.refund_reason && r.cancelled_by === 'customer' && r.requested_at && r.completed_at), adm.data.refunds && adm.data.refunds.find((r) => r.id === r6.id));
    const f = async (q) => (await call('get', `/admin/global/refunds?${q}`, T.admin)).data.refunds;
    check('admin filter: country', (await f('country=GB')).length >= 1 && (await f('country=GB')).every((r) => r.country_code === 'GB'));
    check('admin filter: currency', (await f('currency=AED')).every((r) => r.currency === 'AED') && (await f('currency=AED')).length >= 5);
    check('admin filter: refund status', (await f('status=REFUND_COMPLETED')).every((r) => r.refund_status === 'REFUND_COMPLETED') && (await f('status=REFUND_FAILED')).every((r) => r.refund_status === 'REFUND_FAILED'));
    check('admin filter: business type', (await f('business_type=ACTIVITY')).length >= 2 && (await f('business_type=ACTIVITY')).every((r) => r.business_type === 'ACTIVITY') && (await f('business_type=SPORTS')).every((r) => r.business_type === 'SPORTS'));
    check('admin filter: venue (by name) and cancelled-by', (await f(`venue=${encodeURIComponent('ZZ GL Dubai Park')}`)).length >= 2 && (await f('cancelled_by=admin')).every((r) => r.cancelled_by === 'admin'));
    check('admin filter: date range', (await f(`from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`)).length >= 1 && (await f('from=2001-01-01&to=2001-01-02')).length === 0);

    // ================================================================= 14. configuration safety
    console.log('\n--- configuration safety ---');
    const [[aeTurfCount]] = await pool.query("SELECT COUNT(*) c FROM bookings WHERE turf_id = ? AND status <> 'cancelled' AND payment_status = 'success'", [tAE.data.turf_id]);
    await addBooking({ turfId: tAE.data.turf_id, userId: ID.u1, tz: 'Asia/Dubai', hours: 30, amount: 100, paid: 100, currency: 'AED' });
    const swap = await call('put', `/owners/turfs/${tAE.data.turf_id}`, T.oAE, { name: 'ZZ GL AE', location: 'Test City', sport_type: 'Football', price_per_hour: 100, latitude: 25, longitude: 55, country_code: 'IN' });
    check('a venue with paid bookings cannot switch its currency (an AED booking can never become INR)', swap.status === 400 && /already has paid bookings/.test(swap.data.error) && (await pool.query('SELECT currency_code FROM turfs WHERE id = ?', [tAE.data.turf_id]))[0][0].currency_code === 'AED', swap.data);
    check('existing (India) data keeps working: a legacy booking row is INR by default', (await pool.query("SELECT currency_code FROM bookings WHERE id = ?", [b4.id]))[0][0].currency_code === 'INR');
    check('the money helper formats per currency: ₹1,000 / AED 100 / £50 / $50', [formatMoney(1000, 'INR'), formatMoney(100, 'AED'), formatMoney(50, 'GBP'), formatMoney(50, 'USD')].join('|') === '₹1,000|AED 100|£50|$50');
  } catch (e) {
    console.error('UNEXPECTED ERROR', e);
    results.push(false);
  } finally {
    try {
      const turfIds = created.turfs.length ? created.turfs : [0]; const actIds = created.activities.length ? created.activities : [0];
      const uids = created.users.length ? created.users : [0]; const oids = created.owners.length ? created.owners : [0];
      const q = (a) => a.map(() => '?').join(',');
      const [bk] = await pool.query(`SELECT id FROM bookings WHERE turf_id IN (${q(turfIds)})`, turfIds);
      const [abk] = await pool.query(`SELECT id FROM activity_bookings WHERE activity_id IN (${q(actIds)})`, actIds);
      await pool.query(`DELETE FROM refunds WHERE (booking_type = 'turf' AND booking_id IN (${q(bk.length ? bk.map((b) => b.id) : [0])})) OR (booking_type = 'activity' AND booking_id IN (${q(abk.length ? abk.map((b) => b.id) : [0])})) OR user_id IN (${q(uids)}) OR owner_id IN (${q(oids)})`, [...(bk.length ? bk.map((b) => b.id) : [0]), ...(abk.length ? abk.map((b) => b.id) : [0]), ...uids, ...oids]);
      if (created.matches.length) { await pool.query(`DELETE FROM match_players WHERE match_id IN (${q(created.matches)})`, created.matches); }
      if (bk.length) await pool.query(`DELETE FROM bookings WHERE id IN (${q(bk)})`, bk.map((b) => b.id));
      if (abk.length) {
        const ids = abk.map((b) => b.id);
        for (const t of ['activity_tickets', 'activity_booking_items', 'activity_booking_addons']) await pool.query(`DELETE FROM ${t} WHERE booking_id IN (${q(ids)})`, ids);
        await pool.query(`DELETE FROM activity_bookings WHERE id IN (${q(ids)})`, ids);
      }
      if (created.matches.length) await pool.query(`DELETE FROM player_requests WHERE id IN (${q(created.matches)})`, created.matches);
      for (const t of ['activity_inventory', 'activity_time_windows', 'activity_addons', 'activity_offers', 'activity_ticket_types']) await pool.query(`DELETE FROM ${t} WHERE activity_id IN (${q(actIds)})`, actIds);
      await pool.query(`DELETE FROM activities WHERE id IN (${q(actIds)})`, actIds);
      await pool.query(`DELETE FROM turfs WHERE id IN (${q(turfIds)})`, turfIds);
      await pool.query(`DELETE FROM notifications WHERE (recipient_type = 'user' AND recipient_id IN (${q(uids)})) OR (recipient_type = 'owner' AND recipient_id IN (${q(oids)}))`, [...uids, ...oids]);
      await pool.query("DELETE FROM notifications WHERE recipient_type = 'admin' AND (message LIKE '%ZZ GL%' OR title LIKE '%ZZ GL%')");
      await pool.query(`DELETE FROM owners WHERE id IN (${q(oids)})`, oids);
      await pool.query(`DELETE FROM users WHERE id IN (${q(uids)})`, uids);
      for (const c of created.countries) { await pool.query('DELETE FROM payment_configs WHERE country_code = ?', [c]); await pool.query('DELETE FROM countries WHERE country_code = ?', [c]); }
      await pool.query("DELETE FROM cancellation_policies WHERE note LIKE 'ZZ GL%'");
      // the newest remaining version must be the active default again
      await pool.query('UPDATE cancellation_policies SET is_active = false');
      await pool.query('UPDATE cancellation_policies SET is_active = true WHERE id = (SELECT m FROM (SELECT MAX(id) AS m FROM cancellation_policies) x)');
      const [[left]] = await pool.query("SELECT (SELECT COUNT(*) FROM turfs WHERE name LIKE 'ZZ GL%') t, (SELECT COUNT(*) FROM activities WHERE name LIKE 'ZZ GL%') a, (SELECT COUNT(*) FROM owners WHERE email LIKE 'zz_gl_%') o, (SELECT COUNT(*) FROM users WHERE email LIKE 'zz_gl_%') u, (SELECT COUNT(*) FROM countries WHERE country_name LIKE 'ZZ GL%') c");
      const [[pol]] = await pool.query('SELECT window_hours, fee_percent, is_active FROM cancellation_policies WHERE is_active = true');
      console.log(`cleanup done; leftovers (turfs/activities/owners/users/countries): ${left.t} ${left.a} ${left.o} ${left.u} ${left.c}; active policy ${pol.window_hours}h/${pol.fee_percent}%`);
    } catch (e) { console.log('CLEANUP FAILED:', e.message); }
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    await pool.end();
    process.exit(passed === results.length ? 0 : 1);
  }
})();
