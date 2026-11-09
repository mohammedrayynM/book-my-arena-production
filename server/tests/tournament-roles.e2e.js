// Role-isolation + lifecycle regression test for tournament hosting (user / owner / admin).
// Needs the API running on localhost:9000 and the DB configured in server/.env. It creates its own
// tournaments (prefixed "RT ") and deletes everything it created before exiting.
// Run from the server folder:  node tests/tournament-roles.e2e.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const jwt = require('jsonwebtoken');
const axios = require('axios');
const pool = require('../config/db');

const BASE = 'http://localhost:9000/api';
const S = process.env.JWT_SECRET;
const results = [];
const check = (name, cond, extra) => { results.push(!!cond); console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond ? '' : ' :: ' + JSON.stringify(extra))); };
const call = async (method, url, token, data) => {
  try {
    const r = await axios({ method, url: BASE + url, data, headers: token ? { Authorization: 'Bearer ' + token } : {}, validateStatus: () => true });
    return { status: r.status, data: r.data };
  } catch (e) { return { status: 0, data: { error: e.message } }; }
};

(async () => {
  const created = [];
  try {
    const [[admin]] = await pool.query('SELECT id FROM admins LIMIT 1');
    const [[user]] = await pool.query('SELECT id, name FROM users WHERE id = 30001');
    const [[owner]] = await pool.query('SELECT id, name FROM owners WHERE id = 30001');
    console.log('admin id', admin.id, '| user', user.id, user.name, '| owner', owner.id, owner.name, '(same id on purpose)');

    const userTok = jwt.sign({ id: user.id, email: 'u@test' }, S, { expiresIn: '1h' });               // no role claim, like real user tokens
    const ownerTok = jwt.sign({ id: owner.id, email: 'o@test', role: 'owner' }, S, { expiresIn: '1h' });
    const adminTok = jwt.sign({ id: admin.id, username: 'admin', role: 'admin' }, S, { expiresIn: '1h' });
    const base = { sport: 'Football', venue: 'V', location: 'L', start_date: '2026-12-01', end_date: '2026-12-02', max_teams: 8, entry_fee: 0, format_type: 'Knockout' };

    // --- create as each role
    const gu = await call('post', '/tournaments', null, { ...base, name: 'guest' });
    check('guest cannot create tournament (401)', gu.status === 401, gu);
    const cu = await call('post', '/tournaments', userTok, { ...base, name: 'RT User Cup' });
    check('USER can create a tournament', cu.data.success, cu);
    const co = await call('post', '/tournaments', ownerTok, { ...base, name: 'RT Owner Cup' });
    check('OWNER can create a tournament', co.data.success, co);
    const ca = await call('post', '/tournaments', adminTok, { ...base, name: 'RT Admin Cup' });
    check('ADMIN can create a tournament', ca.data.success, ca);
    const uId = cu.data.tournament_id, oId = co.data.tournament_id, aId = ca.data.tournament_id;
    created.push(uId, oId, aId);

    const [rows] = await pool.query('SELECT id, owner_id, owner_type FROM tournaments WHERE id IN (?, ?, ?)', [uId, oId, aId]);
    const typeOf = id => rows.find(r => r.id === id)?.owner_type;
    check('owner_type stored: user/owner/admin', typeOf(uId) === 'user' && typeOf(oId) === 'owner' && typeOf(aId) === 'admin', rows);

    // --- isolation: "My Tournaments"
    const mineU = (await call('get', '/tournaments/host/mine', userTok)).data.tournaments.map(t => t.id);
    const mineO = (await call('get', '/tournaments/host/mine', ownerTok)).data.tournaments.map(t => t.id);
    const mineA = (await call('get', '/tournaments/host/mine', adminTok)).data.tournaments.map(t => t.id);
    check('user My Tournaments = only user-hosted (despite id clash with owner)', mineU.includes(uId) && !mineU.includes(oId) && !mineU.includes(aId), mineU);
    check('owner My Tournaments = only owner-hosted', mineO.includes(oId) && !mineO.includes(uId), mineO);
    check('admin My Tournaments = only admin-hosted', mineA.includes(aId) && !mineA.includes(uId) && !mineA.includes(oId), mineA);
    const ownerLegacy = (await call('get', '/owners/tournaments', ownerTok)).data.tournaments.map(t => t.id);
    check('legacy /owners/tournaments excludes user-hosted', ownerLegacy.includes(oId) && !ownerLegacy.includes(uId), ownerLegacy);

    // --- manage screen loader: host/:id
    check('user loads own tournament', (await call('get', `/tournaments/host/${uId}`, userTok)).status === 200);
    check('owner (same id 30001) CANNOT load the user\'s tournament', (await call('get', `/tournaments/host/${uId}`, ownerTok)).status === 404);
    check('user CANNOT load the owner\'s tournament', (await call('get', `/tournaments/host/${oId}`, userTok)).status === 404);
    check('admin can load any tournament', (await call('get', `/tournaments/host/${uId}`, adminTok)).status === 200 && (await call('get', `/tournaments/host/${oId}`, adminTok)).status === 200);

    // --- manage: teams
    check('owner CANNOT add team to user tournament', (await call('post', `/tournaments/${uId}/teams`, ownerTok, { name: 'X' })).status === 403);
    const t1 = await call('post', `/tournaments/${uId}/teams`, userTok, { name: 'Alpha' });
    const t2 = await call('post', `/tournaments/${uId}/teams`, userTok, { name: 'Beta' });
    check('user adds teams to own tournament', t1.data.success && t2.data.success, [t1.data, t2.data]);
    const t3 = await call('post', `/tournaments/${uId}/teams`, adminTok, { name: 'Gamma' });
    check('admin adds team to a user tournament', t3.data.success, t3.data);
    check('teams list OK (GROUP BY fix)', (await call('get', `/tournaments/${uId}/teams`)).data.teams?.length === 3);
    check('user CANNOT add team to owner tournament', (await call('post', `/tournaments/${oId}/teams`, userTok, { name: 'Y' })).status === 403);

    // --- previously-unprotected endpoints (any owner could hit any tournament)
    check('announcement on someone else\'s tournament blocked', (await call('post', `/tournaments/${uId}/announcements`, ownerTok, { title: 't', content: 'c' })).status === 403);
    check('stream on someone else\'s tournament blocked', (await call('post', `/tournaments/${uId}/streams`, ownerTok, { youtube_url: 'https://youtu.be/abc123' })).status === 403);
    check('own announcement works', (await call('post', `/tournaments/${uId}/announcements`, userTok, { title: 'Hi', content: 'Welcome' })).data.success);

    // --- edit + status
    check('owner CANNOT edit user tournament', (await call('put', `/tournaments/${uId}`, ownerTok, { name: 'hacked' })).status === 403);
    const ed = await call('put', `/tournaments/${uId}`, userTok, { name: 'RT User Cup EDITED', max_teams: 6, entry_fee: 100, description: 'edited' });
    check('user edits own tournament', ed.data.success, ed);
    const [[after]] = await pool.query('SELECT name, max_teams, entry_fee FROM tournaments WHERE id = ?', [uId]);
    check('edit persisted', after.name === 'RT User Cup EDITED' && after.max_teams === 6 && Number(after.entry_fee) === 100, after);
    check('invalid status rejected', (await call('patch', `/tournaments/${uId}/status`, userTok, { status: 'BOGUS' })).status === 400);
    check('user closes registration', (await call('patch', `/tournaments/${uId}/status`, userTok, { status: 'REGISTRATION_CLOSED' })).data.success);
    check('owner CANNOT change user tournament status', (await call('patch', `/tournaments/${uId}/status`, ownerTok, { status: 'LIVE' })).status === 403);

    // --- fixtures + live scoring + auto status (uses a 2-team tournament -> single Final)
    const u2 = (await call('post', '/tournaments', userTok, { ...base, name: 'RT User Final Cup' })).data.tournament_id; created.push(u2);
    await call('post', `/tournaments/${u2}/teams`, userTok, { name: 'Red' });
    await call('post', `/tournaments/${u2}/teams`, userTok, { name: 'Blue' });
    check('owner CANNOT generate fixtures for user tournament', (await call('post', `/tournaments/${u2}/fixtures/generate`, ownerTok, {})).status === 403);
    check('user generates fixtures', (await call('post', `/tournaments/${u2}/fixtures/generate`, userTok, {})).data.success);
    const fx = (await call('get', `/tournaments/${u2}/fixtures`)).data.fixtures;
    const m = fx[0];
    check('fixture has both teams', m && m.team_a_id && m.team_b_id, fx);
    check('owner CANNOT start user match', (await call('post', `/tournament-matches/${m.id}/status`, ownerTok, { status: 'LIVE' })).status === 403);
    check('owner CANNOT score user match', (await call('post', `/tournament-matches/${m.id}/events`, ownerTok, { event_type: 'GOAL', team_id: m.team_a_id, value: 1 })).status === 403);
    check('user starts match LIVE', (await call('post', `/tournament-matches/${m.id}/status`, userTok, { status: 'LIVE' })).data.success);
    let [[ts]] = await pool.query('SELECT status FROM tournaments WHERE id = ?', [u2]);
    check('tournament auto-moves to LIVE when a match starts', ts.status === 'LIVE', ts);
    check('user scores a goal', (await call('post', `/tournament-matches/${m.id}/events`, userTok, { event_type: 'GOAL', team_id: m.team_a_id, value: 1 })).data.team_a_score === 1);
    check('user finishes match', (await call('post', `/tournament-matches/${m.id}/status`, userTok, { status: 'FINISHED' })).data.success);
    [[ts]] = await pool.query('SELECT status FROM tournaments WHERE id = ?', [u2]);
    check('tournament auto-moves to COMPLETED when the last match ends', ts.status === 'COMPLETED', ts);
    const res2 = (await call('get', `/tournaments/${u2}/results`)).data;
    check('results endpoint reports the champion', res2.champion === 'Red', res2);

    // --- analytics + registrations
    check('user analytics OK', (await call('get', `/tournaments/${uId}/analytics`, userTok)).data.analytics?.teams === 3);
    check('owner CANNOT read user analytics', (await call('get', `/tournaments/${uId}/analytics`, ownerTok)).status === 403);
    check('user registrations list OK', (await call('get', `/tournaments/${uId}/registrations`, userTok)).status === 200);
    check('admin analytics OK', (await call('get', `/tournaments/${uId}/analytics`, adminTok)).status === 200);

    // --- host names everywhere
    const detail = (await call('get', `/tournaments/${uId}`)).data.tournament;
    check('public page host_name = the user\'s name', detail.host_name === user.name, detail.host_name);
    const adminDetail = (await call('get', `/tournaments/${aId}`)).data.tournament;
    check('admin-hosted tournament shows "Book Arena" as host', adminDetail.host_name === 'Book Arena', adminDetail.host_name);
    const adminList = (await call('get', '/admin-tournaments', adminTok)).data.tournaments;
    const names = Object.fromEntries(adminList.filter(t => created.includes(t.id)).map(t => [t.id, t.owner_name]));
    check('admin list shows host for user/owner/admin tournaments', names[uId] === user.name && names[oId] === owner.name && names[aId] === 'Book Arena', names);
    const pub = (await call('get', '/tournaments?search=RT')).data.tournaments;
    check('public discovery lists hosted tournaments with host_name', pub.length > 0 && pub.every(t => t.host_name), pub.map(t => t.host_name));
  } catch (e) {
    console.error('SCRIPT ERROR', e.response ? JSON.stringify(e.response.data) : e);
  } finally {
    for (const id of created) {
      await pool.query('DELETE FROM tournament_match_events WHERE match_id IN (SELECT id FROM tournament_fixtures WHERE tournament_id = ?)', [id]);
      for (const t of ['tournament_fixtures', 'tournament_announcements', 'tournament_streams', 'tournament_sponsors', 'tournament_registrations', 'tournament_participants', 'tournament_join_requests', 'tournament_teams', 'tournament_audit_logs'])
        await pool.query('DELETE FROM ' + t + ' WHERE tournament_id = ?', [id]);
      await pool.query('DELETE FROM tournaments WHERE id = ?', [id]);
    }
    console.log('--- cleaned up tournaments', created.join(', '));
    console.log('=== ' + results.filter(Boolean).length + '/' + results.length + ' checks passed ===');
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
