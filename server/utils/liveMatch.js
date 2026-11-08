// Shared helpers for live matches: who may score, the match clock, and the public live payload.
const { canManageRow } = require('./tournamentAccess');
const { familyOf, summarize, isMatchMarker, playerStats, currentCricket } = require('./sportScoring');
const { youtubePayload } = require('./youtube');
const { broadcastChannel } = require('./realtime');

// One shared channel carrying every live-score change, for screens that show many tournaments at once.
const LIVE_FEED_CHANNEL = 'live:feed';

// Assigned scorers are ordinary user accounts a host has added to a tournament. They may run the live
// score (start/pause/end, score events, undo) and nothing else.
async function isAssignedScorer(db, tournamentId, host) {
  if (!host || host.type !== 'user') return false;
  const [rows] = await db.query('SELECT id FROM tournament_scorers WHERE tournament_id = ? AND user_id = ? LIMIT 1', [tournamentId, host.id]);
  return rows.length > 0;
}

// `row` must carry tournament_id + owner_id + owner_type.
async function scoringAccess(db, row, host) {
  const canManage = canManageRow(row, host);
  const draftUnpaid = row.tournament_status === 'DRAFT' && !row.is_paid_to_admin;
  const paymentAllowed = !draftUnpaid || host.type === 'admin';
  const canScore = paymentAllowed && (canManage || await isAssignedScorer(db, row.tournament_id, host));
  return { canManage: paymentAllowed && canManage, canScore };
}

// ---- clock -------------------------------------------------------------------------------------------
// Stored as accumulated seconds + the epoch-ms the clock last started running (null while stopped).
// Epoch milliseconds avoid any DB/server timezone conversion.
function clockFields(match, nowMs = Date.now()) {
  const accumulated = Number(match.clock_elapsed_sec) || 0;
  const startedMs = match.clock_started_ms != null ? Number(match.clock_started_ms) : null;
  const running = match.status === 'LIVE' && startedMs != null;
  return {
    status: match.status,
    running,
    elapsed_sec: accumulated + (running ? Math.max(0, Math.floor((nowMs - startedMs) / 1000)) : 0),
    accumulated_sec: accumulated,
    running_since_ms: running ? startedMs : null,
    server_time_ms: nowMs,
  };
}

function periodLabel(match) {
  let info = match.period_info;
  if (typeof info === 'string') { try { info = JSON.parse(info); } catch { info = null; } }
  return (info && info.label) || null;
}

async function tournamentStreamUrl(db, tournamentId) {
  const [rows] = await db.query(
    "SELECT youtube_url FROM tournament_streams WHERE tournament_id = ? AND match_id IS NULL AND stream_status <> 'ENDED' ORDER BY id DESC LIMIT 1",
    [tournamentId]
  );
  return rows[0] ? rows[0].youtube_url : null;
}

async function activeEvents(db, matchIds) {
  if (matchIds.length === 0) return [];
  const [rows] = await db.query(
    `SELECT id, match_id, event_type, team_id, player_id, value, metadata FROM tournament_match_events WHERE match_id IN (${matchIds.map(() => '?').join(',')}) AND is_undone = false`,
    matchIds
  );
  return rows;
}

// Compact card used by the tournament page's live section (one query pair for all live matches).
async function liveMatchCards(db, tournament, fixtureRows, nowMs = Date.now()) {
  const events = await activeEvents(db, fixtureRows.map(f => f.id));
  const tournamentStream = fixtureRows.some(f => !f.youtube_url) ? await tournamentStreamUrl(db, tournament.id) : null;
  return fixtureRows.map((f) => {
    const stats = summarize(tournament.sport, f, events.filter(e => e.match_id === f.id));
    return {
      id: f.id,
      stage: f.stage,
      group_name: f.group_name,
      status: f.status,
      team_a: { id: f.team_a_id, name: f.team_a_name || 'TBD', logo: f.team_a_logo || null, color: f.team_a_color || null },
      team_b: { id: f.team_b_id, name: f.team_b_name || 'TBD', logo: f.team_b_logo || null, color: f.team_b_color || null },
      team_a_score: f.team_a_score ?? 0,
      team_b_score: f.team_b_score ?? 0,
      period: periodLabel(f),
      stats,
      clock: clockFields(f, nowMs),
      youtube: youtubePayload(f.youtube_url) || youtubePayload(tournamentStream),
    };
  });
}

// Everything the Live Match page needs. Public: never includes owner ids, contact details or who scored.
async function buildLivePayload(db, matchId, nowMs = Date.now()) {
  const [matches] = await db.query(`
    SELECT f.*, t.name AS tournament_name, t.sport, t.slug AS tournament_slug, t.status AS tournament_status
    FROM tournament_fixtures f
    JOIN tournaments t ON f.tournament_id = t.id
    WHERE f.id = ?
  `, [matchId]);
  if (matches.length === 0) return null;
  const f = matches[0];

  const teamSql = 'SELECT id, name, logo, color FROM tournament_teams WHERE id = ?';
  const [[teamA], [teamB]] = await Promise.all([
    f.team_a_id ? db.query(teamSql, [f.team_a_id]) : [[]],
    f.team_b_id ? db.query(teamSql, [f.team_b_id]) : [[]],
  ]);

  // LEFT JOIN: most club players have no Book Arena account, and an INNER JOIN here hid every one of them
  // from the team sheets on the scoring screen.
  const playersSql = `
    SELECT p.id, p.user_id, p.team_id, COALESCE(p.player_name, u.name) AS name, COALESCE(p.profile_photo, u.profile_pic) AS avatar,
           p.jersey_number, p.position, p.player_role, p.batting_style, p.bowling_style,
           p.is_captain, p.is_vice_captain, p.is_substitute
    FROM tournament_participants p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.team_id = ? AND p.tournament_id = ? AND p.status = 'APPROVED'
    ORDER BY p.is_substitute ASC, p.id ASC`;
  const [[teamAPlayers], [teamBPlayers]] = await Promise.all([
    f.team_a_id ? db.query(playersSql, [f.team_a_id, f.tournament_id]) : [[]],
    f.team_b_id ? db.query(playersSql, [f.team_b_id, f.tournament_id]) : [[]],
  ]);

  const [events] = await db.query(`
    SELECT e.id, e.event_type, e.team_id, e.player_id, e.value, e.metadata, e.timestamp, e.is_undone, e.undone_at,
           COALESCE(rp.player_name, u.name) AS player_name, t.name AS team_name
    FROM tournament_match_events e
    LEFT JOIN tournament_participants rp ON rp.id = e.player_id
    LEFT JOIN users u ON e.player_id = u.id
    LEFT JOIN tournament_teams t ON e.team_id = t.id
    WHERE e.match_id = ?
    ORDER BY e.id DESC
    LIMIT 300
  `, [matchId]);

  // Stats must use EVERY non-undone event (a 50-over cricket match has more than the 300 shown in the feed).
  const [allEvents] = await db.query(
    'SELECT id, event_type, team_id, player_id, value, metadata FROM tournament_match_events WHERE match_id = ? AND is_undone = false',
    [matchId]
  );
  const scoring = allEvents.filter(e => !isMatchMarker(e.event_type));
  const stats = summarize(f.sport, f, scoring);
  const family = familyOf(f.sport);

  // ---- cricket: the full scorecard, with names attached to every id ----------------------------------
  let cricket = null;
  if (family === 'cricket') {
    const nameOf = new Map();
    for (const p of [...teamAPlayers, ...teamBPlayers]) nameOf.set(Number(p.id), p.name);
    const named = (card) => ({ ...card, name: nameOf.get(Number(card.player_id)) || 'Player' });
    const full = stats.cricket || require('./cricket').replay(scoring, { oversLimit: f.overs_limit || null });
    // Before the first delivery there is nothing to replay, so who is at the crease comes from the fixture —
    // that is exactly what the scorer chose on the set-up screen.
    const strikerId = full.current.striker_id || f.striker_id || null;
    const nonStrikerId = full.current.non_striker_id || f.non_striker_id || null;
    const bowlerId = full.current.bowler_id || f.bowler_id || null;
    full.current.striker_id = strikerId;
    full.current.non_striker_id = nonStrikerId;
    full.current.bowler_id = bowlerId;
    cricket = {
      ...full,
      innings: full.innings.map((inn) => ({
        ...inn,
        batting_card: inn.batting_card.map(named),
        bowling_card: inn.bowling_card.map(named),
        fall_of_wickets: inn.fall_of_wickets.map((w) => ({ ...w, name: nameOf.get(Number(w.player_id)) || 'Player' })),
      })),
      striker: strikerId ? { id: strikerId, name: nameOf.get(Number(strikerId)) || 'Player', runs: 0, balls: 0, fours: 0, sixes: 0, strike_rate: 0, ...(full.current.batters[String(strikerId)] || {}) } : null,
      non_striker: nonStrikerId ? { id: nonStrikerId, name: nameOf.get(Number(nonStrikerId)) || 'Player', runs: 0, balls: 0, fours: 0, sixes: 0, strike_rate: 0, ...(full.current.batters[String(nonStrikerId)] || {}) } : null,
      bowler: bowlerId ? { id: bowlerId, name: nameOf.get(Number(bowlerId)) || 'Player', overs: '0.0', runs: 0, wickets: 0, maidens: 0, economy: 0, ...(full.current.bowlers[String(bowlerId)] || {}) } : null,
      setup: {
        batting_team_id: f.batting_team_id || full.current.batting_team_id || null,
        bowling_team_id: f.bowling_team_id || full.current.bowling_team_id || null,
        overs_limit: f.overs_limit || null,
        current_innings: f.current_innings || full.current.innings,
        ready: !!(strikerId && nonStrikerId && bowlerId),
      },
    };
    cricket.current = cricket.innings[cricket.innings.length - 1] || full.current;
  }
  const streamUrl = f.youtube_url || await tournamentStreamUrl(db, f.tournament_id);

  return {
    match: {
      id: f.id,
      tournament_id: f.tournament_id,
      tournament_name: f.tournament_name,
      tournament_slug: f.tournament_slug,
      tournament_status: f.tournament_status,
      sport: f.sport,
      family,
      stage: f.stage,
      duration_min: f.duration_min || null,
      format_label: f.format_label || null,
      group_name: f.group_name,
      round_number: f.round_number,
      match_number: f.match_number,
      venue: f.venue,
      match_date: f.match_date,
      match_time: f.match_time,
      status: f.status,
      winner_id: f.winner_id,
      is_knockout: !!f.next_match_id,
      team_a_id: f.team_a_id,
      team_b_id: f.team_b_id,
      team_a: teamA[0] || null,
      team_b: teamB[0] || null,
      team_a_score: f.team_a_score ?? 0,
      team_b_score: f.team_b_score ?? 0,
      period: periodLabel(f),
      youtube: youtubePayload(streamUrl),
      has_own_youtube: !!f.youtube_url,
    },
    stats,
    cricket,
    player_stats: playerStats(f.sport, scoring),
    current: family === 'cricket' ? currentCricket(scoring) : null,
    clock: clockFields(f, nowMs),
    team_a_players: teamAPlayers,
    team_b_players: teamBPlayers,
    events,
    server_time_ms: nowMs,
  };
}

// Wake everyone watching this match (and its tournament) so they re-fetch immediately instead of waiting for a poll.
// The signal carries no scores on purpose: clients re-read the payload, so what they show is always what is stored.
function notifyMatch(matchId, tournamentId, type = 'match_update') {
  const payload = { type, matchId: Number(matchId), tournamentId: Number(tournamentId), ts: Date.now() };
  broadcastChannel('match:' + matchId, 'match_update', payload);
  broadcastChannel('tournament:' + tournamentId, 'match_update', payload);
  // ...and the one channel the tournament LIST subscribes to. A browsing screen cannot open a stream per
  // tournament, so every live score change also lands here; the payload is still just "something changed".
  broadcastChannel(LIVE_FEED_CHANNEL, 'match_update', payload);
}

function notifyTournament(tournamentId) {
  const payload = { type: 'tournament_update', tournamentId: Number(tournamentId), ts: Date.now() };
  broadcastChannel('tournament:' + tournamentId, 'match_update', payload);
  broadcastChannel(LIVE_FEED_CHANNEL, 'match_update', payload);
}

module.exports = { LIVE_FEED_CHANNEL, notifyTournament, notifyMatch, isAssignedScorer, scoringAccess, clockFields, periodLabel, tournamentStreamUrl, liveMatchCards, buildLivePayload };
