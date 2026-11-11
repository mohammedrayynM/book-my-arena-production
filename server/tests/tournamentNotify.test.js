// Request F priority 7: who hears about a new tournament. Targeting is by the VENUE's position and the sport,
// never by anyone's own device location, and the same tournament is never announced twice.
const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('./helpers/testDb');
const pool = db.pool;
const q = (s, p) => pool.query(s, p);
const qq = (s, p) => pool.query(s, p).catch(() => {});
const audience = require('../utils/notifications/audience');

// Bandra, Mumbai, and points at increasing distance from it.
const HOME = { lat: 19.0596, lng: 72.8295 };
const NEAR = { lat: 19.0760, lng: 72.8777 };   // ~5 km
const MID = { lat: 19.2183, lng: 72.9781 };    // ~22 km
const FAR = { lat: 18.5204, lng: 73.8567 };    // Pune, ~120 km

let owner;
async function turfAt(name, { lat, lng }, sport = 'Cricket', location = 'Mumbai') {
  const [t] = await q(
    'INSERT INTO turfs (owner_id, name, latitude, longitude, sport_type, location) VALUES (?, ?, ?, ?, ?, ?)',
    [owner, name, lat, lng, sport, location]);
  return t.insertId;
}
async function userWhoBookedAt(name, turfId, sport = 'Cricket') {
  const [u] = await q('INSERT INTO users (name, email) VALUES (?, ?)', [name, `${name}@x.test`]);
  await q("INSERT INTO bookings (turf_id, user_id, amount, status, sport_type, customer_name) VALUES (?, ?, 100, 'confirmed', ?, ?)",
    [turfId, u.insertId, sport, name]);
  return u.insertId;
}
const idsOf = (people) => people.map((p) => p.id).sort((a, b) => a - b);

test.before(async () => {
  await db.setup();
  await qq('CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), email VARCHAR(150), karma_points INT DEFAULT 0, phone VARCHAR(20) NULL, profile_pic VARCHAR(500) NULL)');
  for (const c of ['latitude DOUBLE NULL', 'longitude DOUBLE NULL', 'sport_type VARCHAR(40) NULL', 'location VARCHAR(100) NULL']) await qq(`ALTER TABLE turfs ADD COLUMN ${c}`);
  for (const c of ['user_id INT NULL', 'sport_type VARCHAR(40) NULL']) await qq(`ALTER TABLE bookings ADD COLUMN ${c}`);
  await require('../migrate_tournaments')();
  await require('../migrate_tournament_config')();
});

test.beforeEach(async () => {
  // every table usersInterestedIn() reads, so one test's data can never leak into another's audience
  for (const t of ['bookings', 'turfs', 'users', 'tournaments', 'player_availability', 'match_players',
    'player_requests', 'tournament_participants']) await qq(`DELETE FROM ${t}`);
  const [o] = await q("INSERT INTO owners (name, email) VALUES ('O', 'o@x.test')");
  owner = o.insertId;
});
test.after(async () => { await pool.end(); });

test('only people active within the radius are told, and distance is measured from the venue', async () => {
  const near = await userWhoBookedAt('Near', await turfAt('Near Turf', NEAR));
  const mid = await userWhoBookedAt('Mid', await turfAt('Mid Turf', MID));
  const far = await userWhoBookedAt('Far', await turfAt('Far Turf', FAR));

  const within10 = await audience.usersNearTournament({ sport: 'Cricket', lat: HOME.lat, lng: HOME.lng, radiusKm: 10 });
  assert.deepEqual(idsOf(within10), [near], 'only the 5 km user should be inside a 10 km radius');

  const within30 = await audience.usersNearTournament({ sport: 'Cricket', lat: HOME.lat, lng: HOME.lng, radiusKm: 30 });
  assert.deepEqual(idsOf(within30), [near, mid].sort((a, b) => a - b));

  const within200 = await audience.usersNearTournament({ sport: 'Cricket', lat: HOME.lat, lng: HOME.lng, radiusKm: 200 });
  assert.deepEqual(idsOf(within200), [near, mid, far].sort((a, b) => a - b));
});

test('the radius is configurable, and setting it to zero turns distance targeting off', async () => {
  await userWhoBookedAt('Near', await turfAt('Near Turf', NEAR));
  assert.equal((await audience.usersNearTournament({ sport: 'Cricket', lat: HOME.lat, lng: HOME.lng, radiusKm: 0 })).length, 0);
  assert.equal((await audience.usersNearTournament({ sport: 'Cricket', lat: HOME.lat, lng: HOME.lng, radiusKm: 2 })).length, 0);
  assert.equal((await audience.usersNearTournament({ sport: 'Cricket', lat: HOME.lat, lng: HOME.lng, radiusKm: 10 })).length, 1);
});

test('a nearby player of a different sport is not told', async () => {
  await userWhoBookedAt('Footballer', await turfAt('Football Turf', NEAR, 'Football'), 'Football');
  const cricket = await audience.usersNearTournament({ sport: 'Cricket', lat: HOME.lat, lng: HOME.lng, radiusKm: 25 });
  assert.equal(cricket.length, 0);
  const football = await audience.usersNearTournament({ sport: 'Football', lat: HOME.lat, lng: HOME.lng, radiusKm: 25 });
  assert.equal(football.length, 1);
});

test('the host is never notified about their own tournament', async () => {
  const turf = await turfAt('Near Turf', NEAR);
  const host = await userWhoBookedAt('Host', turf);
  const other = await userWhoBookedAt('Other', turf);
  const people = await audience.usersNearTournament({ sport: 'Cricket', lat: HOME.lat, lng: HOME.lng, radiusKm: 25, excludeUserId: host });
  assert.deepEqual(idsOf(people), [other]);
});

test('a venue with no coordinates falls back to city matching instead of telling nobody', async () => {
  const turf = await turfAt('City Turf', { lat: null, lng: null }, 'Cricket', 'Mumbai');
  const user = await userWhoBookedAt('Mumbaikar', turf);

  const byDistance = await audience.usersNearTournament({ sport: 'Cricket', lat: HOME.lat, lng: HOME.lng, radiusKm: 25 });
  assert.equal(byDistance.length, 0, 'no coordinates means nothing to measure');

  const byCity = await audience.usersInterestedIn({ sport: 'Cricket', location: 'Mumbai' });
  assert.ok(idsOf(byCity).includes(user), 'the city rule should still reach this player');
});

test('a tournament with no coordinates at all is not targeted by distance', async () => {
  await userWhoBookedAt('Near', await turfAt('Near Turf', NEAR));
  for (const bad of [{ lat: null, lng: null }, { lat: undefined, lng: 72 }, { lat: 'x', lng: 'y' }]) {
    const people = await audience.usersNearTournament({ sport: 'Cricket', lat: bad.lat, lng: bad.lng, radiusKm: 25 });
    assert.equal(people.length, 0, JSON.stringify(bad));
  }
});

test('each person is told once, however many qualifying bookings they have', async () => {
  const [u] = await q('INSERT INTO users (name, email) VALUES (?, ?)', ['Regular', 'r@x.test']);
  const turf = await turfAt('Near Turf', NEAR);
  for (let i = 0; i < 4; i++) {
    await q("INSERT INTO bookings (turf_id, user_id, amount, status, sport_type, customer_name) VALUES (?, ?, 100, 'confirmed', 'Cricket', 'Regular')", [turf, u.insertId]);
  }
  const people = await audience.usersNearTournament({ sport: 'Cricket', lat: HOME.lat, lng: HOME.lng, radiusKm: 25 });
  assert.equal(people.length, 1);
});

test('the audience is a list of ids only — no names, contact details or positions', async () => {
  await userWhoBookedAt('Near', await turfAt('Near Turf', NEAR));
  const people = await audience.usersNearTournament({ sport: 'Cricket', lat: HOME.lat, lng: HOME.lng, radiusKm: 25 });
  assert.deepEqual(Object.keys(people[0]).sort(), ['id', 'type']);
  assert.equal(people[0].type, 'user');
});

test('a cancelled or abandoned booking does not make someone an audience member', async () => {
  const [u] = await q('INSERT INTO users (name, email) VALUES (?, ?)', ['Cancelled', 'c@x.test']);
  const turf = await turfAt('Near Turf', NEAR);
  await q("INSERT INTO bookings (turf_id, user_id, amount, status, sport_type, customer_name) VALUES (?, ?, 100, 'cancelled', 'Cricket', 'C')", [turf, u.insertId]);
  const people = await audience.usersNearTournament({ sport: 'Cricket', lat: HOME.lat, lng: HOME.lng, radiusKm: 25 });
  assert.equal(people.length, 0);
});
