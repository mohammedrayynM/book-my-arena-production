const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { verifyHost } = require('../utils/tournamentAccess');
const { broadcastSse, openChannelStream } = require('../utils/realtime');
const { fire: fireNotification } = require('../utils/notifications/events');
const { familyOf, resolveScoreEvent, PERIODS, isMatchMarker } = require('../utils/sportScoring');
const { scoringAccess, buildLivePayload, clockFields, notifyMatch } = require('../utils/liveMatch');
const { replay: replayCricket, availableBatters, bowlerEligibility, DISMISSALS } = require('../utils/cricket');

const toId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);

// Allowed match lifecycle: SCHEDULED -> LIVE <-> PAUSED (break) -> FINISHED. A finished match is final.
const TRANSITIONS = {
  SCHEDULED: ['LIVE'],
  LIVE: ['PAUSED', 'FINISHED'],
  PAUSED: ['LIVE', 'FINISHED'],
};

// Locks the fixture row so two scorers acting at once cannot corrupt the score/clock, then loads what the
// permission check needs. Returns null when the match does not exist.
async function lockMatch(conn, matchId) {
  const [rows] = await conn.query('SELECT * FROM tournament_fixtures WHERE id = ? FOR UPDATE', [matchId]);
  if (rows.length === 0) return null;
  const match = rows[0];
  const [t] = await conn.query('SELECT owner_id, owner_type, sport, status AS tournament_status, is_paid_to_admin, name AS tournament_name FROM tournaments WHERE id = ?', [match.tournament_id]);
  return t.length ? { ...match, ...t[0] } : null;
}

async function requireScorer(conn, res, matchId, host) {
  const match = await lockMatch(conn, matchId);
  if (!match) { await conn.rollback(); res.status(404).json({ success: false, error: 'Match not found' }); return null; }
  const access = await scoringAccess(conn, match, host);
  if (!access.canScore) {
    await conn.rollback();
    res.status(403).json({ success: false, error: 'Only the tournament host, an admin or an assigned scorer can change this match' });
    return null;
  }
  return match;
}

const actorTag = (host) => `${host.type}:${host.id}`;

// GET /api/tournament-matches/:id/live - Public live match center (scoreboard, stats, players, events, video)
router.get('/:id/live', async (req, res) => {
  try {
    const matchId = toId(req.params.id);
    const payload = matchId ? await buildLivePayload(pool, matchId) : null;
    if (!payload) return res.status(404).json({ success: false, error: 'Match not found' });
    res.json({ success: true, ...payload });
  } catch (error) {
    console.error('Error fetching live match:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch live match' });
  }
});

// GET /api/tournament-matches/:id/stream - Public Server-Sent Events: a tiny "something changed" signal for viewers of this
// match. Clients re-read /live when it arrives, so the screen updates at once without polling hard.
router.get('/:id/stream', (req, res) => {
  const matchId = toId(req.params.id);
  if (!matchId) return res.status(404).json({ success: false, error: 'Match not found' });
  openChannelStream('match:' + matchId, req, res);
});

// GET /api/tournament-matches/:id/access - What may the signed-in caller do with this match?
// Always 200 so the app can show/hide the control center without tripping auth handling.
router.get('/:id/access', verifyToken, verifyHost, async (req, res) => {
  try {
    const matchId = toId(req.params.id);
    const [rows] = matchId ? await pool.query(`
      SELECT f.id, f.tournament_id, t.owner_id, t.owner_type, t.status AS tournament_status, t.is_paid_to_admin
      FROM tournament_fixtures f JOIN tournaments t ON f.tournament_id = t.id WHERE f.id = ?`, [matchId]) : [[]];
    if (rows.length === 0) return res.json({ success: true, can_manage: false, can_score: false });
    const access = await scoringAccess(pool, rows[0], req.tHost);
    res.json({ success: true, can_manage: access.canManage, can_score: access.canScore });
  } catch (error) {
    res.json({ success: true, can_manage: false, can_score: false });
  }
});

// POST /api/tournament-matches/:id/events - Record a score event (goal, run, wicket, card...)
router.post('/:id/events', verifyToken, verifyHost, async (req, res) => {
  const matchId = toId(req.params.id);
  if (!matchId) return res.status(404).json({ success: false, error: 'Match not found' });
  const body = req.body || {};
  if (typeof body.event_type !== 'string' || !body.event_type) {
    return res.status(400).json({ success: false, error: 'event_type is required' });
  }
  const clientEventId = body.client_event_id == null ? null : String(body.client_event_id);
  if (clientEventId !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(clientEventId)) {
    return res.status(400).json({ success: false, error: 'client_event_id must be a unique 8-64 character request ID' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const match = await requireScorer(connection, res, matchId, req.tHost);
    if (!match) return;

    const [[priorEvent]] = clientEventId
      ? await connection.query(
        'SELECT id FROM tournament_match_events WHERE match_id = ? AND client_event_id = ?',
        [matchId, clientEventId]
      )
      : [[null]];
    if (priorEvent) {
      await connection.rollback();
      return res.json({
        success: true,
        duplicate: true,
        message: 'This score event was already recorded',
        eventId: priorEvent.id,
        team_a_score: match.team_a_score,
        team_b_score: match.team_b_score,
      });
    }

    if (match.status !== 'LIVE') {
      await connection.rollback();
      return res.status(409).json({ success: false, error: match.status === 'PAUSED' ? 'The match is on a break - resume it before scoring' : match.status === 'FINISHED' ? 'This match has finished - its result is final' : 'Start the match before scoring' });
    }

    const spec = resolveScoreEvent(match.sport, body.event_type, body.value);
    if (spec.error) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: spec.error });
    }

    const teamId = toId(body.team_id);
    if (!teamId || (teamId !== match.team_a_id && teamId !== match.team_b_id)) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'team_id must be one of the two teams playing this match' });
    }
    const isTeamA = teamId === match.team_a_id;

    // A player, when given, must be an approved member of THAT team in THIS tournament
    // Players are referenced by their ROSTER id (tournament_participants.id), because a club player usually
    // has no Book Arena account at all. A plain user id still resolves, for rows written before squads existed.
    const checkPlayer = async (playerId, inTeamId = teamId) => {
      if (playerId === undefined || playerId === null || playerId === '') return null;
      const pid = toId(playerId);
      if (!pid) return false;
      const [p] = await connection.query(
        `SELECT id FROM tournament_participants
          WHERE tournament_id = ? AND team_id = ? AND status = 'APPROVED' AND (id = ? OR user_id = ?)
          ORDER BY (id = ?) DESC LIMIT 1`,
        [match.tournament_id, inTeamId, pid, pid, pid]
      );
      return p.length ? p[0].id : false;
    };
    const playerId = await checkPlayer(body.player_id);
    if (playerId === false) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'That player is not an approved member of this team' });
    }
    const meta = { by: actorTag(req.tHost) };
    // Cricket: the bowler belongs to the OTHER team (the one in the field)
    if (familyOf(match.sport) === 'cricket' && body.bowler_id !== undefined && body.bowler_id !== null && body.bowler_id !== '') {
      const bowlerId = await checkPlayer(body.bowler_id, isTeamA ? match.team_b_id : match.team_a_id);
      if (bowlerId === false) {
        await connection.rollback();
        return res.status(400).json({ success: false, error: 'The bowler must be an approved player of the fielding team' });
      }
      meta.bowler_id = bowlerId;
    }
    // ---- cricket: the rest of the delivery -----------------------------------------------------------
    if (familyOf(match.sport) === 'cricket') {
      const fieldingTeamId = isTeamA ? match.team_b_id : match.team_a_id;
      meta.innings = Math.max(1, toId(body.innings) || match.current_innings || 1);
      meta.bowling_team_id = fieldingTeamId;

      const nonStriker = await checkPlayer(body.non_striker_id);
      if (nonStriker === false) { await connection.rollback(); return res.status(400).json({ success: false, error: 'The non-striker is not an approved player of the batting team' }); }
      if (nonStriker) meta.non_striker_id = nonStriker;
      if (playerId && nonStriker && playerId === nonStriker) {
        await connection.rollback();
        return res.status(400).json({ success: false, error: 'The striker and the non-striker must be two different players' });
      }

      if (spec.type === 'NO_BALL') {
        const offBat = Number(body.off_bat) || 0;
        if (offBat < 0 || offBat > 6 || offBat > spec.delta - 1) {
          await connection.rollback();
          return res.status(400).json({ success: false, error: 'Runs off the bat must fit inside the no-ball total' });
        }
        meta.off_bat = offBat;
      }

      if (spec.type === 'WICKET') {
        const kind = String(body.dismissal || 'bowled');
        if (!DISMISSALS.includes(kind)) {
          await connection.rollback();
          return res.status(400).json({ success: false, error: `Dismissal must be one of: ${DISMISSALS.join(', ')}` });
        }
        meta.dismissal = kind;
        meta.runs = spec.delta;
        const outId = await checkPlayer(body.out_player_id === undefined ? playerId : body.out_player_id);
        if (outId === false) { await connection.rollback(); return res.status(400).json({ success: false, error: 'The dismissed player is not an approved player of the batting team' }); }
        meta.out_player_id = outId || playerId;
        if (body.fielder_id) {
          const fielder = await checkPlayer(body.fielder_id, fieldingTeamId);
          if (fielder === false) { await connection.rollback(); return res.status(400).json({ success: false, error: 'The fielder is not an approved player of the fielding team' }); }
          meta.fielder_id = fielder;
        }
        if (body.off_wide) meta.off_wide = true;
        if (body.off_no_ball) meta.off_no_ball = true;
        if (body.new_batter_id) {
          const nextMan = await checkPlayer(body.new_batter_id);
          if (nextMan === false) { await connection.rollback(); return res.status(400).json({ success: false, error: 'The incoming batter is not an approved player of the batting team' }); }
          // a batter who is already out, or already at the crease, cannot walk in
          const [priorEvents] = await connection.query(
            'SELECT id, event_type, team_id, player_id, value, metadata, is_undone FROM tournament_match_events WHERE match_id = ? AND is_undone = false', [matchId]);
          const state = replayCricket(priorEvents, { oversLimit: match.overs_limit || null });
          const [squadRows] = await connection.query(
            "SELECT id FROM tournament_participants WHERE tournament_id = ? AND team_id = ? AND status = 'APPROVED'", [match.tournament_id, teamId]);
          if (!availableBatters(state.current, squadRows.map((r) => r.id)).includes(Number(nextMan))) {
            await connection.rollback();
            return res.status(400).json({ success: false, error: 'That batter is already out or already at the crease' });
          }
          meta.new_batter_id = nextMan;
        }
      }
    }

    if (body.metadata && typeof body.metadata === 'object') {
      if (typeof body.metadata.note === 'string') meta.note = body.metadata.note.trim().slice(0, 100);
      if (body.metadata.player_in_id !== undefined) {
        const inId = await checkPlayer(body.metadata.player_in_id);
        if (inId === false) {
          await connection.rollback();
          return res.status(400).json({ success: false, error: 'The incoming player is not an approved member of this team' });
        }
        if (inId) meta.player_in_id = inId;
      }
    }

    if (spec.max) {
      const [[c]] = await connection.query('SELECT COUNT(*) AS c FROM tournament_match_events WHERE match_id = ? AND team_id = ? AND event_type = ? AND is_undone = false', [matchId, teamId, spec.type]);
      if (c.c >= spec.max) {
        await connection.rollback();
        return res.status(400).json({ success: false, error: `A team can only lose ${spec.max} wickets` });
      }
    }

    const current = isTeamA ? match.team_a_score : match.team_b_score;
    if (current + spec.delta < 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'A score cannot go below 0' });
    }

    const [result] = await connection.query(`
      INSERT INTO tournament_match_events (match_id, event_type, team_id, player_id, value, metadata, created_by, client_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [matchId, spec.type, teamId, playerId, spec.delta, JSON.stringify(meta), req.user.id, clientEventId]);
    const eventId = result.insertId;

    if (spec.delta !== 0) {
      await connection.query(`UPDATE tournament_fixtures SET ${isTeamA ? 'team_a_score' : 'team_b_score'} = ${isTeamA ? 'team_a_score' : 'team_b_score'} + ? WHERE id = ?`, [spec.delta, matchId]);
    }
    // the fixture row is locked for this transaction, so the new totals are exactly current + delta (one query saved per tap)
    const updated = {
      team_a_score: match.team_a_score + (isTeamA ? spec.delta : 0),
      team_b_score: match.team_b_score + (isTeamA ? 0 : spec.delta),
    };
    // Keep the fixture's own idea of who is at the crease in step with the ball just recorded, so a scorer
    // who reopens the screen (or a second scorer) picks up exactly where play is.
    if (familyOf(match.sport) === 'cricket') {
      const after = replayCricket(
        (await connection.query('SELECT id, event_type, team_id, player_id, value, metadata, is_undone FROM tournament_match_events WHERE match_id = ? AND is_undone = false', [matchId]))[0],
        { oversLimit: match.overs_limit || null });
      await connection.query(
        'UPDATE tournament_fixtures SET striker_id = ?, non_striker_id = ?, bowler_id = ?, batting_team_id = ?, bowling_team_id = ?, current_innings = ? WHERE id = ?',
        [after.current.striker_id, after.current.non_striker_id, after.current.bowler_id,
         after.current.batting_team_id, isTeamA ? match.team_b_id : match.team_a_id,
         after.current.innings, matchId]);
    }

    await connection.commit();

    notifyMatch(matchId, match.tournament_id);
    broadcastSse('tournament_event', {
      matchId, eventId, eventType: spec.type, teamId, playerId, value: spec.delta,
      teamAScore: updated.team_a_score, teamBScore: updated.team_b_score, timestamp: new Date(),
    });

    res.json({ success: true, message: 'Event recorded successfully', eventId, team_a_score: updated.team_a_score, team_b_score: updated.team_b_score });
  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error('Error recording match event:', error);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to record event' });
  } finally {
    connection.release();
  }
});

// POST /api/tournament-matches/:id/status - START (LIVE), BREAK (PAUSED), RESUME (LIVE), END (FINISHED)
router.post('/:id/status', verifyToken, verifyHost, async (req, res) => {
  const matchId = toId(req.params.id);
  if (!matchId) return res.status(404).json({ success: false, error: 'Match not found' });
  const { status, winner_id, period_info } = req.body || {};
  if (!['LIVE', 'PAUSED', 'FINISHED'].includes(status)) {
    return res.status(400).json({ success: false, error: 'status must be LIVE, PAUSED or FINISHED' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const match = await requireScorer(connection, res, matchId, req.tHost);
    if (!match) return;

    if (!(TRANSITIONS[match.status] || []).includes(status)) {
      await connection.rollback();
      const why = match.status === 'FINISHED' ? 'This match has finished - its result is final' : `A ${match.status.toLowerCase()} match cannot move to ${status}`;
      return res.status(409).json({ success: false, error: why });
    }
    if (match.tournament_status === 'CANCELLED') {
      await connection.rollback();
      return res.status(409).json({ success: false, error: 'This tournament is cancelled' });
    }
    if (status === 'LIVE' && match.status === 'SCHEDULED' && (!match.team_a_id || !match.team_b_id || match.team_a_id === match.team_b_id)) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'Both teams must be decided before the match can start' });
    }

    const family = familyOf(match.sport);
    const requestedLabel = period_info && typeof period_info === 'object' ? period_info.label : undefined;
    if (requestedLabel !== undefined && !PERIODS[family].includes(requestedLabel)) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: `period must be one of: ${PERIODS[family].join(', ')}` });
    }

    // ---- winner
    let winnerId = match.winner_id;
    if (status === 'FINISHED') {
      const requested = winner_id === undefined || winner_id === null || winner_id === '' ? null : toId(winner_id);
      if (requested !== null && requested !== match.team_a_id && requested !== match.team_b_id) {
        await connection.rollback();
        return res.status(400).json({ success: false, error: 'winner_id must be one of the two teams playing this match' });
      }
      winnerId = requested || (match.team_a_score > match.team_b_score ? match.team_a_id : match.team_b_score > match.team_a_score ? match.team_b_id : null);
      if (match.next_match_id && !winnerId) {
        await connection.rollback();
        return res.status(400).json({ success: false, error: 'A knockout match cannot end level - choose the winner', needs_winner: true });
      }
    }

    // ---- clock: only time spent LIVE counts
    const now = Date.now();
    let elapsed = Number(match.clock_elapsed_sec) || 0;
    if (match.status === 'LIVE' && match.clock_started_ms != null) elapsed += Math.max(0, Math.floor((now - Number(match.clock_started_ms)) / 1000));
    if (match.status === 'SCHEDULED') elapsed = 0;
    const startedMs = status === 'LIVE' ? now : null;

    const currentInfo = typeof match.period_info === 'string' ? (() => { try { return JSON.parse(match.period_info); } catch { return null; } })() : match.period_info;
    const label = requestedLabel || (match.status === 'SCHEDULED' ? PERIODS[family][0] : (currentInfo && currentInfo.label) || null);

    await connection.query(`
      UPDATE tournament_fixtures
      SET status = ?, winner_id = ?, period_info = ?, clock_elapsed_sec = ?, clock_started_ms = ?
      WHERE id = ?
    `, [status, winnerId || null, label ? JSON.stringify({ label }) : null, elapsed, startedMs, matchId]);

    await connection.query(
      'INSERT INTO tournament_match_events (match_id, event_type, metadata, created_by) VALUES (?, ?, ?, ?)',
      [matchId, `MATCH_${status}`, JSON.stringify({ by: actorTag(req.tHost), from: match.status }), req.user.id]
    );

    // Knockout: the winner moves straight into the next round
    if (status === 'FINISHED' && winnerId && match.next_match_id) {
      const slotColumn = match.next_match_slot === 'B' ? 'team_b_id' : 'team_a_id';
      await connection.query(`UPDATE tournament_fixtures SET ${slotColumn} = ? WHERE id = ?`, [winnerId, match.next_match_id]);
    }

    // Tournament status follows its matches
    if (status === 'LIVE') {
      await connection.query(
        "UPDATE tournaments SET status = 'LIVE' WHERE id = ? AND status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'UPCOMING')",
        [match.tournament_id]
      );
    }
    if (status === 'FINISHED') {
      const [[unfinished]] = await connection.query(
        "SELECT COUNT(*) as c FROM tournament_fixtures WHERE tournament_id = ? AND status NOT IN ('FINISHED', 'CANCELLED')",
        [match.tournament_id]
      );
      if (unfinished.c === 0) {
        await connection.query("UPDATE tournaments SET status = 'COMPLETED' WHERE id = ? AND status = 'LIVE'", [match.tournament_id]);
      }
    }

    await connection.commit();

    notifyMatch(matchId, match.tournament_id);
    broadcastSse('tournament_status_change', { matchId, status, winnerId, timestamp: new Date() });

    // Notifications (in-app + push, deduplicated, only the two teams). Kickoff is announced once - resuming after a break is not a
    // kickoff - and the final result once. Live SCORE changes are never pushed: they stream inside the app.
    if (status === 'LIVE' && match.status === 'SCHEDULED') fireNotification('tournament.match_live', { fixtureId: matchId });
    if (status === 'FINISHED') {
      fireNotification('tournament.match_finished', { fixtureId: matchId });
      fireNotification('tournament.completed', { tournamentId: match.tournament_id }); // only announces if this was the last match
    }

    res.json({
      success: true,
      message: `Match status updated to ${status}`,
      status,
      winner_id: winnerId || null,
      clock: clockFields({ status, clock_elapsed_sec: elapsed, clock_started_ms: startedMs }),
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error('Error updating match status:', error);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to update match status' });
  } finally {
    connection.release();
  }
});

// POST /api/tournament-matches/:id/period - Set the current period (1st half, Q3, 2nd innings, Set 2...)
router.post('/:id/period', verifyToken, verifyHost, async (req, res) => {
  const matchId = toId(req.params.id);
  if (!matchId) return res.status(404).json({ success: false, error: 'Match not found' });
  const label = req.body && req.body.label;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const match = await requireScorer(connection, res, matchId, req.tHost);
    if (!match) return;
    const allowed = PERIODS[familyOf(match.sport)];
    if (!allowed.includes(label)) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: `period must be one of: ${allowed.join(', ')}` });
    }
    if (!['LIVE', 'PAUSED'].includes(match.status)) {
      await connection.rollback();
      return res.status(409).json({ success: false, error: 'The period can only change while the match is in play' });
    }
    await connection.query('UPDATE tournament_fixtures SET period_info = ? WHERE id = ?', [JSON.stringify({ label }), matchId]);
    await connection.query(
      'INSERT INTO tournament_match_events (match_id, event_type, metadata, created_by) VALUES (?, ?, ?, ?)',
      [matchId, 'PERIOD_CHANGE', JSON.stringify({ label, by: actorTag(req.tHost) }), req.user.id]
    );
    await connection.commit();
    notifyMatch(matchId, match.tournament_id);
    broadcastSse('tournament_status_change', { matchId, status: match.status, period: label, timestamp: new Date() });
    res.json({ success: true, period: label });
  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error('Error changing period:', error);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to change period' });
  } finally {
    connection.release();
  }
});

// DELETE /api/tournament-matches/:id/events/:eventId - Undo a score event (only while the match is in play)
router.delete('/:id/events/:eventId', verifyToken, verifyHost, async (req, res) => {
  const matchId = toId(req.params.id);
  const eventId = toId(req.params.eventId);
  if (!matchId || !eventId) return res.status(404).json({ success: false, error: 'Event not found' });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const match = await requireScorer(connection, res, matchId, req.tHost);
    if (!match) return;

    if (!['LIVE', 'PAUSED'].includes(match.status)) {
      await connection.rollback();
      return res.status(409).json({ success: false, error: 'Events can only be undone while the match is in play' });
    }

    const [events] = await connection.query('SELECT * FROM tournament_match_events WHERE id = ? AND match_id = ? FOR UPDATE', [eventId, matchId]);
    if (events.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, error: 'Event not found' });
    }
    const event = events[0];
    if (isMatchMarker(event.event_type)) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'Match start/end markers cannot be undone' });
    }
    if (event.is_undone) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'Event already undone' });
    }

    await connection.query(
      'UPDATE tournament_match_events SET is_undone = true, undone_by = ?, undone_at = CURRENT_TIMESTAMP WHERE id = ?',
      [req.user.id, eventId]
    );

    if (event.value && event.team_id) {
      const col = event.team_id === match.team_a_id ? 'team_a_score' : event.team_id === match.team_b_id ? 'team_b_score' : null;
      if (col) await connection.query(`UPDATE tournament_fixtures SET ${col} = GREATEST(0, ${col} - ?) WHERE id = ?`, [event.value, matchId]);
    }

    const [[updated]] = await connection.query('SELECT team_a_score, team_b_score FROM tournament_fixtures WHERE id = ?', [matchId]);
    await connection.commit();

    notifyMatch(matchId, match.tournament_id);
    broadcastSse('tournament_event_undo', {
      matchId, eventId, teamId: event.team_id, value: event.value,
      teamAScore: updated.team_a_score, teamBScore: updated.team_b_score, timestamp: new Date(),
    });

    res.json({ success: true, message: 'Event undone successfully', team_a_score: updated.team_a_score, team_b_score: updated.team_b_score });
  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error('Error undoing event:', error);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to undo event' });
  } finally {
    connection.release();
  }
});


// ==================================================================================================
// CRICKET SET-UP — who is batting, who is bowling, and who is on strike.
// These are the things a scoreboard needs before the first delivery, and they were simply not recorded
// anywhere before: the old screen could only guess from the last ball.
// ==================================================================================================

/** The fixture plus the caller's scoring rights, or null. */
async function scorableMatch(db, matchId, host) {
  const [rows] = await db.query(
    `SELECT f.*, t.sport, t.owner_id, t.owner_type, t.players_per_team, t.status AS tournament_status, t.is_paid_to_admin
       FROM tournament_fixtures f JOIN tournaments t ON t.id = f.tournament_id WHERE f.id = ?`, [matchId]);
  if (!rows.length) return { error: 'Match not found', status: 404 };
  const access = await scoringAccess(db, rows[0], host);
  if (!access.canScore) return { error: 'You are not a scorer for this tournament', status: 403 };
  return { match: rows[0] };
}

// POST /api/tournament-matches/:id/innings — choose the batting and bowling teams and the overs limit
router.post('/:id/innings', verifyToken, verifyHost, async (req, res) => {
  try {
    const matchId = toId(req.params.id);
    if (!matchId) return res.status(404).json({ success: false, error: 'Match not found' });
    const found = await scorableMatch(pool, matchId, req.tHost);
    if (found.error) return res.status(found.status).json({ success: false, error: found.error });
    const match = found.match;
    if (familyOf(match.sport) !== 'cricket') return res.status(400).json({ success: false, error: 'This match is not cricket' });
    if (match.status === 'FINISHED') return res.status(409).json({ success: false, error: 'The match has finished; the innings setup is locked.' });

    const b = req.body || {};
    const battingTeamId = toId(b.batting_team_id);
    const bowlingTeamId = toId(b.bowling_team_id);
    const both = [match.team_a_id, match.team_b_id].map(Number);
    if (!battingTeamId || !bowlingTeamId || !both.includes(battingTeamId) || !both.includes(bowlingTeamId)) {
      return res.status(400).json({ success: false, error: 'Both teams must be the two teams playing this match' });
    }
    if (battingTeamId === bowlingTeamId) {
      return res.status(400).json({ success: false, error: 'A team cannot bat and bowl at the same time' });
    }
    const oversLimit = b.overs_limit === null || b.overs_limit === undefined || b.overs_limit === '' ? null : parseInt(b.overs_limit, 10);
    if (oversLimit !== null && (!Number.isInteger(oversLimit) || oversLimit < 1 || oversLimit > 100)) {
      return res.status(400).json({ success: false, error: 'Overs per innings must be between 1 and 100' });
    }
    const innings = Math.max(1, Math.min(4, parseInt(b.innings, 10) || match.current_innings || 1));

    // Changing sides after balls have been bowled in this innings would rewrite the scorecard.
    const [[bowled]] = await pool.query(
      "SELECT COUNT(*) AS n FROM tournament_match_events WHERE match_id = ? AND is_undone = false AND event_type IN ('RUN','BYE','LEG_BYE','WIDE','NO_BALL','WICKET') AND JSON_EXTRACT(metadata, '$.innings') = ?",
      [matchId, innings]);
    if (Number(bowled.n) > 0 && Number(match.batting_team_id) !== battingTeamId) {
      return res.status(409).json({ success: false, error: 'This innings has already started, so the batting side cannot be changed.' });
    }

    await pool.query(
      `UPDATE tournament_fixtures
          SET batting_team_id = ?, bowling_team_id = ?, overs_limit = COALESCE(?, overs_limit), current_innings = ?,
              striker_id = NULL, non_striker_id = NULL, bowler_id = NULL
        WHERE id = ?`,
      [battingTeamId, bowlingTeamId, oversLimit, innings, matchId]);

    notifyMatch(matchId, match.tournament_id);
    res.json({ success: true, message: 'Innings set up', batting_team_id: battingTeamId, bowling_team_id: bowlingTeamId, overs_limit: oversLimit, innings });
  } catch (error) {
    console.error('Error setting up innings:', error);
    res.status(500).json({ success: false, error: 'Failed to set up the innings' });
  }
});

// POST /api/tournament-matches/:id/players — pick the striker, the non-striker and the bowler
router.post('/:id/players', verifyToken, verifyHost, async (req, res) => {
  try {
    const matchId = toId(req.params.id);
    if (!matchId) return res.status(404).json({ success: false, error: 'Match not found' });
    const found = await scorableMatch(pool, matchId, req.tHost);
    if (found.error) return res.status(found.status).json({ success: false, error: found.error });
    const match = found.match;
    if (familyOf(match.sport) !== 'cricket') return res.status(400).json({ success: false, error: 'This match is not cricket' });
    if (match.status === 'FINISHED') return res.status(409).json({ success: false, error: 'The match has finished; player selection is locked.' });
    if (!match.batting_team_id || !match.bowling_team_id) {
      return res.status(400).json({ success: false, error: 'Choose the batting and bowling teams first' });
    }

    const b = req.body || {};
    const inTeam = async (ref, teamId) => {
      if (ref === undefined || ref === null || ref === '') return null;
      const id = toId(ref);
      if (!id) return false;
      const [r] = await pool.query(
        "SELECT id FROM tournament_participants WHERE tournament_id = ? AND team_id = ? AND status = 'APPROVED' AND id = ? LIMIT 1",
        [match.tournament_id, teamId, id]);
      return r.length ? r[0].id : false;
    };

    const striker = await inTeam(b.striker_id, match.batting_team_id);
    const nonStriker = await inTeam(b.non_striker_id, match.batting_team_id);
    const bowler = await inTeam(b.bowler_id, match.bowling_team_id);
    if (striker === false) return res.status(400).json({ success: false, error: 'The striker must be a player in the batting team' });
    if (nonStriker === false) return res.status(400).json({ success: false, error: 'The non-striker must be a player in the batting team' });
    if (bowler === false) return res.status(400).json({ success: false, error: 'The bowler must be a player in the bowling team' });
    if (striker && nonStriker && striker === nonStriker) {
      return res.status(400).json({ success: false, error: 'The two batters must be different players' });
    }

    const [events] = await pool.query(
      'SELECT id, event_type, team_id, player_id, value, metadata, is_undone FROM tournament_match_events WHERE match_id = ? AND is_undone = false', [matchId]);
    const state = replayCricket(events, { oversLimit: match.overs_limit || null });
    const [squad] = await pool.query(
      "SELECT id FROM tournament_participants WHERE tournament_id = ? AND team_id = ? AND status = 'APPROVED'", [match.tournament_id, match.batting_team_id]);
    const free = availableBatters(state.current, squad.map((r) => r.id));

    // a batter who is already out cannot be sent in again
    for (const [who, id] of [['striker', striker], ['non-striker', nonStriker]]) {
      if (!id) continue;
      const card = state.current.batters[String(id)];
      const alreadyIn = Number(state.current.striker_id) === Number(id) || Number(state.current.non_striker_id) === Number(id);
      if (card && card.out) return res.status(400).json({ success: false, error: `That ${who} is already out in this innings` });
      if (!alreadyIn && !free.includes(Number(id)) && card && card.out) {
        return res.status(400).json({ success: false, error: `That ${who} cannot bat again` });
      }
    }
    if (bowler) {
      const verdict = bowlerEligibility(state.current, bowler, { oversLimit: match.overs_limit || null });
      if (!verdict.ok) return res.status(400).json({ success: false, error: verdict.error });
    }

    await pool.query(
      `UPDATE tournament_fixtures SET striker_id = COALESCE(?, striker_id), non_striker_id = COALESCE(?, non_striker_id),
              bowler_id = COALESCE(?, bowler_id) WHERE id = ?`,
      [striker, nonStriker, bowler, matchId]);

    notifyMatch(matchId, match.tournament_id);
    res.json({ success: true, message: 'Players selected', striker_id: striker, non_striker_id: nonStriker, bowler_id: bowler });
  } catch (error) {
    console.error('Error selecting players:', error);
    res.status(500).json({ success: false, error: 'Failed to select the players' });
  }
});

// POST /api/tournament-matches/:id/swap-strike — the scorer corrects who is on strike
router.post('/:id/swap-strike', verifyToken, verifyHost, async (req, res) => {
  try {
    const matchId = toId(req.params.id);
    const found = await scorableMatch(pool, matchId, req.tHost);
    if (found.error) return res.status(found.status).json({ success: false, error: found.error });
    await pool.query('UPDATE tournament_fixtures SET striker_id = non_striker_id, non_striker_id = striker_id WHERE id = ?', [matchId]);
    notifyMatch(matchId, found.match.tournament_id);
    res.json({ success: true, message: 'Strike swapped' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to swap the strike' });
  }
});

module.exports = router;
