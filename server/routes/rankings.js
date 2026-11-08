const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

const GOAL_EVENTS = ['GOAL', 'RUN', 'POINT', '1_POINT', '2_POINTS', '3_POINTS'];

async function getWeights(sport) {
  const [rows] = await pool.query('SELECT * FROM ranking_settings WHERE sport = ?', [sport || 'DEFAULT']);
  if (rows.length > 0) return rows[0];
  const [fallback] = await pool.query("SELECT * FROM ranking_settings WHERE sport = 'DEFAULT'");
  return fallback[0] || {
    points_per_goal: 5, points_per_assist: 3, points_per_mvp: 20, points_per_win: 10, points_per_tournament: 5
  };
}

// GET /api/rankings - Public leaderboard, filterable by sport/city/turf/time period.
// The formula itself is never hardcoded: all weights come from ranking_settings (admin-configurable).
router.get('/', async (req, res) => {
  try {
    const { sport, city, turf, period = 'all', limit = 50 } = req.query;
    const weights = await getWeights(sport);

    const periodClause = period === 'week' ? 'AND e.timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)'
      : period === 'month' ? 'AND e.timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)'
      : '';

    const filters = [];
    const params = [weights.points_per_goal, weights.points_per_assist, weights.points_per_mvp];
    if (sport) { filters.push('t.sport = ?'); params.push(sport); }
    if (city) { filters.push('t.location LIKE ?'); params.push(`%${city}%`); }
    if (turf) { filters.push('t.venue LIKE ?'); params.push(`%${turf}%`); }
    const filterClause = filters.length ? 'AND ' + filters.join(' AND ') : '';

    const [rows] = await pool.query(`
      SELECT u.id as user_id, u.name, u.profile_pic,
        SUM(
          CASE
            WHEN e.event_type IN (${GOAL_EVENTS.map(() => '?').join(',')}) THEN e.value * ?
            WHEN e.event_type = 'ASSIST' THEN ?
            WHEN e.event_type = 'MVP' THEN ?
            ELSE 0
          END
        ) as event_score,
        COUNT(DISTINCT e.match_id) as matches_played,
        COUNT(DISTINCT f.tournament_id) as tournaments_played
      FROM tournament_match_events e
      JOIN tournament_fixtures f ON e.match_id = f.id
      JOIN tournaments t ON f.tournament_id = t.id
      JOIN users u ON e.player_id = u.id
      WHERE e.is_undone = false ${periodClause} ${filterClause}
      GROUP BY u.id, u.name, u.profile_pic
    `, [...GOAL_EVENTS, ...params]);

    const rankings = rows
      .map(r => ({
        user_id: r.user_id,
        name: r.name,
        profile_photo: r.profile_pic,
        matches_played: r.matches_played,
        tournaments_played: r.tournaments_played,
        score: Math.round(Number(r.event_score || 0) + Number(r.tournaments_played || 0) * Number(weights.points_per_tournament)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(limit) || 50)
      .map((r, i) => ({ rank: i + 1, ...r }));

    res.json({
      success: true,
      filters: { sport: sport || 'All', city: city || 'All', turf: turf || 'All', period },
      rankings
    });
  } catch (error) {
    console.error('Error computing rankings:', error);
    res.status(500).json({ success: false, error: 'Failed to compute rankings' });
  }
});

// GET /api/rankings/settings - Admin views the configurable point weights per sport
router.get('/settings', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM ranking_settings ORDER BY sport ASC');
    res.json({ success: true, settings: rows });
  } catch (error) {
    console.error('Error fetching ranking settings:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch ranking settings' });
  }
});

// PUT /api/rankings/settings/:sport - Admin updates the point weights for one sport
router.put('/settings/:sport', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { sport } = req.params;
    const { points_per_goal, points_per_assist, points_per_mvp, points_per_win, points_per_tournament } = req.body;

    const [result] = await pool.query(`
      UPDATE ranking_settings SET
        points_per_goal = COALESCE(?, points_per_goal),
        points_per_assist = COALESCE(?, points_per_assist),
        points_per_mvp = COALESCE(?, points_per_mvp),
        points_per_win = COALESCE(?, points_per_win),
        points_per_tournament = COALESCE(?, points_per_tournament)
      WHERE sport = ?
    `, [points_per_goal, points_per_assist, points_per_mvp, points_per_win, points_per_tournament, sport]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Unknown sport ranking profile' });
    }

    res.json({ success: true, message: 'Ranking weights updated' });
  } catch (error) {
    console.error('Error updating ranking settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update ranking settings' });
  }
});

module.exports = router;
