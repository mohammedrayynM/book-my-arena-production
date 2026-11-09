// Live-experience regression test: manual match creation, cricket batter/bowler statistics, realtime (SSE) signals,
// the live tournament listing, and public-data privacy. Needs the API on localhost:9000 + the DB in server/.env.
// Creates throwaway accounts/tournaments (prefix "ZZ LX") and deletes everything. Run from the server folder:
//   node tests/live-experience.e2e.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const http = require('http');
const axios = require('axios');
const pool = require('../config/db');

const BASE = 'http://localhost:9000/api';
const results = [];
const check = (name, cond, extra) => { results.push(!!cond); console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond ? '' : ' :: ' + JSON.stringify(extra))); };
const call = async (method, url, token, data) => {
  const r = await axios({ method, url: BASE + url, data, headers: token ? { Authorization: 'Bearer ' + token } : {}, validateStatus: () => true });
  return { status: r.status, data: r.data };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// minimal SSE client: resolves the list of received events once `close()` is called
function sse(path) {
  const events = [];
  let req;
  const ready = new Promise((resolve) => {
    req = http.get(BASE + path, { headers: { Accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block); const data = /^data: (.*)$/m.exec(block);
          if (ev) events.push({ event: ev[1], data: data ? JSON.parse(data[1]) : null });
        }
      });
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
  });
  return { ready, events, close: () => req.destroy() };
}

(async () => {
  const stamp = Date.now();
  const password = 'Test#12345';
  const mail = (k) => `zz_lx_${k}_${stamp}@example.com`;
  const tournaments = [];
  const ids = {};
  try {
    await axios.post(BASE + '/owners/register', { name: 'ZZ LX Owner', email: mail('owner'), phone: '9999999999', password });
    const ownerTok = (await axios.post(BASE + '/owners/login', { email: mail('owner'), password })).data.token;
    const tokens = {};
    for (const k of ['viewer', 'bat1', 'bat2', 'bowl1', 'bowl2']) {
      await axios.post(BASE + '/users/register', { name: `ZZ LX ${k}`, email: mail(k), phone: '9999999999', password });
      const l = await axios.post(BASE + '/users/login', { email: mail(k), password });
      tokens[k] = l.data.token; ids[k] = l.data.user.id;
    }
    const mk = async (sport, names, extra = {}) => {
      const c = await call('post', '/tournaments', ownerTok, { name: `ZZ LX ${sport} ${stamp}`, sport, venue: 'Galaxy', location: 'Chennai', start_date: plusDays(10), end_date: plusDays(12), format_type: 'Knockout', max_teams: 8, entry_fee: 0, ...extra });
      if (!c.data.tournament_id) throw new Error('create failed ' + JSON.stringify(c));
      tournaments.push(c.data.tournament_id);
      const teams = [];
      for (const n of names) teams.push((await call('post', `/tournaments/${c.data.tournament_id}/teams`, ownerTok, { name: n })).data.team_id);
      return { id: c.data.tournament_id, slug: c.data.slug, teams };
    };

    // ============================================================ manual match creation
    console.log('\n--- create match by hand (works with any 2 teams, no bracket generation) ---');
    const C = await mk('Cricket', ['LX Titans', 'LX Kings']);
    const other = await mk('Cricket', ['LX Other A', 'LX Other B']);
    const [T1, T2] = C.teams;
    const base = { team_a_id: T1, team_b_id: T2, match_date: plusDays(11), match_time: '19:00', venue: 'Galaxy Turf', format_label: 'T20', duration_min: 90, stage: 'Quarter Final', group_name: 'Group A' };
    const cm = await call('post', `/tournaments/${C.id}/fixtures`, ownerTok, base);
    check('host creates a match with date, time, venue, format, duration, round and group', cm.status === 200 && cm.data.fixture_id, cm);
    const fixtures = (await call('get', `/tournaments/${C.id}/fixtures`)).data.fixtures;
    const created = fixtures.find(f => f.id === cm.data.fixture_id);
    check('the match is stored exactly as entered', created && created.match_date === base.match_date && created.match_time === '19:00:00' && created.stage === 'Quarter Final' && created.group_name === 'Group A' && created.duration_min === 90 && created.format_label === 'T20' && created.status === 'SCHEDULED', created);
    check('match_date is a plain YYYY-MM-DD (no timezone shift)', /^\d{4}-\d{2}-\d{2}$/.test(created.match_date), created.match_date);
    for (const [label, patch, code] of [
      ['same team twice', { team_b_id: T1 }, 400],
      ['missing team', { team_b_id: undefined }, 400],
      ['team from another tournament', { team_b_id: other.teams[0] }, 400],
      ['bad time (25:99)', { match_time: '25:99' }, 400],
      ['bad date (2026-13-45)', { match_date: '2026-13-45' }, 400],
      ['absurd duration', { duration_min: 99999 }, 400],
    ]) {
      const r = await call('post', `/tournaments/${C.id}/fixtures`, ownerTok, { ...base, ...patch });
      check(`create match rejected: ${label}`, r.status === code && r.data.error, r);
    }
    check('a normal user cannot create a match (403)', (await call('post', `/tournaments/${C.id}/fixtures`, tokens.viewer, base)).status === 403);
    check('a guest cannot create a match (401)', (await call('post', `/tournaments/${C.id}/fixtures`, null, base)).status === 401);
    const edit = await call('patch', `/tournaments/${C.id}/fixtures/${cm.data.fixture_id}`, ownerTok, { match_time: '20:30', duration_min: 60 });
    check('a scheduled match can be rescheduled', edit.status === 200 && (await call('get', `/tournaments/${C.id}/fixtures`)).data.fixtures.find(f => f.id === cm.data.fixture_id).match_time === '20:30:00', edit);
    check('bad reschedule is rejected (400)', (await call('patch', `/tournaments/${C.id}/fixtures/${cm.data.fixture_id}`, ownerTok, { match_time: 'noon' })).status === 400);
    const spare = await call('post', `/tournaments/${C.id}/fixtures`, ownerTok, { ...base, stage: 'Spare' });
    check('a not-started match can be deleted', (await call('delete', `/tournaments/${C.id}/fixtures/${spare.data.fixture_id}`, ownerTok)).status === 200);
    check('delete by a normal user is refused (403)', (await call('delete', `/tournaments/${C.id}/fixtures/${cm.data.fixture_id}`, tokens.viewer)).status === 403);

    // ============================================================ tournament LIVE with a stream but no match yet
    console.log('\n--- live tournament with no match in play ---');
    await call('patch', `/tournaments/${C.id}/status`, ownerTok, { status: 'LIVE' });
    await call('post', `/tournaments/${C.id}/streams`, ownerTok, { youtube_url: 'https://youtu.be/dQw4w9WgXcQ' });
    const ln0 = await call('get', `/tournaments/${C.id}/live-now`);
    check('live-now: no match in play, but the tournament video is still delivered', ln0.data.matches.length === 0 && ln0.data.stream && ln0.data.stream.id === 'dQw4w9WgXcQ', ln0.data);
    check('live-now: tells viewers which match is next', ln0.data.next_match && ln0.data.next_match.team_a_name === 'LX Titans' && ln0.data.next_match.match_date === base.match_date, ln0.data.next_match);

    // players: 2 batters (team A), 2 bowlers (team B)
    const M = cm.data.fixture_id;
    const rows = [[ids.bat1, T1, '7', 'Opener'], [ids.bat2, T1, '18', 'Middle order'], [ids.bowl1, T2, '11', 'Fast bowler'], [ids.bowl2, T2, '22', 'Spinner']];
    for (const [uid, team, jersey, pos] of rows) await pool.query("INSERT INTO tournament_participants (tournament_id, user_id, team_id, status, jersey_number, position, profile_photo) VALUES (?, ?, ?, 'APPROVED', ?, ?, ?)", [C.id, uid, team, jersey, pos, `/uploads/players/${uid}.jpg`]);

    // ============================================================ realtime signals
    console.log('\n--- realtime (SSE) ---');
    const sMatch = sse(`/tournament-matches/${M}/stream`);
    const sTour = sse(`/tournaments/${C.id}/stream`);
    const sOther = sse(`/tournaments/${other.id}/stream`);
    const codes = await Promise.all([sMatch.ready, sTour.ready, sOther.ready]);
    check('match and tournament streams open (200)', codes.every(c => c === 200), codes);
    check('streams say hello first', (await sleep(150), sMatch.events[0] && sMatch.events[0].event === 'connected'), sMatch.events);

    const start = await call('post', `/tournament-matches/${M}/status`, ownerTok, { status: 'LIVE' });
    check('host starts the match', start.status === 200, start);
    await sleep(400);
    check('viewers of the match are signalled instantly when it starts', sMatch.events.some(e => e.event === 'match_update' && e.data.matchId === M), sMatch.events);
    check('viewers of the tournament are signalled too', sTour.events.some(e => e.event === 'match_update'), sTour.events);
    check('a different tournament is NOT woken by this match', !sOther.events.some(e => e.event === 'match_update'), sOther.events);

    // ============================================================ cricket: batter / bowler
    console.log('\n--- cricket: current batter, bowler and player statistics ---');
    const ev = (type, value, player, bowler, extra = {}) => call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: type, team_id: T1, value, player_id: player, bowler_id: bowler, ...extra });
    const before = sMatch.events.length;
    const r4 = await ev('RUN', 4, ids.bat1, ids.bowl1);
    await sleep(300);
    check('a scoring tap signals the match stream (score change reaches viewers)', sMatch.events.length > before && sMatch.events.slice(before).some(e => e.event === 'match_update'), sMatch.events.slice(before));
    check('RUN 4 credited to the batter against the bowler', r4.status === 200, r4);
    await ev('RUN', 6, ids.bat1, ids.bowl1);
    await ev('RUN', 1, ids.bat1, ids.bowl1);
    await ev('RUN', 0, ids.bat1, ids.bowl1);
    await ev('WIDE', undefined, ids.bat1, ids.bowl1);
    await ev('LEG_BYE', 2, ids.bat1, ids.bowl2);
    await ev('BYE', 1, ids.bat1, ids.bowl2);
    check('bowler must be from the FIELDING team (a batter as bowler is refused)', (await ev('RUN', 1, ids.bat1, ids.bat2)).status === 400);
    check('batter must be from the batting team (a bowler as batter is refused)', (await ev('RUN', 1, ids.bowl1, ids.bowl2)).status === 400);
    let live = (await call('get', `/tournament-matches/${M}/live`)).data;
    const b1 = live.player_stats[ids.bat1], w1 = live.player_stats[ids.bowl1], w2 = live.player_stats[ids.bowl2];
    check('batter: 11 runs off 6 balls faced (wide is not faced; byes count as faced), 1 four, 1 six', b1.runs === 11 && b1.balls === 6 && b1.fours === 1 && b1.sixes === 1, b1);
    check('batter strike rate = runs/balls x 100', Math.abs(b1.strike_rate - (11 / 6) * 100) < 0.01, b1.strike_rate);
    check('bowler 1: 5 legal balls, 12 runs conceded (11 + wide), 0 wickets', w1.bowl_balls === 4 && w1.bowl_runs === 12 && !w1.bowl_wickets && w1.bowl_overs === '0.4', w1);
    check('byes / leg byes are NOT charged to the bowler', w2.bowl_runs === undefined || w2.bowl_runs === 0, w2);
    check('team totals include leg byes and byes: 11 + 1 wide + 2 + 1 = 15 runs', live.match.team_a_score === 15 && live.stats.a.extras === 4, live.stats.a);
    check('current batter / bowler come from the latest ball', live.current.batter_id === ids.bat1 && live.current.bowler_id === ids.bowl2, live.current);
    check('player photos are delivered with the squads', live.team_a_players.every(p => p.avatar && p.avatar.startsWith('/uploads/players/')), live.team_a_players);
    await ev('WICKET', undefined, ids.bat1, ids.bowl1);
    live = (await call('get', `/tournament-matches/${M}/live`)).data;
    check('after a wicket: the bowler gets it, the batter is out, and no batter is at the crease yet', live.player_stats[ids.bowl1].bowl_wickets === 1 && live.player_stats[ids.bat1].out === true && live.current.batter_id === null, live.current);
    const undo = await call('delete', `/tournament-matches/${M}/events/${(await call('get', `/tournament-matches/${M}/live`)).data.events.find(e => e.event_type === 'WICKET').id}`, ownerTok);
    live = (await call('get', `/tournament-matches/${M}/live`)).data;
    check('undoing the wicket restores the batter and removes the bowler wicket', undo.status === 200 && !live.player_stats[ids.bowl1].bowl_wickets && !live.player_stats[ids.bat1].out && live.current.batter_id === ids.bat1, live.current);

    // ============================================================ listing shows the live score
    console.log('\n--- tournament list ---');
    const list = (await call('get', '/tournaments')).data.tournaments;
    const mine = list.find(t => t.id === C.id);
    check('the list carries teams_count', mine && mine.teams_count === 2, mine && mine.teams_count);
    check('a LIVE tournament in the list carries its current match with the live score', mine && mine.live_match && mine.live_match.team_a.name === 'LX Titans' && mine.live_match.team_a_score === 15 && mine.live_match.status === 'LIVE', mine && mine.live_match);
    check('cricket list card has runs/wickets/overs for the batting team', mine.live_match.stats.a.wickets === 0 && mine.live_match.stats.a.overs === '1.0', mine.live_match.stats.a);

    // ============================================================ football + basketball timeouts
    console.log('\n--- timeouts ---');
    const F = await mk('Football', ['LX Reds', 'LX Blues']);
    const fm = (await call('post', `/tournaments/${F.id}/fixtures`, ownerTok, { team_a_id: F.teams[0], team_b_id: F.teams[1] })).data.fixture_id;
    await call('post', `/tournament-matches/${fm}/status`, ownerTok, { status: 'LIVE' });
    const to = await call('post', `/tournament-matches/${fm}/events`, ownerTok, { event_type: 'TIMEOUT', team_id: F.teams[0] });
    check('football accepts a TIMEOUT (does not change the score)', to.status === 200 && to.data.team_a_score === 0, to);
    check('TIMEOUT shows in the events feed', (await call('get', `/tournament-matches/${fm}/live`)).data.events.some(e => e.event_type === 'TIMEOUT'));
    check('a match created with defaults uses the tournament venue and stage "Match"', (await call('get', `/tournaments/${F.id}/fixtures`)).data.fixtures[0].venue === 'Galaxy' && (await call('get', `/tournaments/${F.id}/fixtures`)).data.fixtures[0].stage === 'Match');

    // ============================================================ privacy of the public team APIs
    console.log('\n--- privacy ---');
    const teams = (await call('get', `/tournaments/${C.id}/teams`)).data;
    check('public team list exposes no email addresses', !JSON.stringify(teams).match(/@/), teams);
    const squad = (await call('get', `/tournaments/${C.id}/teams/${T1}`)).data;
    check('public squad exposes no emails but has name, jersey, position and photo', !JSON.stringify(squad).match(/@/) && squad.players.length === 2 && squad.players.every(p => p.name && p.jersey_number && p.position && p.avatar), squad);
    const host = (await call('get', `/tournaments/${C.id}/participants`, ownerTok)).data;
    check('host participant list carries the player photo', host.participants.every(p => p.avatar), host.participants[0]);

    sMatch.close(); sTour.close(); sOther.close();
  } catch (e) {
    check('test run finished without an unexpected error', false, e.response ? { status: e.response.status, data: e.response.data } : e.stack);
  } finally {
    try {
      for (const id of tournaments) {
        await pool.query('DELETE FROM tournament_match_events WHERE match_id IN (SELECT id FROM tournament_fixtures WHERE tournament_id = ?)', [id]);
        for (const t of ['tournament_fixtures', 'tournament_teams', 'tournament_participants', 'tournament_audit_logs', 'tournament_registrations', 'tournament_scorers', 'tournament_streams']) await pool.query(`DELETE FROM ${t} WHERE tournament_id = ?`, [id]);
        await pool.query('DELETE FROM tournaments WHERE id = ?', [id]);
      }
      await pool.query("DELETE FROM users WHERE email LIKE 'zz_lx_%'");
      await pool.query("DELETE FROM owners WHERE email LIKE 'zz_lx_%'");
      const [[left]] = await pool.query("SELECT (SELECT COUNT(*) FROM tournaments WHERE name LIKE 'ZZ LX %') t, (SELECT COUNT(*) FROM users WHERE email LIKE 'zz_lx_%') u, (SELECT COUNT(*) FROM owners WHERE email LIKE 'zz_lx_%') o, (SELECT COUNT(*) FROM tournament_teams WHERE name LIKE 'LX %') tm");
      console.log('cleanup done; leftovers (tournaments/users/owners/teams):', left.t, left.u, left.o, left.tm);
    } catch (e) { console.log('CLEANUP FAILED:', e.message); }
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
