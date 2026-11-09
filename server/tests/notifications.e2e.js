// End-to-end tests for the notification system. Needs the API on localhost:9000 (started with NOTIFICATION_WORKER=off so the
// background worker cannot touch real data while this runs) and the DB in server/.env.
//
// HTTP for everything a customer/owner/admin can do; in-process calls (with a local MOCK of Expo's push service) for push
// delivery, retries, and the scheduler - the scheduler is always run with an explicit `scope` of this test's own ids.
// Creates throwaway rows prefixed "ZZ NT" / zz_nt_ and deletes all of them. Run from the server folder:
//   node tests/notifications.e2e.js
const http = require('http');
const crypto = require('crypto');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

// ---- mock Expo push service (must be configured BEFORE the push module is loaded) ----------------------------------
const mock = { mode: 'ok', sends: [], receipts: [], deadTokens: new Set(), n: 0 };
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/send')) {
      mock.sends.push(...json);
      if (mock.mode === 'down') { res.statusCode = 503; return res.end('{"errors":[{"message":"unavailable"}]}'); }
      return res.end(JSON.stringify({ data: json.map((m) => (mock.deadTokens.has(m.to)
        ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }
        : { status: 'ok', id: `tkt-${++mock.n}` })) }));
    }
    if (req.url.startsWith('/receipts')) {
      mock.receipts.push(...json.ids);
      const out = {}; json.ids.forEach((id) => { out[id] = { status: 'ok' }; });
      return res.end(JSON.stringify({ data: out }));
    }
    res.statusCode = 404; res.end('{}');
  });
});

const axios = require('axios');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const BASE = 'http://localhost:9000/api';
const results = [];
const check = (name, cond, extra) => { results.push(!!cond); console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond ? '' : ' :: ' + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(200); } return v; };
const call = async (method, url, token, data, extraHeaders = {}) => {
  const r = await axios({ method, url: BASE + url, data, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extraHeaders }, validateStatus: () => true });
  return { status: r.status, data: r.data };
};
const pad = (n) => String(n).padStart(2, '0');

(async () => {
  await new Promise((r) => mockServer.listen(0, r));
  const mockPort = mockServer.address().port;
  process.env.EXPO_PUSH_URL = `http://localhost:${mockPort}/send`;
  process.env.EXPO_RECEIPTS_URL = `http://localhost:${mockPort}/receipts`;

  const svc = require('../utils/notifications/service');
  const push = require('../utils/notifications/push');
  const events = require('../utils/notifications/events');
  const sched = require('../utils/notifications/scheduler');
  const T = require('../utils/notifications/time');
  const { TYPES } = require('../utils/notifications/constants');

  const stamp = Date.now();
  const pw = 'Test#12345';
  const mail = (k) => `zz_nt_${k}_${stamp}@example.com`;
  const SPORT = 'ZZNTSport';
  const ids = { users: {}, owners: {}, tokens: {} };
  const created = { turfs: [], bookings: [], tournaments: [], plans: [], requests: [], ownerSubs: [] };
  const inbox = async (who, tok, params = '') => (await call('get', `/notifications?limit=50${params}`, tok)).data.notifications || [];
  const ofType = async (tok, type) => (await inbox(null, tok)).filter((n) => n.type === type);
  const day = (offset = 0) => T.addDays(T.localDateString(), offset);

  try {
    // ================================================================= accounts
    for (const k of ['u1', 'u2', 'u3', 'u4']) {
      await axios.post(BASE + '/users/register', { name: `ZZ NT ${k}`, email: mail(k), phone: '9999999999', password: pw });
      const l = await axios.post(BASE + '/users/login', { email: mail(k), password: pw });
      ids.users[k] = l.data.user.id; ids.tokens[k] = l.data.token;
    }
    for (const k of ['o1', 'o2']) {
      await axios.post(BASE + '/owners/register', { name: `ZZ NT ${k}`, email: mail(k), phone: '9999999999', password: pw });
      const l = await axios.post(BASE + '/owners/login', { email: mail(k), password: pw });
      ids.owners[k] = l.data.owner.id; ids.tokens[k] = l.data.token;
    }
    const [[admin]] = await pool.query('SELECT id FROM admins ORDER BY id LIMIT 1');
    ids.tokens.admin = jwt.sign({ id: admin.id, username: 'admin', role: 'admin' }, process.env.JWT_SECRET || 'your_jwt_secret_key', { expiresIn: '1h' });
    const U = ids.users, O = ids.owners, TK = ids.tokens;
    const to = (k) => ({ type: k.startsWith('o') ? 'owner' : 'user', id: k.startsWith('o') ? O[k] : U[k] });

    // ================================================================= 1. access control + API surface
    console.log('\n--- API security ---');
    for (const [m, u] of [['get', '/notifications'], ['get', '/notifications/unread-count'], ['patch', '/notifications/read-all'], ['get', '/notifications/preferences'], ['post', '/notifications/push-tokens'], ['get', '/notifications/stream']]) {
      check(`${m.toUpperCase()} ${u} without a token -> 401`, (await call(m, u, null, {})).status === 401);
    }
    check('there is NO route to create a notification (a client cannot forge one)', (await call('post', '/notifications', TK.u1, { recipient_id: U.u2, title: 'x', message: 'y' })).status === 404);
    check('non-admin cannot use admin notification routes (403)', (await call('get', '/admin/notifications/stats', TK.u1)).status === 403 && (await call('post', '/admin/notifications/broadcast', TK.o1, {})).status === 403);
    check('external scheduler endpoint is invisible without the cron secret (404)', (await call('post', '/notifications/internal/run', null, {})).status === 404);

    // ================================================================= 2. service: create, dedupe, preferences
    console.log('\n--- service: dedupe + preferences ---');
    const base = { to: to('u1'), type: 'SYSTEM_ANNOUNCEMENT', eventKey: `svc-${stamp}`, data: { title: 'ZZ NT hello', message: 'first' } };
    const a = await svc.notify(base);
    const b = await svc.notify(base);
    check('the same event creates ONE notification (second call is deduplicated)', a.id && b.deduped === true, { a, b });
    check('a different event key creates a new notification', !!(await svc.notify({ ...base, eventKey: `svc2-${stamp}` })).id);
    check('unknown type / missing key / bad recipient never throw', (await svc.notify({ to: to('u1'), type: 'NOPE', eventKey: 'x' })).error && (await svc.notify({ to: to('u1'), type: 'SYSTEM_ANNOUNCEMENT' })).error && (await svc.notify({ to: { type: 'user', id: 0 }, type: 'SYSTEM_ANNOUNCEMENT', eventKey: 'x' })).skipped === 'no-recipient');
    check('user 2 cannot see user 1\'s notifications', (await inbox('u2', TK.u2)).length === 0 && (await inbox('u1', TK.u1)).length === 2);

    const prefs = (await call('get', '/notifications/preferences', TK.u1)).data.preferences;
    check('preferences list every category; payments/bookings/subscriptions/system are locked, the rest can be toggled', ['BOOKINGS', 'PAYMENTS', 'SUBSCRIPTIONS', 'TOURNAMENTS', 'FIND_PLAYERS', 'PROMOTIONS', 'REMINDERS', 'SYSTEM'].every((c) => prefs.some((p) => p.category === c)) && prefs.find((p) => p.category === 'PAYMENTS').locked && !prefs.find((p) => p.category === 'PROMOTIONS').locked && !prefs.some((p) => /GYM|FITNESS|TRAINER/.test(p.category)), prefs.map((p) => p.category));
    check('a locked category cannot be switched off', (await call('patch', '/notifications/preferences', TK.u1, { category: 'PAYMENTS', enabled: false })).status === 400 && (await call('patch', '/notifications/preferences', TK.u1, { category: 'SYSTEM', enabled: false })).status === 400);
    check('an optional category can be switched off and stays off', (await call('patch', '/notifications/preferences', TK.u1, { category: 'PROMOTIONS', enabled: false })).data.preferences.find((p) => p.category === 'PROMOTIONS').enabled === false);
    check('marketing (PROMOTION) respects the opt-out', (await svc.notify({ to: to('u1'), type: 'PROMOTION', eventKey: `promo-${stamp}`, data: { title: 'ZZ NT offer', message: 'x' } })).skipped === 'preference');
    check('transactional notifications ignore preferences (a payment failure still arrives)', !!(await svc.notify({ to: to('u1'), type: 'PAYMENT_FAILED', eventKey: `pf-${stamp}`, data: { subject: 'x', entityId: 1, deepLink: '/x' } })).id);
    check('unknown category / non-boolean rejected', (await call('patch', '/notifications/preferences', TK.u1, { category: 'GYM', enabled: false })).status === 400 && (await call('patch', '/notifications/preferences', TK.u1, { category: 'TOURNAMENTS', enabled: 'no' })).status === 400);

    // ================================================================= 3. read / unread / pagination
    console.log('\n--- notification center API ---');
    for (let i = 0; i < 5; i++) await svc.notify({ to: to('u2'), type: 'SYSTEM_ANNOUNCEMENT', eventKey: `page-${stamp}-${i}`, data: { title: `ZZ NT page ${i}`, message: 'm' } });
    let page1 = (await call('get', '/notifications?limit=2', TK.u2)).data;
    check('list is paginated newest-first with a cursor and an unread count', page1.notifications.length === 2 && page1.next_cursor && page1.unread_count === 5 && page1.notifications[0].id > page1.notifications[1].id, page1);
    const page2 = (await call('get', `/notifications?limit=2&cursor=${page1.next_cursor}`, TK.u2)).data;
    const page3 = (await call('get', `/notifications?limit=2&cursor=${page2.next_cursor}`, TK.u2)).data;
    check('following the cursor walks all 5 without repeats and ends with no cursor', page2.notifications.length === 2 && page3.notifications.length === 1 && page3.next_cursor === null && new Set([...page1.notifications, ...page2.notifications, ...page3.notifications].map((n) => n.id)).size === 5, [page2.next_cursor, page3.next_cursor]);
    const first = page1.notifications[0];
    check('mark one as read: unread count drops and read_at is set (the row is not deleted)', (await call('patch', `/notifications/${first.id}/read`, TK.u2)).data.unread_count === 4 && (await inbox('u2', TK.u2)).find((n) => n.id === first.id).is_read === true && (await inbox('u2', TK.u2)).length === 5);
    check('someone else\'s notification cannot be marked read (404, and it stays unread)', (await call('patch', `/notifications/${page2.notifications[0].id}/read`, TK.u1)).status === 404 && (await call('get', '/notifications/unread-count', TK.u2)).data.unread_count === 4);
    check('unread filter works', (await call('get', '/notifications?unread=1', TK.u2)).data.notifications.every((n) => !n.is_read));
    check('mark all read', (await call('patch', '/notifications/read-all', TK.u2)).data.unread_count === 0 && (await inbox('u2', TK.u2)).length === 5);

    // ================================================================= 4. devices + push (mock Expo)
    console.log('\n--- devices and push delivery ---');
    const tokA = `ExponentPushToken[zzntA${stamp}abcdef]`, tokB = `ExponentPushToken[zzntB${stamp}abcdef]`, tokC = `ExponentPushToken[zzntC${stamp}abcdef]`;
    check('an invalid token is rejected (400)', (await call('post', '/notifications/push-tokens', TK.u1, { push_token: 'not-a-token' })).status === 400);
    check('a device registers for the signed-in account', (await call('post', '/notifications/push-tokens', TK.u1, { push_token: tokA, platform: 'android', device_id: 'dev-A', app_version: '1.0.0', device_name: 'Pixel' })).data.success);
    await call('post', '/notifications/push-tokens', TK.u1, { push_token: tokA, platform: 'android', device_id: 'dev-A' });
    check('registering the same token again does not create a duplicate', (await call('get', '/notifications/push-tokens', TK.u1)).data.devices.length === 1);
    await call('post', '/notifications/push-tokens', TK.u1, { push_token: tokB, platform: 'ios', device_id: 'dev-B' });
    check('multiple devices per user are supported', (await call('get', '/notifications/push-tokens', TK.u1)).data.devices.filter((d) => d.is_active).length === 2);

    mock.sends.length = 0;
    const nb = await svc.notify({ to: to('u1'), type: 'BOOKING_CONFIRMED', eventKey: `push-${stamp}`, data: { bookingId: 1, turfName: 'ZZ NT Turf', when: '7:00 PM today' } });
    await until(() => mock.sends.length >= 2);
    check('one push per device (2), never duplicated', mock.sends.length === 2 && new Set(mock.sends.map((m) => m.to)).size === 2 && mock.sends.every((m) => [tokA, tokB].includes(m.to)), mock.sends.map((m) => m.to));
    const msg = mock.sends[0];
    check('push carries title, body and the deep link; nothing sensitive', msg.title === 'Booking confirmed' && /ZZ NT Turf/.test(msg.body) && msg.data.deep_link === '/booking-receipt?id=1' && msg.data.notification_id === nb.id && !/@|₹|\b\d{10}\b/.test(`${msg.title} ${msg.body} ${JSON.stringify(msg.data)}`), msg);
    await svc.notify({ to: to('u1'), type: 'BOOKING_CONFIRMED', eventKey: `push-${stamp}`, data: { bookingId: 1, turfName: 'ZZ NT Turf', when: 'x' } });
    await sleep(500);
    check('the same event again sends no second push', mock.sends.length === 2);
    const dl = async (id) => (await pool.query('SELECT status FROM notification_deliveries WHERE notification_id = ? ORDER BY device_id', [id]))[0].map((r) => r.status);
    check('delivery log records SENT for both devices', (await dl(nb.id)).join() === 'SENT,SENT', await dl(nb.id));

    // receipts
    await pool.query("UPDATE notification_deliveries SET sent_at = DATE_SUB(NOW(), INTERVAL 20 MINUTE) WHERE notification_id = ?", [nb.id]);
    const rc = await push.checkReceipts();
    check('receipts confirm delivery (DELIVERED)', rc.delivered >= 2 && (await dl(nb.id)).every((s) => s === 'DELIVERED'), rc);

    // in-app only types do not push
    mock.sends.length = 0;
    await svc.notify({ to: to('u1'), type: 'PAYMENT_SUCCESS', eventKey: `ps-${stamp}`, data: { subject: 'x', entityType: 'booking', entityId: 1, deepLink: '/booking-receipt?id=1' } });
    await sleep(500);
    check('in-app-only types (PAYMENT_SUCCESS) create the notification but send no push', mock.sends.length === 0 && (await ofType(TK.u1, 'PAYMENT_SUCCESS')).length === 1);

    // dead token -> deactivated
    mock.deadTokens.add(tokB); mock.sends.length = 0;
    const nd = await svc.notify({ to: to('u1'), type: 'SYSTEM_ANNOUNCEMENT', eventKey: `dead-${stamp}`, data: { title: 'ZZ NT dead', message: 'm' } });
    await until(async () => (await pool.query("SELECT COUNT(*) c FROM user_push_tokens WHERE push_token = ? AND is_active = false", [tokB]))[0][0].c === 1);
    const devs = (await call('get', '/notifications/push-tokens', TK.u1)).data.devices;
    check('an invalid/expired token (DeviceNotRegistered) is deactivated automatically, the good device is untouched', devs.filter((d) => d.is_active).length === 1 && (await dl(nd.id)).sort().join() === 'FAILED,SENT', { devs, dl: await dl(nd.id) });
    mock.sends.length = 0;
    await svc.notify({ to: to('u1'), type: 'SYSTEM_ANNOUNCEMENT', eventKey: `after-dead-${stamp}`, data: { title: 'ZZ NT after', message: 'm' } });
    await until(() => mock.sends.length >= 1); await sleep(300);
    check('no further pushes go to the dead token', mock.sends.length === 1 && mock.sends[0].to === tokA);
    mock.deadTokens.clear();

    // service outage: in-app survives, delivery retries with backoff, later succeeds
    mock.mode = 'down'; mock.sends.length = 0;
    const nr = await svc.notify({ to: to('u1'), type: 'SYSTEM_ANNOUNCEMENT', eventKey: `down-${stamp}`, data: { title: 'ZZ NT outage', message: 'm' } });
    check('push service down: the notification is still created and delivered in-app (nothing throws)', !!nr.id && (await ofType(TK.u1, 'SYSTEM_ANNOUNCEMENT')).some((n) => n.title === 'ZZ NT outage'));
    await until(async () => (await dl(nr.id))[0] === 'RETRY');
    const [[rt]] = await pool.query('SELECT retry_count, next_attempt_at, error FROM notification_deliveries WHERE notification_id = ?', [nr.id]);
    const [[future]] = await pool.query('SELECT next_attempt_at > NOW() AS f FROM notification_deliveries WHERE notification_id = ?', [nr.id]);
    check('the failed push is scheduled for a retry (retry_count 1, a future next_attempt_at, reason recorded)', rt.retry_count === 1 && Number(future.f) === 1 && /503/.test(rt.error), rt);
    mock.mode = 'ok';
    await pool.query('UPDATE notification_deliveries SET next_attempt_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE notification_id = ?', [nr.id]);
    const due = await push.processDue();
    check('the worker retry delivers it once the service is back', (await dl(nr.id))[0] === 'SENT' && due.sent >= 1, due);
    mock.mode = 'down';
    const nx = await svc.notify({ to: to('u1'), type: 'SYSTEM_ANNOUNCEMENT', eventKey: `exhaust-${stamp}`, data: { title: 'ZZ NT exhaust', message: 'm' } });
    await until(async () => (await dl(nx.id))[0] === 'RETRY');
    await pool.query('UPDATE notification_deliveries SET retry_count = 5, next_attempt_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE notification_id = ?', [nx.id]);
    await push.processDue();
    check('retries are not endless: after 5 the delivery is marked FAILED', (await dl(nx.id))[0] === 'FAILED');
    mock.mode = 'ok';

    // device ownership
    await call('post', '/notifications/push-tokens', TK.u2, { push_token: tokC, platform: 'android', device_id: 'dev-C' });
    check('a token seen under another account MOVES to that account (shared device / new login)', (await call('post', '/notifications/push-tokens', TK.u1, { push_token: tokC, device_id: 'dev-C' })).data.success && (await call('get', '/notifications/push-tokens', TK.u2)).data.devices.every((d) => !d.is_active || d.id === undefined) === true);
    const tokC2 = `ExponentPushToken[zzntC2${stamp}abcdef]`;
    await call('post', '/notifications/push-tokens', TK.u1, { push_token: tokC2, device_id: 'dev-C' });
    check('a device that rotates its token replaces the old row (one active row per device)', (await pool.query("SELECT COUNT(*) c FROM user_push_tokens WHERE recipient_type='user' AND recipient_id = ? AND device_id = 'dev-C' AND is_active = true", [U.u1]))[0][0].c === 1);
    const devId = (await call('get', '/notifications/push-tokens', TK.u1)).data.devices[0].id;
    check('you cannot deactivate someone else\'s device', (await call('delete', `/notifications/push-tokens?id=${devId}`, TK.u2)).data.deactivated === false);
    check('sign-out deactivates this device only', (await call('delete', '/notifications/push-tokens', TK.u1, { push_token: tokA })).data.deactivated === true && (await pool.query('SELECT is_active FROM user_push_tokens WHERE push_token = ?', [tokA]))[0][0].is_active === 0);
    check('legacy /users/push-token (older app builds) also registers a device', (await call('post', '/users/push-token', TK.u3, { push_token: `ExponentPushToken[zzntL${stamp}abcdef]` })).data.success && (await call('get', '/notifications/push-tokens', TK.u3)).data.devices.length === 1);

    // ================================================================= 5. bookings + payments (real HTTP verify / webhook)
    console.log('\n--- bookings and payments ---');
    const [tr] = await pool.query("INSERT INTO turfs (name, location, address, sport_type, price_per_hour, owner_id, is_active, slug) VALUES ('ZZ NT Turf', 'Chennai', 'x', ?, 100, ?, true, ?)", [SPORT, O.o1, `zz-nt-turf-${stamp}`]);
    const turfId = tr.insertId; created.turfs.push(turfId);
    const mkBooking = async (slot, orderId, userKey = 'u1', dateStr = day(0), status = 'pending', pay = 'pending') => {
      const [r] = await pool.query("INSERT INTO bookings (turf_id, customer_name, customer_phone, customer_email, booking_date, time_slot, amount, payment_status, status, user_id, advance_amount, razorpay_order_id) VALUES (?, 'ZZ NT', '9999999999', 'x@example.com', ?, ?, 100, ?, ?, ?, 0, ?)", [turfId, dateStr, slot, pay, status, U[userKey], orderId]);
      created.bookings.push(r.insertId); return r.insertId;
    };
    const sign = (o, p) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${o}|${p}`).digest('hex');
    const hook = (event, entity) => { const raw = JSON.stringify({ event, payload: { payment: { entity } } }); return call('post', '/bookings/webhook', null, raw, { 'Content-Type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || 'bookmyarena_secret').update(raw).digest('hex') }); };
    // the JSON body must reach the raw parser untouched
    const rawHook = async (event, entity) => { const raw = JSON.stringify({ event, payload: { payment: { entity } } }); const r = await axios.post(BASE + '/bookings/webhook', raw, { headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || 'bookmyarena_secret').update(raw).digest('hex') }, transformRequest: [(d) => d], validateStatus: () => true }); return r.status; };

    const pendingId = await mkBooking('19:00 - 20:00', `order_zznt_a_${stamp}`);
    await events.emit('payment.initiated', { bookingIds: [pendingId] });
    check('payment initiated: an in-app note (no push), and NO "Booking Confirmed" yet', (await ofType(TK.u1, 'PAYMENT_INITIATED')).length === 1 && (await ofType(TK.u1, 'BOOKING_CONFIRMED')).length === 1 /* the earlier synthetic one */ && (await pool.query("SELECT COUNT(*) c FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.notification_type = 'PAYMENT_INITIATED' AND n.recipient_id = ?", [U.u1]))[0][0].c === 0);
    const beforeConfirmed = (await ofType(TK.u1, 'BOOKING_CONFIRMED')).length;

    const badSig = await call('post', '/bookings/verify', null, { booking_id: String(pendingId), razorpay_order_id: `order_zznt_a_${stamp}`, razorpay_payment_id: 'pay_zznt_bad', razorpay_signature: 'deadbeef' });
    await until(async () => (await ofType(TK.u1, 'PAYMENT_FAILED')).some((n) => n.entity_id === String(pendingId)));
    check('payment verification FAILS: user gets "Payment failed", no booking-confirmed notification, booking is not confirmed', badSig.status === 400 && (await ofType(TK.u1, 'PAYMENT_FAILED')).some((n) => n.entity_id === String(pendingId)) && (await ofType(TK.u1, 'BOOKING_CONFIRMED')).length === beforeConfirmed && (await pool.query('SELECT status FROM bookings WHERE id = ?', [pendingId]))[0][0].status === 'cancelled');

    const b2 = await mkBooking('20:00 - 21:00', `order_zznt_b_${stamp}`);
    check('a pending (unpaid) booking produces no confirmation and no owner notification', (await ofType(TK.o1, 'OWNER_NEW_BOOKING')).length === 0);
    const okVerify = await call('post', '/bookings/verify', null, { booking_id: String(b2), razorpay_order_id: `order_zznt_b_${stamp}`, razorpay_payment_id: `pay_zznt_ok_${stamp}`, razorpay_signature: sign(`order_zznt_b_${stamp}`, `pay_zznt_ok_${stamp}`) });
    await until(async () => (await ofType(TK.o1, 'OWNER_NEW_BOOKING')).length >= 1);
    const conf = (await ofType(TK.u1, 'BOOKING_CONFIRMED')).filter((n) => n.entity_id === String(b2));
    check('payment verified by the backend: the customer gets ONE "Booking confirmed" with the venue and time', okVerify.data.success && conf.length === 1 && /ZZ NT Turf/.test(conf[0].message) && /8:00 PM today/.test(conf[0].message), conf);
    check('...plus an in-app "Payment successful" (verified payment id), no amount shown', (await ofType(TK.u1, 'PAYMENT_SUCCESS')).some((n) => n.entity_id === String(b2)) && !(await inbox('u1', TK.u1)).some((n) => /₹|\d+\.\d\d/.test(n.message)));
    check('the venue owner gets "New booking" + "Payment received" - and only the owner of THAT venue', (await ofType(TK.o1, 'OWNER_NEW_BOOKING')).length === 1 && (await ofType(TK.o1, 'OWNER_PAYMENT_RECEIVED')).length === 1 && (await inbox('o2', TK.o2)).filter((n) => n.type.startsWith('OWNER_')).length === 0);
    check('owner link opens the owner booking screen; customer link opens the receipt', (await ofType(TK.o1, 'OWNER_NEW_BOOKING'))[0].deep_link === `/(owner)/booking/${b2}` && conf[0].deep_link === `/booking-receipt?id=${b2}`);

    // duplicates: verify again + the Razorpay webhook for the same payment
    await call('post', '/bookings/verify', null, { booking_id: String(b2), razorpay_order_id: `order_zznt_b_${stamp}`, razorpay_payment_id: `pay_zznt_ok_${stamp}`, razorpay_signature: sign(`order_zznt_b_${stamp}`, `pay_zznt_ok_${stamp}`) });
    const wh1 = await rawHook('payment.captured', { id: `pay_zznt_ok_${stamp}`, order_id: `order_zznt_b_${stamp}`, amount: 10000 });
    const wh2 = await rawHook('payment.captured', { id: `pay_zznt_ok_${stamp}`, order_id: `order_zznt_b_${stamp}`, amount: 10000 });
    await sleep(1500);
    check('DUPLICATE verify + webhook x2: still exactly one confirmation, one payment-success, one owner notification', wh1 === 200 && wh2 === 200 && (await ofType(TK.u1, 'BOOKING_CONFIRMED')).filter((n) => n.entity_id === String(b2)).length === 1 && (await ofType(TK.u1, 'PAYMENT_SUCCESS')).filter((n) => n.entity_id === String(b2)).length === 1 && (await ofType(TK.o1, 'OWNER_NEW_BOOKING')).length === 1);

    // webhook-only confirmation (customer's app died) + failed attempt via webhook
    const b3 = await mkBooking('21:00 - 22:00', `order_zznt_c_${stamp}`);
    await rawHook('payment.captured', { id: `pay_zznt_c_${stamp}`, order_id: `order_zznt_c_${stamp}`, amount: 10000 });
    await until(async () => (await ofType(TK.u1, 'BOOKING_CONFIRMED')).some((n) => n.entity_id === String(b3)));
    check('confirmed by the webhook alone (app closed): the customer is still notified once', (await ofType(TK.u1, 'BOOKING_CONFIRMED')).filter((n) => n.entity_id === String(b3)).length === 1);
    const b4 = await mkBooking('22:00 - 23:00', `order_zznt_d_${stamp}`);
    await rawHook('payment.failed', { id: `pay_zznt_f_${stamp}`, order_id: `order_zznt_d_${stamp}` });
    await rawHook('payment.failed', { id: `pay_zznt_f_${stamp}`, order_id: `order_zznt_d_${stamp}` });
    await until(async () => (await ofType(TK.u1, 'PAYMENT_FAILED')).some((n) => n.entity_id === String(b4)));
    await sleep(600);
    check('payment.failed webhook (sent twice): ONE "Payment failed", the booking is left pending (the customer may retry), no confirmation', (await ofType(TK.u1, 'PAYMENT_FAILED')).filter((n) => n.entity_id === String(b4)).length === 1 && (await pool.query('SELECT status FROM bookings WHERE id = ?', [b4]))[0][0].status === 'pending' && !(await ofType(TK.u1, 'BOOKING_CONFIRMED')).some((n) => n.entity_id === String(b4)));

    // cancelled by an admin
    const cAdmin = await call('put', `/admin/bookings/${b3}/cancel`, TK.admin);
    await until(async () => (await ofType(TK.u1, 'BOOKING_CANCELLED')).some((n) => n.entity_id === String(b3)));
    check('admin cancels a CONFIRMED booking: customer and venue owner are told', cAdmin.status === 200 && (await ofType(TK.u1, 'BOOKING_CANCELLED')).some((n) => n.entity_id === String(b3)) && (await ofType(TK.o1, 'OWNER_BOOKING_CANCELLED')).length === 1);
    await call('put', `/admin/bookings/${b4}/cancel`, TK.admin); await sleep(600);
    check('cancelling a never-paid pending hold notifies nobody', (await ofType(TK.u1, 'BOOKING_CANCELLED')).filter((n) => n.entity_id === String(b4)).length === 0);

    // slot lost after payment
    const b5 = await mkBooking('20:00 - 21:00', `order_zznt_e_${stamp}`);
    await call('post', '/bookings/verify', null, { booking_id: String(b5), razorpay_order_id: `order_zznt_e_${stamp}`, razorpay_payment_id: `pay_zznt_e_${stamp}`, razorpay_signature: sign(`order_zznt_e_${stamp}`, `pay_zznt_e_${stamp}`) });
    await until(async () => (await ofType(TK.u1, 'BOOKING_CANCELLED')).some((n) => n.entity_id === String(b5)));
    check('the slot was taken by someone else: the customer is told it could not be confirmed (never "confirmed")', (await ofType(TK.u1, 'BOOKING_CANCELLED')).some((n) => n.entity_id === String(b5) && /no longer available/.test(n.message)) && !(await ofType(TK.u1, 'BOOKING_CONFIRMED')).some((n) => n.entity_id === String(b5)));

    // ================================================================= 6. booking reminders (scheduler, scoped)
    console.log('\n--- booking reminders ---');
    const nowMs = Date.now();
    const localParts = (ms) => { const d = new Date(ms + T.OFFSET_MIN * 60000); return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, hhmm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` }; };
    const slotAt = (ms) => { const s = localParts(ms), e = localParts(ms + 3600000); return { date: s.date, slot: `${s.hhmm} - ${e.hhmm}` }; };
    const twoH = slotAt(nowMs + 2 * 3600000 - 5 * 60000);           // the 2-hour window opened 5 minutes ago
    const rBook = await mkBooking(twoH.slot, `order_zznt_r_${stamp}`, 'u2', twoH.date, 'confirmed', 'success');
    await pool.query('UPDATE bookings SET created_at = DATE_SUB(NOW(), INTERVAL 5 HOUR) WHERE id = ?', [rBook]);
    const lateBooking = slotAt(nowMs + 2 * 3600000 - 5 * 60000);
    const rLate = await mkBooking(lateBooking.slot, `order_zznt_l_${stamp}`, 'u3', lateBooking.date, 'confirmed', 'success'); // booked just now for the same time: no 2h reminder
    const rCancelled = await mkBooking(twoH.slot, `order_zznt_x_${stamp}`, 'u1', twoH.date, 'cancelled', 'success');
    await pool.query('UPDATE bookings SET created_at = DATE_SUB(NOW(), INTERVAL 5 HOUR) WHERE id = ?', [rCancelled]);
    const rep1 = await sched.runOnce({ now: Date.now(), scope: { userIds: [U.u1, U.u2, U.u3] } });
    await until(async () => (await ofType(TK.u2, 'BOOKING_REMINDER')).length >= 1);
    const reminders = await ofType(TK.u2, 'BOOKING_REMINDER');
    check('a confirmed booking 2 hours away gets its reminder ("starts in 2 hours")', reminders.length === 1 && /starts in 2 hours/.test(reminders[0].message) && /ZZ NT Turf/.test(reminders[0].message), reminders);
    check('a booking made after the window opened gets no stale reminder', (await ofType(TK.u3, 'BOOKING_REMINDER')).length === 0);
    check('a cancelled booking gets no reminder', (await ofType(TK.u1, 'BOOKING_REMINDER')).length === 0);
    await sched.runOnce({ now: Date.now(), scope: { userIds: [U.u1, U.u2, U.u3] } });
    await sched.runOnce({ now: Date.now(), scope: { userIds: [U.u1, U.u2, U.u3] } });
    await sleep(400);
    check('running the scheduler again (or on another instance) never duplicates the reminder', (await ofType(TK.u2, 'BOOKING_REMINDER')).length === 1);
    const far = slotAt(nowMs + 20 * 3600000);
    check('a scoped scan touches only its own ids (a scan with no matching ids reports nothing)', (await sched.runOnce({ scope: { userIds: [] } })).booking_reminders.length === 0);
    check('the 24h / 2h / 30min windows only open near their time (stale windows are skipped)', sched.openWindow(sched.BOOKING_WINDOWS, nowMs + 24 * 3600000 - 10 * 60000, nowMs - 3 * 86400000, nowMs)?.hours === 24 && sched.openWindow(sched.BOOKING_WINDOWS, nowMs + 24 * 3600000 - 3 * 3600000, nowMs - 3 * 86400000, nowMs) === null && sched.openWindow(sched.BOOKING_WINDOWS, nowMs - 60000, 0, nowMs) === null);

    // ================================================================= 7. sport / activity subscriptions
    console.log('\n--- sport / activity subscriptions ---');
    let subTurfId = null; // a venue of its own: subscriptions reserve slots, so they must not share one with the suite's relative-time bookings
    const mkPlan = async (name, price, days, months, ownerKey = 'o1', turf = null) => {
      turf = turf || subTurfId;
      const [r] = await pool.query("INSERT INTO subscription_plans (owner_id, turf_id, name, price, duration_months, duration_days, start_time, end_time, max_subscribers, is_active) VALUES (?, ?, ?, ?, ?, ?, '18:00:00', '19:00:00', 50, true)", [O[ownerKey], turf, name, price, months, days]);
      created.plans.push(r.insertId); return r.insertId;
    };
    const [tr2] = await pool.query("INSERT INTO turfs (name, location, address, sport_type, price_per_hour, owner_id, is_active, slug) VALUES ('ZZ NT Swim Club', 'Chennai', 'x', 'Swimming', 100, ?, true, ?)", [O.o2, `zz-nt-swim-${stamp}`]);
    created.turfs.push(tr2.insertId);
    const [tr3] = await pool.query("INSERT INTO turfs (name, location, address, sport_type, price_per_hour, owner_id, is_active, slug) VALUES ('ZZ NT Turf Subs', 'Chennai', 'x', ?, 100, ?, true, ?)", [SPORT, O.o1, `zz-nt-subs-${stamp}`]);
    created.turfs.push(tr3.insertId); subTurfId = tr3.insertId;
    const freeBad = await mkPlan('ZZ NT Badminton Monthly', 0, 30, 1);
    const freeSwim = await mkPlan('ZZ NT Swimming Monthly', 0, null, 1, 'o2', tr2.insertId);
    const paid = await mkPlan('ZZ NT Cricket Monthly', 2, 30, 1);

    check('subscription routes need a login (they used to trust a user_id from the request)', (await call('get', '/subscriptions/my-plans', null)).status === 401 && (await call('post', '/subscriptions/purchase', null, { plan_id: paid })).status === 401 && (await call('get', '/subscriptions/1', null)).status === 401);
    check('an owner token cannot be used as a customer (ids overlap between tables)', (await call('get', '/subscriptions/my-plans', TK.o1)).status === 403 && (await call('post', '/subscriptions/purchase', TK.o1, { plan_id: paid })).status === 403);

    const p1 = await call('post', '/subscriptions/purchase', TK.u1, { plan_id: freeBad });
    await until(async () => (await ofType(TK.u1, 'SUBSCRIPTION_ACTIVATED')).length >= 1);
    const act = (await ofType(TK.u1, 'SUBSCRIPTION_ACTIVATED'))[0];
    const [[row1]] = await pool.query('SELECT id, start_date, expiry_date, status, payment_status FROM user_subscriptions WHERE user_id = ? AND plan_id = ?', [U.u1, freeBad]);
    const SR = require('../services/subscriptionReservations');
    const expect30 = SR.addDays(SR.addMonthsClamped(T.localDateString(), 1), -1); // one calendar month, last day inclusive
    check('free plan: subscription is active/paid and expires start + the plan\'s 30 days', p1.data.skipPayment && row1.status === 'active' && row1.payment_status === 'paid' && T.dateOnly(row1.expiry_date) === expect30 && T.dateOnly(row1.start_date) === T.localDateString(), row1);
    check('"Subscription activated" uses the REAL plan, venue and expiry date from the record', act && /ZZ NT Badminton Monthly/.test(act.message) && /ZZ NT Turf/.test(act.message) && act.message.includes(T.prettyDate(expect30)) && act.deep_link === `/subscription/${row1.id}` && act.metadata.sport === SPORT, act);
    check('a free plan has no "payment successful" notification', (await ofType(TK.u1, 'SUBSCRIPTION_PAYMENT_SUCCESS')).length === 0);
    check('the plan\'s owner gets "New subscriber" (and the OTHER owner does not)', (await ofType(TK.o1, 'OWNER_NEW_SUBSCRIPTION')).length === 1 && (await ofType(TK.o2, 'OWNER_NEW_SUBSCRIPTION')).length === 0);

    await call('post', '/subscriptions/purchase', TK.u1, { plan_id: freeSwim });
    await until(async () => (await ofType(TK.u1, 'SUBSCRIPTION_ACTIVATED')).length >= 2);
    const swim = (await ofType(TK.u1, 'SUBSCRIPTION_ACTIVATED')).find((n) => /Swimming/.test(n.message));
    check('a different sport and venue produce different, correct copy (plan + venue name)', swim && /ZZ NT Swim Club/.test(swim.message) && !/Badminton/.test(swim.message) && swim.metadata.sport === 'Swimming', swim);
    const monthPlan = await mkPlan('ZZ NT Tennis 3 Months', 0, null, 3);
    await call('post', '/subscriptions/purchase', TK.u3, { plan_id: monthPlan });
    const [[mrow]] = await pool.query('SELECT start_date, expiry_date FROM user_subscriptions WHERE user_id = ? AND plan_id = ?', [U.u3, monthPlan]);
    const sd = T.dateOnly(mrow.start_date); const ex3 = new Date(Number(sd.slice(0, 4)), Number(sd.slice(5, 7)) - 1 + 3, Number(sd.slice(8, 10)));
    check('a 3-month plan runs 3 calendar months from the start date (last day = the day before the period ends)', T.dateOnly(mrow.expiry_date) === SR.addDays(SR.addMonthsClamped(sd, 3), -1), [sd, T.dateOnly(mrow.expiry_date)]);

    // buying the SAME schedule again while it is active is refused (renewal is its own paid flow: /subscriptions/:id/renew, see subscriptions.e2e.js)
    const again = await call('post', '/subscriptions/purchase', TK.u1, { plan_id: freeBad });
    check('buying the same schedule again while it is active is refused instead of creating a duplicate', again.status === 409 && /already have an active subscription/.test(again.data.error) && (await pool.query('SELECT COUNT(*) c FROM user_subscriptions WHERE user_id = ? AND plan_id = ?', [U.u1, freeBad]))[0][0].c === 1, again.data);

    // paid: real Razorpay order, price from the plan, verified by signature
    const buy = await call('post', '/subscriptions/purchase', TK.u2, { plan_id: paid, amount: 1 });
    check('paid plan: the order amount comes from the PLAN (200 paise), not the client-sent amount', buy.data.success && buy.data.amount === 200 && /^order_/.test(buy.data.order_id), buy.data);
    const oid = buy.data.order_id;
    const [[pend]] = await pool.query('SELECT id, status, payment_status FROM user_subscriptions WHERE razorpay_order_id = ?', [oid]);
    check('before payment the subscription is PENDING (not active) and not listed', pend.status === 'pending' && pend.payment_status === 'pending' && (await call('get', '/subscriptions/my-plans', TK.u2)).data.subscriptions.length === 0);
    check('no "Subscription activated" exists before the payment is verified', (await ofType(TK.u2, 'SUBSCRIPTION_ACTIVATED')).length === 0);
    const pay1 = `pay_zznt_s1_${stamp}`;
    check('a bad signature does not activate it', (await call('post', '/subscriptions/verify', TK.u2, { razorpay_order_id: oid, razorpay_payment_id: pay1, razorpay_signature: 'nope' })).status === 400 && (await pool.query('SELECT status FROM user_subscriptions WHERE id = ?', [pend.id]))[0][0].status === 'pending');
    check('another customer cannot verify (or hijack) this order (403)', (await call('post', '/subscriptions/verify', TK.u3, { razorpay_order_id: oid, razorpay_payment_id: pay1, razorpay_signature: sign(oid, pay1) })).status === 403);
    await rawHook('payment.failed', { id: `pay_zznt_sf_${stamp}`, order_id: oid });
    await rawHook('payment.failed', { id: `pay_zznt_sf_${stamp}`, order_id: oid });
    await until(async () => (await ofType(TK.u2, 'SUBSCRIPTION_PAYMENT_FAILED')).length >= 1); await sleep(500);
    check('failed subscription payment (webhook twice): ONE "Subscription payment failed", still pending, never active', (await ofType(TK.u2, 'SUBSCRIPTION_PAYMENT_FAILED')).length === 1 && (await pool.query('SELECT status FROM user_subscriptions WHERE id = ?', [pend.id]))[0][0].status === 'pending' && (await ofType(TK.u2, 'SUBSCRIPTION_ACTIVATED')).length === 0);
    const v1 = await call('post', '/subscriptions/verify', TK.u2, { razorpay_order_id: oid, razorpay_payment_id: pay1, razorpay_signature: sign(oid, pay1), user_id: 999999, plan_id: freeBad, amount: 1 });
    await until(async () => (await ofType(TK.u2, 'SUBSCRIPTION_ACTIVATED')).length >= 1);
    const [[actRow]] = await pool.query('SELECT user_id, plan_id, status, payment_status, razorpay_payment_id FROM user_subscriptions WHERE id = ?', [pend.id]);
    check('verified payment activates the subscription for THAT order\'s plan and customer (forged user_id / plan_id in the body are ignored)', v1.data.success && actRow.user_id === U.u2 && actRow.plan_id === paid && actRow.status === 'active' && actRow.payment_status === 'paid' && actRow.razorpay_payment_id === pay1, actRow);
    check('user gets Activated + Subscription payment successful; owner gets New subscriber + Payment received', (await ofType(TK.u2, 'SUBSCRIPTION_ACTIVATED')).length === 1 && (await ofType(TK.u2, 'SUBSCRIPTION_PAYMENT_SUCCESS')).length === 1 && (await ofType(TK.o1, 'OWNER_SUBSCRIPTION_PAYMENT_RECEIVED')).length === 1 && /ZZ NT Cricket Monthly/.test((await ofType(TK.u2, 'SUBSCRIPTION_PAYMENT_SUCCESS'))[0].message));
    await call('post', '/subscriptions/verify', TK.u2, { razorpay_order_id: oid, razorpay_payment_id: pay1, razorpay_signature: sign(oid, pay1) });
    await rawHook('payment.captured', { id: pay1, order_id: oid, amount: 200 });
    await rawHook('payment.captured', { id: pay1, order_id: oid, amount: 200 });
    await sleep(1500);
    check('DUPLICATE verify + webhook x2 for the same payment: one subscription, one set of notifications', (await pool.query('SELECT COUNT(*) c FROM user_subscriptions WHERE razorpay_order_id = ?', [oid]))[0][0].c === 1 && (await ofType(TK.u2, 'SUBSCRIPTION_ACTIVATED')).length === 1 && (await ofType(TK.u2, 'SUBSCRIPTION_PAYMENT_SUCCESS')).length === 1 && (await ofType(TK.o1, 'OWNER_NEW_SUBSCRIPTION')).filter((n) => n.entity_id === String(pend.id)).length === 1);
    const paid2 = await mkPlan('ZZ NT Cricket Monthly Evening', 2, 30, 1);
    await pool.query("UPDATE subscription_plans SET start_time = ?, end_time = ? WHERE id = ?", [`${pad((new Date().getHours() + 12) % 24)}:00:00`, `${pad((new Date().getHours() + 13) % 24)}:00:00`, paid2]); // a different schedule, 12h from now: this suite books slots relative to the current time and a booking in the way correctly cancels a paid subscription
    const oid2 = (await call('post', '/subscriptions/purchase', TK.u3, { plan_id: paid2 })).data.order_id;
    await rawHook('payment.captured', { id: `pay_zznt_s3_${stamp}`, order_id: oid2, amount: 200 });
    await until(async () => (await ofType(TK.u3, 'SUBSCRIPTION_ACTIVATED')).some((n) => /Cricket/.test(n.message))); // u3 already has an older Tennis one: wait for THIS one
    check('the webhook alone activates a paid subscription (customer\'s phone died after paying) and notifies once',(await pool.query('SELECT status, payment_status FROM user_subscriptions WHERE razorpay_order_id = ?', [oid2]))[0][0].status === 'active' && (await ofType(TK.u3, 'SUBSCRIPTION_ACTIVATED')).filter((n) => /Cricket/.test(n.message)).length === 1);

    // detail screen access (deep-link target)
    const subId = actRow && pend.id;
    check('subscription detail: the customer and the plan\'s owner can open it, nobody else (403)', (await call('get', `/subscriptions/${subId}`, TK.u2)).data.subscription.plan_name === 'ZZ NT Cricket Monthly' && (await call('get', `/subscriptions/${subId}`, TK.o1)).status === 200 && (await call('get', `/subscriptions/${subId}`, TK.u1)).status === 403 && (await call('get', `/subscriptions/${subId}`, TK.o2)).status === 403);
    check('subscription dates leave the API as plain YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test((await call('get', `/subscriptions/${subId}`, TK.u2)).data.subscription.expiry_date));

    // cancellation
    check('an owner cannot cancel another owner\'s subscriber (404)', (await call('delete', `/subscriptions/owner/subscribers/${subId}`, TK.o2)).status === 403 && (await pool.query('SELECT status FROM user_subscriptions WHERE id = ?', [subId]))[0][0].status === 'active');
    const cancelRes = await call('delete', `/subscriptions/owner/subscribers/${subId}`, TK.o1);
    await until(async () => (await ofType(TK.u2, 'SUBSCRIPTION_CANCELLED')).length >= 1);
    check('owner cancels: the backend records "cancelled" FIRST, then the customer is told (once)', cancelRes.status === 200 && (await pool.query('SELECT status FROM user_subscriptions WHERE id = ?', [subId]))[0][0].status === 'cancelled' && (await ofType(TK.u2, 'SUBSCRIPTION_CANCELLED')).length === 1);
    await call('delete', `/subscriptions/owner/subscribers/${subId}`, TK.o1); await sleep(400);
    check('cancelling twice announces once', (await ofType(TK.u2, 'SUBSCRIPTION_CANCELLED')).length === 1);

    // ================================================================= 8. subscription scheduler (scoped, real rows)
    console.log('\n--- subscription reminders, expiry, renewal ---');
    const insSub = async (userKey, planId, turf, startOff, endOff, status = 'active', payStatus = 'paid') => {
      const [r] = await pool.query("INSERT INTO user_subscriptions (user_id, plan_id, turf_id, start_date, expiry_date, status, payment_status, razorpay_payment_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [U[userKey], planId, turf, day(startOff), day(endOff), status, payStatus, `pay_zznt_${Math.random().toString(36).slice(2, 10)}`]);
      return r.insertId;
    };
    const planA = await mkPlan('ZZ NT Football Monthly', 500, 30, 1);
    // fresh users' worth of rows: u2 owns three periods at different points
    const s7 = await insSub('u2', planA, turfId, -23, 7);
    const runFor = (keys) => sched.runOnce({ scope: { userIds: keys.map((k) => U[k]) } });
    let rep = await runFor(['u2']);
    check('7 days before expiry: a renewal reminder using the actual expiry date', rep.subscription_reminders.some((r) => r.subscriptionId === s7 && r.threshold === 7), rep.subscription_reminders);
    await until(async () => (await ofType(TK.u2, 'SUBSCRIPTION_RENEWAL_REMINDER')).length >= 1);
    const r7 = (await ofType(TK.u2, 'SUBSCRIPTION_RENEWAL_REMINDER'))[0];
    check('reminder text: real plan name + venue + "7 days"', /ZZ NT Football Monthly/.test(r7.message) && /ZZ NT Turf/.test(r7.message) && /7 days/.test(r7.message) && r7.deep_link === `/subscription/${s7}`, r7);
    await runFor(['u2']); await sleep(400);
    check('the same reminder is never sent twice', (await ofType(TK.u2, 'SUBSCRIPTION_RENEWAL_REMINDER')).length === 1);
    await pool.query('UPDATE user_subscriptions SET expiry_date = ? WHERE id = ?', [day(3), s7]);
    await runFor(['u2']); await until(async () => (await ofType(TK.u2, 'SUBSCRIPTION_EXPIRING')).length >= 1);
    check('3 days before: "expiring soon"', /expiring soon \(3 days left\)/.test((await ofType(TK.u2, 'SUBSCRIPTION_EXPIRING'))[0].message));
    await pool.query('UPDATE user_subscriptions SET expiry_date = ? WHERE id = ?', [day(1), s7]);
    await runFor(['u2']); await until(async () => (await ofType(TK.u2, 'SUBSCRIPTION_EXPIRING')).length >= 2);
    check('1 day before: "expires tomorrow"', (await ofType(TK.u2, 'SUBSCRIPTION_EXPIRING')).some((n) => /expires tomorrow/.test(n.message)));

    // renewal suppresses outdated reminders
    const sRenewedOld = await insSub('u3', planA, turfId, -28, 2);
    const sRenewedNew = await insSub('u3', planA, turfId, 0, 30);
    await runFor(['u3']); await sleep(1200);
    check('a RENEWED subscription (a later paid period exists) gets no outdated expiry reminder', (await inbox('u3', TK.u3)).filter((n) => ['SUBSCRIPTION_EXPIRING', 'SUBSCRIPTION_RENEWAL_REMINDER'].includes(n.type) && n.entity_id === String(sRenewedOld)).length === 0);
    check('...and nothing is sent for the new period until it nears its end', !(await inbox('u3', TK.u3)).some((n) => n.entity_id === String(sRenewedNew) && /expir/i.test(n.title)));
    const sCancelled = await insSub('u3', await mkPlan('ZZ NT Cancelled Plan', 1, 30, 1), turfId, -28, 1, 'cancelled');
    await runFor(['u3']); await sleep(600);
    check('a cancelled subscription gets no expiry reminder', !(await inbox('u3', TK.u3)).some((n) => n.entity_id === String(sCancelled)));

    // expiry maintained by the backend
    const sJustExpired = await insSub('u1', planA, turfId, -31, -1);
    const sLongAgo = await insSub('u1', planA, turfId, -80, -50);
    const sRenewedExpired = await insSub('u1', await mkPlan('ZZ NT Renewed Plan', 1, 30, 1), turfId, -31, -1);
    await insSub('u1', (await pool.query('SELECT plan_id FROM user_subscriptions WHERE id = ?', [sRenewedExpired]))[0][0].plan_id, turfId, 0, 30); // a newer paid period of that plan
    rep = await runFor(['u1']);
    await until(async () => (await ofType(TK.u1, 'SUBSCRIPTION_EXPIRED')).length >= 1);
    const st = async (id) => (await pool.query('SELECT status FROM user_subscriptions WHERE id = ?', [id]))[0][0].status;
    check('an active subscription past its end date is marked EXPIRED by the backend (status maintained server-side)', (await st(sJustExpired)) === 'expired' && (await st(sLongAgo)) === 'expired' && (await st(sRenewedExpired)) === 'expired');
    check('"Subscription expired" is sent for the one that just lapsed', (await ofType(TK.u1, 'SUBSCRIPTION_EXPIRED')).some((n) => n.entity_id === String(sJustExpired) && /has expired/.test(n.message)));
    check('long-lapsed ones are corrected silently (no notification about something that ended 50 days ago)', !(await inbox('u1', TK.u1)).some((n) => n.entity_id === String(sLongAgo) && n.type === 'SUBSCRIPTION_EXPIRED'));
    check('a period that was RENEWED does not send "expired" (the customer is still subscribed)', !(await inbox('u1', TK.u1)).some((n) => n.entity_id === String(sRenewedExpired) && n.type === 'SUBSCRIPTION_EXPIRED'));
    await runFor(['u1']); await sleep(500);
    check('expiry runs once: a second pass changes and sends nothing more', (await ofType(TK.u1, 'SUBSCRIPTION_EXPIRED')).filter((n) => n.entity_id === String(sJustExpired)).length === 1);

    // the owner's own Book Arena platform plan: a different thing, sent to a different recipient
    const [os1] = await pool.query("INSERT INTO owner_subscriptions (owner_id, plan_name, price, start_date, expiry_date, status, payment_status) VALUES (?, 'ZZ NT Pro', 999, ?, ?, 'active', 'paid')", [O.o1, day(-27), day(3)]);
    const [os2] = await pool.query("INSERT INTO owner_subscriptions (owner_id, plan_name, price, start_date, expiry_date, status, payment_status) VALUES (?, 'ZZ NT Basic', 99, ?, ?, 'expired', 'paid')", [O.o2, day(-31), day(-1)]);
    created.ownerSubs.push(os1.insertId, os2.insertId);
    await sched.runOnce({ scope: { ownerIds: [O.o1, O.o2] } });
    await until(async () => (await ofType(TK.o1, 'OWNER_SUBSCRIPTION_EXPIRING')).length >= 1 && (await ofType(TK.o2, 'OWNER_SUBSCRIPTION_EXPIRED')).length >= 1);
    check('owner\'s Book Arena plan: expiring notice to that owner (not a customer notification)', (await ofType(TK.o1, 'OWNER_SUBSCRIPTION_EXPIRING')).length === 1 && /ZZ NT Pro/.test((await ofType(TK.o1, 'OWNER_SUBSCRIPTION_EXPIRING'))[0].message) && (await ofType(TK.u1, 'OWNER_SUBSCRIPTION_EXPIRING')).length === 0);
    check('owner\'s plan recorded as expired: expired notice to that owner only', (await ofType(TK.o2, 'OWNER_SUBSCRIPTION_EXPIRED')).length === 1 && (await ofType(TK.o1, 'OWNER_SUBSCRIPTION_EXPIRED')).length === 0);

    // ================================================================= 9. tournaments
    console.log('\n--- tournaments ---');
    await pool.query("INSERT INTO player_availability (user_id, sport_type, preferred_location, availability_start, availability_end, availability_date, role, skill_level, status) VALUES (?, ?, 'Chennai', '18:00', '20:00', ?, 'any', 'all', 'active'), (?, ?, 'Chennai', '18:00', '20:00', ?, 'any', 'all', 'active')", [U.u1, SPORT, day(3), U.u3, SPORT, day(3)]);
    await call('patch', '/notifications/preferences', TK.u3, { category: 'TOURNAMENTS', enabled: false });
    const tCreate = await call('post', '/tournaments', TK.o1, { name: `ZZ NT Cup ${stamp}`, sport: SPORT, venue: 'ZZ NT Turf', location: 'Chennai', start_date: day(10), end_date: day(12), format_type: 'Knockout', max_teams: 8, entry_fee: 0 });
    const TID = tCreate.data.tournament_id; created.tournaments.push(TID); const SLUG = tCreate.data.slug;
    await until(async () => (await ofType(TK.u1, 'TOURNAMENT_CREATED')).length >= 1);
    check('a new tournament is announced to people interested in that sport (and area)', (await ofType(TK.u1, 'TOURNAMENT_CREATED')).length === 1 && /ZZ NT Cup/.test((await ofType(TK.u1, 'TOURNAMENT_CREATED'))[0].message) && (await ofType(TK.u1, 'TOURNAMENT_CREATED'))[0].deep_link === `/tournament/${SLUG}` && /near you/.test((await ofType(TK.u1, 'TOURNAMENT_CREATED'))[0].title), await ofType(TK.u1, 'TOURNAMENT_CREATED'));
    check('...not spammed to everyone: a user with no interest gets nothing; one who opted out of tournaments gets nothing; the host gets nothing; a customer who has booked that sport does', (await ofType(TK.u4, 'TOURNAMENT_CREATED')).length === 0 && (await ofType(TK.u3, 'TOURNAMENT_CREATED')).length === 0 && (await ofType(TK.o1, 'TOURNAMENT_CREATED')).length === 0 && (await ofType(TK.u2, 'TOURNAMENT_CREATED')).length === 1);
    await call('patch', '/notifications/preferences', TK.u3, { category: 'TOURNAMENTS', enabled: true });

    await call('post', `/tournaments/${TID}/join`, TK.u2, {});
    await call('post', `/tournaments/${TID}/join`, TK.u1, {});
    await call('post', `/tournaments/${TID}/join`, TK.u3, {});
    await until(async () => (await ofType(TK.o1, 'TOURNAMENT_JOIN_REQUEST')).length >= 3);
    check('the host gets one "join request" per player (with the player\'s name, no contact details)', (await ofType(TK.o1, 'TOURNAMENT_JOIN_REQUEST')).length === 3 && (await ofType(TK.o1, 'TOURNAMENT_JOIN_REQUEST')).every((n) => /ZZ NT u\d/.test(n.message) && n.deep_link === `/(owner)/my-tournaments/${TID}`));
    const pid = async (k) => (await pool.query('SELECT id FROM tournament_participants WHERE tournament_id = ? AND user_id = ?', [TID, U[k]]))[0][0].id;
    const teamA = (await call('post', `/tournaments/${TID}/teams`, TK.o1, { name: 'ZZ NT Titans' })).data.team_id;
    const teamB = (await call('post', `/tournaments/${TID}/teams`, TK.o1, { name: 'ZZ NT Warriors' })).data.team_id;
    check('a normal user cannot approve a join request (403) - so no forged approval notification', (await call('patch', `/tournaments/${TID}/participants/${await pid('u2')}`, TK.u1, { status: 'APPROVED' })).status === 403 && (await ofType(TK.u2, 'TOURNAMENT_JOIN_APPROVED')).length === 0);
    await call('patch', `/tournaments/${TID}/participants/${await pid('u2')}`, TK.o1, { status: 'APPROVED', team_id: teamA });
    await call('patch', `/tournaments/${TID}/participants/${await pid('u3')}`, TK.o1, { status: 'APPROVED', team_id: teamB });
    await call('patch', `/tournaments/${TID}/participants/${await pid('u1')}`, TK.o1, { status: 'REJECTED' });
    await until(async () => (await ofType(TK.u2, 'TOURNAMENT_TEAM_ASSIGNED')).length >= 1 && (await ofType(TK.u1, 'TOURNAMENT_JOIN_REJECTED')).length >= 1);
    check('approved: "You\'re approved for <tournament>" to that player only', (await ofType(TK.u2, 'TOURNAMENT_JOIN_APPROVED')).length === 1 && /approved for ZZ NT Cup/.test((await ofType(TK.u2, 'TOURNAMENT_JOIN_APPROVED'))[0].message) && (await ofType(TK.u1, 'TOURNAMENT_JOIN_APPROVED')).length === 0);
    check('rejected: "was not approved" to that player', (await ofType(TK.u1, 'TOURNAMENT_JOIN_REJECTED')).length === 1 && /not approved/.test((await ofType(TK.u1, 'TOURNAMENT_JOIN_REJECTED'))[0].message));
    check('team assigned: "You\'ve been added to <team>"', /added to ZZ NT Titans/.test((await ofType(TK.u2, 'TOURNAMENT_TEAM_ASSIGNED'))[0].message));
    await call('patch', `/tournaments/${TID}/participants/${await pid('u2')}`, TK.o1, { status: 'APPROVED' }); await sleep(400);
    check('re-saving the same decision does not notify again', (await ofType(TK.u2, 'TOURNAMENT_JOIN_APPROVED')).length === 1);

    await call('post', `/tournaments/${TID}/announcements`, TK.o1, { title: 'ZZ NT Rain plan', content: 'Matches move to 5 PM if it rains.' });
    await until(async () => (await ofType(TK.u2, 'TOURNAMENT_ANNOUNCEMENT')).length >= 1);
    check('an announcement reaches the tournament\'s approved players only', (await ofType(TK.u2, 'TOURNAMENT_ANNOUNCEMENT')).length === 1 && (await ofType(TK.u3, 'TOURNAMENT_ANNOUNCEMENT')).length === 1 && (await ofType(TK.u1, 'TOURNAMENT_ANNOUNCEMENT')).length === 0);

    const fx = await call('post', `/tournaments/${TID}/fixtures`, TK.o1, { team_a_id: teamA, team_b_id: teamB, match_date: day(4), match_time: '19:00', stage: 'Final' });
    const FID = fx.data.fixture_id;
    await until(async () => (await ofType(TK.u2, 'TOURNAMENT_MATCH_SCHEDULED')).length >= 1);
    check('a scheduled match tells both teams\' players', (await ofType(TK.u2, 'TOURNAMENT_MATCH_SCHEDULED')).length === 1 && (await ofType(TK.u3, 'TOURNAMENT_MATCH_SCHEDULED')).length === 1 && /ZZ NT Titans vs ZZ NT Warriors/.test((await ofType(TK.u2, 'TOURNAMENT_MATCH_SCHEDULED'))[0].message) && (await ofType(TK.u1, 'TOURNAMENT_MATCH_SCHEDULED')).length === 0);

    // match reminder window
    const m1 = slotAt(nowMs + 3600000 - 5 * 60000);
    const fx2 = await call('post', `/tournaments/${TID}/fixtures`, TK.o1, { team_a_id: teamA, team_b_id: teamB, match_date: m1.date, match_time: m1.slot.slice(0, 5), stage: 'Group' });
    await pool.query('UPDATE tournament_fixtures SET created_at = DATE_SUB(NOW(), INTERVAL 5 HOUR) WHERE id = ?', [fx2.data.fixture_id]);
    await sched.runOnce({ scope: { tournamentIds: [TID] } });
    await until(async () => (await ofType(TK.u2, 'TOURNAMENT_MATCH_REMINDER')).length >= 1);
    await sched.runOnce({ scope: { tournamentIds: [TID] } }); await sleep(400);
    check('match reminder: players of both teams are reminded once, 1 hour before', (await ofType(TK.u2, 'TOURNAMENT_MATCH_REMINDER')).length === 1 && (await ofType(TK.u3, 'TOURNAMENT_MATCH_REMINDER')).length === 1 && /starts in 1 hour/.test((await ofType(TK.u2, 'TOURNAMENT_MATCH_REMINDER'))[0].message) && (await ofType(TK.u1, 'TOURNAMENT_MATCH_REMINDER')).length === 0);
    await call('delete', `/tournaments/${TID}/fixtures/${fx2.data.fixture_id}`, TK.o1);

    // live match: exactly one push-worthy event at kickoff, none per score
    const st2 = (s) => call('post', `/tournament-matches/${FID}/status`, TK.o1, { status: s });
    await st2('LIVE');
    await until(async () => (await ofType(TK.u2, 'TOURNAMENT_MATCH_LIVE')).length >= 1);
    const live = (await ofType(TK.u2, 'TOURNAMENT_MATCH_LIVE'))[0];
    check('match LIVE: the two teams\' players are told ("<tournament> is LIVE" / "A vs B has started") and it deep-links to the live match', /is LIVE/.test(live.title) && /ZZ NT Titans vs ZZ NT Warriors has started/.test(live.message) && live.deep_link === `/tournament/live/${FID}` && (await ofType(TK.u3, 'TOURNAMENT_MATCH_LIVE')).length === 1);
    check('...and nobody else: not the rejected player, not the host', (await ofType(TK.u1, 'TOURNAMENT_MATCH_LIVE')).length === 0 && (await ofType(TK.o1, 'TOURNAMENT_MATCH_LIVE')).length === 0);
    const countBefore = (await inbox('u2', TK.u2)).length;
    for (let i = 0; i < 6; i++) await call('post', `/tournament-matches/${FID}/events`, TK.o1, { event_type: i % 2 ? 'GOAL' : 'YELLOW_CARD', team_id: teamA });
    await st2('PAUSED'); await st2('LIVE'); await sleep(1200);
    check('LIVE SCORES DO NOT SPAM: 6 score events + a break + resume created ZERO notifications', (await inbox('u2', TK.u2)).length === countBefore && (await ofType(TK.u2, 'TOURNAMENT_MATCH_LIVE')).length === 1);
    await st2('FINISHED');
    await until(async () => (await ofType(TK.u2, 'TOURNAMENT_COMPLETED')).length >= 1 && (await ofType(TK.u2, 'TOURNAMENT_MATCH_COMPLETED')).length >= 1 && (await ofType(TK.u3, 'TOURNAMENT_MATCH_COMPLETED')).length >= 1);
    check('match finished: result notification with the final score; the tournament completes', /ZZ NT Titans 1 - 0 ZZ NT Warriors|ZZ NT Titans 3 - 0 ZZ NT Warriors|ZZ NT Titans \d - 0/.test((await ofType(TK.u2, 'TOURNAMENT_MATCH_COMPLETED'))[0].message) && (await ofType(TK.u3, 'TOURNAMENT_MATCH_COMPLETED')).length === 1, await ofType(TK.u2, 'TOURNAMENT_MATCH_COMPLETED'));
    check('tournament completed: once, to the tournament\'s players', (await ofType(TK.u2, 'TOURNAMENT_COMPLETED')).length === 1 && (await ofType(TK.u1, 'TOURNAMENT_COMPLETED')).length === 0);

    // ================================================================= 10. find players
    console.log('\n--- find players ---');
    const [pr] = await pool.query("INSERT INTO player_requests (host_id, turf_id, sport_type, match_type, match_date, match_time, total_slots, filled_slots, skill_level, status, share_token, booking_time_slot) VALUES (?, ?, ?, 'friendly', ?, '19:00:00', 5, 1, 'all', 'open', ?, '19:00 - 20:00')", [U.u1, turfId, SPORT, day(2), `zznt${stamp}`]);
    const PR = pr.insertId; created.requests.push(PR);
    await events.emit('find_players.match_created', { matchRequestId: PR });
    check('a new open match is announced to players available for that sport - not to its host, not to unrelated users', (await ofType(TK.u3, 'MATCH_REQUEST_CREATED')).length === 1 && (await ofType(TK.u1, 'MATCH_REQUEST_CREATED')).length === 0 && (await ofType(TK.u2, 'MATCH_REQUEST_CREATED')).length === 0 && (await ofType(TK.u3, 'MATCH_REQUEST_CREATED'))[0].deep_link === '/find-players');
    check('joining now needs a login (it used to trust a user_id in the body)', (await call('post', '/match-requests/join', null, { match_id: PR, user_id: U.u2, role: 'any', payment_type: 'split' })).status === 401);
    await call('post', '/match-requests/join', TK.u2, { match_id: PR, role: 'any', payment_type: 'split', user_id: U.u3 });
    await until(async () => (await ofType(TK.u1, 'MATCH_JOIN_REQUEST')).length >= 1);
    check('a join request reaches the host, naming the REAL joining player (a forged user_id in the body is ignored)', (await ofType(TK.u1, 'MATCH_JOIN_REQUEST')).length === 1 && /ZZ NT u2/.test((await ofType(TK.u1, 'MATCH_JOIN_REQUEST'))[0].message));
    const mp2 = (await pool.query('SELECT id FROM match_players WHERE match_id = ? AND user_id = ?', [PR, U.u2]))[0][0].id;
    await until(async () => (await ofType(TK.u2, 'MATCH_JOIN_APPROVED')).length >= 1);
    check('a free join is approved instantly by the existing flow: the player is told once', (await ofType(TK.u2, 'MATCH_JOIN_APPROVED')).length === 1);
    // put that request back to "awaiting the host" (state set directly) to test the host's decision path
    await pool.query("UPDATE match_players SET status = 'pending' WHERE id = ?", [mp2]);
    await pool.query("DELETE FROM notifications WHERE recipient_type = 'user' AND recipient_id = ? AND notification_type = 'MATCH_JOIN_APPROVED'", [U.u2]);
    check('only the host can approve (the host is taken from the token): a non-host gets 403 and no approval notification', (await call('put', `/match-requests/${PR}/approve-player`, TK.u3, { player_id: mp2, host_id: U.u1 })).status === 403 && (await ofType(TK.u2, 'MATCH_JOIN_APPROVED')).length === 0, { st: (await pool.query('SELECT status FROM match_players WHERE id = ?', [mp2]))[0][0].status, n: await ofType(TK.u2, 'MATCH_JOIN_APPROVED') });
    await call('put', `/match-requests/${PR}/approve-player`, TK.u1, { player_id: mp2 });
    await until(async () => (await ofType(TK.u2, 'MATCH_JOIN_APPROVED')).length >= 1);
    check('approval notifies the player', /approved/.test((await ofType(TK.u2, 'MATCH_JOIN_APPROVED'))[0].message));
    await call('post', '/match-requests/join', TK.u3, { match_id: PR, role: 'any', payment_type: 'split' });
    await until(async () => (await ofType(TK.u1, 'MATCH_JOIN_REQUEST')).length >= 2);
    const mp3 = (await pool.query('SELECT id FROM match_players WHERE match_id = ? AND user_id = ?', [PR, U.u3]))[0][0].id;
    await call('put', `/match-requests/${PR}/reject-player`, TK.u1, { player_id: mp3 });
    await until(async () => (await ofType(TK.u3, 'MATCH_JOIN_REJECTED')).length >= 1);
    check('rejection notifies the player (the row is deleted, so the route passes who to tell)', (await ofType(TK.u3, 'MATCH_JOIN_REJECTED')).length === 1);
    await pool.query("UPDATE player_requests SET match_time = ?, match_date = ?, created_at = DATE_SUB(NOW(), INTERVAL 6 HOUR) WHERE id = ?", [`${localParts(nowMs + 2 * 3600000 - 5 * 60000).hhmm}:00`, localParts(nowMs + 2 * 3600000 - 5 * 60000).date, PR]);
    await sched.runOnce({ scope: { hostIds: [U.u1] } });
    await until(async () => (await ofType(TK.u2, 'MATCH_REMINDER')).length >= 1);
    check('a Find Players match reminder goes to the host and approved players, once', (await ofType(TK.u2, 'MATCH_REMINDER')).length === 1 && (await ofType(TK.u1, 'MATCH_REMINDER')).length === 1 && (await ofType(TK.u3, 'MATCH_REMINDER')).length === 0);
    check('a non-host cannot cancel the match (403) and nothing is announced', (await call('delete', `/match-requests/${PR}`, TK.u3, { host_id: U.u1 })).status === 403 && (await ofType(TK.u2, 'MATCH_CANCELLED')).length === 0);
    await call('delete', `/match-requests/${PR}`, TK.u1, {});
    await until(async () => (await ofType(TK.u2, 'MATCH_CANCELLED')).length >= 1);
    check('the host cancels: joined players are told once', (await ofType(TK.u2, 'MATCH_CANCELLED')).length === 1 && /cancelled/.test((await ofType(TK.u2, 'MATCH_CANCELLED'))[0].message));

    // ================================================================= 11. admin + system
    console.log('\n--- owners / admin / system ---');
    const [[ownerRow]] = await pool.query('SELECT id FROM owners WHERE email = ?', [mail('o1')]);
    const adminNotes = (await pool.query("SELECT COUNT(*) c FROM notifications WHERE recipient_type = 'admin' AND notification_type = 'ADMIN_NEW_OWNER' AND event_key LIKE ?", [`ADMIN_NEW_OWNER:${ownerRow.id}:%`]))[0][0].c;
    check('a new owner registration notifies the admins (deduplicated per owner)', adminNotes >= 1);
    const apr = await call('put', `/admin/owners/${O.o1}/approve`, TK.admin); await until(async () => (await ofType(TK.o1, 'SYSTEM_ANNOUNCEMENT')).some((n) => /approved/.test(n.title)), 15000);
    check('admin approval is announced to that owner only after the row says approved', (await ofType(TK.o1, 'SYSTEM_ANNOUNCEMENT')).some((n) => /approved/.test(n.title)), { apr, notes: await ofType(TK.o1, 'SYSTEM_ANNOUNCEMENT') });
    check('owner inbox works for owner tokens too (separate from user ids)', (await call('get', '/notifications/unread-count', TK.o1)).data.unread_count > 0 && (await call('get', '/notifications/unread-count', TK.admin)).data.success);

    // admin management + broadcasts (audience is ONLY the test users: they are the only ones with this sport interest)
    const stats = await call('get', '/admin/notifications/stats', TK.admin);
    check('admin stats: totals, by category, by type, delivery status, devices', stats.data.success && stats.data.totals.total > 0 && Array.isArray(stats.data.by_category) && Array.isArray(stats.data.deliveries) && stats.data.devices.accounts >= 1, stats.data);
    const types = await call('get', '/admin/notifications/types', TK.admin);
    check('admin type registry: every type, category, and whether it has a real trigger (no gym/fitness types)', types.data.types.length > 40 && types.data.types.some((t) => t.type === 'BOOKING_REMINDER') && types.data.types.find((t) => t.type === 'PAYMENT_REFUNDED').wired === false && !types.data.types.some((t) => /GYM|FITNESS|TRAINER|WORKOUT/.test(t.type)), types.data.types.length);
    const hist = await call('get', '/admin/notifications/history?limit=5', TK.admin);
    check('admin history is paginated and filterable', hist.data.notifications.length === 5 && hist.data.next_cursor && (await call('get', '/admin/notifications/history?type=TOURNAMENT_MATCH_LIVE&limit=50', TK.admin)).data.notifications.every((n) => n.notification_type === 'TOURNAMENT_MATCH_LIVE'));
    check('admin can see failed deliveries', (await call('get', '/admin/notifications/failures', TK.admin)).data.failures.some((f) => f.status === 'FAILED'));

    const draft = { kind: 'promotion', title: 'ZZ NT Weekend offer', message: 'Book any turf this weekend.', segment: { roles: ['user'], sport: SPORT } };
    const noPreview = await call('post', '/admin/notifications/broadcast', TK.admin, draft);
    check('a broadcast cannot be sent without previewing/confirming it first', noPreview.status === 400);
    const prev = await call('post', '/admin/notifications/broadcast/preview', TK.admin, draft);
    check('preview shows exactly who would receive it (the 3 test users with this sport interest, not the 4th) - nothing has been sent yet', prev.data.recipient_count === 3 && (await ofType(TK.u4, 'PROMOTION')).length === 0 && (await ofType(TK.u3, 'PROMOTION')).length === 0 && prev.data.confirm_token, prev.data);
    check('the confirmation is bound to the message: editing it after the preview is refused', (await call('post', '/admin/notifications/broadcast', TK.admin, { ...draft, message: 'Something else entirely.', confirm_token: prev.data.confirm_token })).status === 400);
    check('sending to the WHOLE user base needs extra confirmation ("SEND TO ALL") and the API asks for it', (await call('post', '/admin/notifications/broadcast/preview', TK.admin, { ...draft, segment: { roles: ['user'] } })).data.requires_all_confirmation === true);
    const sendRes = await call('post', '/admin/notifications/broadcast', TK.admin, { ...draft, confirm_token: prev.data.confirm_token });
    await until(async () => (await ofType(TK.u3, 'PROMOTION')).length >= 1);
    check('confirmed broadcast is delivered; users who switched promotions off are skipped (u1 opted out)', sendRes.data.success && (await ofType(TK.u3, 'PROMOTION')).length === 1 && (await ofType(TK.u1, 'PROMOTION')).length === 0, sendRes.data);
    check('the broadcast is recorded (who sent what to how many)', (await call('get', '/admin/notifications/broadcasts', TK.admin)).data.broadcasts.some((b) => b.title === 'ZZ NT Weekend offer' && b.recipient_count === 3), (await call('get', '/admin/notifications/broadcasts', TK.admin)).data);
    const prev2 = await call('post', '/admin/notifications/broadcast/preview', TK.admin, { kind: 'announcement', title: 'ZZ NT maintenance', message: 'Short maintenance tonight.', segment: { roles: ['user'], sport: SPORT } });
    await call('post', '/admin/notifications/broadcast', TK.admin, { kind: 'announcement', title: 'ZZ NT maintenance', message: 'Short maintenance tonight.', segment: { roles: ['user'], sport: SPORT }, confirm_token: prev2.data.confirm_token });
    await until(async () => (await ofType(TK.u1, 'SYSTEM_ANNOUNCEMENT')).some((n) => n.title === 'ZZ NT maintenance'));
    check('a platform announcement (important, not marketing) reaches everyone in the segment even with promotions off', (await ofType(TK.u1, 'SYSTEM_ANNOUNCEMENT')).some((n) => n.title === 'ZZ NT maintenance'));
    check('an empty audience is refused (nobody matches this sport)', (await call('post', '/admin/notifications/broadcast/preview', TK.admin, { ...draft, segment: { roles: ['user'], sport: 'zz-nobody-plays-this' } })).data.recipient_count === 0);

    // ================================================================= 12. privacy + deep links across everything created
    console.log('\n--- privacy and deep links ---');
    const [all] = await pool.query("SELECT notification_type, title, message, deep_link, metadata FROM notifications WHERE (recipient_type = 'user' AND recipient_id IN (?, ?, ?)) OR (recipient_type = 'owner' AND recipient_id IN (?, ?))", [U.u1, U.u2, U.u3, O.o1, O.o2]);
    check(`no notification exposes emails, phone numbers, card data or amounts (${all.length} checked)`, all.filter((n) => !/^(REFUND_|SUBSCRIPTION_ACTIVATED|SUBSCRIPTION_RENEWED)/.test(n.notification_type)).every((n) => !/@|\b\d{10}\b|card|₹|rs\.?\s?\d|\bINR\b/i.test(`${n.title} ${n.message} ${JSON.stringify(n.metadata)}`)), all.filter((n) => /@|\b\d{10}\b|card|₹/i.test(`${n.title} ${n.message}`)).slice(0, 2));
    const linkOk = { BOOKING_CONFIRMED: /^\/booking-receipt\?id=\d+$/, OWNER_NEW_BOOKING: /^\/\(owner\)\/booking\/\d+$/, SUBSCRIPTION_ACTIVATED: /^\/subscription\/\d+$/, SUBSCRIPTION_EXPIRED: /^\/subscription\/\d+$/, TOURNAMENT_CREATED: /^\/tournament\/[\w-]+$/, TOURNAMENT_MATCH_LIVE: /^\/tournament\/live\/\d+$/, TOURNAMENT_JOIN_REQUEST: /^\/\(owner\)\/my-tournaments\/\d+$/, MATCH_JOIN_APPROVED: /^\/my-matches$/, MATCH_REQUEST_CREATED: /^\/find-players$/, OWNER_SUBSCRIPTION_EXPIRING: /^\/\(owner\)\/earnings$/ };
    const badLinks = all.filter((n) => linkOk[n.notification_type] && !linkOk[n.notification_type].test(n.deep_link));
    check('every deep link is a real Book Arena route for the right audience (booking, subscription, tournament, live match, find players)', badLinks.length === 0 && Object.keys(linkOk).every((t) => all.some((n) => n.notification_type === t)), { bad: badLinks.slice(0, 2), missing: Object.keys(linkOk).filter((t) => !all.some((n) => n.notification_type === t)) });
    check('every notification type used maps to a registered type/category', all.every((n) => TYPES[n.notification_type]));
    check('no gym / fitness / trainer / workout notification exists anywhere', !all.some((n) => /gym|fitness|trainer|workout/i.test(`${n.notification_type} ${n.title} ${n.message}`)));
  } catch (e) {
    check('test run finished without an unexpected error', false, e.response ? { status: e.response.status, data: e.response.data } : e.stack);
  } finally {
    try {
      const uid = Object.values(ids.users), oid = Object.values(ids.owners);
      const uq = uid.length ? uid : [0], oq = oid.length ? oid : [0];
      const inU = uq.map(() => '?').join(','), inO = oq.map(() => '?').join(',');
      await pool.query(`DELETE FROM notification_deliveries WHERE notification_id IN (SELECT id FROM notifications WHERE (recipient_type='user' AND recipient_id IN (${inU})) OR (recipient_type='owner' AND recipient_id IN (${inO})))`, [...uq, ...oq]);
      await pool.query(`DELETE FROM notifications WHERE (recipient_type='user' AND recipient_id IN (${inU})) OR (recipient_type='owner' AND recipient_id IN (${inO}))`, [...uq, ...oq]);
      for (const id of oid) await pool.query("DELETE FROM notifications WHERE recipient_type = 'admin' AND event_key LIKE ?", [`ADMIN_NEW_OWNER:${id}:%`]);
      await pool.query(`DELETE FROM user_push_tokens WHERE (recipient_type='user' AND recipient_id IN (${inU})) OR (recipient_type='owner' AND recipient_id IN (${inO}))`, [...uq, ...oq]);
      await pool.query(`DELETE FROM notification_preferences WHERE (recipient_type='user' AND recipient_id IN (${inU})) OR (recipient_type='owner' AND recipient_id IN (${inO}))`, [...uq, ...oq]);
      await pool.query("DELETE FROM notification_broadcasts WHERE title LIKE 'ZZ NT%'");
      await pool.query("DELETE FROM subscription_reservations WHERE subscription_id IN (SELECT id FROM user_subscriptions WHERE plan_id IN (SELECT id FROM subscription_plans WHERE name LIKE 'ZZ N%'))");
      await pool.query("DELETE FROM subscription_payments WHERE subscription_id IN (SELECT id FROM user_subscriptions WHERE plan_id IN (SELECT id FROM subscription_plans WHERE name LIKE 'ZZ N%'))");
      await pool.query("DELETE FROM subscription_audit_log WHERE subscription_id IN (SELECT id FROM user_subscriptions WHERE plan_id IN (SELECT id FROM subscription_plans WHERE name LIKE 'ZZ N%'))");
      await pool.query(`DELETE FROM user_subscriptions WHERE user_id IN (${inU})`, uq);
      await pool.query(`DELETE FROM subscription_plans WHERE owner_id IN (${inO})`, oq);
      await pool.query(`DELETE FROM owner_subscriptions WHERE owner_id IN (${inO})`, oq);
      await pool.query(`DELETE FROM player_availability WHERE user_id IN (${inU})`, uq);
      for (const r of created.requests) { await pool.query('DELETE FROM match_players WHERE match_id = ?', [r]); await pool.query('DELETE FROM player_requests WHERE id = ?', [r]); }
      await pool.query(`DELETE FROM match_players WHERE user_id IN (${inU})`, uq);
      await pool.query(`DELETE FROM player_requests WHERE host_id IN (${inU})`, uq);
      for (const id of created.tournaments) {
        await pool.query('DELETE FROM tournament_match_events WHERE match_id IN (SELECT id FROM tournament_fixtures WHERE tournament_id = ?)', [id]);
        for (const t of ['tournament_fixtures', 'tournament_teams', 'tournament_participants', 'tournament_join_requests', 'tournament_announcements', 'tournament_audit_logs', 'tournament_registrations', 'tournament_scorers', 'tournament_streams']) await pool.query(`DELETE FROM ${t} WHERE tournament_id = ?`, [id]);
        await pool.query('DELETE FROM tournaments WHERE id = ?', [id]);
      }
      if (created.bookings.length) { const q = created.bookings.map(() => '?').join(','); await pool.query(`DELETE FROM razorpay_transfers WHERE booking_id IN (${q})`, created.bookings); await pool.query(`DELETE FROM bookings WHERE id IN (${q})`, created.bookings); }
      for (const t of created.turfs) await pool.query('DELETE FROM turfs WHERE id = ?', [t]);
      await pool.query("DELETE FROM users WHERE email LIKE 'zz_nt_%'");
      await pool.query("DELETE FROM owners WHERE email LIKE 'zz_nt_%'");
      const [[left]] = await pool.query("SELECT (SELECT COUNT(*) FROM users WHERE email LIKE 'zz_nt_%') u, (SELECT COUNT(*) FROM owners WHERE email LIKE 'zz_nt_%') o, (SELECT COUNT(*) FROM turfs WHERE name LIKE 'ZZ NT%') t, (SELECT COUNT(*) FROM tournaments WHERE name LIKE 'ZZ NT%') tt, (SELECT COUNT(*) FROM subscription_plans WHERE name LIKE 'ZZ NT%') p, (SELECT COUNT(*) FROM notifications WHERE title LIKE 'ZZ NT%' OR message LIKE '%ZZ NT%') n, (SELECT COUNT(*) FROM user_push_tokens WHERE push_token LIKE '%zznt%') d");
      console.log('cleanup done; leftovers (users/owners/turfs/tournaments/plans/notifications/devices):', left.u, left.o, left.t, left.tt, left.p, left.n, left.d);
    } catch (e) { console.log('CLEANUP FAILED:', e.message); }
    mockServer.close();
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
