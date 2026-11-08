// Who should hear about non-transactional things (new tournament, match looking for players, admin campaigns).
// Everything here is derived from real activity in the database; there is no gym / fitness / trainer targeting.
//
// "Interest" in a sport = the person has, at some point:
//   - booked a turf of that sport, or
//   - published availability for it (Find Players), or
//   - joined / hosted a Find Players match of that sport, or
//   - taken part in a tournament of that sport.
// Location is whatever those same activities were tied to (turf city/area, availability area, tournament city).
const pool = require('../../config/db');

const LIMIT = 500;
const like = (v) => `%${String(v).trim().toLowerCase().replace(/[%_]/g, '')}%`;

// rows of { user_id, location } describing where a user has been active for a sport (location may be null)
async function activityRows(sport) {
  const s = like(sport);
  const queries = [
    ['SELECT DISTINCT b.user_id AS user_id, t.location AS location FROM bookings b JOIN turfs t ON b.turf_id = t.id WHERE b.user_id IS NOT NULL AND b.status IN (\'confirmed\', \'completed\') AND (LOWER(b.sport_type) LIKE ? OR LOWER(t.sport_type) LIKE ?) LIMIT 5000', [s, s]],
    ['SELECT DISTINCT user_id, preferred_location AS location FROM player_availability WHERE LOWER(sport_type) LIKE ? LIMIT 5000', [s]],
    ['SELECT DISTINCT mp.user_id AS user_id, tf.location AS location FROM match_players mp JOIN player_requests pr ON mp.match_id = pr.id LEFT JOIN turfs tf ON pr.turf_id = tf.id WHERE mp.status = \'approved\' AND LOWER(pr.sport_type) LIKE ? LIMIT 5000', [s]],
    ['SELECT DISTINCT pr.host_id AS user_id, tf.location AS location FROM player_requests pr LEFT JOIN turfs tf ON pr.turf_id = tf.id WHERE pr.host_id IS NOT NULL AND LOWER(pr.sport_type) LIKE ? LIMIT 5000', [s]],
    ['SELECT DISTINCT p.user_id AS user_id, tr.location AS location FROM tournament_participants p JOIN tournaments tr ON p.tournament_id = tr.id WHERE LOWER(tr.sport) LIKE ? LIMIT 5000', [s]],
  ];
  const out = [];
  for (const [sql, params] of queries) {
    try { const [rows] = await pool.query(sql, params); out.push(...rows); } catch (e) { /* a missing optional table just means less data */ }
  }
  return out;
}

// users interested in `sport`; when `location` is given, keep people whose activity was in that area, or who have no
// known area at all (so a new player is not excluded just because we know nothing about them yet).
async function usersInterestedIn({ sport, location = null, excludeUserId = null, limit = LIMIT }) {
  if (!sport) return [];
  const rows = await activityRows(sport);
  const byUser = new Map();
  for (const r of rows) {
    if (!r.user_id) continue;
    const e = byUser.get(r.user_id) || { locs: [] };
    if (r.location) e.locs.push(String(r.location).toLowerCase());
    byUser.set(r.user_id, e);
  }
  const city = location ? String(location).trim().toLowerCase() : '';
  const ids = [];
  for (const [uid, e] of byUser) {
    if (excludeUserId && Number(uid) === Number(excludeUserId)) continue;
    if (city && e.locs.length > 0 && !e.locs.some((l) => l.includes(city) || city.includes(l))) continue;
    ids.push(uid);
    if (ids.length >= limit) break;
  }
  return ids.map((id) => ({ type: 'user', id }));
}

// Find Players: people who published availability for this sport (active), optionally at the same venue.
async function availablePlayers({ sport, turfId = null, excludeUserId = null, limit = 100 }) {
  if (!sport) return [];
  const params = [like(sport)];
  let sql = "SELECT DISTINCT user_id FROM player_availability WHERE status = 'active' AND LOWER(sport_type) LIKE ?";
  if (excludeUserId) { sql += ' AND user_id <> ?'; params.push(excludeUserId); }
  sql += ` LIMIT ${Math.min(limit, 500)}`;
  const [rows] = await pool.query(sql, params);
  return rows.map((r) => ({ type: 'user', id: r.user_id }));
}

// Admin campaign segments. Returns recipients (capped) and the uncapped count for the confirmation screen.
//   { roles: ['user','owner'], sport, city, activeSubscription: bool }
async function segment(spec = {}) {
  const roles = (Array.isArray(spec.roles) && spec.roles.length ? spec.roles : ['user']).filter((r) => ['user', 'owner'].includes(r));
  const CAP = 5000;
  let recipients = [];

  if (roles.includes('user')) {
    let users;
    if (spec.sport) users = await usersInterestedIn({ sport: spec.sport, location: spec.city || null, limit: CAP });
    else if (spec.city) {
      const [rows] = await pool.query(
        `SELECT DISTINCT b.user_id AS id FROM bookings b JOIN turfs t ON b.turf_id = t.id WHERE b.user_id IS NOT NULL AND LOWER(t.location) LIKE ? LIMIT ${CAP}`, [like(spec.city)]);
      users = rows.map((r) => ({ type: 'user', id: r.id }));
    } else {
      const [rows] = await pool.query(`SELECT id FROM users ORDER BY id DESC LIMIT ${CAP}`);
      users = rows.map((r) => ({ type: 'user', id: r.id }));
    }
    if (spec.activeSubscription) {
      const [subs] = await pool.query("SELECT DISTINCT user_id FROM user_subscriptions WHERE status = 'active' AND payment_status = 'paid'");
      const set = new Set(subs.map((r) => r.user_id));
      users = users.filter((u) => set.has(u.id));
    }
    recipients.push(...users);
  }
  if (roles.includes('owner') && !spec.sport && !spec.activeSubscription) {
    const [rows] = await pool.query(`SELECT id FROM owners WHERE is_approved = true AND (is_blocked = false OR is_blocked IS NULL) LIMIT ${CAP}`);
    recipients.push(...rows.map((r) => ({ type: 'owner', id: r.id })));
  }
  return { recipients: recipients.slice(0, CAP), count: recipients.length, capped: recipients.length > CAP };
}

/**
 * People to tell about a tournament at a known point: anyone whose own activity for this sport happened at a
 * venue within `radiusKm`. Distance is measured venue-to-venue — we never store or read a person's own position,
 * so nobody's location is exposed to the host or to anyone else.
 * Returns [] when there is nothing to measure; the caller then uses the city-name rule instead.
 */
async function usersNearTournament({ sport, lat, lng, radiusKm = 25, excludeUserId = null, limit = LIMIT }) {
  if (!sport || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)) || !(radiusKm > 0)) return [];
  const s = like(sport);
  // Haversine in SQL (6371 km earth radius), bounded first by a cheap lat/lng box so an index can still be used.
  const degLat = radiusKm / 111;
  const degLng = radiusKm / (111 * Math.max(0.1, Math.cos((Number(lat) * Math.PI) / 180)));
  const box = [Number(lat) - degLat, Number(lat) + degLat, Number(lng) - degLng, Number(lng) + degLng];
  const haversine = '(6371 * ACOS(LEAST(1, COS(RADIANS(?)) * COS(RADIANS(t.latitude)) * COS(RADIANS(t.longitude) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(t.latitude)))))';
  const sql = `
    SELECT DISTINCT b.user_id AS user_id
      FROM bookings b
      JOIN turfs t ON b.turf_id = t.id
     WHERE b.user_id IS NOT NULL
       AND b.status IN ('confirmed', 'completed')
       AND (LOWER(b.sport_type) LIKE ? OR LOWER(t.sport_type) LIKE ?)
       AND t.latitude IS NOT NULL AND t.longitude IS NOT NULL
       AND t.latitude BETWEEN ? AND ? AND t.longitude BETWEEN ? AND ?
       AND ${haversine} <= ?
     LIMIT ?`;
  try {
    const [rows] = await pool.query(sql, [s, s, box[0], box[1], box[2], box[3], lat, lng, lat, radiusKm, limit]);
    return rows
      .map((r) => Number(r.user_id))
      .filter((id) => id && (!excludeUserId || id !== Number(excludeUserId)))
      .map((id) => ({ type: 'user', id }));
  } catch (e) {
    return [];
  }
}

module.exports = { usersInterestedIn, usersNearTournament, availablePlayers, segment };
