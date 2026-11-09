// End-to-end tests for the Razorpay Route SPLIT-PAYMENT system (routeSplit.js / admin-route.js), plus the three
// secondary security fixes from the same pass (GET /bookings/:id, POST /bookings/confirm-demo, the legacy
// processRouteTransfer bug). Needs the API on localhost:9000 and the DB in server/.env (live TiDB, live Razorpay keys).
//
// SAFETY: every turf this test creates keeps route_environment = 'test' (the default) for every payment it actually
// runs, so routeProvider.createTransfer never makes a network call — see services/routeProvider.js. The one place this
// test touches route_environment = 'live' is a pure admin-API validation check (the confirmation-phrase gate); it is
// flipped back to 'test' immediately and no payment is ever processed while it is set to 'live'. No real Razorpay
// Route/Linked Account API is ever called, and no live money moves.
//
// Creates its own accounts/turfs/bookings prefixed "ZZ RT" / zz_rt_ and deletes them all in a finally block.
//   node tests/route-split.e2e.js
const crypto = require('crypto');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const axios = require('axios');
const pool = require('../config/db');
const routeSplit = require('../services/routeSplit');
const { processRouteTransfer } = require('../services/razorpayRoute');
const BASE = 'http://localhost:9000/api';
const results = [];
const check = (name, cond, extra) => { results.push(!!cond); console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond ? '' : ' :: ' + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, url, token, data) => { const r = await axios({ method, url: BASE + url, data, headers: token ? { Authorization: 'Bearer ' + token } : {}, validateStatus: () => true }); return { status: r.status, data: r.data }; };
const rawCall = async (method, url, token, data, extraHeaders = {}) => { const r = await axios({ method, url: BASE + url, data, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extraHeaders }, transformRequest: [(d) => d], validateStatus: () => true }); return { status: r.status, data: r.data }; };

(async () => {
  const stamp = Date.now();
  const pw = 'Test#12345';
  const mail = (k) => `zz_rt_${k}_${stamp}@example.com`;
  const sign = (o, p) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${o}|${p}`).digest('hex');
  const webhookSign = (raw) => crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || 'bookmyarena_secret').update(raw).digest('hex');
  const rawHook = async (event, entity) => {
    const raw = JSON.stringify({ event, payload: { payment: { entity } } });
    return rawCall('post', '/bookings/webhook', null, raw, { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSign(raw) });
  };

  const ids = { users: {}, owners: {}, tokens: {} };
  const created = { turfs: [], bookings: [] };

  const mkTurf = async (ownerKey, name) => {
    const [r] = await pool.query(
      "INSERT INTO turfs (name, location, address, sport_type, price_per_hour, owner_id, is_active, slug) VALUES (?, 'Chennai', 'x', 'Football', 500, ?, true, ?)",
      [name, ids.owners[ownerKey], `zz-rt-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp}`]
    );
    created.turfs.push(r.insertId);
    return r.insertId;
  };
  let slotSeq = 0;
  const mkBooking = async (turfId, orderId, amount, userKey = null) => {
    const h = 6 + (slotSeq++ % 16); // a fresh time slot per booking so bookings on the same turf/day never trip the slot-conflict check
    const slot = `${String(h).padStart(2, '0')}:00 - ${String(h + 1).padStart(2, '0')}:00`;
    const [r] = await pool.query(
      "INSERT INTO bookings (turf_id, customer_name, customer_phone, customer_email, booking_date, time_slot, amount, advance_amount, payment_status, status, user_id, razorpay_order_id) VALUES (?, 'ZZ RT', '9999999999', 'zzrt@example.com', CURDATE(), ?, ?, ?, 'pending', 'pending', ?, ?)",
      [turfId, slot, amount, amount, userKey ? ids.users[userKey] : null, orderId]
    );
    created.bookings.push(r.insertId);
    return r.insertId;
  };
  const payAndConfirm = async (bookingId, orderId, amount) => {
    const paymentId = `pay_zzrt_${crypto.randomBytes(6).toString('hex')}`;
    const v = await call('post', '/bookings/verify', null, { booking_id: String(bookingId), razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) });
    return { paymentId, verify: v };
  };
  const transferFor = async (paymentId) => (await pool.query('SELECT * FROM route_split_transfers WHERE razorpay_payment_id = ?', [paymentId]))[0][0] || null;

  try {
    // ================================================================= accounts
    for (const k of ['u1', 'u2']) {
      await axios.post(BASE + '/users/register', { name: `ZZ RT ${k}`, email: mail(k), phone: '9999999999', password: pw });
      const l = await axios.post(BASE + '/users/login', { email: mail(k), password: pw });
      ids.users[k] = l.data.user.id; ids.tokens[k] = l.data.token;
    }
    for (const k of ['o1', 'o2']) {
      await axios.post(BASE + '/owners/register', { name: `ZZ RT ${k}`, email: mail(k), phone: '9999999999', password: pw });
      const l = await axios.post(BASE + '/owners/login', { email: mail(k), password: pw });
      ids.owners[k] = l.data.owner.id; ids.tokens[k] = l.data.token;
    }
    const [[admin]] = await pool.query('SELECT id FROM admins ORDER BY id LIMIT 1');
    const jwt = require('jsonwebtoken');
    ids.tokens.admin = jwt.sign({ id: admin.id, username: 'admin', role: 'admin' }, process.env.JWT_SECRET || 'your_jwt_secret_key', { expiresIn: '1h' });
    const TK = ids.tokens;

    // ================================================================= 1. pure split math
    console.log('\n--- calculateSplit ---');
    check('10% of 1000 -> platform 100, owner 900', JSON.stringify(routeSplit.calculateSplit(1000, 10)) === JSON.stringify({ platformAmount: 100, ownerAmount: 900, grossAmount: 1000 }));
    check('20% of 1000 -> platform 200, owner 800', JSON.stringify(routeSplit.calculateSplit(1000, 20)) === JSON.stringify({ platformAmount: 200, ownerAmount: 800, grossAmount: 1000 }));
    check('0% -> Book Arena gets nothing', routeSplit.calculateSplit(1500, 0).platformAmount === 0 && routeSplit.calculateSplit(1500, 0).ownerAmount === 1500);
    check('100% -> owner gets nothing', routeSplit.calculateSplit(1500, 100).platformAmount === 1500 && routeSplit.calculateSplit(1500, 100).ownerAmount === 0);
    const odd = routeSplit.calculateSplit(999.99, 12.5);
    check('platform + owner always sums to exactly the gross, even with fractional pct/amount', Math.round((odd.platformAmount + odd.ownerAmount) * 100) === Math.round(999.99 * 100), odd);
    check('percentage above 100 is rejected', !!routeSplit.calculateSplit(1000, 101).error);
    check('negative percentage is rejected', !!routeSplit.calculateSplit(1000, -1).error);
    check('zero/negative gross is rejected', !!routeSplit.calculateSplit(0, 10).error && !!routeSplit.calculateSplit(-5, 10).error);
    check('validLinkedAccountId only accepts the acc_... shape', routeSplit.validLinkedAccountId('acc_ABCdef12345') && !routeSplit.validLinkedAccountId('not-an-account') && !routeSplit.validLinkedAccountId('acc_'));

    // ---- flat-amount commission mode ----
    check('a flat ₹50 fee on a ₹1000 booking: platform 50, owner 950', JSON.stringify(routeSplit.calculateFlatSplit(1000, 50)) === JSON.stringify({ platformAmount: 50, ownerAmount: 950, grossAmount: 1000, clamped: false }));
    check('a flat fee of 0 gives the owner everything', routeSplit.calculateFlatSplit(1000, 0).platformAmount === 0 && routeSplit.calculateFlatSplit(1000, 0).ownerAmount === 1000);
    const clampedFlat = routeSplit.calculateFlatSplit(100, 500);
    check('a flat fee bigger than the booking is clamped: Book Arena never takes more than what was actually paid, owner never goes negative', clampedFlat.platformAmount === 100 && clampedFlat.ownerAmount === 0 && clampedFlat.clamped === true, clampedFlat);
    check('a negative flat amount is rejected', !!routeSplit.calculateFlatSplit(1000, -1).error);
    check('calculateSplitFor dispatches by the turf\'s commission_type', routeSplit.calculateSplitFor({ route_commission_type: 'flat', route_flat_amount: 40 }, 500).platformAmount === 40 && routeSplit.calculateSplitFor({ route_commission_type: 'percentage', route_split_percentage: 10 }, 500).platformAmount === 50);
    check('validFlatAmount / validCommissionType', routeSplit.validFlatAmount(0) && routeSplit.validFlatAmount(25.5) && !routeSplit.validFlatAmount(-1) && !routeSplit.validFlatAmount('x') && routeSplit.validCommissionType('percentage') && routeSplit.validCommissionType('flat') && !routeSplit.validCommissionType('fixed'));

    // ================================================================= 2. admin API access control
    console.log('\n--- admin route-config API security ---');
    for (const [m, u] of [['get', '/admin/route/turfs'], ['get', '/admin/route/transfers'], ['get', '/admin/route/audit']]) {
      check(`${m.toUpperCase()} ${u} needs a token`, (await call(m, u, null)).status === 401);
    }
    const tA = await mkTurf('o1', `ZZ RT Turf A ${stamp}`);
    check('an owner cannot read the admin Route config API (403)', (await call('get', `/admin/route/turfs/${tA}`, TK.o1)).status === 403);
    check('a customer cannot configure Route (403)', (await call('put', `/admin/route/turfs/${tA}/config`, TK.u1, { route_split_percentage: 10 })).status === 403);
    check('an owner cannot enable Route on their own turf (403)', (await call('post', `/admin/route/turfs/${tA}/enable`, TK.o1, {})).status === 403);

    // ================================================================= 3. default state + regression turf
    console.log('\n--- default state (existing-turf regression) ---');
    const [[freshTurf]] = await pool.query('SELECT route_enabled, route_status, route_environment FROM turfs WHERE id = ?', [tA]);
    check('a brand new turf defaults to Route OFF, not_configured, environment test', freshTurf.route_enabled === 0 && freshTurf.route_status === 'not_configured' && freshTurf.route_environment === 'test', freshTurf);

    const tLegacy = await mkTurf('o1', `ZZ RT Existing-style Turf ${stamp}`); // never touched by the admin Route API - stands in for a real production turf
    const orderLegacy = `order_zzrt_legacy_${stamp}`;
    const bLegacy = await mkBooking(tLegacy, orderLegacy, 1000, 'u1');
    const [[razorpayTransfersBefore]] = await pool.query("SELECT COUNT(*) c FROM razorpay_transfers WHERE turf_id = ?", [tLegacy]);
    const payLegacy = await payAndConfirm(bLegacy, orderLegacy, 1000);
    await sleep(500);
    const [[bookingRow]] = await pool.query('SELECT status, payment_status FROM bookings WHERE id = ?', [bLegacy]);
    const [[razorpayTransfersAfter]] = await pool.query("SELECT COUNT(*) c FROM razorpay_transfers WHERE turf_id = ?", [tLegacy]);
    check('EXISTING (route_enabled=false) turf: booking still confirms and payment still verifies normally', payLegacy.verify.status === 200 && bookingRow.status === 'confirmed' && bookingRow.payment_status === 'success', payLegacy.verify.data);
    check('...and NO Route transfer of any kind is created (legacy table untouched, new table untouched)', (await transferFor(payLegacy.paymentId)) === null && razorpayTransfersAfter.c === razorpayTransfersBefore.c, { new: await transferFor(payLegacy.paymentId), legacyBefore: razorpayTransfersBefore.c, legacyAfter: razorpayTransfersAfter.c });

    // legacy processRouteTransfer: prove the bug is actually fixed (no longer throws), without ever reaching Razorpay
    // (this test turf has no legacy linked account, so the function's own logic stops before any network call)
    let legacyThrew = null; let legacyResult = null;
    try { legacyResult = await processRouteTransfer(payLegacy.paymentId, [bLegacy]); } catch (e) { legacyThrew = e; }
    check('legacy processRouteTransfer(paymentId, bookingIds) no longer throws "unexpected \'?\'" (the missing-params bug is fixed)', legacyThrew === null && legacyResult && legacyResult.success === true, legacyThrew ? legacyThrew.message : legacyResult);
    check('...and correctly computed: no linked account configured -> the owner keeps 100% (nothing invented)', legacyResult && legacyResult.ownerAmount === 1000 && legacyResult.platformAmount === 0);

    // ================================================================= 4. admin configuration flow
    console.log('\n--- admin: configure -> approve -> enable ---');
    check('cannot approve before configuring', (await call('post', `/admin/route/turfs/${tA}/approve`, TK.admin)).status === 400);
    check('cannot enable before approving', (await call('post', `/admin/route/turfs/${tA}/enable`, TK.admin)).status === 400);
    check('rejects an out-of-range percentage', (await call('put', `/admin/route/turfs/${tA}/config`, TK.admin, { route_split_percentage: 150 })).status === 400);
    check('rejects a negative percentage', (await call('put', `/admin/route/turfs/${tA}/config`, TK.admin, { route_split_percentage: -5 })).status === 400);
    check('rejects a malformed linked-account id', (await call('put', `/admin/route/turfs/${tA}/config`, TK.admin, { route_linked_account_id: 'not-real' })).status === 400);
    check('rejects an unknown environment value', (await call('put', `/admin/route/turfs/${tA}/config`, TK.admin, { route_environment: 'staging' })).status === 400);
    check('rejects an unknown commission type', (await call('put', `/admin/route/turfs/${tA}/config`, TK.admin, { route_commission_type: 'fixed' })).status === 400);
    check('rejects a negative flat amount', (await call('put', `/admin/route/turfs/${tA}/config`, TK.admin, { route_flat_amount: -10 })).status === 400);
    const cfg1 = await call('put', `/admin/route/turfs/${tA}/config`, TK.admin, { route_split_percentage: 10, route_linked_account_id: `acc_zzrtA${stamp}` });
    check('setting percentage + linked account moves status to "configured"', cfg1.status === 200 && cfg1.data.turf.route_status === 'configured' && Number(cfg1.data.turf.route_split_percentage) === 10, cfg1.data);
    check('...and it is still NOT enabled (configuring is not the same as switching it on)', cfg1.data.turf.route_enabled === 0);

    // the live-environment confirmation gate (admin-API check only; never used with a real payment)
    const liveNoPhrase = await call('put', `/admin/route/turfs/${tA}/config`, TK.admin, { route_environment: 'live' });
    check('switching to live payouts without the confirmation phrase is refused', liveNoPhrase.status === 400 && /ENABLE LIVE PAYOUTS/.test(liveNoPhrase.data.error), liveNoPhrase.data);
    const liveWrongPhrase = await call('put', `/admin/route/turfs/${tA}/config`, TK.admin, { route_environment: 'live', confirm_live_text: 'yes please' });
    check('...or with the wrong phrase', liveWrongPhrase.status === 400);
    const liveOk = await call('put', `/admin/route/turfs/${tA}/config`, TK.admin, { route_environment: 'live', confirm_live_text: 'ENABLE LIVE PAYOUTS' });
    check('...but succeeds with the exact phrase', liveOk.status === 200 && liveOk.data.turf.route_environment === 'live', liveOk.data);
    const backToTest = await call('put', `/admin/route/turfs/${tA}/config`, TK.admin, { route_environment: 'test' });
    check('switching back to test needs no phrase (only test -> live is guarded), and this test never processes a payment while it was live', backToTest.status === 200 && backToTest.data.turf.route_environment === 'test');

    const appr = await call('post', `/admin/route/turfs/${tA}/approve`, TK.admin);
    check('approve records who and when', appr.status === 200 && appr.data.turf.route_status === 'approved' && !!appr.data.turf.route_approved_at && appr.data.turf.route_approved_by === admin.id, appr.data);
    const en = await call('post', `/admin/route/turfs/${tA}/enable`, TK.admin);
    check('enable turns Route on', en.status === 200 && !!en.data.turf.route_enabled && en.data.turf.route_status === 'active', en.data);
    const auditRows = (await call('get', `/admin/route/audit?turf_id=${tA}`, TK.admin)).data.audit_log;
    check('every step is in the audit log with the admin who did it', auditRows.length >= 4 && auditRows.every((a) => a.admin_name === 'admin' || a.admin_id === admin.id) && auditRows.some((a) => a.action === 'enable') && auditRows.some((a) => a.action === 'approve'), auditRows.map((a) => a.action));

    // ================================================================= 5. Turf A: 10% split, real (test-environment) payment
    console.log('\n--- Turf A: 10% split (simulated transfer) ---');
    const orderA = `order_zzrt_a_${stamp}`;
    const bA = await mkBooking(tA, orderA, 1000, 'u1');
    const payA = await payAndConfirm(bA, orderA, 1000);
    await sleep(600);
    const trA = await transferFor(payA.paymentId);
    check('confirmed booking on a Route-enabled 10% turf: one transfer, correctly split', trA && Number(trA.gross_amount) === 1000 && Number(trA.platform_amount) === 100 && Number(trA.owner_amount) === 900 && trA.status === 'SUCCESS', trA);
    check('the transfer was SIMULATED (test environment: no real Razorpay call was made)', trA && /^sim_transfer_/.test(trA.razorpay_transfer_id), trA && trA.razorpay_transfer_id);
    check('the percentage recorded is the turf\'s configured 10%, not anything the client could have sent', Number(trA.split_percentage) === 10);
    const [[bookingAfterA]] = await pool.query('SELECT status FROM bookings WHERE id = ?', [bA]);
    check('the booking itself still confirms normally alongside the Route transfer', bookingAfterA.status === 'confirmed');

    // a client-supplied percentage in the request body must have zero effect
    const orderAx = `order_zzrt_ax_${stamp}`;
    const bAx = await mkBooking(tA, orderAx, 500, 'u1');
    const payAx = `pay_zzrt_${crypto.randomBytes(6).toString('hex')}`;
    await call('post', '/bookings/verify', null, { booking_id: String(bAx), razorpay_order_id: orderAx, razorpay_payment_id: payAx, razorpay_signature: sign(orderAx, payAx), route_split_percentage: 1, platform_amount: 0, owner_amount: 500 });
    await sleep(500);
    const trAx = await transferFor(payAx);
    check('a forged split/percentage in the request body is ignored — the server-stored 10% is used regardless', trAx && Number(trAx.split_percentage) === 10 && Number(trAx.platform_amount) === 50 && Number(trAx.owner_amount) === 450, trAx);

    // duplicate payment (verify called twice, and the webhook for the same payment): still exactly one transfer
    await call('post', '/bookings/verify', null, { booking_id: String(bA), razorpay_order_id: orderA, razorpay_payment_id: payA.paymentId, razorpay_signature: sign(orderA, payA.paymentId) });
    await rawHook('payment.captured', { id: payA.paymentId, order_id: orderA, amount: 100000 });
    await rawHook('payment.captured', { id: payA.paymentId, order_id: orderA, amount: 100000 });
    await sleep(800);
    const [[dupCount]] = await pool.query('SELECT COUNT(*) c FROM route_split_transfers WHERE razorpay_payment_id = ?', [payA.paymentId]);
    check('duplicate verify + webhook x2 for the same payment: still exactly one route_split_transfers row', dupCount.c === 1, dupCount.c);

    // a multi-slot booking (two booking rows, one payment): gross is the sum of both
    const orderA2 = `order_zzrt_a2_${stamp}`;
    const bA2a = await mkBooking(tA, orderA2, 300, 'u1');
    const bA2b = await mkBooking(tA, orderA2, 200, 'u1');
    const payA2 = `pay_zzrt_${crypto.randomBytes(6).toString('hex')}`;
    await call('post', '/bookings/verify', null, { booking_id: `${bA2a},${bA2b}`, razorpay_order_id: orderA2, razorpay_payment_id: payA2, razorpay_signature: sign(orderA2, payA2) });
    await sleep(600);
    const trA2 = await transferFor(payA2);
    check('a multi-slot booking (2 rows, 1 payment): the split is computed on their combined amount (500), not just one row', trA2 && Number(trA2.gross_amount) === 500 && Number(trA2.platform_amount) === 50 && Number(trA2.owner_amount) === 450, trA2);

    // ================================================================= 6. Turf B: Route explicitly kept disabled
    console.log('\n--- Turf B: Route disabled ---');
    const tB = await mkTurf('o1', `ZZ RT Turf B ${stamp}`);
    await call('put', `/admin/route/turfs/${tB}/config`, TK.admin, { route_split_percentage: 15, route_linked_account_id: `acc_zzrtB${stamp}` });
    // deliberately never approved/enabled
    const orderB = `order_zzrt_b_${stamp}`;
    const bB = await mkBooking(tB, orderB, 1000, 'u2');
    const payB = await payAndConfirm(bB, orderB, 1000);
    await sleep(500);
    const [[bookingB]] = await pool.query('SELECT status FROM bookings WHERE id = ?', [bB]);
    check('a configured-but-not-enabled turf: booking still confirms, no transfer is created', payB.verify.status === 200 && bookingB.status === 'confirmed' && (await transferFor(payB.paymentId)) === null);

    // ================================================================= 7. Turf C: 20% split
    console.log('\n--- Turf C: 20% split ---');
    const tC = await mkTurf('o2', `ZZ RT Turf C ${stamp}`);
    await call('put', `/admin/route/turfs/${tC}/config`, TK.admin, { route_split_percentage: 20, route_linked_account_id: `acc_zzrtC${stamp}` });
    await call('post', `/admin/route/turfs/${tC}/approve`, TK.admin);
    await call('post', `/admin/route/turfs/${tC}/enable`, TK.admin);
    const orderC = `order_zzrt_c_${stamp}`;
    const bC = await mkBooking(tC, orderC, 1000, 'u2');
    const payC = await payAndConfirm(bC, orderC, 1000);
    await sleep(600);
    const trC = await transferFor(payC.paymentId);
    check('Turf C at 20%: platform 200, owner 800', trC && Number(trC.platform_amount) === 200 && Number(trC.owner_amount) === 800, trC);
    check('Turf A (10%) and Turf C (20%) are independent — one venue\'s percentage never leaks into another\'s', Number(trA.split_percentage) === 10 && Number(trC.split_percentage) === 20);

    // ================================================================= 7b. Turf E: flat ₹ commission instead of a percentage
    console.log('\n--- Turf E: flat ₹75 commission ---');
    const tE = await mkTurf('o2', `ZZ RT Turf E flat ${stamp}`);
    const cfgFlat = await call('put', `/admin/route/turfs/${tE}/config`, TK.admin, { route_commission_type: 'flat', route_flat_amount: 75, route_linked_account_id: `acc_zzrtE${stamp}` });
    check('switching a turf to flat mode and saving an amount moves it to "configured" too', cfgFlat.status === 200 && cfgFlat.data.turf.route_status === 'configured' && cfgFlat.data.turf.route_commission_type === 'flat' && Number(cfgFlat.data.turf.route_flat_amount) === 75, cfgFlat.data);
    await call('post', `/admin/route/turfs/${tE}/approve`, TK.admin);
    await call('post', `/admin/route/turfs/${tE}/enable`, TK.admin);
    const orderE = `order_zzrt_e_${stamp}`;
    const bE = await mkBooking(tE, orderE, 1000, 'u1');
    const payE = await payAndConfirm(bE, orderE, 1000);
    await sleep(600);
    const trE = await transferFor(payE.paymentId);
    check('flat ₹75 on a ₹1,000 booking: platform 75 (not a %), owner 925', trE && trE.commission_type === 'flat' && Number(trE.flat_amount) === 75 && Number(trE.platform_amount) === 75 && Number(trE.owner_amount) === 925, trE);
    check('the transfer still records an effective percentage for reporting (75/1000 = 7.5%), without that being what was configured', Math.abs(Number(trE.split_percentage) - 7.5) < 0.01, trE.split_percentage);

    // a booking smaller than the flat fee: Book Arena takes the whole (small) amount, never more
    const orderE2 = `order_zzrt_e2_${stamp}`;
    const bE2 = await mkBooking(tE, orderE2, 40, 'u1');
    const payE2 = await payAndConfirm(bE2, orderE2, 40);
    await sleep(600);
    const trE2 = await transferFor(payE2.paymentId);
    check('a booking smaller than the flat fee: Book Arena takes the whole amount, owner gets 0 (never negative), and it is flagged', trE2 && Number(trE2.platform_amount) === 40 && Number(trE2.owner_amount) === 0 && /exceeded/.test(trE2.error_message || ''), trE2);

    // an owner/customer still cannot influence this from the request body
    const orderE3 = `order_zzrt_e3_${stamp}`;
    const bE3 = await mkBooking(tE, orderE3, 500, 'u1');
    const payE3 = `pay_zzrt_${crypto.randomBytes(6).toString('hex')}`;
    await call('post', '/bookings/verify', null, { booking_id: String(bE3), razorpay_order_id: orderE3, razorpay_payment_id: payE3, razorpay_signature: sign(orderE3, payE3), route_flat_amount: 1, route_commission_type: 'percentage' });
    await sleep(600);
    const trE3 = await transferFor(payE3);
    check('a forged commission_type/flat_amount in the request body is ignored — the server-stored flat ₹75 is used regardless', trE3 && trE3.commission_type === 'flat' && Number(trE3.platform_amount) === 75, trE3);

    // ================================================================= 8. disable, then misconfigured-but-enabled
    console.log('\n--- disable + misconfiguration handling ---');
    const dis = await call('post', `/admin/route/turfs/${tC}/disable`, TK.admin);
    check('disable turns it off and the turf can be re-enabled later without re-approving', dis.status === 200 && !dis.data.turf.route_enabled && dis.data.turf.route_status === 'suspended', dis.data);
    const reEnable = await call('post', `/admin/route/turfs/${tC}/enable`, TK.admin);
    check('re-enabling a previously-approved (now suspended) turf does not require configuring/approving again', reEnable.status === 200 && !!reEnable.data.turf.route_enabled, reEnable.data);
    await call('post', `/admin/route/turfs/${tC}/disable`, TK.admin); // leave it off for the rest of the run

    const tD = await mkTurf('o1', `ZZ RT Turf D misconfigured ${stamp}`);
    // force route_enabled = true directly (simulating a bad state) WITHOUT a linked account or percentage
    await pool.query("UPDATE turfs SET route_enabled = true, route_status = 'active' WHERE id = ?", [tD]);
    const orderD = `order_zzrt_d_${stamp}`;
    const bD = await mkBooking(tD, orderD, 1000, 'u1');
    const payD = await payAndConfirm(bD, orderD, 1000);
    await sleep(500);
    const [[bookingD]] = await pool.query('SELECT status FROM bookings WHERE id = ?', [bD]);
    const trD = await transferFor(payD.paymentId);
    check('Route enabled but misconfigured (no linked account/percentage): booking STILL confirms — a Route problem never blocks a booking', bookingD.status === 'confirmed');
    check('...and it is recorded as FAILED with a clear reason, not silently dropped', trD && trD.status === 'FAILED' && /linked account|percentage|status is/.test(trD.error_message || ''), trD);

    // ================================================================= 9. GET /bookings/:id authorization
    console.log('\n--- GET /bookings/:id authorization ---');
    check('the booking\'s own customer can read it', (await call('get', `/bookings/${bA}`, TK.u1)).status === 200);
    check('a different signed-in customer cannot (404, not 403 — existence is not revealed)', (await call('get', `/bookings/${bA}`, TK.u2)).status === 404);
    check('the venue\'s owner can read it', (await call('get', `/bookings/${bA}`, TK.o1)).status === 200);
    check('a different owner cannot', (await call('get', `/bookings/${bA}`, TK.o2)).status === 404);
    check('an admin can read any booking', (await call('get', `/bookings/${bA}`, TK.admin)).status === 200);
    check('no token and no proof: refused', (await call('get', `/bookings/${bA}`, null)).status === 404);
    check('no token but the matching payment id as proof (a guest right after paying): allowed', (await call('get', `/bookings/${bA}?payment_id=${payA.paymentId}`, null)).status === 200);
    check('no token and the WRONG payment id: still refused', (await call('get', `/bookings/${bA}?payment_id=pay_not_it`, null)).status === 404);
    check('the matching order id also works as proof', (await call('get', `/bookings/${bA}?order_id=${orderA}`, null)).status === 200);

    // ================================================================= 10. POST /bookings/confirm-demo
    console.log('\n--- POST /bookings/confirm-demo ---');
    const orderFree = `order_zzrt_free_${stamp}`;
    const bFree = await mkBooking(tA, orderFree, 0, 'u1');
    const orderPaid = `order_zzrt_paid_${stamp}`;
    const bPaid = await mkBooking(tA, orderPaid, 500, 'u1');
    check('a booking that actually has an amount due cannot be confirmed for free', (await call('post', '/bookings/confirm-demo', TK.u1, { booking_id: String(bPaid) })).status === 400);
    const [[stillPending]] = await pool.query('SELECT status FROM bookings WHERE id = ?', [bPaid]);
    check('...and it stays pending', stillPending.status === 'pending');
    check('another customer cannot confirm someone else\'s free booking', (await call('post', '/bookings/confirm-demo', TK.u2, { booking_id: String(bFree) })).status === 403);
    const okFree = await call('post', '/bookings/confirm-demo', TK.u1, { booking_id: String(bFree) });
    check('the booking\'s own customer CAN confirm a genuinely free booking', okFree.status === 200, okFree.data);
    check('confirming it twice is refused (already confirmed, not pending)', (await call('post', '/bookings/confirm-demo', TK.u1, { booking_id: String(bFree) })).status === 409);
    const orderGuest = `order_zzrt_guest_${stamp}`;
    const bGuest = await mkBooking(tA, orderGuest, 0, null); // no account (guest checkout)
    check('a true guest booking (no account) can still be confirmed without a token', (await call('post', '/bookings/confirm-demo', null, { booking_id: String(bGuest) })).status === 200);

    // ================================================================= 11. previewSubscriptionSplit (scaffolding only, not wired in)
    console.log('\n--- subscription Route scaffolding (preview only, not activated) ---');
    const previewOn = await routeSplit.previewSubscriptionSplit({ turfId: tA, grossAmount: 200 });
    check('a Route-ready turf reports subscription-split eligibility and numbers for a future pass to use', previewOn.routeEligible === true && previewOn.platformAmount === 20 && previewOn.ownerAmount === 180, previewOn);
    const previewOff = await routeSplit.previewSubscriptionSplit({ turfId: tLegacy, grossAmount: 200 });
    check('a non-Route turf reports not eligible, with a reason', previewOff.routeEligible === false && !!previewOff.reason, previewOff);
  } catch (e) {
    check('test run finished without an unexpected error', false, e.response ? { status: e.response.status, data: e.response.data } : e.stack);
  } finally {
    try {
      const uid = Object.values(ids.users), oid = Object.values(ids.owners);
      if (created.bookings.length) {
        const q = created.bookings.map(() => '?').join(',');
        await pool.query(`DELETE FROM route_split_transfers WHERE booking_id IN (${q})`, created.bookings);
        await pool.query(`DELETE FROM razorpay_transfers WHERE booking_id IN (${q})`, created.bookings);
        await pool.query(`DELETE FROM bookings WHERE id IN (${q})`, created.bookings);
      }
      if (created.turfs.length) {
        const q = created.turfs.map(() => '?').join(',');
        await pool.query(`DELETE FROM route_split_transfers WHERE turf_id IN (${q})`, created.turfs);
        await pool.query(`DELETE FROM route_audit_log WHERE turf_id IN (${q})`, created.turfs);
        await pool.query(`DELETE FROM turfs WHERE id IN (${q})`, created.turfs);
      }
      await pool.query("DELETE FROM users WHERE email LIKE 'zz_rt_%'");
      await pool.query("DELETE FROM owners WHERE email LIKE 'zz_rt_%'");
      const [[left]] = await pool.query("SELECT (SELECT COUNT(*) FROM turfs WHERE name LIKE 'ZZ RT%') t, (SELECT COUNT(*) FROM users WHERE email LIKE 'zz_rt_%') u, (SELECT COUNT(*) FROM owners WHERE email LIKE 'zz_rt_%') o, (SELECT COUNT(*) FROM route_split_transfers WHERE razorpay_payment_id LIKE 'pay_zzrt_%') rt, (SELECT COUNT(*) FROM bookings WHERE customer_name = 'ZZ RT') b");
      console.log('cleanup done; leftovers (turfs/users/owners/route_transfers/bookings):', left.t, left.u, left.o, left.rt, left.b);
    } catch (e) { console.log('CLEANUP FAILED:', e.message); }
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
