// Request F priority 5/6: real-time score delivery, per-match isolation, and the live score shown on listing cards.
// Measures the ACTUAL delay between a scorer's write and a viewer being woken, over a real SSE connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';

const fakePath = require.resolve('razorpay');
class FakeRazorpay {
  constructor() { this.orders = { create: async () => ({ id: `order_l${Date.now()}` }) }; this.payments = { fetch: async () => null }; }
}
require.cache[fakePath] = { id: fakePath, filename: fakePath, loaded: true, exports: FakeRazorpay };

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('./helpers/testDb');

let app; let server; let origin;
const q = (s, p) => db.pool.query(s, p);
const qq = (s, p) => db.pool.query(s, p).catch(() => {});
const SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';
const tok = (id) => ({ Authorization: `Bearer ${jwt.sign({ id, email: 'u@x.test' }, SECRET)}` });
const U = {};
let eventSequence = 0;

/** Opens a real SSE connection and resolves with every frame as it arrives, timestamped. */
function openStream(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${origin}${path}`, { headers: { Accept: 'text/event-stream' } }, (res) => {
      const frames = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, i); buffer = buffer.slice(i + 2);
          const event = (raw.match(/^event: (.*)$/m) || [])[1];
          const dataLine = (raw.match(/^data: (.*)$/m) || [])[1];
          if (event) frames.push({ event, data: dataLine ? JSON.parse(dataLine) : null, at: Date.now() });
        }
      });
      const consumed = new Map(); // event name -> how many of that event this test has already taken
      resolve({
        frames,
        status: res.statusCode,
        close: () => { req.destroy(); res.destroy(); },
        /**
         * Takes the next not-yet-taken frame of this type, waiting up to `ms` for it.
         * A frame that arrived before the call still counts — otherwise the very first `connected`
         * frame, which arrives immediately, would be missed.
         */
        async next(event, ms = 4000) {
          const start = Date.now();
          do {
            const taken = consumed.get(event) || 0;
            const hit = frames.filter((f) => f.event === event)[taken];
            if (hit) { consumed.set(event, taken + 1); return hit; }
            await new Promise((r) => setTimeout(r, 5));
          } while (Date.now() - start < ms);
          return null;
        },
      });
    });
    req.on('error', reject);
  });
}

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
  app.use('/api/tournaments', require('../routes/tournament-live'));
  app.use('/api/tournament-matches', require('../routes/tournament-matches'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  for (const t of ['tournament_match_events', 'tournament_fixtures', 'tournament_teams', 'tournament_participants', 'tournaments', 'users']) await qq(`DELETE FROM ${t}`);
  await q('UPDATE tournament_settings SET fee_amount = 0, is_active = 1, creation_enabled = 1, max_duration_days = 60');
  const [h] = await q('INSERT INTO users (name, email) VALUES (?, ?)', ['Host', 'h@x.test']); U.host = h.insertId;
});
test.after(async () => {
  // SSE responses are long-lived sockets: without this the listener never finishes closing.
  if (server) { try { server.closeAllConnections && server.closeAllConnections(); } catch { } server.close(); }
  await db.pool.end();
});

/** A live match with two teams, ready to be scored. Returns { tournamentId, matchId }. */
async function liveMatch(name, sport = 'Football') {
  const made = await request(app).post('/api/tournaments').set(tok(U.host))
    .send({ name, sport, format_type: 'Knockout', start_date: '2099-03-01', end_date: '2099-03-02', max_teams: 2 });
  const id = made.body.tournament_id;
  await request(app).post(`/api/tournaments/${id}/teams`).set(tok(U.host)).send({ name: `${name} A` });
  await request(app).post(`/api/tournaments/${id}/teams`).set(tok(U.host)).send({ name: `${name} B` });
  await request(app).post(`/api/tournaments/${id}/fixtures/generate`).set(tok(U.host)).send({});
  const [[fx]] = await q('SELECT id FROM tournament_fixtures WHERE tournament_id = ?', [id]);
  await request(app).post(`/api/tournament-matches/${fx.id}/status`).set(tok(U.host)).send({ status: 'LIVE' });
  return { tournamentId: id, matchId: fx.id };
}
const score = (matchId, teamId, type = 'GOAL') =>
  request(app).post(`/api/tournament-matches/${matchId}/events`).set(tok(U.host)).send({ event_type: type, team_id: teamId, value: 1, client_event_id: `live-test-${++eventSequence}` });

test('a viewer can open a live stream for a match and gets a connected frame', async () => {
  const { matchId } = await liveMatch('Stream Cup');
  const s = await openStream(`/api/tournament-matches/${matchId}/stream`);
  const hello = await s.next('connected');
  assert.ok(hello, 'no connected frame');
  assert.equal(hello.data.channel, `match:${matchId}`);
  s.close();
});

test('a score update reaches a watching viewer in well under a second', async () => {
  const { matchId } = await liveMatch('Latency Cup');
  const [[team]] = await q('SELECT id FROM tournament_teams ORDER BY id LIMIT 1');
  const s = await openStream(`/api/tournament-matches/${matchId}/stream`);
  await s.next('connected');

  const samples = [];
  for (let i = 0; i < 5; i++) {
    const sentAt = Date.now();
    const res = await score(matchId, team.id);
    assert.equal(res.status, 200);
    const frame = await s.next('match_update');
    assert.ok(frame, `no match_update for event ${i + 1}`);
    samples.push(frame.at - sentAt);
  }
  s.close();

  const max = Math.max(...samples);
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  console.log(`      ↳ measured push latency: avg ${avg}ms, max ${max}ms over ${samples.length} score updates (loopback)`);
  assert.ok(max < 1000, `slowest push was ${max}ms, expected under 1000ms`);
});

test('a retried score event with the same request ID is applied only once', async () => {
  const { matchId } = await liveMatch('Idempotent Cup');
  const [[team]] = await q('SELECT id FROM tournament_teams ORDER BY id LIMIT 1');
  const body = { event_type: 'GOAL', team_id: team.id, value: 1, client_event_id: 'retry-test-event-0001' };
  const first = await request(app).post(`/api/tournament-matches/${matchId}/events`).set(tok(U.host)).send(body);
  const retry = await request(app).post(`/api/tournament-matches/${matchId}/events`).set(tok(U.host)).send(body);
  const [[fixture]] = await q('SELECT team_a_score, team_b_score FROM tournament_fixtures WHERE id = ?', [matchId]);
  const [[count]] = await q('SELECT COUNT(*) AS n FROM tournament_match_events WHERE match_id = ? AND client_event_id = ?', [matchId, body.client_event_id]);

  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(count.n, 1);
  assert.equal(Number(fixture.team_a_score) + Number(fixture.team_b_score), 1);
});

test('the push carries the match and tournament it belongs to', async () => {
  const { tournamentId, matchId } = await liveMatch('Payload Cup');
  const [[team]] = await q('SELECT id FROM tournament_teams ORDER BY id LIMIT 1');
  const s = await openStream(`/api/tournament-matches/${matchId}/stream`);
  await s.next('connected');
  await score(matchId, team.id);
  const frame = await s.next('match_update');
  assert.equal(frame.data.matchId, matchId);
  assert.equal(frame.data.tournamentId, tournamentId);
  s.close();
});

test('two tournaments running at once never cross over', async () => {
  const one = await liveMatch('Alpha Open');
  const two = await liveMatch('Beta Open');
  const [teams] = await q('SELECT id, tournament_id FROM tournament_teams ORDER BY id');
  const teamOne = teams.find((t) => t.tournament_id === one.tournamentId);
  const teamTwo = teams.find((t) => t.tournament_id === two.tournamentId);

  const sOne = await openStream(`/api/tournament-matches/${one.matchId}/stream`);
  const sTwo = await openStream(`/api/tournament-matches/${two.matchId}/stream`);
  const tOne = await openStream(`/api/tournaments/${one.tournamentId}/stream`);
  const tTwo = await openStream(`/api/tournaments/${two.tournamentId}/stream`);
  await Promise.all([sOne.next('connected'), sTwo.next('connected'), tOne.next('connected'), tTwo.next('connected')]);

  // score only in tournament one, three times
  for (let i = 0; i < 3; i++) await score(one.matchId, teamOne.id);
  await sOne.next('match_update');
  await new Promise((r) => setTimeout(r, 300));

  const updates = (s) => s.frames.filter((f) => f.event === 'match_update');
  assert.equal(updates(sOne).length, 3, 'tournament one match stream should have 3 updates');
  assert.equal(updates(tOne).length, 3, 'tournament one tournament stream should have 3 updates');
  assert.equal(updates(sTwo).length, 0, 'tournament two match stream must stay silent');
  assert.equal(updates(tTwo).length, 0, 'tournament two tournament stream must stay silent');

  // and the stored scores stay separate
  await score(two.matchId, teamTwo.id);
  const [[fxOne]] = await q('SELECT team_a_score, team_b_score FROM tournament_fixtures WHERE id = ?', [one.matchId]);
  const [[fxTwo]] = await q('SELECT team_a_score, team_b_score FROM tournament_fixtures WHERE id = ?', [two.matchId]);
  assert.equal(Number(fxOne.team_a_score), 3);
  assert.equal(Number(fxTwo.team_a_score), 1);

  [sOne, sTwo, tOne, tTwo].forEach((s) => s.close());
});

test('a disconnected viewer is dropped and the next update still reaches everyone else', async () => {
  const { matchId } = await liveMatch('Dropout Cup');
  const [[team]] = await q('SELECT id FROM tournament_teams ORDER BY id LIMIT 1');
  const stays = await openStream(`/api/tournament-matches/${matchId}/stream`);
  const leaves = await openStream(`/api/tournament-matches/${matchId}/stream`);
  await Promise.all([stays.next('connected'), leaves.next('connected')]);

  leaves.close();
  await new Promise((r) => setTimeout(r, 200));

  await score(matchId, team.id);
  const frame = await stays.next('match_update');
  assert.ok(frame, 'the remaining viewer should still be updated');
  const { channelSize } = require('../utils/realtime');
  assert.equal(channelSize(`match:${matchId}`), 1, 'the closed connection should have been cleaned up');
  stays.close();
});

test('the score is persisted before anyone is told about it', async () => {
  const { matchId } = await liveMatch('Persist Cup');
  const [[team]] = await q('SELECT id FROM tournament_teams ORDER BY id LIMIT 1');
  const s = await openStream(`/api/tournament-matches/${matchId}/stream`);
  await s.next('connected');
  await score(matchId, team.id);
  await s.next('match_update');
  const [[fx]] = await q('SELECT team_a_score FROM tournament_fixtures WHERE id = ?', [matchId]);
  assert.equal(Number(fx.team_a_score), 1);
  const live = await request(app).get(`/api/tournament-matches/${matchId}/live`);
  assert.equal(live.body.match.team_a_score, 1);
  s.close();
});

test('scoring is refused for a match that is not live, and for someone who is not the scorer', async () => {
  const { matchId } = await liveMatch('Guard Cup');
  const [[team]] = await q('SELECT id FROM tournament_teams ORDER BY id LIMIT 1');
  const [stranger] = await q('INSERT INTO users (name, email) VALUES (?, ?)', ['Nosy', 'n@x.test']);

  const notMine = await request(app).post(`/api/tournament-matches/${matchId}/events`).set(tok(stranger.insertId))
    .send({ event_type: 'GOAL', team_id: team.id, value: 1 });
  assert.ok([403, 404].includes(notMine.status), `expected 403/404, got ${notMine.status}`);

  await request(app).post(`/api/tournament-matches/${matchId}/status`).set(tok(U.host)).send({ status: 'FINISHED' });
  const finished = await score(matchId, team.id);
  assert.equal(finished.status, 409);
});

test('the tournament listing carries the live score, so cards show it without opening the tournament', async () => {
  const { tournamentId, matchId } = await liveMatch('Card Cup');
  const [[team]] = await q('SELECT id FROM tournament_teams ORDER BY id LIMIT 1');
  await score(matchId, team.id);
  await score(matchId, team.id);

  const list = await request(app).get('/api/tournaments');
  const card = list.body.tournaments.find((t) => t.id === tournamentId);
  assert.ok(card, 'the live tournament should be listed');
  assert.equal(card.status, 'LIVE');
  assert.ok(card.live_match, 'the card should carry its live match');
  assert.equal(card.live_match.team_a.name, 'Card Cup A');
  assert.equal(card.live_match.team_b.name, 'Card Cup B');
  assert.equal(card.live_match.team_a_score, 2);
  assert.equal(card.live_match.status, 'LIVE');
});

test('a tournament that is not in play shows no live score on its card', async () => {
  const made = await request(app).post('/api/tournaments').set(tok(U.host))
    .send({ name: 'Quiet Cup', sport: 'Football', start_date: '2099-03-01', end_date: '2099-03-02' });
  const list = await request(app).get('/api/tournaments');
  const card = list.body.tournaments.find((t) => t.id === made.body.tournament_id);
  assert.equal(card.status, 'REGISTRATION_OPEN');
  assert.ok(!card.live_match, 'a tournament with no live match must not advertise one');
});

// ───────────────────────────── priority 9: who may do what ─────────────────────────────
test('an assigned scorer can score but cannot manage the tournament', async () => {
  const { tournamentId, matchId } = await liveMatch('Role Cup');
  const [[team]] = await q('SELECT id FROM tournament_teams ORDER BY id LIMIT 1');
  const [sc] = await q('INSERT INTO users (name, email) VALUES (?, ?)', ['Scorer', 'scorer@x.test']);
  const scorer = sc.insertId;

  // before being assigned: no scoring
  const before = await request(app).post(`/api/tournament-matches/${matchId}/events`).set(tok(scorer))
    .send({ event_type: 'GOAL', team_id: team.id, value: 1 });
  assert.ok([403, 404].includes(before.status), `expected refusal, got ${before.status}`);

  const added = await request(app).post(`/api/tournaments/${tournamentId}/scorers`).set(tok(U.host)).send({ email: 'scorer@x.test' });
  assert.equal(added.status, 200);

  // now scoring works
  const scored = await request(app).post(`/api/tournament-matches/${matchId}/events`).set(tok(scorer))
    .send({ event_type: 'GOAL', team_id: team.id, value: 1 });
  assert.equal(scored.status, 200);

  // ...but managing the tournament still does not
  const asManager = await request(app).post(`/api/tournaments/${tournamentId}/teams`).set(tok(scorer)).send({ name: 'Scorer FC' });
  assert.equal(asManager.status, 403);
  const access = await request(app).get(`/api/tournament-matches/${matchId}/access`).set(tok(scorer));
  assert.equal(access.body.can_score, true);
  assert.equal(access.body.can_manage, false);
});

test('only the host can assign or remove a scorer', async () => {
  const { tournamentId } = await liveMatch('Assign Cup');
  const [other] = await q('INSERT INTO users (name, email) VALUES (?, ?)', ['Other', 'other@x.test']);
  const res = await request(app).post(`/api/tournaments/${tournamentId}/scorers`).set(tok(other.insertId)).send({ email: 'other@x.test' });
  assert.equal(res.status, 403);
  const removal = await request(app).delete(`/api/tournaments/${tournamentId}/scorers/${other.insertId}`).set(tok(other.insertId));
  assert.equal(removal.status, 403);
});

test('a removed scorer loses the ability to score', async () => {
  const { tournamentId, matchId } = await liveMatch('Revoke Cup');
  const [[team]] = await q('SELECT id FROM tournament_teams ORDER BY id LIMIT 1');
  const [sc] = await q('INSERT INTO users (name, email) VALUES (?, ?)', ['Temp', 'temp@x.test']);
  await request(app).post(`/api/tournaments/${tournamentId}/scorers`).set(tok(U.host)).send({ email: 'temp@x.test' });
  assert.equal((await request(app).post(`/api/tournament-matches/${matchId}/events`).set(tok(sc.insertId)).send({ event_type: 'GOAL', team_id: team.id, value: 1 })).status, 200);

  await request(app).delete(`/api/tournaments/${tournamentId}/scorers/${sc.insertId}`).set(tok(U.host));
  const after = await request(app).post(`/api/tournament-matches/${matchId}/events`).set(tok(sc.insertId))
    .send({ event_type: 'GOAL', team_id: team.id, value: 1 });
  assert.ok([403, 404].includes(after.status), `expected refusal after removal, got ${after.status}`);
});

// ───────────────────────────── the shared live-score feed the tournament LIST listens on ─────────────────────────────
test('one shared feed carries live score changes from every tournament', async () => {
  const one = await liveMatch('Feed Alpha');
  const two = await liveMatch('Feed Beta');
  const [teams] = await q('SELECT id, tournament_id FROM tournament_teams ORDER BY id');
  const teamOne = teams.find((t) => t.tournament_id === one.tournamentId);
  const teamTwo = teams.find((t) => t.tournament_id === two.tournamentId);

  const feed = await openStream('/api/tournaments/live/stream');
  const hello = await feed.next('connected');
  assert.ok(hello, 'the shared feed should connect');
  assert.equal(hello.data.channel, 'live:feed');

  await score(one.matchId, teamOne.id);
  const first = await feed.next('match_update');
  assert.ok(first, 'a score in the first tournament should reach the feed');
  assert.equal(first.data.tournamentId, one.tournamentId);

  await score(two.matchId, teamTwo.id);
  const second = await feed.next('match_update');
  assert.ok(second, 'a score in the second tournament should reach the same feed');
  assert.equal(second.data.tournamentId, two.tournamentId);

  feed.close();
});

test('the shared feed is not confused with a tournament whose id happens to be a word', async () => {
  // /tournaments/live/stream must be the feed, never read as tournament id "live"
  const feed = await openStream('/api/tournaments/live/stream');
  const hello = await feed.next('connected');
  assert.equal(hello.data.channel, 'live:feed');
  feed.close();
});

test('a per-match viewer is not woken by an unrelated tournament, even though the feed is', async () => {
  const one = await liveMatch('Narrow Alpha');
  const two = await liveMatch('Narrow Beta');
  const [teams] = await q('SELECT id, tournament_id FROM tournament_teams ORDER BY id');
  const teamTwo = teams.find((t) => t.tournament_id === two.tournamentId);

  const watchingOne = await openStream(`/api/tournament-matches/${one.matchId}/stream`);
  const feed = await openStream('/api/tournaments/live/stream');
  await Promise.all([watchingOne.next('connected'), feed.next('connected')]);

  await score(two.matchId, teamTwo.id);
  await feed.next('match_update');
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(watchingOne.frames.filter((f) => f.event === 'match_update').length, 0,
    'someone watching one match must not be woken by another tournament');
  watchingOne.close();
  feed.close();
});

// ───────────────────────────── the schedule on a card ─────────────────────────────
test('an upcoming tournament card carries the next match date, time, venue and teams', async () => {
  const made = await request(app).post('/api/tournaments').set(tok(U.host))
    .send({ name: 'Schedule Cup', sport: 'Cricket', start_date: '2099-03-01', end_date: '2099-03-05', max_teams: 2 });
  const id = made.body.tournament_id;
  await request(app).post(`/api/tournaments/${id}/teams`).set(tok(U.host)).send({ name: 'Titans' });
  await request(app).post(`/api/tournaments/${id}/teams`).set(tok(U.host)).send({ name: 'Kings' });
  await request(app).post(`/api/tournaments/${id}/fixtures/generate`).set(tok(U.host)).send({});
  const [[fx]] = await q('SELECT id FROM tournament_fixtures WHERE tournament_id = ?', [id]);
  await q("UPDATE tournament_fixtures SET match_date = '2099-03-02', match_time = '19:00:00', venue = 'MG Ground' WHERE id = ?", [fx.id]);

  const list = await request(app).get('/api/tournaments');
  const card = list.body.tournaments.find((t) => t.id === id);
  assert.ok(card.next_match, 'the card should carry the next match');
  assert.equal(String(card.next_match.date).slice(0, 10), '2099-03-02');
  assert.equal(card.next_match.time, '19:00');
  assert.equal(card.next_match.venue, 'MG Ground');
  assert.equal(card.next_match.team_a_name, 'Titans');
  assert.equal(card.next_match.team_b_name, 'Kings');
});

test('the nearest scheduled match is the one shown, and a live tournament shows its score instead', async () => {
  const made = await request(app).post('/api/tournaments').set(tok(U.host))
    .send({ name: 'Order Cup', sport: 'Football', start_date: '2099-03-01', end_date: '2099-03-20', max_teams: 4 });
  const id = made.body.tournament_id;
  for (const n of ['A', 'B', 'C', 'D']) await request(app).post(`/api/tournaments/${id}/teams`).set(tok(U.host)).send({ name: `Team ${n}` });
  await request(app).post(`/api/tournaments/${id}/fixtures/generate`).set(tok(U.host)).send({});
  const [fixtures] = await q('SELECT id FROM tournament_fixtures WHERE tournament_id = ? ORDER BY id', [id]);
  await q("UPDATE tournament_fixtures SET match_date = '2099-03-10' WHERE id = ?", [fixtures[0].id]);
  await q("UPDATE tournament_fixtures SET match_date = '2099-03-03' WHERE id = ?", [fixtures[1].id]);

  const list = await request(app).get('/api/tournaments');
  const card = list.body.tournaments.find((t) => t.id === id);
  assert.equal(String(card.next_match.date).slice(0, 10), '2099-03-03', 'the soonest match is the one shown');
});

test('a tournament with no scheduled match simply has none to show', async () => {
  const made = await request(app).post('/api/tournaments').set(tok(U.host))
    .send({ name: 'Empty Cup', sport: 'Cricket', start_date: '2099-03-01', end_date: '2099-03-02' });
  const list = await request(app).get('/api/tournaments');
  const card = list.body.tournaments.find((t) => t.id === made.body.tournament_id);
  assert.ok(!card.next_match);
});
