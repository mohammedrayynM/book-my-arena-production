// Application events -> notifications.
//
// Feature code announces WHAT HAPPENED (`emit('booking.confirmed', { bookingIds })`) with ids only. The handler here loads the
// real record from the database, checks it is really in the state the event claims (booking/payment/subscription/tournament
// state is the source of truth, notifications are only a delivery layer), decides the recipients and calls notify().
//
// emit() never throws and resolves when the handlers are done; callers must not depend on it (and normally don't await it).
const pool = require('../../config/db');
const { notify, notifyMany } = require('./service');
const audience = require('./audience');
const T = require('./time');

const handlers = {};
const on = (name, fn) => { handlers[name] = fn; };

async function emit(name, payload = {}) {
  const fn = handlers[name];
  if (!fn) { console.warn(`[notifications] no handler for event ${name}`); return; }
  try { await fn(payload); } catch (e) { console.error(`[notifications] event ${name} failed:`, e.message); }
}
// fire-and-forget form for controllers: schedules the work and returns immediately
const fire = (name, payload) => { setImmediate(() => { emit(name, payload); }); };

const num = (v) => (v === null || v === undefined ? null : Number(v));
const ids = (list) => [...new Set((Array.isArray(list) ? list : [list]).map((x) => parseInt(x, 10)).filter((x) => x > 0))].sort((a, b) => a - b);
const marks = (arr) => arr.map(() => '?').join(',');
const whenLabel = (dateStr, hhmm, nowMs) => {
  const day = T.dayLabel(dateStr, nowMs);
  const time = T.time12(hhmm);
  if (!day) return time;
  return !time ? day : (day === 'today' || day === 'tomorrow' ? `${time} ${day}` : `${time} on ${day}`);
};

// ============================================================================================================
// BOOKINGS + PAYMENTS
// ============================================================================================================
async function loadBookings(bookingIds) {
  const list = ids(bookingIds);
  if (list.length === 0) return [];
  const [rows] = await pool.query(
    `SELECT b.*, t.name AS turf_name, t.owner_id AS turf_owner_id, t.coverImage AS turf_image
     FROM bookings b JOIN turfs t ON b.turf_id = t.id WHERE b.id IN (${marks(list)}) ORDER BY b.id ASC`, list);
  return rows;
}

function bookingFacts(rows, nowMs = Date.now()) {
  const first = rows[0];
  const slots = rows.map((r) => T.parseSlot(r.time_slot)).filter(Boolean).sort((a, b) => (a.start < b.start ? -1 : 1));
  const date = T.dateOnly(first.booking_date);
  const start = slots[0] && slots[0].start;
  return {
    bookingId: Number(rows[0].id), turfName: first.turf_name, image: typeof first.turf_image === 'string' && first.turf_image.length < 500 ? first.turf_image : null,
    date, start, when: whenLabel(date, start, nowMs), timeLabel: T.time12(start),
  };
}

on('booking.confirmed', async ({ bookingIds }) => {
  const rows = (await loadBookings(bookingIds)).filter((r) => r.status === 'confirmed'); // trust the row, not the caller
  if (rows.length === 0) return;
  const f = bookingFacts(rows);
  const key = String(f.bookingId);
  const paid = rows[0].payment_status === 'success' && rows[0].payment_id && !String(rows[0].payment_id).startsWith('demo_');
  if (rows[0].user_id) {
    await notify({ to: { type: 'user', id: rows[0].user_id }, type: 'BOOKING_CONFIRMED', data: f, eventKey: key });
    if (paid) {
      await notify({ to: { type: 'user', id: rows[0].user_id }, type: 'PAYMENT_SUCCESS', eventKey: rows[0].payment_id,
        data: { subject: `your booking at ${f.turfName}`, entityType: 'booking', entityId: f.bookingId, deepLink: `/booking-receipt?id=${f.bookingId}` } });
    }
  }
  if (rows[0].turf_owner_id) {
    await notify({ to: { type: 'owner', id: rows[0].turf_owner_id }, type: 'OWNER_NEW_BOOKING', data: f, eventKey: key });
    if (paid) await notify({ to: { type: 'owner', id: rows[0].turf_owner_id }, type: 'OWNER_PAYMENT_RECEIVED', data: f, eventKey: rows[0].payment_id });
  }
});

// A payment attempt failed, or the payment could not be turned into a booking. `reason`: verification_failed | slot_unavailable | payment_failed
on('booking.failed', async ({ bookingIds, reason = 'payment_failed', paymentId = null }) => {
  const rows = await loadBookings(bookingIds);
  if (rows.length === 0 || !rows[0].user_id) return;
  if (rows.some((r) => r.status === 'confirmed')) return; // it did get confirmed after all: never contradict the booking
  const f = bookingFacts(rows);
  const to = { type: 'user', id: rows[0].user_id };
  if (reason === 'slot_unavailable') {
    await notify({ to, type: 'BOOKING_CANCELLED', data: { ...f, reason }, eventKey: `${f.bookingId}:${reason}` });
  } else {
    await notify({ to, type: 'PAYMENT_FAILED', eventKey: paymentId || `${f.bookingId}:${reason}`,
      data: { subject: `your booking at ${f.turfName}`, entityType: 'booking', entityId: f.bookingId, deepLink: `/booking-receipt?id=${f.bookingId}` } });
  }
});

on('booking.cancelled', async ({ bookingIds, wasConfirmed = false }) => {
  if (!wasConfirmed) return; // cancelling an unpaid pending hold is not news to anyone
  const rows = (await loadBookings(bookingIds)).filter((r) => r.status === 'cancelled');
  if (rows.length === 0) return;
  const f = bookingFacts(rows);
  if (rows[0].user_id) await notify({ to: { type: 'user', id: rows[0].user_id }, type: 'BOOKING_CANCELLED', data: f, eventKey: `cancel:${f.bookingId}` });
  if (rows[0].turf_owner_id) await notify({ to: { type: 'owner', id: rows[0].turf_owner_id }, type: 'OWNER_BOOKING_CANCELLED', data: f, eventKey: `cancel:${f.bookingId}` });
});

on('payment.initiated', async ({ bookingIds }) => {
  const rows = (await loadBookings(bookingIds)).filter((r) => r.status === 'pending');
  if (rows.length === 0 || !rows[0].user_id) return;
  const f = bookingFacts(rows);
  await notify({ to: { type: 'user', id: rows[0].user_id }, type: 'PAYMENT_INITIATED', data: f, eventKey: String(f.bookingId), push: false });
});

// scheduled: `hoursBefore` is the window that just opened (24, 2 or 0.5)
on('booking.reminder', async ({ bookingIds, hoursBefore }) => {
  const rows = (await loadBookings(bookingIds)).filter((r) => r.status === 'confirmed'); // cancelled / refunded / completed: no reminder
  if (rows.length === 0 || !rows[0].user_id) return;
  const f = bookingFacts(rows);
  const startMs = T.toEpoch(f.date, f.start);
  await notify({ to: { type: 'user', id: rows[0].user_id }, type: 'BOOKING_REMINDER', data: { ...f, hoursBefore }, eventKey: `${f.bookingId}:${hoursBefore}h`, expiresAt: startMs });
});

// ============================================================================================================
// SPORT / ACTIVITY SUBSCRIPTIONS (customer)  +  the owner's own Book Arena platform plan
// ============================================================================================================
async function loadSubscription(subscriptionId) {
  const [[r]] = await pool.query(
    `SELECT us.*, p.name AS plan_name, p.owner_id AS plan_owner_id, t.name AS venue_name, t.sport_type AS sport, t.coverImage AS venue_image, t.timezone AS venue_tz, c.name AS court_name
     FROM user_subscriptions us
     JOIN subscription_plans p ON us.plan_id = p.id
     LEFT JOIN turfs t ON us.turf_id = t.id
     LEFT JOIN courts c ON c.id = us.court_id
     WHERE us.id = ?`, [subscriptionId]);
  return r || null;
}
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function subscriptionFacts(s) {
  const { formatMoney, fromMinor } = require('../money');
  const start = T.dateOnly(s.start_date);
  const end = T.dateOnly(s.expiry_date);
  const periodStart = s.current_period_start ? T.dateOnly(s.current_period_start) : start;
  const days = !s.weekdays || s.weekdays === 'all' ? 'every day' : String(s.weekdays).split(',').map((d) => DAY_NAMES[Number(d)]).filter(Boolean).join(', ');
  const timeRange = s.start_time ? `${T.time12(String(s.start_time).slice(0, 5))} - ${T.time12(String(s.end_time).slice(0, 5))}` : null;
  const paidMinor = Number(s.amount_paid_minor || 0);
  return {
    subscriptionId: Number(s.id), plan: s.plan_name, venue: s.venue_name, sport: s.sport, court: s.court_name || null, start, end, from: T.prettyDate(start), until: T.prettyDate(end),
    schedule: timeRange ? `${days}, ${timeRange}` : null, periodFrom: T.prettyDate(periodStart), nextBilling: s.next_billing_date ? T.prettyDate(T.dateOnly(s.next_billing_date)) : null,
    currency: s.currency_code || 'INR', amountText: paidMinor > 0 ? formatMoney(fromMinor(paidMinor, s.currency_code || 'INR'), s.currency_code || 'INR') : null,
    cancelledBy: s.cancelled_by || null, source: s.source,
  };
}
const periodKey = (s) => `${s.id}:${T.dateOnly(s.current_period_end || s.expiry_date)}`;

on('subscription.activated', async ({ subscriptionId, renewal = false }) => {
  const s = await loadSubscription(subscriptionId);
  if (!s || s.status !== 'active' || s.payment_status !== 'paid') return; // only once the backend says it really is active
  const f = subscriptionFacts(s);
  const key = renewal ? periodKey(s) : String(s.id);
  const paid = !!s.razorpay_payment_id;
  if (s.user_id) {
    await notify({ to: { type: 'user', id: s.user_id }, type: renewal ? 'SUBSCRIPTION_RENEWED' : 'SUBSCRIPTION_ACTIVATED', data: f, eventKey: key });
    if (paid) await notify({ to: { type: 'user', id: s.user_id }, type: 'SUBSCRIPTION_PAYMENT_SUCCESS', data: f, eventKey: key });
  }
  if (s.plan_owner_id) {
    await notify({ to: { type: 'owner', id: s.plan_owner_id }, type: 'OWNER_NEW_SUBSCRIPTION', data: f, eventKey: key });
    if (paid) await notify({ to: { type: 'owner', id: s.plan_owner_id }, type: 'OWNER_SUBSCRIPTION_PAYMENT_RECEIVED', data: f, eventKey: key });
  }
});

// A payment for a pending subscription failed (Razorpay webhook), or was verified but the slots were taken in the meantime
// (reason 'slot_conflict': nothing was activated and the payment is being refunded). The customer may retry.
on('subscription.payment_failed', async ({ subscriptionId, paymentId = null, reason = null }) => {
  const s = await loadSubscription(subscriptionId);
  if (!s || !s.user_id) return;
  if (s.payment_status === 'paid' && reason !== 'slot_conflict') return;
  if (s.status === 'active' && reason === 'slot_conflict' && s.source !== 'online') return;
  await notify({ to: { type: 'user', id: s.user_id }, type: 'SUBSCRIPTION_PAYMENT_FAILED', data: { ...subscriptionFacts(s), reason }, eventKey: reason ? `${s.id}:${reason}` : (paymentId || `sub${s.id}`) });
});

// a renewal payment failed: the subscription is NOT extended and keeps running only until its paid end date
on('subscription.renewal_failed', async ({ subscriptionId, paymentId = null }) => {
  const s = await loadSubscription(subscriptionId);
  if (!s || !s.user_id || !['active', 'past_due', 'expired'].includes(s.status)) return;
  await notify({ to: { type: 'user', id: s.user_id }, type: 'SUBSCRIPTION_RENEWAL_FAILED', data: subscriptionFacts(s), eventKey: paymentId || `${s.id}:renewal:${Date.now()}` });
});

// the venue owner added a member who has an app account
on('subscription.manual_added', async ({ subscriptionId }) => {
  const s = await loadSubscription(subscriptionId);
  if (!s || s.source !== 'manual' || s.status !== 'active' || !s.user_id) return;
  await notify({ to: { type: 'user', id: s.user_id }, type: 'SUBSCRIPTION_MANUAL_ADDED', data: subscriptionFacts(s), eventKey: String(s.id) });
});

on('subscription.cancelled', async ({ subscriptionId }) => {
  const s = await loadSubscription(subscriptionId);
  if (!s || s.status !== 'cancelled' || !s.user_id) return; // never announce a cancellation the backend has not recorded
  if (s.cancel_reason === 'payment_cancelled' || s.cancelled_by === 'user') return; // the customer backed out of checkout: not news
  await notify({ to: { type: 'user', id: s.user_id }, type: 'SUBSCRIPTION_CANCELLED', data: subscriptionFacts(s), eventKey: String(s.id) });
});

on('subscription.suspended', async ({ subscriptionId }) => {
  const s = await loadSubscription(subscriptionId);
  if (!s || s.status !== 'suspended' || !s.user_id) return;
  await notify({ to: { type: 'user', id: s.user_id }, type: 'SUBSCRIPTION_SUSPENDED', data: subscriptionFacts(s), eventKey: `${s.id}:suspended` });
});

on('subscription.expired', async ({ subscriptionId }) => {
  const s = await loadSubscription(subscriptionId);
  if (!s || !s.user_id || s.status !== 'expired') return;
  if (await supersededBy(s)) return; // renewed: the customer is still subscribed, "expired" would be wrong
  await notify({ to: { type: 'user', id: s.user_id }, type: 'SUBSCRIPTION_EXPIRED', data: subscriptionFacts(s), eventKey: String(s.id) });
});

// Another paid, active period of the same plan for the same customer that runs LONGER than this one = this one was renewed.
async function supersededBy(s) {
  const [[r]] = await pool.query(
    "SELECT id FROM user_subscriptions WHERE user_id = ? AND plan_id = ? AND id <> ? AND status = 'active' AND payment_status = 'paid' AND expiry_date > ? LIMIT 1",
    [s.user_id, s.plan_id, s.id, s.expiry_date]);
  return !!r;
}

// scheduled: daysLeft counted in the app timezone. 7d -> renewal reminder, 3d and 1d -> "expiring soon".
on('subscription.reminder', async ({ subscriptionId, threshold }) => {
  const s = await loadSubscription(subscriptionId);
  if (!s || !s.user_id || s.status !== 'active' || (s.payment_status !== 'paid')) return;
  if (await supersededBy(s)) return;
  const f = subscriptionFacts(s);
  const daysLeft = T.dayDiff(require('../timezone').todayIn(s.venue_tz || 'Asia/Kolkata'), f.end); // counted in the VENUE's timezone
  if (daysLeft < 0 || daysLeft > threshold) return;
  await notify({
    to: { type: 'user', id: s.user_id }, type: threshold >= 7 ? 'SUBSCRIPTION_RENEWAL_REMINDER' : 'SUBSCRIPTION_EXPIRING',
    data: { ...f, daysLeft }, eventKey: `${s.id}:${threshold}d`, expiresAt: T.toEpoch(f.end, '23:59'),
  });
});

on('owner_subscription.reminder', async ({ subscriptionId, threshold }) => {
  const [[s]] = await pool.query('SELECT * FROM owner_subscriptions WHERE id = ?', [subscriptionId]);
  if (!s || !['active', 'trial'].includes(s.status)) return;
  const end = T.dateOnly(s.expiry_date);
  const daysLeft = T.dayDiff(T.localDateString(), end);
  if (daysLeft < 0 || daysLeft > threshold) return;
  await notify({ to: { type: 'owner', id: s.owner_id }, type: 'OWNER_SUBSCRIPTION_EXPIRING', data: { subscriptionId: s.id, plan: s.plan_name, daysLeft }, eventKey: `${s.id}:${threshold}d` });
});

on('owner_subscription.expired', async ({ subscriptionId }) => {
  const [[s]] = await pool.query('SELECT * FROM owner_subscriptions WHERE id = ?', [subscriptionId]);
  if (!s || s.status !== 'expired') return;
  await notify({ to: { type: 'owner', id: s.owner_id }, type: 'OWNER_SUBSCRIPTION_EXPIRED', data: { subscriptionId: s.id, plan: s.plan_name }, eventKey: String(s.id) });
});

// ============================================================================================================
// TOURNAMENTS
// ============================================================================================================
const hostOf = (t) => ({ type: t.owner_type === 'owner' || t.owner_type === 'admin' ? t.owner_type : 'user', id: t.owner_id });

/** The admin's "tell people within N km" setting; 25 km if the column or row is not there. */
async function tournamentNotifyRadius() {
  try {
    const [[r]] = await pool.query('SELECT notify_radius_km FROM tournament_settings LIMIT 1');
    const n = r && Number(r.notify_radius_km);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 25; }
}

async function tournamentOf(id) {
  const [[t]] = await pool.query('SELECT id, name, slug, sport, location, latitude, longitude, status, visibility, banner, owner_id, owner_type FROM tournaments WHERE id = ?', [id]);
  return t || null;
}

// approved players of the given teams + their captains: the people a match is actually "about"
async function playersOfTeams(tournamentId, teamIds) {
  const list = teamIds.filter(Boolean);
  if (list.length === 0) return [];
  const [p] = await pool.query(`SELECT DISTINCT user_id FROM tournament_participants WHERE tournament_id = ? AND team_id IN (${marks(list)}) AND status = 'APPROVED'`, [tournamentId, ...list]);
  const [c] = await pool.query(`SELECT DISTINCT captain_id FROM tournament_teams WHERE id IN (${marks(list)}) AND captain_id IS NOT NULL`, list);
  return [...new Set([...p.map((r) => r.user_id), ...c.map((r) => r.captain_id)])].map((id) => ({ type: 'user', id }));
}

async function allTournamentPlayers(tournamentId) {
  const [p] = await pool.query("SELECT DISTINCT user_id FROM tournament_participants WHERE tournament_id = ? AND status = 'APPROVED'", [tournamentId]);
  return p.map((r) => ({ type: 'user', id: r.user_id }));
}

// A tournament is "created" for the audience when it is really open for registration (not while it is an unpaid draft).
on('tournament.created', async ({ tournamentId }) => {
  const t = await tournamentOf(tournamentId);
  if (!t || t.status !== 'REGISTRATION_OPEN' || t.visibility !== 'PUBLIC') return;
  const host = hostOf(t);
  const excludeUserId = host.type === 'user' ? host.id : null;
  // Prefer a real distance when the tournament has a venue we have coordinates for; the radius is the admin's
  // setting. Otherwise fall back to matching on the venue's city, which is all we can measure.
  let people = [];
  if (t.latitude !== null && t.latitude !== undefined && t.longitude !== null && t.longitude !== undefined) {
    const radiusKm = await tournamentNotifyRadius();
    people = await audience.usersNearTournament({ sport: t.sport, lat: t.latitude, lng: t.longitude, radiusKm, excludeUserId });
  }
  if (people.length === 0) {
    people = await audience.usersInterestedIn({ sport: t.sport, location: t.location, excludeUserId });
  }
  await notifyMany(people, { type: 'TOURNAMENT_CREATED', eventKey: String(t.id), data: { tournamentId: t.id, name: t.name, slug: t.slug, sport: t.sport, nearby: !!t.location, image: t.banner } });
});

on('tournament.registration_reopened', async ({ tournamentId }) => {
  const t = await tournamentOf(tournamentId);
  if (!t || t.status !== 'REGISTRATION_OPEN' || t.visibility !== 'PUBLIC') return;
  const host = hostOf(t);
  const people = await audience.usersInterestedIn({ sport: t.sport, location: t.location, excludeUserId: host.type === 'user' ? host.id : null });
  await notifyMany(people, { type: 'TOURNAMENT_REGISTRATION_OPEN', eventKey: `${t.id}:${T.localDateString()}`, data: { tournamentId: t.id, name: t.name, slug: t.slug } });
});

on('tournament.join_requested', async ({ tournamentId, userId }) => {
  const t = await tournamentOf(tournamentId);
  const [[u]] = await pool.query('SELECT name FROM users WHERE id = ?', [userId]);
  if (!t || !u) return;
  await notify({ to: hostOf(t), type: 'TOURNAMENT_JOIN_REQUEST', eventKey: `${t.id}:${userId}`, data: { tournamentId: t.id, name: t.name, playerName: u.name, hostType: hostOf(t).type } });
});

on('tournament.registration_created', async ({ tournamentId, registrationId }) => {
  const t = await tournamentOf(tournamentId);
  if (!t) return;
  await notify({ to: hostOf(t), type: 'NEW_TOURNAMENT_REGISTRATION', eventKey: String(registrationId), data: { tournamentId: t.id, name: t.name, hostType: hostOf(t).type } });
});

on('tournament.join_decided', async ({ participantId }) => {
  const [[p]] = await pool.query('SELECT id, tournament_id, user_id, status FROM tournament_participants WHERE id = ?', [participantId]);
  if (!p || !['APPROVED', 'REJECTED'].includes(p.status)) return;
  const t = await tournamentOf(p.tournament_id);
  if (!t) return;
  await notify({ to: { type: 'user', id: p.user_id }, type: p.status === 'APPROVED' ? 'TOURNAMENT_JOIN_APPROVED' : 'TOURNAMENT_JOIN_REJECTED', eventKey: `${p.id}:${p.status}`, data: { tournamentId: t.id, name: t.name, slug: t.slug } });
});

on('tournament.team_assigned', async ({ participantId }) => {
  const [[p]] = await pool.query('SELECT p.id, p.tournament_id, p.user_id, p.team_id, p.status, tm.name AS team_name FROM tournament_participants p JOIN tournament_teams tm ON p.team_id = tm.id WHERE p.id = ?', [participantId]);
  if (!p || p.status !== 'APPROVED') return;
  const t = await tournamentOf(p.tournament_id);
  if (!t) return;
  await notify({ to: { type: 'user', id: p.user_id }, type: 'TOURNAMENT_TEAM_ASSIGNED', eventKey: `${p.id}:${p.team_id}`, data: { tournamentId: t.id, name: t.name, slug: t.slug, teamName: p.team_name } });
});

async function loadFixture(fixtureId) {
  const [[f]] = await pool.query(
    `SELECT f.*, ta.name AS team_a_name, tb.name AS team_b_name FROM tournament_fixtures f
     LEFT JOIN tournament_teams ta ON f.team_a_id = ta.id LEFT JOIN tournament_teams tb ON f.team_b_id = tb.id WHERE f.id = ?`, [fixtureId]);
  return f || null;
}

on('tournament.match_scheduled', async ({ fixtureId }) => {
  const f = await loadFixture(fixtureId);
  if (!f || f.status !== 'SCHEDULED' || !f.team_a_id || !f.team_b_id) return;
  const t = await tournamentOf(f.tournament_id);
  const date = T.dateOnly(f.match_date);
  const time = f.match_time ? String(f.match_time).slice(0, 5) : null;
  if (!t || !date) return; // a match with no date is not "scheduled" yet
  const people = await playersOfTeams(f.tournament_id, [f.team_a_id, f.team_b_id]);
  await notifyMany(people, { type: 'TOURNAMENT_MATCH_SCHEDULED', eventKey: `${f.id}:${date}${time || ''}`,
    data: { matchId: f.id, tournamentId: t.id, name: t.name, slug: t.slug, teamA: f.team_a_name, teamB: f.team_b_name, when: time ? whenLabel(date, time) : T.dayLabel(date) } });
});

// Match started. Only the two teams are told (not every follower), and never per score change: live scores stay in the app.
on('tournament.match_live', async ({ fixtureId }) => {
  const f = await loadFixture(fixtureId);
  if (!f || f.status !== 'LIVE') return;
  const t = await tournamentOf(f.tournament_id);
  if (!t) return;
  const people = await playersOfTeams(f.tournament_id, [f.team_a_id, f.team_b_id]);
  await notifyMany(people, { type: 'TOURNAMENT_MATCH_LIVE', eventKey: `live:${f.id}`, data: { matchId: f.id, tournamentId: t.id, name: t.name, teamA: f.team_a_name, teamB: f.team_b_name } });
});

on('tournament.match_finished', async ({ fixtureId }) => {
  const f = await loadFixture(fixtureId);
  if (!f || f.status !== 'FINISHED') return;
  const t = await tournamentOf(f.tournament_id);
  if (!t) return;
  const people = await playersOfTeams(f.tournament_id, [f.team_a_id, f.team_b_id]);
  await notifyMany(people, { type: 'TOURNAMENT_MATCH_COMPLETED', eventKey: `finished:${f.id}`,
    data: { matchId: f.id, tournamentId: t.id, name: t.name, teamA: f.team_a_name, teamB: f.team_b_name, scoreA: f.team_a_score, scoreB: f.team_b_score } });
});

on('tournament.match_reminder', async ({ fixtureId, hoursBefore }) => {
  const f = await loadFixture(fixtureId);
  if (!f || f.status !== 'SCHEDULED') return;
  const t = await tournamentOf(f.tournament_id);
  const date = T.dateOnly(f.match_date);
  const time = f.match_time ? String(f.match_time).slice(0, 5) : null;
  if (!t || !date || !time) return;
  const people = await playersOfTeams(f.tournament_id, [f.team_a_id, f.team_b_id]);
  await notifyMany(people, { type: 'TOURNAMENT_MATCH_REMINDER', eventKey: `${f.id}:${date}${time}:${hoursBefore}h`, expiresAt: T.toEpoch(date, time),
    data: { matchId: f.id, tournamentId: t.id, name: t.name, teamA: f.team_a_name, teamB: f.team_b_name, hoursBefore, timeLabel: T.time12(time) } });
});

on('tournament.completed', async ({ tournamentId }) => {
  const t = await tournamentOf(tournamentId);
  if (!t || t.status !== 'COMPLETED') return;
  await notifyMany(await allTournamentPlayers(t.id), { type: 'TOURNAMENT_COMPLETED', eventKey: String(t.id), data: { tournamentId: t.id, name: t.name, slug: t.slug } });
});

on('tournament.announcement', async ({ announcementId }) => {
  const [[a]] = await pool.query('SELECT id, tournament_id, title, content FROM tournament_announcements WHERE id = ?', [announcementId]);
  if (!a) return;
  const t = await tournamentOf(a.tournament_id);
  if (!t) return;
  await notifyMany(await allTournamentPlayers(t.id), { type: 'TOURNAMENT_ANNOUNCEMENT', eventKey: String(a.id), data: { tournamentId: t.id, name: t.name, slug: t.slug, title: a.title, content: a.content } });
});

// ============================================================================================================
// FIND PLAYERS
// ============================================================================================================
async function loadMatchRequest(id) {
  const [[m]] = await pool.query(
    `SELECT pr.*, t.name AS turf_name FROM player_requests pr LEFT JOIN turfs t ON pr.turf_id = t.id WHERE pr.id = ?`, [id]);
  return m || null;
}
const matchWhen = (m) => whenLabel(T.dateOnly(m.match_date), m.match_time ? String(m.match_time).slice(0, 5) : null);

// A new open match: notify players interested in this sport / location
on('find_players.match_created', async ({ matchRequestId }) => {
  const m = await loadMatchRequest(matchRequestId);
  if (!m || m.status !== 'open') return;

  const [[turf]] = await pool.query('SELECT location, address, latitude, longitude FROM turfs WHERE id = ?', [m.turf_id]);
  const people = await audience.usersInterestedIn({ sport: m.sport_type, location: turf?.location || null, excludeUserId: m.host_id, limit: 100 });
  const avail = await audience.availablePlayers({ sport: m.sport_type, turfId: m.turf_id, excludeUserId: m.host_id, limit: 50 });

  const allRecipients = new Map();
  for (const p of [...people, ...avail]) {
    if (p && p.id && Number(p.id) !== Number(m.host_id)) {
      allRecipients.set(p.id, p);
    }
  }

  const needed = Math.max(1, (m.total_slots || 2) - (m.filled_slots || 1));
  await notifyMany(Array.from(allRecipients.values()), {
    type: 'MATCH_REQUEST_CREATED',
    eventKey: `match_created:${m.id}`,
    data: {
      matchRequestId: m.id,
      sport: m.sport_type,
      turfName: m.turf_name,
      when: matchWhen(m),
      needed,
      contributionAmount: m.contribution_amount,
      deepLink: `/find-players`
    }
  });
});

// someone asked to join (status pending) -> the host is told. `matchPlayerId` is the match_players row.
on('find_players.join_requested', async ({ matchPlayerId }) => {
  const [[mp]] = await pool.query('SELECT mp.id, mp.match_id, mp.user_id, mp.status, u.name AS player_name FROM match_players mp JOIN users u ON mp.user_id = u.id WHERE mp.id = ?', [matchPlayerId]);
  if (!mp) return;
  const m = await loadMatchRequest(mp.match_id);
  if (!m || !m.host_id || m.host_id === mp.user_id) return;
  // 'approved' = the player paid / the spot was free, so they are already in: the host learns someone joined, the player gets confirmation
  const joined = mp.status === 'approved';
  await notify({ to: { type: 'user', id: m.host_id }, type: 'MATCH_JOIN_REQUEST', eventKey: String(mp.id), data: { matchRequestId: m.id, playerName: mp.player_name, turfName: m.turf_name, joined } });
  if (joined) await notify({ to: { type: 'user', id: mp.user_id }, type: 'MATCH_JOIN_APPROVED', eventKey: `${mp.id}:approved`, data: { matchRequestId: m.id, turfName: m.turf_name } });
});

on('find_players.join_decided', async ({ matchPlayerId, decision, userId = null, matchRequestId = null }) => {
  // reject deletes the row, so the route passes who/what explicitly; approve reads it back
  let uid = userId, mid = matchRequestId, key = String(matchPlayerId);
  if (!uid) {
    const [[mp]] = await pool.query('SELECT match_id, user_id, status FROM match_players WHERE id = ?', [matchPlayerId]);
    if (!mp || mp.status !== 'approved') return;
    uid = mp.user_id; mid = mp.match_id;
  }
  const m = await loadMatchRequest(mid);
  if (!m || !uid) return;
  await notify({ to: { type: 'user', id: uid }, type: decision === 'approved' ? 'MATCH_JOIN_APPROVED' : 'MATCH_JOIN_REJECTED', eventKey: `${key}:${decision}`, data: { matchRequestId: m.id, turfName: m.turf_name } });
});

on('find_players.match_cancelled', async ({ matchRequestId }) => {
  const m = await loadMatchRequest(matchRequestId);
  if (!m || m.status !== 'cancelled') return;
  const [players] = await pool.query('SELECT DISTINCT user_id FROM match_players WHERE match_id = ?', [m.id]);
  await notifyMany(players.filter((p) => p.user_id !== m.host_id).map((p) => ({ type: 'user', id: p.user_id })),
    { type: 'MATCH_CANCELLED', eventKey: String(m.id), data: { matchRequestId: m.id, turfName: m.turf_name, when: matchWhen(m) } });
});

on('find_players.match_reminder', async ({ matchRequestId, hoursBefore }) => {
  const m = await loadMatchRequest(matchRequestId);
  if (!m || !['open', 'full'].includes(m.status)) return;
  const [players] = await pool.query("SELECT DISTINCT user_id FROM match_players WHERE match_id = ? AND status = 'approved'", [m.id]);
  const people = [...new Set([m.host_id, ...players.map((p) => p.user_id)].filter(Boolean))].map((id) => ({ type: 'user', id }));
  const time = m.match_time ? String(m.match_time).slice(0, 5) : null;
  await notifyMany(people, { type: 'MATCH_REMINDER', eventKey: `${m.id}:${hoursBefore}h`, expiresAt: time ? T.toEpoch(T.dateOnly(m.match_date), time) : null,
    data: { matchRequestId: m.id, turfName: m.turf_name, hoursBefore, timeLabel: T.time12(time) } });
});

// ============================================================================================================
// OWNERS / ADMINS / ACCOUNT
// ============================================================================================================
async function adminRecipients() {
  const [rows] = await pool.query('SELECT id FROM admins');
  return rows.map((r) => ({ type: 'admin', id: r.id }));
}

on('owner.registered', async ({ ownerId }) => {
  const [[o]] = await pool.query('SELECT id, name, is_approved FROM owners WHERE id = ?', [ownerId]);
  if (!o) return;
  await notifyMany(await adminRecipients(), { type: 'ADMIN_NEW_OWNER', eventKey: String(o.id), data: { ownerId: o.id, ownerName: o.name, pending: !o.is_approved } });
});

on('owner.decided', async ({ ownerId, decision }) => {
  const [[o]] = await pool.query('SELECT id, is_approved FROM owners WHERE id = ?', [ownerId]);
  if (!o) return;
  const approved = decision === 'approved';
  if (approved !== !!o.is_approved) return; // the row must agree with the announcement
  await notify({ to: { type: 'owner', id: o.id }, type: 'SYSTEM_ANNOUNCEMENT', eventKey: `owner-${decision}:${o.id}`,
    data: { title: approved ? 'Account approved' : 'Account not approved', message: approved ? 'Your Book Arena owner account has been approved. You can now add venues and receive bookings.' : 'Your Book Arena owner account was not approved. Contact support for more information.', deepLink: approved ? '/(owner)' : '/(owner)/notifications' } });
});

// password changed etc.: `to` is { type, id }
on('security.alert', async ({ to, title, message, eventKey }) => {
  await notify({ to, type: 'SECURITY_ALERT', eventKey, data: { title, message } });
});

// money problem that needs a human (e.g. a Razorpay Route transfer failed)
on('payment.issue', async ({ summary, entityType, entityId }) => {
  await notifyMany(await adminRecipients(), { type: 'ADMIN_PAYMENT_ISSUE', eventKey: `${entityType}:${entityId}`, data: { summary, entityType, entityId } });
});

// ============================================================================================================
// ACTIVITIES (ticket-booking engine — fully separate from BOOKINGS above)
// ============================================================================================================
async function loadActivityBooking(bookingId) {
  const [[b]] = await pool.query(
    `SELECT ab.*, a.name AS activity_name, a.images AS activity_images
     FROM activity_bookings ab JOIN activities a ON a.id = ab.activity_id WHERE ab.id = ?`, [bookingId]
  );
  return b || null;
}
const activityImage = (imagesJson) => { try { const arr = typeof imagesJson === 'string' ? JSON.parse(imagesJson) : imagesJson; return Array.isArray(arr) && arr.length ? arr[0] : null; } catch (e) { return null; } };

on('activity.booking_confirmed', async ({ bookingId }) => {
  const b = await loadActivityBooking(bookingId);
  if (!b || b.status !== 'confirmed') return;
  const when = T.prettyDate(T.dateOnly(b.booking_date));
  if (b.user_id) await notify({ to: { type: 'user', id: b.user_id }, type: 'ACTIVITY_BOOKING_CONFIRMED', eventKey: `${b.id}:confirmed`,
    data: { bookingId: b.id, bookingCode: b.booking_code, activityName: b.activity_name, when, image: activityImage(b.activity_images) } });
  const [[g]] = await pool.query('SELECT COALESCE(SUM(quantity),0) AS n FROM activity_booking_items WHERE booking_id = ?', [b.id]);
  await notify({ to: { type: 'owner', id: b.owner_id }, type: 'OWNER_NEW_ACTIVITY_BOOKING', eventKey: `${b.id}:owner-new`,
    data: { bookingId: b.id, bookingCode: b.booking_code, activityName: b.activity_name, when, guests: Number(g.n) } });
});

on('activity.booking_cancelled', async ({ bookingId, reason }) => {
  const b = await loadActivityBooking(bookingId);
  if (!b || b.status !== 'cancelled') return;
  if (b.user_id) await notify({ to: { type: 'user', id: b.user_id }, type: 'ACTIVITY_BOOKING_CANCELLED', eventKey: `${b.id}:cancelled`,
    data: { bookingId: b.id, bookingCode: b.booking_code, activityName: b.activity_name, reason } });
  if (reason === 'owner_cancelled' || reason === 'sold_out' || reason === 'customer_cancelled') {
    await notify({ to: { type: 'owner', id: b.owner_id }, type: 'OWNER_ACTIVITY_BOOKING_CANCELLED', eventKey: `${b.id}:owner-cancelled`,
      data: { bookingId: b.id, bookingCode: b.booking_code, activityName: b.activity_name } });
  }
});

on('activity.payment_failed', async ({ bookingId }) => {
  const b = await loadActivityBooking(bookingId);
  if (!b) return;
  if (b.user_id) await notify({ to: { type: 'user', id: b.user_id }, type: 'ACTIVITY_PAYMENT_FAILED', eventKey: `${b.id}:payment-failed:${b.razorpay_payment_id || Date.now()}`,
    data: { bookingId: b.id, activityName: b.activity_name } });
});

on('owner.activity_created', async ({ activityId }) => {
  const [[a]] = await pool.query('SELECT a.id, a.name, a.status, o.name AS owner_name FROM activities a JOIN owners o ON o.id = a.owner_id WHERE a.id = ?', [activityId]);
  if (!a || a.status !== 'pending') return;
  await notifyMany(await adminRecipients(), { type: 'ADMIN_NEW_ACTIVITY', eventKey: String(a.id), data: { activityId: a.id, activityName: a.name, ownerName: a.owner_name } });
});

on('owner.activity_decided', async ({ activityId, decision }) => {
  const [[a]] = await pool.query('SELECT id, name, owner_id, status FROM activities WHERE id = ?', [activityId]);
  if (!a || a.status !== decision) return; // the row must agree with the announcement
  await notify({ to: { type: 'owner', id: a.owner_id }, type: 'OWNER_ACTIVITY_DECIDED', eventKey: `${a.id}:${decision}`,
    data: { activityId: a.id, activityName: a.name, decision } });
});

on('owner.billing_payment_received', async ({ ownerId, turfId, cycleId, paymentId }) => {
  const [[row]] = await pool.query(
    `SELECT t.name AS venue, c.amount_minor, c.currency, c.cycle_start, p.razorpay_payment_id
     FROM turfs t JOIN turf_subscription_cycles c ON c.turf_id = t.id
     JOIN venue_billing_payments p ON p.cycle_id = c.id
     WHERE t.id = ? AND t.owner_id = ? AND c.id = ? AND p.razorpay_payment_id = ? AND p.status = 'CAPTURED'`,
    [turfId, ownerId, cycleId, paymentId]
  );
  if (!row) return;
  await notify({
    to: { type: 'owner', id: ownerId }, type: 'OWNER_BILLING_NOTICE',
    eventKey: `billing-paid:${turfId}:${cycleId}:${paymentId}`,
    data: { noticeKind: 'PAYMENT_RECEIVED', turfId, venue: row.venue, plan: 'Venue subscription', amountMinor: Number(row.amount_minor), currency: row.currency, dueDate: row.cycle_start },
  });
});

on('owner.billing_payment_failed', async ({ owner_id, turf_id, cycle_id, reason }) => {
  const [[row]] = await pool.query(
    `SELECT t.name AS venue, c.amount_minor, c.currency, c.cycle_start, p.id AS payment_record_id
     FROM turfs t JOIN turf_subscription_cycles c ON c.turf_id = t.id
     JOIN venue_billing_payments p ON p.cycle_id = c.id
     WHERE t.id = ? AND t.owner_id = ? AND c.id = ? AND p.status = 'PENDING'`,
    [turf_id, owner_id, cycle_id]
  );
  if (!row) return;
  await notify({
    to: { type: 'owner', id: owner_id }, type: 'OWNER_BILLING_NOTICE',
    eventKey: `billing-failed:${row.payment_record_id}:${Date.now()}`,
    data: { noticeKind: 'PAYMENT_FAILED', turfId: turf_id, venue: row.venue, plan: 'Venue subscription', amountMinor: Number(row.amount_minor), currency: row.currency, dueDate: row.cycle_start, reason },
  });
});

module.exports = { emit, fire, on, handlers, supersededBy, bookingFacts };

// ---- refunds (both engines): one notification per status the customer cares about ----
on('refund.status', async ({ refundId, status }) => {
  const [[r]] = await pool.query('SELECT * FROM refunds WHERE id = ?', [refundId]);
  if (!r || !r.user_id || Number(r.refund_amount_minor) <= 0) return;
  const type = { REFUND_INITIATED: 'REFUND_INITIATED', REFUND_COMPLETED: 'REFUND_COMPLETED', REFUND_FAILED: 'REFUND_FAILED' }[status];
  if (!type || r.refund_status === 'NOT_REQUIRED') return;
  const { formatMoney, fromMinor } = require('../money');
  await notify({ to: { type: 'user', id: r.user_id }, type, eventKey: `${r.id}:${status}`,
    data: { refundId: r.id, bookingType: r.booking_type, bookingId: r.booking_id, amountText: formatMoney(fromMinor(r.refund_amount_minor, r.currency_code), r.currency_code) } });
});

// ---- activities: reminders (from the scheduler), redemption, refund processed, daily owner summary ----
on('activity.reminder', async ({ bookingId, hoursBefore }) => {
  const b = await loadActivityBooking(bookingId);
  if (!b || b.status !== 'confirmed' || !b.user_id) return;
  await notify({ to: { type: 'user', id: b.user_id }, type: 'ACTIVITY_REMINDER', eventKey: `${b.id}:reminder:${hoursBefore}`,
    data: { bookingId: b.id, bookingCode: b.booking_code, activityName: b.activity_name, when: T.prettyDate(T.dateOnly(b.booking_date)), hoursBefore } });
});

on('activity.ticket_redeemed', async ({ ticketId, redeemed }) => {
  const [[t]] = await pool.query('SELECT t.id, t.booking_id, t.redeemed_quantity FROM activity_tickets t WHERE t.id = ?', [ticketId]);
  if (!t) return;
  const b = await loadActivityBooking(t.booking_id);
  if (!b || !b.user_id) return;
  await notify({ to: { type: 'user', id: b.user_id }, type: 'ACTIVITY_TICKET_REDEEMED', eventKey: `${t.id}:redeemed:${t.redeemed_quantity}`,
    data: { bookingId: b.id, bookingCode: b.booking_code, activityName: b.activity_name, redeemed } });
});

on('activity.refund_processed', async ({ bookingId }) => {
  const b = await loadActivityBooking(bookingId);
  if (!b || b.refund_status !== 'processed' || !b.user_id) return;
  await notify({ to: { type: 'user', id: b.user_id }, type: 'ACTIVITY_REFUND_PROCESSED', eventKey: `${b.id}:refund-processed`,
    data: { bookingId: b.id, bookingCode: b.booking_code, activityName: b.activity_name, amount: Number(b.refund_amount) } });
});

on('activity.daily_summary', async ({ ownerId, date }) => {
  const [[s]] = await pool.query(
    `SELECT COUNT(*) AS bookings, COALESCE(SUM(total_amount),0) AS revenue FROM activity_bookings WHERE owner_id = ? AND booking_date = ? AND status = 'confirmed'`, [ownerId, date]);
  if (!Number(s.bookings)) return;
  const [[q]] = await pool.query(
    `SELECT COALESCE(SUM(t.quantity_covered),0) AS tickets, COALESCE(SUM(t.redeemed_quantity),0) AS entries FROM activity_tickets t JOIN activity_bookings b ON b.id = t.booking_id WHERE b.owner_id = ? AND b.booking_date = ? AND b.status = 'confirmed'`, [ownerId, date]);
  await notify({ to: { type: 'owner', id: ownerId }, type: 'OWNER_ACTIVITY_DAILY_SUMMARY', eventKey: `${ownerId}:summary:${date}`,
    data: { ownerId, bookings: Number(s.bookings), revenue: Math.round(Number(s.revenue)), tickets: Number(q.tickets), entries: Number(q.entries) } });
});
