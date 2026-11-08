// Scheduled notifications: booking / match reminders and subscription renewal, expiry and expired notices.
//
// Why this is production-safe without Redis or per-reminder timers:
//  - nothing is held in memory. Each tick SCANS the real records (bookings, fixtures, subscriptions...) and works out which
//    reminders are due right now. A restart, a crash, or three server instances change nothing: the next tick rebuilds the
//    same answer from the database.
//  - every notification carries an event key (e.g. BOOKING_REMINDER:{booking}:{2h}:{recipient}) with a UNIQUE index, so however
//    many times or on however many instances a window is evaluated, exactly one notification is created.
//  - the interval below only decides how often to look; a missed tick is caught up on the next one. (Only windows that are
//    still open are sent - after a long outage we skip stale reminders instead of sending "starts in 2 hours" for a match
//    that already began.)
//  - state changes come from the record: "expired" is written to the subscription row first, and only then announced.
const pool = require('../../config/db');
const T = require('./time');
const { emit } = require('./events');
const push = require('./push');

const BACKFILL_DAYS = Math.max(0, parseInt(process.env.NOTIFICATION_BACKFILL_DAYS || '2', 10));
const SUB_THRESHOLDS = (process.env.SUBSCRIPTION_REMINDER_DAYS || '7,3,1').split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0).sort((a, b) => a - b);

// hoursBefore = when the reminder is meant to arrive; toleranceMin = how late it may still be sent (stale reminders are skipped)
const BOOKING_WINDOWS = [{ hours: 24, toleranceMin: 60 }, { hours: 2, toleranceMin: 30 }, { hours: 0.5, toleranceMin: 15 }];
const MATCH_WINDOWS = [{ hours: 24, toleranceMin: 60 }, { hours: 1, toleranceMin: 20 }];
const FIND_PLAYERS_WINDOWS = [{ hours: 2, toleranceMin: 30 }];
const ACTIVITY_WINDOWS = [{ hours: 24, toleranceMin: 60 }, { hours: 2, toleranceMin: 30 }];
const ACTIVITY_SUMMARY_FROM_HOUR = 21; // local time: send the owner's "today" summary once, in the evening

// created time comes from the DB as an age (TIMESTAMPDIFF against the DB's own NOW()) - immune to the driver/host timezone.
// The reminder window (if any) that is open right now for an event starting at startMs. The event must have existed
// BEFORE the window opened, otherwise "your booking is in 24 hours" would arrive right after booking a slot for tonight.
function openWindow(windows, startMs, createdMs, nowMs) {
  for (const w of windows) {
    const opens = startMs - w.hours * 3600000;
    if (nowMs >= opens && nowMs < opens + w.toleranceMin * 60000 && nowMs < startMs && (!createdMs || createdMs <= opens)) return w;
  }
  return null;
}

// `scope` (tests / dry-runs): restrict a scan to specific ids. Production calls runOnce() with no scope = everything.
// A scope that lacks the list a scan needs SKIPS that scan, so a scoped run can never touch unrelated real data.
const scopeSql = (scope, key, column, params) => {
  if (!scope) return '';
  const list = scope[key];
  if (!Array.isArray(list) || list.length === 0) return ' AND 1 = 0';
  params.push(...list);
  return ` AND ${column} IN (${list.map(() => '?').join(',')})`;
};

async function scanBookingReminders(now, report, dryRun, scope) {
  const today = T.localDateString(now);
  const params = [today, T.addDays(today, 2)];
  const extra = scopeSql(scope, 'userIds', 'user_id', params);
  const [rows] = await pool.query(
    `SELECT id, user_id, turf_id, booking_date, time_slot, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_sec, razorpay_order_id, payment_id
     FROM bookings WHERE status = 'confirmed' AND user_id IS NOT NULL AND booking_date BETWEEN ? AND ?${extra}`, params);
  const groups = new Map();
  for (const r of rows) {
    const date = T.dateOnly(r.booking_date);
    const slot = T.parseSlot(r.time_slot);
    if (!slot) continue;
    const k = `${r.user_id}|${r.turf_id}|${date}|${r.razorpay_order_id || r.payment_id || `id${r.id}`}`;
    const g = groups.get(k) || { ids: [], date, start: slot.start, created: r.age_sec == null ? null : now - r.age_sec * 1000 };
    g.ids.push(r.id);
    if (slot.start < g.start) g.start = slot.start;
    groups.set(k, g);
  }
  for (const g of groups.values()) {
    const w = openWindow(BOOKING_WINDOWS, T.toEpoch(g.date, g.start), g.created, now);
    if (!w) continue;
    report.booking_reminders.push({ bookingIds: g.ids, hoursBefore: w.hours });
    if (!dryRun) await emit('booking.reminder', { bookingIds: g.ids, hoursBefore: w.hours });
  }
}

async function scanActivityReminders(now, report, dryRun, scope) {
  const today = T.localDateString(now);
  const params = [today, T.addDays(today, 2)];
  const extra = scopeSql(scope, 'activityBookingIds', 'b.id', params);
  const [rows] = await pool.query(
    `SELECT b.id, b.booking_date, TIMESTAMPDIFF(SECOND, b.created_at, NOW()) AS age_sec,
            COALESCE(w.start_time, a.opening_time) AS entry_time
     FROM activity_bookings b JOIN activities a ON a.id = b.activity_id LEFT JOIN activity_time_windows w ON w.id = b.time_window_id
     WHERE b.status = 'confirmed' AND b.user_id IS NOT NULL AND b.booking_date BETWEEN ? AND ?${extra}`, params);
  for (const r of rows) {
    const w = openWindow(ACTIVITY_WINDOWS, T.toEpoch(T.dateOnly(r.booking_date), String(r.entry_time || '09:00').slice(0, 5)), r.age_sec == null ? null : now - r.age_sec * 1000, now);
    if (!w) continue;
    report.activity_reminders.push({ bookingId: r.id, hoursBefore: w.hours });
    if (!dryRun) await emit('activity.reminder', { bookingId: r.id, hoursBefore: w.hours });
  }
}

// Evening summary per owner who had bookings today. Idempotent through the notification's own event key.
async function scanActivityDailySummaries(now, report, dryRun, scope) {
  if (scope || new Date(now).getHours() < ACTIVITY_SUMMARY_FROM_HOUR) return;
  const today = T.localDateString(now);
  const [rows] = await pool.query("SELECT DISTINCT owner_id FROM activity_bookings WHERE booking_date = ? AND status = 'confirmed'", [today]);
  for (const r of rows) {
    report.activity_summaries.push({ ownerId: r.owner_id });
    if (!dryRun) await emit('activity.daily_summary', { ownerId: r.owner_id, date: today });
  }
}

// A ticket past its valid_until can never be used again — write that to the record so every screen/report agrees.
// valid_until is stored as a local wall-clock string, so compare against a local string (never DB NOW(), which is UTC).
async function expireActivityTickets(now, report, dryRun, scope) {
  const d = new Date(now); const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const params = [stamp];
  const extra = scopeSql(scope, 'activityBookingIds', 'booking_id', params);
  if (dryRun) {
    const [[c]] = await pool.query(`SELECT COUNT(*) AS n FROM activity_tickets WHERE status IN ('VALID','UNUSED','SCANNED') AND valid_until < ?${extra}`, params);
    report.activity_tickets_expired = Number(c.n);
    return;
  }
  const [r] = await pool.query(`UPDATE activity_tickets SET status = 'EXPIRED' WHERE status IN ('VALID','UNUSED','SCANNED') AND valid_until < ?${extra}`, params);
  report.activity_tickets_expired = r.affectedRows;
}

async function scanTournamentMatchReminders(now, report, dryRun, scope) {
  const today = T.localDateString(now);
  const params = [today, T.addDays(today, 2)];
  const extra = scopeSql(scope, 'tournamentIds', 'tournament_id', params);
  const [rows] = await pool.query(
    `SELECT id, match_date, match_time, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_sec FROM tournament_fixtures
     WHERE status = 'SCHEDULED' AND match_date BETWEEN ? AND ? AND match_time IS NOT NULL AND team_a_id IS NOT NULL AND team_b_id IS NOT NULL${extra}`, params);
  for (const f of rows) {
    const w = openWindow(MATCH_WINDOWS, T.toEpoch(T.dateOnly(f.match_date), String(f.match_time).slice(0, 5)), f.age_sec == null ? null : now - f.age_sec * 1000, now);
    if (!w) continue;
    report.match_reminders.push({ fixtureId: f.id, hoursBefore: w.hours });
    if (!dryRun) await emit('tournament.match_reminder', { fixtureId: f.id, hoursBefore: w.hours });
  }
}

async function scanFindPlayersReminders(now, report, dryRun, scope) {
  const today = T.localDateString(now);
  const params = [today, T.addDays(today, 1)];
  const extra = scopeSql(scope, 'hostIds', 'host_id', params);
  const [rows] = await pool.query(
    `SELECT id, match_date, match_time, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_sec FROM player_requests WHERE status IN ('open','full') AND match_date BETWEEN ? AND ? AND match_time IS NOT NULL${extra}`, params);
  for (const m of rows) {
    const w = openWindow(FIND_PLAYERS_WINDOWS, T.toEpoch(T.dateOnly(m.match_date), String(m.match_time).slice(0, 5)), m.age_sec == null ? null : now - m.age_sec * 1000, now);
    if (!w) continue;
    report.find_players_reminders.push({ matchRequestId: m.id, hoursBefore: w.hours });
    if (!dryRun) await emit('find_players.match_reminder', { matchRequestId: m.id, hoursBefore: w.hours });
  }
}

// The reminder threshold that applies for `daysLeft`: the smallest configured threshold that is >= daysLeft.
const thresholdFor = (daysLeft) => SUB_THRESHOLDS.find((t) => daysLeft <= t) || null;

async function scanSubscriptions(now, report, dryRun, scope) {
  const today = T.localDateString(now);

  // 1) backend-maintained expiry: an active subscription whose paid period ended (in the VENUE's timezone) becomes 'expired', its
  //    future reservations are released (history kept); THEN it is announced.
  const pastParams = [];
  const pastExtra = scopeSql(scope, 'userIds', 'user_id', pastParams);
  let scopeIds = null;
  if (scope) scopeIds = (await pool.query(`SELECT id FROM user_subscriptions WHERE 1=1${pastExtra}`, pastParams))[0].map((r) => r.id);
  if (!scopeIds || scopeIds.length) {
    const sw = await require('../../services/subscriptionService').sweep({ now, dryRun, scopeIds });
    for (const id of sw.expired) {
      const [[row]] = await pool.query('SELECT expiry_date FROM user_subscriptions WHERE id = ?', [id]);
      const ago = row ? T.dayDiff(T.dateOnly(row.expiry_date), today) : 0;
      report.subscriptions_expired.push({ subscriptionId: id, daysAgo: ago, announced: ago <= BACKFILL_DAYS });
      // subscriptions that lapsed long ago are corrected silently: telling someone in September that they expired in June is noise
      if (!dryRun && ago <= BACKFILL_DAYS) await emit('subscription.expired', { subscriptionId: id });
    }
  }

  // 2) reminders (7 / 3 / 1 days by default) - only for subscriptions that are still active and paid
  const soonParams = [T.addDays(today, -1), T.addDays(today, Math.max(...SUB_THRESHOLDS, 1))]; // -1: venues in timezones behind the app's
  const soonExtra = scopeSql(scope, 'userIds', 'user_id', soonParams);
  const [soon] = await pool.query(`SELECT id, expiry_date FROM user_subscriptions WHERE status = 'active' AND payment_status = 'paid' AND expiry_date BETWEEN ? AND ?${soonExtra}`, soonParams);
  for (const s of soon) {
    const daysLeft = T.dayDiff(today, T.dateOnly(s.expiry_date));
    const threshold = thresholdFor(daysLeft);
    if (!threshold) continue;
    report.subscription_reminders.push({ subscriptionId: s.id, daysLeft, threshold });
    if (!dryRun) await emit('subscription.reminder', { subscriptionId: s.id, threshold });
  }

  // 3) unpaid orders nobody completed: close them quietly (no notification - nothing happened to the customer)
  if (!dryRun && !scope) await pool.query("UPDATE user_subscriptions SET status = 'expired', payment_status = 'failed' WHERE status = 'pending' AND payment_status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)");

  // 4) the venue owner's own Book Arena plan (a different thing from customer subscriptions)
  const ownerSoonParams = [today, T.addDays(today, Math.max(...SUB_THRESHOLDS, 1))];
  const ownerSoonExtra = scopeSql(scope, 'ownerIds', 'owner_id', ownerSoonParams);
  const [ownerSoon] = await pool.query(`SELECT id, expiry_date FROM owner_subscriptions WHERE status IN ('active','trial') AND expiry_date BETWEEN ? AND ?${ownerSoonExtra}`, ownerSoonParams);
  for (const s of ownerSoon) {
    const daysLeft = T.dayDiff(today, T.dateOnly(s.expiry_date));
    const threshold = thresholdFor(daysLeft);
    if (!threshold) continue;
    report.owner_plan_reminders.push({ subscriptionId: s.id, daysLeft, threshold });
    if (!dryRun) await emit('owner_subscription.reminder', { subscriptionId: s.id, threshold });
  }
  // the status here is set elsewhere (this scheduler does not own owner plans); we only announce an expiry that is recorded
  const goneParams = [T.addDays(today, -BACKFILL_DAYS)];
  const goneExtra = scopeSql(scope, 'ownerIds', 'owner_id', goneParams);
  const [ownerGone] = await pool.query(`SELECT id FROM owner_subscriptions WHERE status = 'expired' AND expiry_date >= ?${goneExtra}`, goneParams);
  for (const s of ownerGone) {
    report.owner_plan_expired.push({ subscriptionId: s.id });
    if (!dryRun) await emit('owner_subscription.expired', { subscriptionId: s.id });
  }
}

/**
 * One scheduler pass. `dryRun` lists what WOULD be sent and changes nothing (used to look before switching a worker on).
 * Each step is isolated: a failing scan never stops the others, and never affects business data.
 */
async function runOnce({ now = Date.now(), dryRun = false, scope = null } = {}) {
  const report = { at: new Date(now).toISOString(), dryRun, booking_reminders: [], match_reminders: [], find_players_reminders: [], subscription_reminders: [], subscriptions_expired: [], owner_plan_reminders: [], owner_plan_expired: [], activity_reminders: [], activity_summaries: [], activity_tickets_expired: 0, push: null, receipts: null, errors: [] };
  const step = async (name, fn) => { try { await fn(); } catch (e) { report.errors.push(`${name}: ${e.message}`); console.error(`[notifications] scheduler step ${name} failed:`, e.message); } };
  await step('booking-reminders', () => scanBookingReminders(now, report, dryRun, scope));
  await step('tournament-match-reminders', () => scanTournamentMatchReminders(now, report, dryRun, scope));
  await step('find-players-reminders', () => scanFindPlayersReminders(now, report, dryRun, scope));
  await step('activity-reminders', () => scanActivityReminders(now, report, dryRun, scope));
  await step('activity-summaries', () => scanActivityDailySummaries(now, report, dryRun, scope));
  await step('activity-ticket-expiry', () => expireActivityTickets(now, report, dryRun, scope));
  await step('subscriptions', () => scanSubscriptions(now, report, dryRun, scope));
  if (!dryRun && !scope) {
    await step('push-retries', async () => { report.push = await push.processDue(); });
    await step('push-receipts', async () => { report.receipts = await push.checkReceipts(); });
  }
  return report;
}

// ---- the in-process worker ---------------------------------------------------------------------------------
let timer = null;
let running = false;

function start() {
  if (process.env.NOTIFICATION_WORKER === 'off') { console.log('[notifications] worker disabled (NOTIFICATION_WORKER=off)'); return null; }
  if (timer) return timer;
  const every = Math.max(15000, parseInt(process.env.NOTIFICATION_WORKER_INTERVAL_MS || '60000', 10));
  const tick = async () => {
    if (running) return; // never overlap with itself
    running = true;
    try { await runOnce(); } catch (e) { console.error('[notifications] worker tick failed:', e.message); } finally { running = false; }
  };
  timer = setInterval(tick, every);
  timer.unref();
  setTimeout(tick, 5000).unref();
  console.log(`[notifications] worker started (every ${Math.round(every / 1000)}s)`);
  return timer;
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { runOnce, start, stop, openWindow, thresholdFor, BOOKING_WINDOWS, MATCH_WINDOWS, SUB_THRESHOLDS };
