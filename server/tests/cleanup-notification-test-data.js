// Removes everything notifications.e2e.js may have left behind after an aborted run (network drop mid-test).
// Only touches rows whose email/name carries the test marker (zz_nt_ / "ZZ NT").
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const pool = require('../config/db');
(async () => {
  const q = async (sql, p = []) => (await pool.query(sql, p))[0];
  const users = (await q("SELECT id FROM users WHERE email LIKE 'zz_nt_%'")).map((r) => r.id);
  const owners = (await q("SELECT id FROM owners WHERE email LIKE 'zz_nt_%'")).map((r) => r.id);
  const turfs = (await q("SELECT id FROM turfs WHERE name LIKE 'ZZ NT%'")).map((r) => r.id);
  const tournaments = (await q("SELECT id FROM tournaments WHERE name LIKE 'ZZ NT%'")).map((r) => r.id);
  const inList = (a) => (a.length ? a.map(() => '?').join(',') : 'NULL');
  const U = inList(users), O = inList(owners);
  await q(`DELETE FROM notification_deliveries WHERE notification_id IN (SELECT id FROM notifications WHERE (recipient_type='user' AND recipient_id IN (${U})) OR (recipient_type='owner' AND recipient_id IN (${O})))`, [...users, ...owners]);
  await q(`DELETE FROM notifications WHERE (recipient_type='user' AND recipient_id IN (${U})) OR (recipient_type='owner' AND recipient_id IN (${O}))`, [...users, ...owners]);
  for (const id of owners) await q("DELETE FROM notifications WHERE recipient_type = 'admin' AND event_key LIKE ?", [`ADMIN_NEW_OWNER:${id}:%`]);
  await q(`DELETE FROM user_push_tokens WHERE (recipient_type='user' AND recipient_id IN (${U})) OR (recipient_type='owner' AND recipient_id IN (${O}))`, [...users, ...owners]);
  await q(`DELETE FROM notification_preferences WHERE (recipient_type='user' AND recipient_id IN (${U})) OR (recipient_type='owner' AND recipient_id IN (${O}))`, [...users, ...owners]);
  await q("DELETE FROM notification_broadcasts WHERE title LIKE 'ZZ NT%'");
  for (const t of ['subscription_reservations', 'subscription_payments', 'subscription_audit_log']) await q(`DELETE FROM ${t} WHERE subscription_id IN (SELECT id FROM user_subscriptions WHERE user_id IN (${U}) OR plan_id IN (SELECT id FROM subscription_plans WHERE owner_id IN (${O})))`, [...users, ...owners]);
  await q(`DELETE FROM user_subscriptions WHERE user_id IN (${U}) OR plan_id IN (SELECT id FROM subscription_plans WHERE owner_id IN (${O}))`, [...users, ...owners]);
  await q(`DELETE FROM subscription_plans WHERE owner_id IN (${O})`, owners);
  await q(`DELETE FROM owner_subscriptions WHERE owner_id IN (${O})`, owners);
  await q(`DELETE FROM player_availability WHERE user_id IN (${U})`, users);
  await q(`DELETE FROM match_players WHERE user_id IN (${U})`, users);
  await q(`DELETE FROM match_players WHERE match_id IN (SELECT id FROM player_requests WHERE host_id IN (${U}))`, users);
  await q(`DELETE FROM player_requests WHERE host_id IN (${U})`, users);
  for (const id of tournaments) {
    await q('DELETE FROM tournament_match_events WHERE match_id IN (SELECT id FROM tournament_fixtures WHERE tournament_id = ?)', [id]).catch(() => {});
    for (const t of ['tournament_fixtures', 'tournament_teams', 'tournament_participants', 'tournament_join_requests', 'tournament_announcements', 'tournament_audit_logs', 'tournament_registrations', 'tournament_scorers', 'tournament_streams']) await q(`DELETE FROM ${t} WHERE tournament_id = ?`, [id]).catch(() => {});
    await q('DELETE FROM tournaments WHERE id = ?', [id]);
  }
  const bookings = (await q(`SELECT id FROM bookings WHERE user_id IN (${U}) OR turf_id IN (${inList(turfs)})`, [...users, ...turfs])).map((r) => r.id);
  if (bookings.length) {
    await q(`DELETE FROM razorpay_transfers WHERE booking_id IN (${inList(bookings)})`, bookings).catch(() => {});
    await q(`DELETE FROM bookings WHERE id IN (${inList(bookings)})`, bookings);
  }
  await q(`DELETE FROM turfs WHERE id IN (${inList(turfs)})`, turfs);
  await q("DELETE FROM users WHERE email LIKE 'zz_nt_%'");
  await q("DELETE FROM owners WHERE email LIKE 'zz_nt_%'");
  const [l] = await q("SELECT (SELECT COUNT(*) FROM users WHERE email LIKE 'zz_nt_%') u,(SELECT COUNT(*) FROM owners WHERE email LIKE 'zz_nt_%') o,(SELECT COUNT(*) FROM turfs WHERE name LIKE 'ZZ NT%') t,(SELECT COUNT(*) FROM subscription_plans WHERE name LIKE 'ZZ NT%') p,(SELECT COUNT(*) FROM bookings WHERE customer_name = 'ZZ NT') b");
  console.log('cleaned; leftovers:', JSON.stringify(l), `(removed ${users.length} users, ${owners.length} owners, ${turfs.length} turfs)`);
  process.exit(0);
})().catch((e) => { console.log('cleanup error:', e.message); process.exit(1); });
