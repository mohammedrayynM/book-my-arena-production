// Request G: rosters built player by player, open registration from an invite link, the organizer's approval
// dashboard, and a full cricket match scored through the real API against a throwaway database.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';
const fakePath = require.resolve('razorpay');
class FakeRazorpay { constructor() { this.orders = { create: async () => ({ id: 'order_sq' }) }; this.payments = { fetch: async () => null }; } }
require.cache[fakePath] = { id: fakePath, filename: fakePath, loaded: true, exports: FakeRazorpay };

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('./helpers/testDb');

let app;
const q = (s, p) => db.pool.query(s, p);
const qq = (s, p) => db.pool.query(s, p).catch(() => {});
const SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';
const tok = (id) => ({ Authorization: `Bearer ${jwt.sign({ id, email: 'u@x.test' }, SECRET)}` });
const U = {};
const DATES = { start_date: '2099-03-01', end_date: '2099-03-02' };

test.before(async () => {
  await db.setup();
  await qq('CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), email VARCHAR(150), karma_points INT DEFAULT 0, phone VARCHAR(20) NULL)');
  await require('../migrate_tournaments')();
  for (const m of ['migrate_tournament_host_type', 'migrate_tournament_venue', 'migrate_tournament_analytics',
    'migrate_live_match', 'migrate_sponsors', 'migrate_tournament_registrations', 'migrate_tournament_plans',
    'migrate_tournament_config', 'migrate_tournament_squads']) await require(`../${m}`)();

  app = express();
  app.use(express.json());
  app.use('/api/tournaments', require('../routes/tournaments'));
  app.use('/api/tournaments', require('../routes/tournament-management'));
  app.use('/api/tournaments', require('../routes/tournament-live'));
  app.use('/api/tournament-matches', require('../routes/tournament-matches'));
});

test.beforeEach(async () => {
  for (const t of ['tournament_registration_requests', 'tournament_match_events', 'tournament_fixtures',
    'tournament_participants', 'tournament_teams', 'tournaments', 'users']) await qq(`DELETE FROM ${t}`);
  await q('UPDATE tournament_settings SET fee_amount = 0, is_active = 1, creation_enabled = 1, max_duration_days = 60');
  const [h] = await q('INSERT INTO users (name, email) VALUES (?, ?)', ['Host', 'host@x.test']); U.host = h.insertId;
  const [o] = await q('INSERT INTO users (name, email) VALUES (?, ?)', ['Outsider', 'out@x.test']); U.outsider = o.insertId;
});
test.after(async () => { await db.pool.end(); });

const makeTournament = (extra = {}) => request(app).post('/api/tournaments').set(tok(U.host))
  .send({ name: 'Club Cup', sport: 'Cricket', format_type: 'Knockout', ...DATES, players_per_team: 11, substitute_limit: 2, max_teams: 4, ...extra });
const addTeam = (id, name) => request(app).post(`/api/tournaments/${id}/teams`).set(tok(U.host)).send({ name });
const addMember = (id, teamId, body) => request(app).post(`/api/tournaments/${id}/teams/${teamId}/members`).set(tok(U.host)).send(body);
const tokenOf = async (id) => (await q('SELECT join_token FROM tournaments WHERE id = ?', [id]))[0][0].join_token;

// ───────────────────────────── 1. building a roster ─────────────────────────────
test('the organizer adds players one by one, with no Book Arena account needed', async () => {
  const t = (await makeTournament()).body.tournament_id;
  const team = (await addTeam(t, 'Chennai Titans')).body.team_id;

  const res = await addMember(t, team, {
    player_name: 'Rayyan', phone: '9876543210', player_role: 'ALL_ROUNDER',
    batting_style: 'RIGHT', bowling_style: 'RIGHT_ARM_FAST', is_captain: true,
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.member_id);

  const [[row]] = await q('SELECT * FROM tournament_participants WHERE id = ?', [res.body.member_id]);
  assert.equal(row.player_name, 'Rayyan');
  assert.equal(row.user_id, null, 'a roster player needs no account');
  assert.equal(row.phone, '9876543210');
  assert.equal(row.player_role, 'ALL_ROUNDER');
  assert.equal(row.batting_style, 'RIGHT');
  assert.equal(row.bowling_style, 'RIGHT_ARM_FAST');
  assert.equal(row.is_captain, 1);
  assert.equal(row.status, 'APPROVED');
});

test('team roles follow the tournament sport instead of applying cricket roles everywhere', async () => {
  const t = (await makeTournament({ sport: 'Football' })).body.tournament_id;
  const team = (await addTeam(t, 'City FC')).body.team_id;
  const keeper = await addMember(t, team, { player_name: 'Keeper', player_role: 'GOALKEEPER', batting_style: 'RIGHT' });
  const batter = await addMember(t, team, { player_name: 'Forward', player_role: 'BATTER' });
  assert.equal(keeper.status, 200);
  assert.equal(batter.status, 200);

  const [rows] = await q('SELECT player_name, player_role, batting_style FROM tournament_participants WHERE team_id = ? ORDER BY id', [team]);
  assert.deepEqual(rows.map((r) => [r.player_name, r.player_role, r.batting_style]), [
    ['Keeper', 'GOALKEEPER', 'UNSPECIFIED'],
    ['Forward', 'PLAYER', 'UNSPECIFIED'],
  ]);
});

test('the roster reads back with every player, including those with no account', async () => {
  const t = (await makeTournament()).body.tournament_id;
  const team = (await addTeam(t, 'Titans')).body.team_id;
  for (const n of ['Rayyan', 'Hamdan', 'Vikram']) await addMember(t, team, { player_name: n });

  const res = await request(app).get(`/api/tournaments/${t}/teams/${team}/members`).set(tok(U.host));
  assert.equal(res.status, 200);
  assert.equal(res.body.members.length, 3);
  assert.deepEqual(res.body.members.map((m) => m.display_name), ['Rayyan', 'Hamdan', 'Vikram']);
  assert.equal(res.body.limits.players_per_team, 11);

  // the participants list must show them too — this is where the INNER JOIN used to hide them
  const list = await request(app).get(`/api/tournaments/${t}/participants`).set(tok(U.host));
  assert.equal(list.body.participants.length, 3);
});

test('a player name is required and the same player cannot be added twice', async () => {
  const t = (await makeTournament()).body.tournament_id;
  const team = (await addTeam(t, 'Titans')).body.team_id;
  assert.equal((await addMember(t, team, {})).status, 400);
  assert.equal((await addMember(t, team, { player_name: '   ' })).status, 400);
  assert.equal((await addMember(t, team, { player_name: 'Rayyan' })).status, 200);
  const dupe = await addMember(t, team, { player_name: 'rayyan' });
  assert.equal(dupe.status, 400);
  assert.match(dupe.body.error, /already in this team/);
});

test('a bad phone number is refused, and a blank one is fine', async () => {
  const t = (await makeTournament()).body.tournament_id;
  const team = (await addTeam(t, 'Titans')).body.team_id;
  const bad = await addMember(t, team, { player_name: 'Rayyan', phone: '123' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /valid phone/);
  assert.equal((await addMember(t, team, { player_name: 'Rayyan', phone: '' })).status, 200);
});

test('two players in a team cannot share a phone number', async () => {
  const t = (await makeTournament()).body.tournament_id;
  const team = (await addTeam(t, 'Titans')).body.team_id;
  await addMember(t, team, { player_name: 'Rayyan', phone: '9876543210' });
  const clash = await addMember(t, team, { player_name: 'Hamdan', phone: '98765 43210' });
  assert.equal(clash.status, 400);
  assert.match(clash.body.error, /phone number is already/);
});

test('the squad size and substitute limits come from the tournament', async () => {
  const t = (await makeTournament({ players_per_team: 2, substitute_limit: 1 })).body.tournament_id;
  const team = (await addTeam(t, 'Titans')).body.team_id;
  assert.equal((await addMember(t, team, { player_name: 'One' })).status, 200);
  assert.equal((await addMember(t, team, { player_name: 'Two' })).status, 200);
  const third = await addMember(t, team, { player_name: 'Three' });
  assert.equal(third.status, 400);
  assert.match(third.body.error, /already has its 2 players/);

  assert.equal((await addMember(t, team, { player_name: 'Sub One', is_substitute: true })).status, 200);
  const secondSub = await addMember(t, team, { player_name: 'Sub Two', is_substitute: true });
  assert.equal(secondSub.status, 400);
  assert.match(secondSub.body.error, /At most 1 substitute is allowed/);
});

test('only one captain and one vice-captain per team', async () => {
  const t = (await makeTournament()).body.tournament_id;
  const team = (await addTeam(t, 'Titans')).body.team_id;
  await addMember(t, team, { player_name: 'Rayyan', is_captain: true });
  await addMember(t, team, { player_name: 'Hamdan', is_captain: true });
  const [rows] = await q('SELECT player_name, is_captain FROM tournament_participants WHERE team_id = ? ORDER BY id', [team]);
  assert.equal(rows.filter((r) => r.is_captain).length, 1);
  assert.equal(rows.find((r) => r.is_captain).player_name, 'Hamdan');
});

test('a player can be edited and removed, and only by the host', async () => {
  const t = (await makeTournament()).body.tournament_id;
  const team = (await addTeam(t, 'Titans')).body.team_id;
  const memberId = (await addMember(t, team, { player_name: 'Rayyan' })).body.member_id;

  const stranger = await request(app).patch(`/api/tournaments/${t}/teams/${team}/members/${memberId}`).set(tok(U.outsider)).send({ player_name: 'Hacked' });
  assert.equal(stranger.status, 404);

  const edit = await request(app).patch(`/api/tournaments/${t}/teams/${team}/members/${memberId}`).set(tok(U.host))
    .send({ player_name: 'Rayyan Khan', player_role: 'WICKETKEEPER', batting_style: 'LEFT' });
  assert.equal(edit.status, 200);
  const [[after]] = await q('SELECT * FROM tournament_participants WHERE id = ?', [memberId]);
  assert.equal(after.player_name, 'Rayyan Khan');
  assert.equal(after.player_role, 'WICKETKEEPER');
  assert.equal(after.batting_style, 'LEFT');

  assert.equal((await request(app).delete(`/api/tournaments/${t}/teams/${team}/members/${memberId}`).set(tok(U.outsider))).status, 404);
  assert.equal((await request(app).delete(`/api/tournaments/${t}/teams/${team}/members/${memberId}`).set(tok(U.host))).status, 200);
  const [[gone]] = await q('SELECT COUNT(*) AS n FROM tournament_participants WHERE id = ?', [memberId]);
  assert.equal(gone.n, 0);
});

test('the public squads endpoint shows rosters but never phone numbers', async () => {
  const t = (await makeTournament()).body.tournament_id;
  const team = (await addTeam(t, 'Titans')).body.team_id;
  await addMember(t, team, { player_name: 'Rayyan', phone: '9876543210' });
  const res = await request(app).get(`/api/tournaments/${t}/squads`);
  assert.equal(res.status, 200);
  assert.equal(res.body.teams[0].players[0].name, 'Rayyan');
  assert.ok(!JSON.stringify(res.body).includes('9876543210'), 'a public endpoint must not leak phone numbers');
});

// ───────────────────────────── 2. open registration ─────────────────────────────
const openTournament = async (extra = {}) => {
  const t = (await makeTournament({ open_registration: true, ...extra })).body.tournament_id;
  return { id: t, token: await tokenOf(t) };
};
const registerTeam = (token, body) => request(app).post(`/api/tournaments/join/${token}/register-team`).send(body);
const registerPlayer = (token, body) => request(app).post(`/api/tournaments/join/${token}/register-player`).send(body);

test('the invite says whether outsiders may register, and how', async () => {
  const open = await openTournament();
  const res = await request(app).get(`/api/tournaments/join/${open.token}`);
  assert.equal(res.body.tournament.open_registration, true);
  assert.equal(res.body.tournament.allow_team_registration, true);
  assert.equal(res.body.tournament.allow_individual_registration, true);
});

test('an unknown team registers through the link, with its whole roster, and waits for approval', async () => {
  const open = await openTournament();
  const res = await registerTeam(open.token, {
    team_name: 'Ambur Titans', captain_name: 'Hamdan', contact_phone: '9876543210', city: 'Ambur',
    roster: [
      { player_name: 'Hamdan', player_role: 'ALL_ROUNDER', batting_style: 'RIGHT', is_captain: true },
      { player_name: 'Vikram', player_role: 'BOWLER', bowling_style: 'LEFT_ARM_FAST' },
      { player_name: 'Sameer', player_role: 'WICKETKEEPER', is_substitute: true },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'PENDING');

  const [[row]] = await q('SELECT * FROM tournament_registration_requests WHERE id = ?', [res.body.request_id]);
  assert.equal(row.kind, 'TEAM');
  assert.equal(row.team_name, 'Ambur Titans');
  assert.equal(row.status, 'PENDING');
  assert.equal(JSON.parse(row.roster).length, 3);

  // nothing is in the tournament yet
  const [[teams]] = await q('SELECT COUNT(*) AS n FROM tournament_teams WHERE tournament_id = ?', [open.id]);
  assert.equal(teams.n, 0, 'a request must not join the tournament by itself');
});

test('an individual player registers without an account', async () => {
  const open = await openTournament();
  const res = await registerPlayer(open.token, {
    player_name: 'Rayyan', contact_phone: '9876543210', city: 'Chennai',
    player_role: 'BATTER', batting_style: 'RIGHT', experience: '5 years club cricket',
  });
  assert.equal(res.status, 200);
  const [[row]] = await q('SELECT * FROM tournament_registration_requests WHERE id = ?', [res.body.request_id]);
  assert.equal(row.kind, 'INDIVIDUAL');
  assert.equal(row.player_name, 'Rayyan');
  assert.equal(row.player_role, 'BATTER');
  assert.equal(row.status, 'PENDING');
});

test('registration is refused when the organizer has not opened it', async () => {
  const t = (await makeTournament()).body.tournament_id;           // open_registration defaults to off
  const token = await tokenOf(t);
  const res = await registerTeam(token, { team_name: 'Nope', captain_name: 'X', contact_phone: '9876543210' });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /not accepting outside registrations/);
});

test('only the registration kinds the organizer enabled are accepted', async () => {
  const teamsOnly = await openTournament({ allow_individual_registration: false });
  const solo = await registerPlayer(teamsOnly.token, { player_name: 'Rayyan', contact_phone: '9876543210' });
  assert.equal(solo.status, 403);
  assert.match(solo.body.error, /only accepts full teams/);

  const soloOnly = await openTournament({ name: 'Solo Cup', allow_team_registration: false });
  const team = await registerTeam(soloOnly.token, { team_name: 'Titans', captain_name: 'H', contact_phone: '9876543210' });
  assert.equal(team.status, 403);
  assert.match(team.body.error, /only accepts individual players/);
});

test('registration validates its fields', async () => {
  const open = await openTournament();
  assert.match((await registerTeam(open.token, { captain_name: 'H', contact_phone: '9876543210' })).body.error, /Team name is required/);
  assert.match((await registerTeam(open.token, { team_name: 'T', contact_phone: '9876543210' })).body.error, /captain's name is required/);
  assert.match((await registerTeam(open.token, { team_name: 'T', captain_name: 'H' })).body.error, /contact number is required/);
  assert.match((await registerTeam(open.token, { team_name: 'T', captain_name: 'H', contact_phone: '12' })).body.error, /valid contact number/);
  assert.match((await registerTeam(open.token, { team_name: 'T', captain_name: 'H', contact_phone: '9876543210', roster: [{ player_name: '' }] })).body.error, /needs a name/);
  assert.match((await registerPlayer(open.token, { contact_phone: '9876543210' })).body.error, /name is required/);
});

test('a roster larger than the squad limit is refused at registration', async () => {
  const open = await openTournament({ players_per_team: 2, substitute_limit: 0 });
  const res = await registerTeam(open.token, {
    team_name: 'Big Squad', captain_name: 'H', contact_phone: '9876543210',
    roster: [{ player_name: 'A' }, { player_name: 'B' }, { player_name: 'C' }],
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at most 2 players/);
});

test('the same team name cannot be submitted twice', async () => {
  const open = await openTournament();
  const body = { team_name: 'Titans', captain_name: 'H', contact_phone: '9876543210' };
  assert.equal((await registerTeam(open.token, body)).status, 200);
  const again = await registerTeam(open.token, body);
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already been submitted/);
});

test('an expired, cancelled or closed tournament accepts nothing', async () => {
  for (const [sql, re] of [
    ["UPDATE tournaments SET status = 'CANCELLED' WHERE id = ?", /cancelled/i],
    ["UPDATE tournaments SET status = 'COMPLETED' WHERE id = ?", /finished/i],
    ["UPDATE tournaments SET reg_close_date = '2000-01-01' WHERE id = ?", /deadline/i],
    ['UPDATE tournaments SET join_link_active = false WHERE id = ?', /turned this invitation link off/i],
  ]) {
    const open = await openTournament({ name: `Cup ${Math.random()}` });
    await q(sql, [open.id]);
    const res = await registerTeam(open.token, { team_name: 'T', captain_name: 'H', contact_phone: '9876543210' });
    assert.ok(res.status >= 400, sql);
    assert.match(res.body.error, re);
  }
});

// ───────────────────────────── 3. the approval dashboard ─────────────────────────────
test('the host sees pending requests with the full roster and contact details', async () => {
  const open = await openTournament();
  await registerTeam(open.token, {
    team_name: 'Ambur Titans', captain_name: 'Hamdan', contact_phone: '9876543210',
    roster: [{ player_name: 'Hamdan', is_captain: true }, { player_name: 'Vikram' }],
  });
  await registerPlayer(open.token, { player_name: 'Rayyan', contact_phone: '9000000001', player_role: 'BATTER' });

  const res = await request(app).get(`/api/tournaments/${open.id}/registration-requests`).set(tok(U.host));
  assert.equal(res.status, 200);
  assert.equal(res.body.counts.pending, 2);
  const team = res.body.requests.find((r) => r.kind === 'TEAM');
  assert.equal(team.team_name, 'Ambur Titans');
  assert.equal(team.contact_phone, '9876543210', 'the organizer is entitled to the contact number');
  assert.equal(team.roster.length, 2);
  assert.ok(res.body.requests.find((r) => r.kind === 'INDIVIDUAL').player_name === 'Rayyan');
});

test('a stranger can neither see nor decide registration requests', async () => {
  const open = await openTournament();
  const made = await registerTeam(open.token, { team_name: 'T', captain_name: 'H', contact_phone: '9876543210' });
  assert.equal((await request(app).get(`/api/tournaments/${open.id}/registration-requests`).set(tok(U.outsider))).status, 404);
  const decide = await request(app).patch(`/api/tournaments/${open.id}/registration-requests/${made.body.request_id}`).set(tok(U.outsider)).send({ status: 'APPROVED' });
  assert.equal(decide.status, 404);
});

test('approving a team creates it with its whole roster', async () => {
  const open = await openTournament();
  const made = await registerTeam(open.token, {
    team_name: 'Ambur Titans', captain_name: 'Hamdan', contact_phone: '9876543210',
    roster: [
      { player_name: 'Hamdan', player_role: 'ALL_ROUNDER', is_captain: true },
      { player_name: 'Vikram', player_role: 'BOWLER' },
      { player_name: 'Sameer', is_substitute: true },
    ],
  });
  const res = await request(app).patch(`/api/tournaments/${open.id}/registration-requests/${made.body.request_id}`).set(tok(U.host)).send({ status: 'APPROVED' });
  assert.equal(res.status, 200);
  assert.ok(res.body.team_id);

  const [[team]] = await q('SELECT * FROM tournament_teams WHERE id = ?', [res.body.team_id]);
  assert.equal(team.name, 'Ambur Titans');
  const [players] = await q('SELECT * FROM tournament_participants WHERE team_id = ? ORDER BY id', [res.body.team_id]);
  assert.equal(players.length, 3);
  assert.deepEqual(players.map((p) => p.player_name), ['Hamdan', 'Vikram', 'Sameer']);
  assert.equal(players[0].is_captain, 1);
  assert.equal(players[2].is_substitute, 1);
  assert.equal(players.every((p) => p.status === 'APPROVED'), true);
});

test('the captain is added as a player even when the roster left them out', async () => {
  const open = await openTournament();
  const made = await registerTeam(open.token, {
    team_name: 'Titans', captain_name: 'Hamdan', contact_phone: '9876543210',
    roster: [{ player_name: 'Vikram' }],
  });
  const res = await request(app).patch(`/api/tournaments/${open.id}/registration-requests/${made.body.request_id}`).set(tok(U.host)).send({ status: 'APPROVED' });
  const [players] = await q('SELECT player_name, is_captain FROM tournament_participants WHERE team_id = ? ORDER BY id', [res.body.team_id]);
  assert.deepEqual(players.map((p) => p.player_name), ['Hamdan', 'Vikram']);
  assert.equal(players[0].is_captain, 1);
});

test('approving an individual puts them in the player pool with no team', async () => {
  const open = await openTournament();
  const made = await registerPlayer(open.token, { player_name: 'Rayyan', contact_phone: '9876543210', player_role: 'BATTER', batting_style: 'LEFT' });
  const res = await request(app).patch(`/api/tournaments/${open.id}/registration-requests/${made.body.request_id}`).set(tok(U.host)).send({ status: 'APPROVED' });
  assert.equal(res.status, 200);
  const [[p]] = await q('SELECT * FROM tournament_participants WHERE id = ?', [res.body.participant_id]);
  assert.equal(p.player_name, 'Rayyan');
  assert.equal(p.team_id, null, 'an individual is not given a team of their own');
  assert.equal(p.batting_style, 'LEFT');
  const [[teams]] = await q('SELECT COUNT(*) AS n FROM tournament_teams WHERE tournament_id = ?', [open.id]);
  assert.equal(teams.n, 0);
});

test('rejecting keeps the record and the reason, and adds nobody', async () => {
  const open = await openTournament();
  const made = await registerTeam(open.token, { team_name: 'Titans', captain_name: 'H', contact_phone: '9876543210' });
  const res = await request(app).patch(`/api/tournaments/${open.id}/registration-requests/${made.body.request_id}`).set(tok(U.host))
    .send({ status: 'REJECTED', reason: 'Squad list incomplete' });
  assert.equal(res.status, 200);
  const [[row]] = await q('SELECT * FROM tournament_registration_requests WHERE id = ?', [made.body.request_id]);
  assert.equal(row.status, 'REJECTED');
  assert.equal(row.decision_reason, 'Squad list incomplete');
  assert.ok(row.decided_at);
  const [[teams]] = await q('SELECT COUNT(*) AS n FROM tournament_teams WHERE tournament_id = ?', [open.id]);
  assert.equal(teams.n, 0);
});

test('a request can be waitlisted and approved later', async () => {
  const open = await openTournament();
  const made = await registerTeam(open.token, { team_name: 'Titans', captain_name: 'H', contact_phone: '9876543210' });
  const url = `/api/tournaments/${open.id}/registration-requests/${made.body.request_id}`;
  assert.equal((await request(app).patch(url).set(tok(U.host)).send({ status: 'WAITLISTED' })).status, 200);
  const res = await request(app).patch(url).set(tok(U.host)).send({ status: 'APPROVED' });
  assert.equal(res.status, 200);
  assert.ok(res.body.team_id);
});

test('approving twice does not create the team twice', async () => {
  const open = await openTournament();
  const made = await registerTeam(open.token, { team_name: 'Titans', captain_name: 'H', contact_phone: '9876543210' });
  const url = `/api/tournaments/${open.id}/registration-requests/${made.body.request_id}`;
  const first = await request(app).patch(url).set(tok(U.host)).send({ status: 'APPROVED' });
  const second = await request(app).patch(url).set(tok(U.host)).send({ status: 'APPROVED' });
  assert.equal(first.status, 200);
  assert.equal(second.body.unchanged, true);
  const [[teams]] = await q('SELECT COUNT(*) AS n FROM tournament_teams WHERE tournament_id = ?', [open.id]);
  assert.equal(teams.n, 1);
});

test('an approved team cannot be quietly rejected afterwards', async () => {
  const open = await openTournament();
  const made = await registerTeam(open.token, { team_name: 'Titans', captain_name: 'H', contact_phone: '9876543210' });
  const url = `/api/tournaments/${open.id}/registration-requests/${made.body.request_id}`;
  await request(app).patch(url).set(tok(U.host)).send({ status: 'APPROVED' });
  const res = await request(app).patch(url).set(tok(U.host)).send({ status: 'REJECTED' });
  assert.equal(res.status, 409);
});

test('a request submitted while there was room is refused once the places have gone', async () => {
  const open = await openTournament({ max_teams: 1 });
  // the request arrives while a place is still free...
  const made = await registerTeam(open.token, { team_name: 'Late Team', captain_name: 'H', contact_phone: '9876543210' });
  assert.equal(made.status, 200);
  // ...and the organizer fills the last place before deciding on it
  await addTeam(open.id, 'Existing Team');
  const res = await request(app).patch(`/api/tournaments/${open.id}/registration-requests/${made.body.request_id}`).set(tok(U.host)).send({ status: 'APPROVED' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /places are taken/);
});

test('a new request is refused outright when the tournament is already full', async () => {
  const open = await openTournament({ max_teams: 1 });
  await addTeam(open.id, 'Existing Team');
  const res = await registerTeam(open.token, { team_name: 'Late Team', captain_name: 'H', contact_phone: '9876543210' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /places are taken/);
});

test('a decision must be one of the three', async () => {
  const open = await openTournament();
  const made = await registerTeam(open.token, { team_name: 'T', captain_name: 'H', contact_phone: '9876543210' });
  const res = await request(app).patch(`/api/tournaments/${open.id}/registration-requests/${made.body.request_id}`).set(tok(U.host)).send({ status: 'MAYBE' });
  assert.equal(res.status, 400);
});
