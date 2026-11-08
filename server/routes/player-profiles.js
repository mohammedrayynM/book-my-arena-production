const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET /api/players/:id - Player tournament analytics profile & insights
router.get('/:id', async (req, res) => {
  try {
    const userId = req.params.id;

    // Fetch user profile
    const [users] = await pool.query(`
      SELECT id, name, email, profile_pic as profile_photo, created_at
      FROM users WHERE id = ?
    `, [userId]);

    if (users.length === 0) {
      return res.status(404).json({ success: false, error: 'Player profile not found' });
    }
    const user = users[0];

    // Fetch tournament participation records
    const [participations] = await pool.query(`
      SELECT p.*, t.name as tournament_name, t.sport, t.slug as tournament_slug, tm.name as team_name
      FROM tournament_participants p
      JOIN tournaments t ON p.tournament_id = t.id
      LEFT JOIN tournament_teams tm ON p.team_id = tm.id
      WHERE p.user_id = ? AND p.status = 'APPROVED'
      ORDER BY p.registered_at DESC
    `, [userId]);

    // Fetch player match events history
    const [events] = await pool.query(`
      SELECT e.*, f.tournament_id, f.stage, f.match_date, t.name as tournament_name, t.sport
      FROM tournament_match_events e
      JOIN tournament_fixtures f ON e.match_id = f.id
      JOIN tournaments t ON f.tournament_id = t.id
      WHERE e.player_id = ? AND e.is_undone = false
      ORDER BY e.timestamp DESC
    `, [userId]);

    // Calculate aggregated statistics
    let totalMatches = 0;
    let totalGoals = 0;
    let totalAssists = 0;
    let totalPoints = 0;
    let yellowCards = 0;
    let redCards = 0;
    let mvpCount = 0;

    const matchesSet = new Set();

    events.forEach(ev => {
      matchesSet.add(ev.match_id);
      if (['GOAL', 'RUN', 'POINT', '1_POINT', '2_POINTS', '3_POINTS'].includes(ev.event_type)) {
        totalGoals += (ev.value || 1);
        totalPoints += (ev.value || 1);
      }
      if (ev.event_type === 'ASSIST') totalAssists += 1;
      if (ev.event_type === 'YELLOW_CARD') yellowCards += 1;
      if (ev.event_type === 'RED_CARD') redCards += 1;
      if (ev.event_type === 'MVP') mvpCount += 1;
    });

    totalMatches = matchesSet.size;

    // Generate real dynamic insights
    const insights = [];
    if (totalMatches > 0) {
      const avgScore = (totalGoals / totalMatches).toFixed(1);
      if (avgScore > 0) {
        insights.push(`Average ${avgScore} points/goals per match`);
      }
    }
    if (totalGoals >= 5) {
      insights.push(`Top scorer with ${totalGoals} career tournament points/goals`);
    }
    if (totalAssists >= 3) {
      insights.push(`Playmaker with ${totalAssists} assists`);
    }
    if (mvpCount > 0) {
      insights.push(`Awarded MVP ${mvpCount} time${mvpCount > 1 ? 's' : ''}`);
    }
    if (participations.length > 0) {
      insights.push(`Participated in ${participations.length} tournament${participations.length > 1 ? 's' : ''}`);
    }

    res.json({
      success: true,
      player: {
        ...user,
        stats: {
          total_tournaments: participations.length,
          total_matches: totalMatches,
          total_goals: totalGoals,
          total_assists: totalAssists,
          total_points: totalPoints,
          yellow_cards: yellowCards,
          red_cards: redCards,
          mvp_count: mvpCount
        },
        insights,
        participations,
        recent_events: events.slice(0, 15)
      }
    });
  } catch (error) {
    console.error('Error fetching player profile:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch player profile' });
  }
});

module.exports = router;
