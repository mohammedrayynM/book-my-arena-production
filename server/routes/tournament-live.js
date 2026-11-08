const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { verifyHost, findManageableTournament } = require('../utils/tournamentAccess');
const { liveMatchCards, tournamentStreamUrl, clockFields } = require('../utils/liveMatch');
const { youtubePayload } = require('../utils/youtube');
const { openChannelStream } = require('../utils/realtime');
const { dateOnlyResponses } = require('../utils/tournamentValidation');

const toId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
const MAX_SCORERS = 10;

// match_date etc. leave this router as plain YYYY-MM-DD
router.use(dateOnlyResponses);

// GET /api/tournaments/:id/live-now - Public. Light payload for the tournament page's live section:
// every match in play right now (score, clock, sport stats, video) + the tournament-wide stream.
// Polled every few seconds, so it stays small and does one round of queries.
router.get('/:id/live-now', async (req, res) => {
  try {
    const id = toId(req.params.id);
    if (!id) return res.status(404).json({ success: false, error: 'Tournament not found' });
    const [ts] = await pool.query('SELECT id, name, slug, sport, status FROM tournaments WHERE id = ?', [id]);
    if (ts.length === 0) return res.status(404).json({ success: false, error: 'Tournament not found' });
    const tournament = ts[0];

    const [fixtures] = await pool.query(`
      SELECT f.*, ta.name AS team_a_name, ta.logo AS team_a_logo, ta.color AS team_a_color,
             tb.name AS team_b_name, tb.logo AS team_b_logo, tb.color AS team_b_color
      FROM tournament_fixtures f
      LEFT JOIN tournament_teams ta ON f.team_a_id = ta.id
      LEFT JOIN tournament_teams tb ON f.team_b_id = tb.id
      WHERE f.tournament_id = ? AND f.status IN ('LIVE', 'PAUSED')
      ORDER BY (f.status = 'LIVE') DESC, f.id ASC
    `, [id]);

    const [upcoming] = await pool.query(`
      SELECT f.id, f.stage, f.group_name, f.match_date, f.match_time, f.venue, ta.name AS team_a_name, tb.name AS team_b_name
      FROM tournament_fixtures f
      LEFT JOIN tournament_teams ta ON f.team_a_id = ta.id
      LEFT JOIN tournament_teams tb ON f.team_b_id = tb.id
      WHERE f.tournament_id = ? AND f.status = 'SCHEDULED' AND f.team_a_id IS NOT NULL AND f.team_b_id IS NOT NULL
      ORDER BY f.match_date IS NULL, f.match_date, f.match_time, f.id
      LIMIT 1
    `, [id]);

    const nowMs = Date.now();
    const matches = await liveMatchCards(pool, tournament, fixtures, nowMs);
    res.json({
      success: true,
      tournament,
      matches,
      next_match: upcoming[0] || null,
      stream: youtubePayload(await tournamentStreamUrl(pool, id)),
      server_time_ms: nowMs,
    });
  } catch (error) {
    console.error('Error fetching live-now:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch live matches' });
  }
});

// GET /api/tournaments/live/stream - Public SSE for the tournament LIST: one connection that wakes on any live
// score change anywhere, so browsing cards update without opening a stream per tournament. Declared before
// /:id/stream so the literal "live" is not read as a tournament id.
router.get('/live/stream', (req, res) => {
  openChannelStream(require('../utils/liveMatch').LIVE_FEED_CHANNEL, req, res);
});

// GET /api/tournaments/:id/stream - Public SSE: wakes tournament viewers when any of its matches / streams change
router.get('/:id/stream', (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(404).json({ success: false, error: 'Tournament not found' });
  openChannelStream('tournament:' + id, req, res);
});

// GET /api/tournaments/:id/players - Public roster (approved players only, no contact details)
router.get('/:id/players', async (req, res) => {
  try {
    const id = toId(req.params.id);
    if (!id) return res.status(404).json({ success: false, error: 'Tournament not found' });
    const [players] = await pool.query(`
      SELECT p.id, p.user_id, p.team_id, tm.name AS team_name,
             COALESCE(p.player_name, u.name) AS name, COALESCE(p.profile_photo, u.profile_pic) AS avatar,
             p.jersey_number, p.position
      FROM tournament_participants p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN tournament_teams tm ON p.team_id = tm.id
      WHERE p.tournament_id = ? AND p.status = 'APPROVED'
      ORDER BY tm.name, name
    `, [id]);
    res.json({ success: true, players });
  } catch (error) {
    console.error('Error fetching players:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch players' });
  }
});

// ---- Assigned scorers (host / admin only) ------------------------------------------------------------

router.get('/:id/scorers', verifyToken, verifyHost, async (req, res) => {
  try {
    const t = await findManageableTournament(pool, req.params.id, req.tHost, { columns: 'id' });
    if (!t) return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    const [scorers] = await pool.query(`
      SELECT s.user_id, u.name, u.email, s.created_at
      FROM tournament_scorers s JOIN users u ON s.user_id = u.id
      WHERE s.tournament_id = ? ORDER BY s.id
    `, [t.id]);
    res.json({ success: true, scorers });
  } catch (error) {
    console.error('Error listing scorers:', error);
    res.status(500).json({ success: false, error: 'Failed to load scorers' });
  }
});

router.post('/:id/scorers', verifyToken, verifyHost, async (req, res) => {
  try {
    const t = await findManageableTournament(pool, req.params.id, req.tHost, { columns: 'id' });
    if (!t) return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });

    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Enter the scorer\'s Book Arena account email' });
    }
    const [users] = await pool.query('SELECT id, name FROM users WHERE LOWER(email) = ? LIMIT 1', [email]);
    if (users.length === 0) {
      return res.status(404).json({ success: false, error: 'No Book Arena player account uses that email. Ask them to sign up first.' });
    }
    const [[count]] = await pool.query('SELECT COUNT(*) AS c FROM tournament_scorers WHERE tournament_id = ?', [t.id]);
    const [existing] = await pool.query('SELECT id FROM tournament_scorers WHERE tournament_id = ? AND user_id = ?', [t.id, users[0].id]);
    if (existing.length === 0) {
      if (count.c >= MAX_SCORERS) return res.status(400).json({ success: false, error: `A tournament can have up to ${MAX_SCORERS} scorers` });
      await pool.query('INSERT INTO tournament_scorers (tournament_id, user_id, assigned_by_id, assigned_by_type) VALUES (?, ?, ?, ?)',
        [t.id, users[0].id, req.tHost.id, req.tHost.type]);
    }
    res.json({ success: true, scorer: { user_id: users[0].id, name: users[0].name } });
  } catch (error) {
    console.error('Error adding scorer:', error);
    res.status(500).json({ success: false, error: 'Failed to add scorer' });
  }
});

router.delete('/:id/scorers/:userId', verifyToken, verifyHost, async (req, res) => {
  try {
    const t = await findManageableTournament(pool, req.params.id, req.tHost, { columns: 'id' });
    if (!t) return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    await pool.query('DELETE FROM tournament_scorers WHERE tournament_id = ? AND user_id = ?', [t.id, toId(req.params.userId) || 0]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing scorer:', error);
    res.status(500).json({ success: false, error: 'Failed to remove scorer' });
  }
});

module.exports = router;
