// Live-match regression test: permissions, sport rules, clock, YouTube validation, public payload.
// Needs the API on localhost:9000 + the DB in server/.env. Creates throwaway accounts/tournaments (prefix "ZZ LM")
// and deletes everything it created. Run from the server folder:  node tests/live-match.e2e.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const jwt = require('jsonwebtoken');
const axios = require('axios');
const pool = require('../config/db');

const BASE = 'http://localhost:9000/api';
const results = [];
const check = (name, cond, extra) => { results.push(!!cond); console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond ? '' : ' :: ' + JSON.stringify(extra))); };
const call = async (method, url, token, data) => {
  const r = await axios({ method, url: BASE + url, data, headers: token ? { Authorization: 'Bearer ' + token } : {}, validateStatus: () => true });
  return { status: r.status, data: r.data };
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

(async () => {
  const stamp = Date.now();
  const password = 'Test#12345';
  const mail = (k) => `zz_lm_${k}_${stamp}@example.com`;
  const tournaments = [];
  const userIds = {};
  let ownerId;
  try {
    // ---- accounts: 1 owner (host), users: scorer, viewer, playerA, playerB
    await axios.post(BASE + '/owners/register', { name: 'ZZ LM Owner', email: mail('owner'), phone: '9999999999', password });
    const ownerLogin = await axios.post(BASE + '/owners/login', { email: mail('owner'), password });
    const ownerTok = ownerLogin.data.token; ownerId = ownerLogin.data.owner.id;
    const tokens = {};
    for (const k of ['scorer', 'viewer', 'pa', 'pb']) {
      await axios.post(BASE + '/users/register', { name: `ZZ LM ${k}`, email: mail(k), phone: '9999999999', password });
      const l = await axios.post(BASE + '/users/login', { email: mail(k), password });
      tokens[k] = l.data.token; userIds[k] = l.data.user.id;
    }
    const [[admin]] = await pool.query('SELECT id FROM admins LIMIT 1');
    const adminTok = jwt.sign({ id: admin.id, username: 'admin', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const mk = async (sport, teamNames, extra = {}) => {
      const c = await call('post', '/tournaments', ownerTok, { name: `ZZ LM ${sport} ${stamp}`, sport, venue: 'V', location: 'L', start_date: plusDays(10), end_date: plusDays(12), format_type: 'Knockout', max_teams: 8, entry_fee: 0, ...extra });
      if (!c.data.tournament_id) throw new Error('create failed ' + JSON.stringify(c));
      tournaments.push(c.data.tournament_id);
      const teams = [];
      for (const n of teamNames) teams.push((await call('post', `/tournaments/${c.data.tournament_id}/teams`, ownerTok, { name: n })).data.team_id);
      await call('post', `/tournaments/${c.data.tournament_id}/fixtures/generate`, ownerTok, {});
      const fx = (await call('get', `/tournaments/${c.data.tournament_id}/fixtures`)).data.fixtures;
      return { id: c.data.tournament_id, teams, fixtures: fx };
    };

    // =============================================================== FOOTBALL
    console.log('\n--- football: permissions, validation, clock, video ---');
    const T = await mk('Football', ['LM Alpha', 'LM Bravo', 'LM Charlie', 'LM Delta']);
    const semi = T.fixtures.find(f => f.team_a_id && f.team_b_id);
    const semi2 = T.fixtures.filter(f => f.team_a_id && f.team_b_id)[1];
    const M = semi.id;
    const A = semi.team_a_id, B = semi.team_b_id;
    // approved players for the two teams (a real registration flow would do this)
    await pool.query("INSERT INTO tournament_participants (tournament_id, user_id, team_id, status) VALUES (?, ?, ?, 'APPROVED'), (?, ?, ?, 'APPROVED')", [T.id, userIds.pa, A, T.id, userIds.pb, B]);

    // public payload
    const pub = await call('get', `/tournament-matches/${M}/live`);
    check('anyone (no login) can read the live match', pub.status === 200 && pub.data.match.team_a && pub.data.match.status === 'SCHEDULED', pub);
    check('public payload does not expose owner ids or who scored', !JSON.stringify(pub.data).match(/owner_id|owner_type|created_by/), Object.keys(pub.data.match));
    check('no YouTube link yet -> youtube is null (no empty video box)', pub.data.match.youtube === null, pub.data.match.youtube);
    check('players of both teams are listed', pub.data.team_a_players.length === 1 && pub.data.team_b_players.length === 1, [pub.data.team_a_players, pub.data.team_b_players]);
    check('roster exposes no contact details', !JSON.stringify(pub.data.team_a_players).match(/email|phone/), pub.data.team_a_players);

    // security: unauthenticated / plain user cannot touch the match
    check('guest cannot start a match (401)', (await call('post', `/tournament-matches/${M}/status`, null, { status: 'LIVE' })).status === 401);
    const uStart = await call('post', `/tournament-matches/${M}/status`, tokens.viewer, { status: 'LIVE' });
    check('normal user cannot start a match (403)', uStart.status === 403, uStart);
    check('normal user cannot score (403)', (await call('post', `/tournament-matches/${M}/events`, tokens.viewer, { event_type: 'GOAL', team_id: A })).status === 403);
    const acc = await call('get', `/tournament-matches/${M}/access`, tokens.viewer);
    check('access endpoint: viewer can_score=false can_manage=false', acc.data.can_score === false && acc.data.can_manage === false, acc.data);
    check('access endpoint: host can_score+can_manage', (await call('get', `/tournament-matches/${M}/access`, ownerTok)).data.can_manage === true);
    check('access endpoint: admin can_score+can_manage', (await call('get', `/tournament-matches/${M}/access`, adminTok)).data.can_score === true);

    // scoring before the match is live is refused
    check('cannot score before the match starts (409)', (await call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: 'GOAL', team_id: A })).status === 409);
    check('cannot pause a match that has not started (409)', (await call('post', `/tournament-matches/${M}/status`, ownerTok, { status: 'PAUSED' })).status === 409);
    check('bogus status is rejected (400)', (await call('post', `/tournament-matches/${M}/status`, ownerTok, { status: 'HACKED' })).status === 400);

    // YouTube: validation + ownership + embedding
    const ys = `/tournaments/${T.id}/streams`;
    for (const [label, url] of [['not a url', 'hello world'], ['other host', 'https://evil.example.com/watch?v=dQw4w9WgXcQ'], ['lookalike host', 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ'], ['javascript:', 'javascript:alert(1)'], ['credentials trick', 'https://youtube.com@evil.com/watch?v=dQw4w9WgXcQ'], ['no video id', 'https://www.youtube.com/'], ['channel handle', 'https://www.youtube.com/@somechannel/live']]) {
      const r = await call('post', ys, ownerTok, { youtube_url: url });
      check(`YouTube URL rejected: ${label}`, r.status === 400 && r.data.error, r);
    }
    check('normal user cannot set a YouTube link (403)', (await call('post', ys, tokens.viewer, { youtube_url: 'https://youtu.be/dQw4w9WgXcQ' })).status === 403);
    const other = await mk('Football', ['LM Echo', 'LM Foxtrot']);
    const cross = await call('post', ys, ownerTok, { youtube_url: 'https://youtu.be/dQw4w9WgXcQ', match_id: other.fixtures[0].id });
    check("cannot attach a stream to ANOTHER tournament's match (400)", cross.status === 400, cross);
    const okYt = await call('post', `${ys}`, ownerTok, { youtube_url: 'https://youtu.be/dQw4w9WgXcQ?si=abc', match_id: M });
    check('valid YouTube link saved for the match', okYt.status === 200 && okYt.data.youtube.embed_url.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'), okYt);
    const okYt2 = await call('post', `${ys}`, ownerTok, { youtube_url: 'https://www.youtube.com/live/aqz-KE-bpKQ', match_id: M });
    const streams = await call('get', ys);
    check('saving again UPDATES the link (one link per match, not a pile)', okYt2.status === 200 && streams.data.streams.filter(s => s.match_id === M).length === 1, streams.data);
    const pub2 = await call('get', `/tournament-matches/${M}/live`);
    check('live payload now carries the embeddable video (id aqz-KE-bpKQ)', pub2.data.match.youtube && pub2.data.match.youtube.id === 'aqz-KE-bpKQ' && /^https:\/\/www\.youtube-nocookie\.com\/embed\//.test(pub2.data.match.youtube.embed_url), pub2.data.match.youtube);
    const tYt = await call('post', ys, ownerTok, { youtube_url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk' });
    check('tournament-wide link saved too', tYt.status === 200);
    const pubOther = await call('get', `/tournament-matches/${T.fixtures.find(f => f.id !== M && f.team_a_id).id}/live`);
    check('a match without its own link falls back to the tournament-wide link', pubOther.data.match.youtube && pubOther.data.match.youtube.id === 'jfKfPfyJRdk', pubOther.data.match.youtube);

    // start
    const start = await call('post', `/tournament-matches/${M}/status`, ownerTok, { status: 'LIVE' });
    check('host starts the match', start.status === 200 && start.data.clock.running === true, start);
    check('starting twice is refused (409)', (await call('post', `/tournament-matches/${M}/status`, ownerTok, { status: 'LIVE' })).status === 409);
    const ln = await call('get', `/tournaments/${T.id}/live-now`);
    check('live-now lists the match with score, clock and video', ln.status === 200 && ln.data.matches.length === 1 && ln.data.matches[0].id === M && ln.data.matches[0].clock.running && ln.data.matches[0].youtube, ln.data);
    const tstat = (await call('get', `/tournaments/${T.id}`)).data.tournament.status;
    check('tournament status moved to LIVE automatically', tstat === 'LIVE', tstat);

    // scoring validation
    const goal = await call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: 'GOAL', team_id: A, value: 50 });
    check('host scores a goal; a tampered value (50) is ignored - server decides it is worth 1', goal.status === 200 && goal.data.team_a_score === 1 && goal.data.team_b_score === 0, goal);
    check('WICKET is not a football event (400)', (await call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: 'WICKET', team_id: A })).status === 400);
    check('unknown event type rejected (400)', (await call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: 'DROP TABLE', team_id: A })).status === 400);
    check('team that is not in this match rejected (400)', (await call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: 'GOAL', team_id: T.teams[3] === A || T.teams[3] === B ? T.teams[2] : T.teams[3] })).status === 400);
    check('missing team rejected (400)', (await call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: 'GOAL' })).status === 400);
    check("a player from the OTHER team cannot be credited (400)", (await call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: 'GOAL', team_id: A, player_id: userIds.pb })).status === 400);
    check('score cannot go below 0 (400)', (await call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: 'CORRECTION', team_id: B, value: -1 })).status === 400);
    const goalP = await call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: 'GOAL', team_id: B, player_id: userIds.pb });
    check('goal credited to a real player of that team', goalP.status === 200 && goalP.data.team_b_score === 1, goalP);
    await call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: 'YELLOW_CARD', team_id: A, player_id: userIds.pa });
    await call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: 'SUBSTITUTION', team_id: A, player_id: userIds.pa });
    const view = await call('get', `/tournament-matches/${M}/live`);
    check('football stats: goals 1-1, 1 yellow card, 1 substitution', view.data.stats.family === 'goals' && view.data.stats.a.goals === 1 && view.data.stats.b.goals === 1 && view.data.stats.a.yellow_cards === 1 && view.data.stats.a.substitutions === 1, view.data.stats);
    check('events feed shows player names', view.data.events.some(e => e.event_type === 'GOAL' && e.player_name === 'ZZ LM pb'), view.data.events.slice(0, 3));

    // assigned scorer
    const noRights = await call('post', `/tournaments/${T.id}/scorers`, tokens.viewer, { email: mail('scorer') });
    check('normal user cannot assign scorers (403)', noRights.status === 403, noRights);
    check('unknown email cannot be assigned (404)', (await call('post', `/tournaments/${T.id}/scorers`, ownerTok, { email: 'nobody_' + stamp + '@example.com' })).status === 404);
    const addSc = await call('post', `/tournaments/${T.id}/scorers`, ownerTok, { email: mail('scorer') });
    check('host assigns a scorer', addSc.status === 200 && addSc.data.scorer.user_id === userIds.scorer, addSc);
    check('scorers list is host-only', (await call('get', `/tournaments/${T.id}/scorers`, tokens.scorer)).status === 403 && (await call('get', `/tournaments/${T.id}/scorers`, ownerTok)).data.scorers.length === 1);
    const scAcc = await call('get', `/tournaments/${T.id}/can-manage`, tokens.scorer);
    check('scorer: can_score=true but can_manage=false', scAcc.data.can_score === true && scAcc.data.can_manage === false, scAcc.data);
    check('viewer: can_score=false', (await call('get', `/tournaments/${T.id}/can-manage`, tokens.viewer)).data.can_score === false);
    const scGoal = await call('post', `/tournament-matches/${M}/events`, tokens.scorer, { event_type: 'GOAL', team_id: A, player_id: userIds.pa });
    check('assigned scorer can score', scGoal.status === 200 && scGoal.data.team_a_score === 2, scGoal);
    check('scorer cannot change the YouTube link (403)', (await call('post', ys, tokens.scorer, { youtube_url: 'https://youtu.be/dQw4w9WgXcQ' })).status === 403);
    check('scorer cannot assign other scorers (403)', (await call('post', `/tournaments/${T.id}/scorers`, tokens.scorer, { email: mail('viewer') })).status === 403);
    check('scorer cannot edit the tournament (403)', (await call('put', `/tournaments/${T.id}`, tokens.scorer, { name: 'hijacked' })).status === 403);
    check('scorer cannot score a match of ANOTHER tournament (403)', (await call('post', `/tournament-matches/${other.fixtures[0].id}/status`, tokens.scorer, { status: 'LIVE' })).status === 403);
    const adminGoal = await call('post', `/tournament-matches/${M}/events`, adminTok, { event_type: 'GOAL', team_id: B });
    check('admin can score any match', adminGoal.status === 200 && adminGoal.data.team_b_score === 2, adminGoal);

    // undo
    const undo = await call('delete', `/tournament-matches/${M}/events/${adminGoal.data.eventId}`, tokens.scorer);
    check('scorer undoes an event; score reverts 2-1', undo.status === 200 && undo.data.team_b_score === 1 && undo.data.team_a_score === 2, undo);
    check('undo by a normal user is refused (403)', (await call('delete', `/tournament-matches/${M}/events/${scGoal.data.eventId}`, tokens.viewer)).status === 403);
    const markerId = (await call('get', `/tournament-matches/${M}/live`)).data.events.find(e => e.event_type === 'MATCH_LIVE').id;
    check('start/end markers cannot be undone (400)', (await call('delete', `/tournament-matches/${M}/events/${markerId}`, ownerTok)).status === 400);

    // period + break + clock
    check('host sets the period to 2nd Half', (await call('post', `/tournament-matches/${M}/period`, ownerTok, { label: '2nd Half' })).status === 200);
    check('invalid period rejected (400)', (await call('post', `/tournament-matches/${M}/period`, ownerTok, { label: 'Q9' })).status === 400);
    await sleep(1300);
    const brk = await call('post', `/tournament-matches/${M}/status`, ownerTok, { status: 'PAUSED' });
    check('host pauses for a break; clock stops', brk.status === 200 && brk.data.clock.running === false && brk.data.clock.elapsed_sec >= 1, brk.data);
    const el1 = (await call('get', `/tournament-matches/${M}/live`)).data.clock.elapsed_sec;
    await sleep(2200);
    const brkView = await call('get', `/tournament-matches/${M}/live`);
    check('clock does NOT advance during the break', brkView.data.clock.elapsed_sec === el1 && brkView.data.match.status === 'PAUSED', { el1, now: brkView.data.clock });
    check('break time shows in live-now as PAUSED', (await call('get', `/tournaments/${T.id}/live-now`)).data.matches[0].status === 'PAUSED');
    check('cannot score during a break (409)', (await call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: 'GOAL', team_id: A })).status === 409);
    const res = await call('post', `/tournament-matches/${M}/status`, tokens.scorer, { status: 'LIVE' });
    check('scorer resumes; clock running again from the same elapsed time', res.status === 200 && res.data.clock.running === true && res.data.clock.elapsed_sec >= el1, res.data);

    // finish (knockout: 2-1 -> winner A advances)
    check('normal user cannot end the match (403)', (await call('post', `/tournament-matches/${M}/status`, tokens.viewer, { status: 'FINISHED' })).status === 403);
    check('winner_id must be a team of the match (400)', (await call('post', `/tournament-matches/${M}/status`, ownerTok, { status: 'FINISHED', winner_id: 99999999 })).status === 400);
    const fin = await call('post', `/tournament-matches/${M}/status`, ownerTok, { status: 'FINISHED' });
    check('host ends the match; winner is the higher score (A)', fin.status === 200 && fin.data.winner_id === A, fin);
    const next = (await call('get', `/tournaments/${T.id}/fixtures`)).data.fixtures.find(f => f.id === semi.next_match_id);
    check('knockout: the winner moved into the next round', next && (next.team_a_id === A || next.team_b_id === A), next);
    check('scoring after the end is refused (409)', (await call('post', `/tournament-matches/${M}/events`, ownerTok, { event_type: 'GOAL', team_id: A })).status === 409);
    check('a finished match cannot be restarted (409)', (await call('post', `/tournament-matches/${M}/status`, ownerTok, { status: 'LIVE' })).status === 409);
    check('undo after the end is refused (409)', (await call('delete', `/tournament-matches/${M}/events/${scGoal.data.eventId}`, ownerTok)).status === 409);
    check('fixtures PATCH cannot reopen a finished match (409)', (await call('patch', `/tournaments/${T.id}/fixtures/${M}`, ownerTok, { status: 'LIVE' })).status === 400);
    check('fixtures PATCH cannot swap the teams of a finished match (409)', (await call('patch', `/tournaments/${T.id}/fixtures/${M}`, ownerTok, { team_a_id: T.teams[2] })).status === 409);
    check('finished match leaves live-now', (await call('get', `/tournaments/${T.id}/live-now`)).data.matches.length === 0);
    check('the finished clock is frozen with a final time', (await call('get', `/tournament-matches/${M}/live`)).data.clock.running === false);

    // knockout tie needs a winner
    await call('post', `/tournament-matches/${semi2.id}/status`, ownerTok, { status: 'LIVE' });
    const tie = await call('post', `/tournament-matches/${semi2.id}/status`, ownerTok, { status: 'FINISHED' });
    check('a level knockout match cannot be ended without a winner (400)', tie.status === 400 && tie.data.needs_winner === true, tie);
    const tieOk = await call('post', `/tournament-matches/${semi2.id}/status`, ownerTok, { status: 'FINISHED', winner_id: semi2.team_b_id });
    check('...but can with an explicit winner (penalties)', tieOk.status === 200 && tieOk.data.winner_id === semi2.team_b_id, tieOk);

    // scorer removal
    await call('delete', `/tournaments/${T.id}/scorers/${userIds.scorer}`, ownerTok);
    check('removed scorer loses access (403)', (await call('post', `/tournament-matches/${other.fixtures[0].id}/status`, tokens.scorer, { status: 'LIVE' })).status === 403 && (await call('get', `/tournaments/${T.id}/can-manage`, tokens.scorer)).data.can_score === false);
    const ytDel = await call('delete', `${ys}/${streams.data.streams.find(s => s.match_id === M).id}`, ownerTok);
    check('host removes the match video; it disappears (falls back to tournament link)', ytDel.status === 200 && (await call('get', `/tournament-matches/${M}/live`)).data.match.has_own_youtube === false);

    // =============================================================== CRICKET
    console.log('\n--- cricket ---');
    const C = await mk('Cricket', ['LM Kites', 'LM Hawks']);
    const cm = C.fixtures[0].id, KA = C.fixtures[0].team_a_id, KB = C.fixtures[0].team_b_id;
    await call('post', `/tournament-matches/${cm}/status`, ownerTok, { status: 'LIVE' });
    const ev = (type, team, value) => call('post', `/tournament-matches/${cm}/events`, ownerTok, { event_type: type, team_id: team, value });
    await ev('RUN', KA, 4); await ev('RUN', KA, 6); await ev('WIDE', KA); await ev('WICKET', KA); await ev('RUN', KA, 0); await ev('RUN', KA, 1);
    check('cricket: invalid run value 7 rejected (400)', (await ev('RUN', KA, 7)).status === 400);
    check('cricket: GOAL is not a cricket event (400)', (await ev('GOAL', KA)).status === 400);
    const cv = await call('get', `/tournament-matches/${cm}/live`);
    const ca = cv.data.stats.a;
    check('cricket scoreboard: 12 runs, 1 wicket, 0.5 overs (wide is not a legal ball)', cv.data.stats.family === 'cricket' && ca.runs === 12 && ca.wickets === 1 && ca.overs === '0.5' && ca.legal_balls === 5 && ca.fours === 1 && ca.sixes === 1, ca);
    for (let i = 0; i < 9; i++) await ev('WICKET', KA);
    check('cricket: an innings cannot lose an 11th wicket (400)', (await ev('WICKET', KA)).status === 400);
    const over = await call('get', `/tournament-matches/${cm}/live`);
    check('cricket: 10 wickets counted, overs roll over (0.5 + 9 balls = 2.2)', over.data.stats.a.wickets === 10 && over.data.stats.a.overs === '2.2', over.data.stats.a);
    await call('post', `/tournament-matches/${cm}/period`, ownerTok, { label: '2nd Innings' });
    await ev('RUN', KB, 2);
    check('cricket: second team scores independently (2/0 in 0.1)', (await call('get', `/tournament-matches/${cm}/live`)).data.stats.b.runs === 2);

    // =============================================================== BADMINTON (sets)
    console.log('\n--- badminton (sets) ---');
    const S = await mk('Badminton', ['LM Smash', 'LM Drop']);
    const sm = S.fixtures[0].id, SA = S.fixtures[0].team_a_id, SB = S.fixtures[0].team_b_id;
    await call('post', `/tournament-matches/${sm}/status`, ownerTok, { status: 'LIVE' });
    const sv = (type, team) => call('post', `/tournament-matches/${sm}/events`, ownerTok, { event_type: type, team_id: team });
    for (let i = 0; i < 3; i++) await sv('POINT', SA);
    await sv('POINT', SB);
    let sview = (await call('get', `/tournament-matches/${sm}/live`)).data;
    check('badminton: points in the current set 3-1, sets 0-0', sview.stats.family === 'sets' && sview.stats.a.points === 3 && sview.stats.b.points === 1 && sview.stats.a.sets === 0 && sview.match.team_a_score === 0, sview.stats);
    const setWon = await sv('SET_WON', SA);
    sview = (await call('get', `/tournament-matches/${sm}/live`)).data;
    check('badminton: SET_WON gives A one set and resets the set points (0-0, set 2)', setWon.status === 200 && sview.stats.a.sets === 1 && sview.stats.a.points === 0 && sview.stats.current_set === 2 && sview.match.team_a_score === 1, sview.stats);
    const undoSet = await call('delete', `/tournament-matches/${sm}/events/${setWon.data.eventId}`, ownerTok);
    sview = (await call('get', `/tournament-matches/${sm}/live`)).data;
    check('badminton: undoing the set restores the set points (3-1, sets 0)', undoSet.status === 200 && sview.stats.a.points === 3 && sview.stats.a.sets === 0, sview.stats);

    // =============================================================== BASKETBALL
    console.log('\n--- basketball ---');
    const K = await mk('Basketball', ['LM Hoops', 'LM Dunk']);
    const km = K.fixtures[0].id, HA = K.fixtures[0].team_a_id;
    await call('post', `/tournament-matches/${km}/status`, ownerTok, { status: 'LIVE' });
    await call('post', `/tournament-matches/${km}/events`, ownerTok, { event_type: '3_POINTS', team_id: HA });
    await call('post', `/tournament-matches/${km}/events`, ownerTok, { event_type: '2_POINTS', team_id: HA });
    const kv = (await call('get', `/tournament-matches/${km}/live`)).data;
    check('basketball: 3 + 2 = 5 points, 1 three-pointer', kv.match.team_a_score === 5 && kv.stats.a.threes === 1, kv.stats);

    // =============================================================== stats endpoints still work
    const st = await call('get', `/tournaments/${T.id}/stats`);
    check('tournament statistics endpoint still works with the new events', st.status === 200 && Array.isArray(st.data.topScorers), st.status);
    const pl = await call('get', `/tournaments/${T.id}/players`);
    check('public players endpoint lists the roster without contact details', pl.status === 200 && pl.data.players.length === 2 && !JSON.stringify(pl.data).match(/email|phone/), pl.data);
  } catch (e) {
    check('test run finished without an unexpected error', false, e.response ? { status: e.response.status, data: e.response.data } : e.stack);
  } finally {
    try {
      for (const id of tournaments) {
        await pool.query('DELETE FROM tournament_match_events WHERE match_id IN (SELECT id FROM tournament_fixtures WHERE tournament_id = ?)', [id]);
        for (const t of ['tournament_fixtures', 'tournament_teams', 'tournament_participants', 'tournament_audit_logs', 'tournament_registrations', 'tournament_scorers', 'tournament_streams']) await pool.query(`DELETE FROM ${t} WHERE tournament_id = ?`, [id]);
        await pool.query('DELETE FROM tournaments WHERE id = ?', [id]);
      }
      await pool.query("DELETE FROM users WHERE email LIKE 'zz_lm_%'");
      await pool.query("DELETE FROM owners WHERE email LIKE 'zz_lm_%'");
      const [[left]] = await pool.query("SELECT (SELECT COUNT(*) FROM tournaments WHERE name LIKE 'ZZ LM %') t, (SELECT COUNT(*) FROM users WHERE email LIKE 'zz_lm_%') u, (SELECT COUNT(*) FROM owners WHERE email LIKE 'zz_lm_%') o, (SELECT COUNT(*) FROM tournament_teams WHERE name LIKE 'LM %') tm");
      console.log('cleanup done; leftovers (tournaments/users/owners/teams):', left.t, left.u, left.o, left.tm);
    } catch (e) { console.log('CLEANUP FAILED:', e.message); }
    console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
