// Request G: a full cricket match scored through the real API — team selection, batter and bowler selection,
// runs, extras, wickets, undo, and two matches running at once without their scores mixing.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';
const fakePath = require.resolve('razorpay');
class FakeRazorpay { constructor() { this.orders = { create: async () => ({ id: 'order_cm' }) }; this.payments = { fetch: async () => null }; } }
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

test.before(async () => {
  await db.setup();
  await qq('CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), email VARCHAR(150), karma_points INT DEFAULT 0, phone VARCHAR(20) NULL, profile_pic VARCHAR(500) NULL)');
  await require('../migrate_tournaments')();
  for (const m of ['migrate_tournament_host_type', 'migrate_tournament_venue', 'migrate_tournament_analytics',
    'migrate_live_match', 'migrate_sponsors', 'migrate_tournament_registrations', 'migrate_tournament_plans',
    'migrate_tournament_config', 'migrate_tournament_squads']) await require(`../${m}`)();
  app = express();
  app.use(express.json());
  app.use('/api/tournaments', require('../routes/tournaments'));
  app.use('/api/tournaments', require('../routes/tournament-management'));
  app.use('/api/tournament-matches', require('../routes/tournament-matches'));
});

test.beforeEach(async () => {
  for (const t of ['tournament_match_events', 'tournament_fixtures', 'tournament_participants',
    'tournament_teams', 'tournaments', 'users']) await qq(`DELETE FROM ${t}`);
  await q('UPDATE tournament_settings SET fee_amount = 0, is_active = 1, creation_enabled = 1, max_duration_days = 60');
  const [h] = await q('INSERT INTO users (name, email) VALUES (?, ?)', ['Host', 'host@x.test']); U.host = h.insertId;
  const [o] = await q('INSERT INTO users (name, email) VALUES (?, ?)', ['Outsider', 'out@x.test']); U.outsider = o.insertId;
});
test.after(async () => { await db.pool.end(); });

/** A cricket match with two full squads, live, ready to be set up. */
async function setUpMatch({ oversLimit = 2, name = 'Club Cup' } = {}) {
  const made = await request(app).post('/api/tournaments').set(tok(U.host))
    .send({ name, sport: 'Cricket', format_type: 'Knockout', start_date: '2099-03-01', end_date: '2099-03-02', max_teams: 2, players_per_team: 4, substitute_limit: 1 });
  const t = made.body.tournament_id;
  const teamA = (await request(app).post(`/api/tournaments/${t}/teams`).set(tok(U.host)).send({ name: `${name} Titans` })).body.team_id;
  const teamB = (await request(app).post(`/api/tournaments/${t}/teams`).set(tok(U.host)).send({ name: `${name} Kings` })).body.team_id;

  const ids = { A: {}, B: {} };
  for (const [label, team, names] of [['A', teamA, ['Rayyan', 'Hamdan', 'Vikram', 'Sameer']], ['B', teamB, ['Imran', 'Kabir', 'Noor', 'Zaid']]]) {
    for (const n of names) {
      const r = await request(app).post(`/api/tournaments/${t}/teams/${team}/members`).set(tok(U.host)).send({ player_name: n });
      ids[label][n] = r.body.member_id;
    }
  }
  await request(app).post(`/api/tournaments/${t}/fixtures/generate`).set(tok(U.host)).send({});
  const [[fx]] = await q('SELECT id FROM tournament_fixtures WHERE tournament_id = ?', [t]);
  await request(app).post(`/api/tournament-matches/${fx.id}/status`).set(tok(U.host)).send({ status: 'LIVE' });
  await request(app).post(`/api/tournament-matches/${fx.id}/innings`).set(tok(U.host))
    .send({ batting_team_id: teamA, bowling_team_id: teamB, overs_limit: oversLimit, innings: 1 });
  await request(app).post(`/api/tournament-matches/${fx.id}/players`).set(tok(U.host))
    .send({ striker_id: ids.A.Rayyan, non_striker_id: ids.A.Hamdan, bowler_id: ids.B.Imran });
  return { t, matchId: fx.id, teamA, teamB, ids };
}

const live = (matchId) => request(app).get(`/api/tournament-matches/${matchId}/live`);
const ball = (m, body) => request(app).post(`/api/tournament-matches/${m.matchId}/events`).set(tok(U.host))
  .send({ team_id: m.teamA, innings: 1, bowler_id: m.ids.B.Imran, non_striker_id: m.ids.A.Hamdan, ...body });

// ───────────────────────────── set-up ─────────────────────────────
test('the scorer picks the batting and bowling teams before the first ball', async () => {
  const m = await setUpMatch();
  const res = await live(m.matchId);
  assert.equal(res.status, 200);
  assert.equal(res.body.cricket.setup.batting_team_id, m.teamA);
  assert.equal(res.body.cricket.setup.bowling_team_id, m.teamB);
  assert.equal(res.body.cricket.setup.overs_limit, 2);
  assert.equal(res.body.cricket.setup.ready, true);
});

test('a team cannot bat and bowl at the same time', async () => {
  const m = await setUpMatch();
  const res = await request(app).post(`/api/tournament-matches/${m.matchId}/innings`).set(tok(U.host))
    .send({ batting_team_id: m.teamA, bowling_team_id: m.teamA, overs_limit: 2 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot bat and bowl/);
});

test('only the two teams playing the match can be chosen', async () => {
  const m = await setUpMatch();
  const other = await setUpMatch({ name: 'Other Cup' });
  const res = await request(app).post(`/api/tournament-matches/${m.matchId}/innings`).set(tok(U.host))
    .send({ batting_team_id: other.teamA, bowling_team_id: m.teamB });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /two teams playing this match/);
});

test('the striker and non-striker must be two different players from the batting side', async () => {
  const m = await setUpMatch();
  const same = await request(app).post(`/api/tournament-matches/${m.matchId}/players`).set(tok(U.host))
    .send({ striker_id: m.ids.A.Rayyan, non_striker_id: m.ids.A.Rayyan });
  assert.equal(same.status, 400);
  assert.match(same.body.error, /different players/);

  const wrongSide = await request(app).post(`/api/tournament-matches/${m.matchId}/players`).set(tok(U.host))
    .send({ striker_id: m.ids.B.Imran });
  assert.equal(wrongSide.status, 400);
  assert.match(wrongSide.body.error, /striker must be a player in the batting team/);
});

test('the bowler must come from the fielding side', async () => {
  const m = await setUpMatch();
  const res = await request(app).post(`/api/tournament-matches/${m.matchId}/players`).set(tok(U.host))
    .send({ bowler_id: m.ids.A.Vikram });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /bowler must be a player in the bowling team/);
});

test('a stranger cannot set up or score the match', async () => {
  const m = await setUpMatch();
  assert.equal((await request(app).post(`/api/tournament-matches/${m.matchId}/innings`).set(tok(U.outsider)).send({ batting_team_id: m.teamA, bowling_team_id: m.teamB })).status, 403);
  assert.equal((await request(app).post(`/api/tournament-matches/${m.matchId}/players`).set(tok(U.outsider)).send({ striker_id: m.ids.A.Rayyan })).status, 403);
  const score = await request(app).post(`/api/tournament-matches/${m.matchId}/events`).set(tok(U.outsider))
    .send({ team_id: m.teamA, event_type: 'RUN', value: 4, player_id: m.ids.A.Rayyan });
  assert.ok([403, 404].includes(score.status));
});

// ───────────────────────────── scoring through the API ─────────────────────────────
test('the live scoreboard names the batters and the bowler with their figures', async () => {
  const m = await setUpMatch();
  await ball(m, { event_type: 'RUN', value: 4, player_id: m.ids.A.Rayyan });
  await ball(m, { event_type: 'RUN', value: 2, player_id: m.ids.A.Rayyan });

  const c = (await live(m.matchId)).body.cricket;
  assert.equal(c.striker.name, 'Rayyan');
  assert.equal(c.striker.runs, 6);
  assert.equal(c.striker.balls, 2);
  assert.equal(c.striker.fours, 1);
  assert.equal(c.striker.strike_rate, 300);
  assert.equal(c.non_striker.name, 'Hamdan');
  assert.equal(c.bowler.name, 'Imran');
  assert.equal(c.bowler.overs, '0.2');
  assert.equal(c.bowler.runs, 6);
  assert.equal(c.current.runs, 6);
  assert.equal(c.current.overs, '0.2');
});

test('a single puts the other batter on strike, and the backend remembers it', async () => {
  const m = await setUpMatch();
  await ball(m, { event_type: 'RUN', value: 1, player_id: m.ids.A.Rayyan });
  const c = (await live(m.matchId)).body.cricket;
  assert.equal(c.striker.name, 'Hamdan');
  assert.equal(c.non_striker.name, 'Rayyan');
  const [[fx]] = await q('SELECT striker_id, non_striker_id FROM tournament_fixtures WHERE id = ?', [m.matchId]);
  assert.equal(fx.striker_id, m.ids.A.Hamdan, 'the fixture itself tracks who is on strike');
});

test('extras are counted the cricket way, end to end', async () => {
  const m = await setUpMatch();
  await ball(m, { event_type: 'WIDE', value: 1, player_id: m.ids.A.Rayyan });
  await ball(m, { event_type: 'NO_BALL', value: 5, player_id: m.ids.A.Rayyan, off_bat: 4 });
  await ball(m, { event_type: 'BYE', value: 2, player_id: m.ids.A.Rayyan });

  const c = (await live(m.matchId)).body.cricket;
  assert.equal(c.current.runs, 8);
  assert.equal(c.current.legal_balls, 1, 'only the bye was a legal delivery');
  assert.equal(c.current.extras.wides, 1);
  assert.equal(c.current.extras.no_balls, 1);
  assert.equal(c.current.extras.byes, 2);
  assert.equal(c.current.extras.total, 4);
  const rayyan = c.current.batting_card.find((b) => b.name === 'Rayyan');
  assert.equal(rayyan.runs, 4, 'only the four off the no-ball is his');
  assert.equal(c.current.bowling_card[0].runs, 6, 'the bowler is charged the wide and the no-ball, not the byes');
});

test('a wicket records the dismissal and brings in the next batter', async () => {
  const m = await setUpMatch();
  const res = await ball(m, {
    event_type: 'WICKET', value: 0, player_id: m.ids.A.Rayyan,
    dismissal: 'bowled', out_player_id: m.ids.A.Rayyan, new_batter_id: m.ids.A.Vikram,
  });
  assert.equal(res.status, 200);
  const c = (await live(m.matchId)).body.cricket;
  assert.equal(c.current.wickets, 1);
  assert.equal(c.striker.name, 'Vikram');
  const out = c.current.batting_card.find((b) => b.name === 'Rayyan');
  assert.equal(out.out, true);
  assert.equal(out.dismissal, 'bowled');
  assert.equal(c.current.bowling_card[0].wickets, 1);
  assert.equal(c.current.fall_of_wickets.length, 1);
});

test('a batter who is already out cannot walk in again', async () => {
  const m = await setUpMatch();
  await ball(m, { event_type: 'WICKET', value: 0, player_id: m.ids.A.Rayyan, dismissal: 'bowled', out_player_id: m.ids.A.Rayyan, new_batter_id: m.ids.A.Vikram });
  const again = await ball(m, {
    event_type: 'WICKET', value: 0, player_id: m.ids.A.Vikram, dismissal: 'bowled',
    out_player_id: m.ids.A.Vikram, new_batter_id: m.ids.A.Rayyan,
  });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already out or already at the crease/);
});

test('a run out is not credited to the bowler', async () => {
  const m = await setUpMatch();
  const res = await ball(m, {
    event_type: 'WICKET', value: 1, player_id: m.ids.A.Rayyan, dismissal: 'run_out',
    out_player_id: m.ids.A.Hamdan, fielder_id: m.ids.B.Kabir, new_batter_id: m.ids.A.Vikram,
  });
  assert.equal(res.status, 200);
  const c = (await live(m.matchId)).body.cricket;
  assert.equal(c.current.wickets, 1);
  assert.equal(c.current.bowling_card[0].wickets, 0);
  assert.equal(c.current.runs, 1);
});

test('an unknown dismissal is refused', async () => {
  const m = await setUpMatch();
  const res = await ball(m, { event_type: 'WICKET', value: 0, player_id: m.ids.A.Rayyan, dismissal: 'vibes' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Dismissal must be one of/);
});

test('a player from the other team cannot be made the striker of a delivery', async () => {
  const m = await setUpMatch();
  const res = await ball(m, { event_type: 'RUN', value: 4, player_id: m.ids.B.Imran });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not an approved member of this team/);
});

test('a bowler from the batting team is refused', async () => {
  const m = await setUpMatch();
  const res = await request(app).post(`/api/tournament-matches/${m.matchId}/events`).set(tok(U.host))
    .send({ team_id: m.teamA, event_type: 'RUN', value: 1, player_id: m.ids.A.Rayyan, bowler_id: m.ids.A.Vikram, innings: 1 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /bowler must be an approved player of the fielding team/);
});

test('an innings cannot run past its overs limit or ten wickets', async () => {
  const m = await setUpMatch({ oversLimit: 1 });
  for (let i = 0; i < 6; i++) await ball(m, { event_type: 'RUN', value: 0, player_id: m.ids.A.Rayyan });
  const c = (await live(m.matchId)).body.cricket;
  assert.equal(c.current.legal_balls, 6);
  assert.equal(c.current.complete, true);
  assert.equal(c.current.balls_remaining, 0);
});

test('scoring is refused once the match is finished', async () => {
  const m = await setUpMatch();
  await request(app).post(`/api/tournament-matches/${m.matchId}/status`).set(tok(U.host)).send({ status: 'FINISHED' });
  const res = await ball(m, { event_type: 'RUN', value: 4, player_id: m.ids.A.Rayyan });
  assert.equal(res.status, 409);
});

// ───────────────────────────── undo ─────────────────────────────
test('undo takes back the last delivery and every number it touched', async () => {
  const m = await setUpMatch();
  await ball(m, { event_type: 'RUN', value: 4, player_id: m.ids.A.Rayyan });
  const second = await ball(m, { event_type: 'RUN', value: 6, player_id: m.ids.A.Rayyan });

  const undo = await request(app).delete(`/api/tournament-matches/${m.matchId}/events/${second.body.eventId}`).set(tok(U.host));
  assert.equal(undo.status, 200);

  const c = (await live(m.matchId)).body.cricket;
  assert.equal(c.current.runs, 4);
  assert.equal(c.current.legal_balls, 1);
  assert.equal(c.striker.runs, 4);
  assert.equal(c.striker.balls, 1);
  assert.equal(c.striker.sixes, 0);
  assert.equal(c.current.bowling_card[0].runs, 4);
});

test('undoing a wicket brings the batter back to the crease', async () => {
  const m = await setUpMatch();
  await ball(m, { event_type: 'RUN', value: 4, player_id: m.ids.A.Rayyan });
  const w = await ball(m, { event_type: 'WICKET', value: 0, player_id: m.ids.A.Rayyan, dismissal: 'bowled', out_player_id: m.ids.A.Rayyan, new_batter_id: m.ids.A.Vikram });
  await request(app).delete(`/api/tournament-matches/${m.matchId}/events/${w.body.eventId}`).set(tok(U.host));

  const c = (await live(m.matchId)).body.cricket;
  assert.equal(c.current.wickets, 0);
  assert.equal(c.current.fall_of_wickets.length, 0);
  assert.equal(c.striker.name, 'Rayyan');
  assert.equal(c.striker.runs, 4);
  assert.equal(c.current.bowling_card[0].wickets, 0);
});

test('undoing an extra restores the extras and the team total', async () => {
  const m = await setUpMatch();
  const wide = await ball(m, { event_type: 'WIDE', value: 3, player_id: m.ids.A.Rayyan });
  await request(app).delete(`/api/tournament-matches/${m.matchId}/events/${wide.body.eventId}`).set(tok(U.host));
  const c = (await live(m.matchId)).body.cricket;
  assert.equal(c.current.runs, 0);
  assert.equal(c.current.extras.total, 0);
  assert.equal(c.current.bowling_card.length === 0 || c.current.bowling_card[0].runs === 0, true);
});

// ───────────────────────────── second innings & isolation ─────────────────────────────
test('the second innings knows the target and what is still needed', async () => {
  const m = await setUpMatch({ oversLimit: 1 });
  for (let i = 0; i < 6; i++) await ball(m, { event_type: 'RUN', value: 2, player_id: m.ids.A.Rayyan });

  await request(app).post(`/api/tournament-matches/${m.matchId}/innings`).set(tok(U.host))
    .send({ batting_team_id: m.teamB, bowling_team_id: m.teamA, innings: 2 });
  await request(app).post(`/api/tournament-matches/${m.matchId}/players`).set(tok(U.host))
    .send({ striker_id: m.ids.B.Imran, non_striker_id: m.ids.B.Kabir, bowler_id: m.ids.A.Rayyan });
  await request(app).post(`/api/tournament-matches/${m.matchId}/events`).set(tok(U.host))
    .send({ team_id: m.teamB, innings: 2, event_type: 'RUN', value: 4, player_id: m.ids.B.Imran, bowler_id: m.ids.A.Rayyan, non_striker_id: m.ids.B.Kabir });

  const c = (await live(m.matchId)).body.cricket;
  assert.equal(c.innings.length, 2);
  assert.equal(c.target, 13, 'twelve were made, so thirteen to win');
  assert.equal(c.chase.runs_needed, 9);
  assert.equal(c.current.innings, 2);
  assert.equal(c.striker.name, 'Imran');
});

test('two matches scored at the same time never mix', async () => {
  const one = await setUpMatch({ name: 'Alpha' });
  const two = await setUpMatch({ name: 'Beta' });

  await ball(one, { event_type: 'RUN', value: 4, player_id: one.ids.A.Rayyan });
  await ball(one, { event_type: 'RUN', value: 6, player_id: one.ids.A.Rayyan });
  await request(app).post(`/api/tournament-matches/${two.matchId}/events`).set(tok(U.host))
    .send({ team_id: two.teamA, innings: 1, event_type: 'RUN', value: 1, player_id: two.ids.A.Rayyan, bowler_id: two.ids.B.Imran, non_striker_id: two.ids.A.Hamdan });

  const cOne = (await live(one.matchId)).body.cricket;
  const cTwo = (await live(two.matchId)).body.cricket;
  assert.equal(cOne.current.runs, 10);
  assert.equal(cTwo.current.runs, 1);
  assert.equal(cOne.current.legal_balls, 2);
  assert.equal(cTwo.current.legal_balls, 1);
});

test('the fixture total matches the scorecard, so cards and the scoreboard agree', async () => {
  const m = await setUpMatch();
  await ball(m, { event_type: 'RUN', value: 4, player_id: m.ids.A.Rayyan });
  await ball(m, { event_type: 'WIDE', value: 2, player_id: m.ids.A.Rayyan });
  await ball(m, { event_type: 'BYE', value: 1, player_id: m.ids.A.Rayyan });

  const body = (await live(m.matchId)).body;
  const [[fx]] = await q('SELECT team_a_score, team_b_score FROM tournament_fixtures WHERE id = ?', [m.matchId]);
  const battingIsA = Number(body.cricket.current.batting_team_id) === Number(m.teamA);
  const stored = battingIsA ? fx.team_a_score : fx.team_b_score;
  assert.equal(Number(stored), body.cricket.current.runs);
  assert.equal(body.cricket.current.runs, 7);
});
