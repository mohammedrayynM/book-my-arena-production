// Idempotent schema setup for the player ranking system (Phase 9).
// Ranking scores are always computed live from tournament_match_events using these
// admin-configurable weights — nothing here hardcodes the ranking formula itself.
const pool = require('./config/db');

const DEFAULT_SPORTS = ['Cricket', 'Football', 'Badminton', 'Tennis', 'Basketball', 'DEFAULT'];

module.exports = async function ensureRankingSettingsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranking_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sport VARCHAR(50) NOT NULL UNIQUE,
      points_per_goal DECIMAL(6,2) NOT NULL DEFAULT 5,
      points_per_assist DECIMAL(6,2) NOT NULL DEFAULT 3,
      points_per_mvp DECIMAL(6,2) NOT NULL DEFAULT 20,
      points_per_win DECIMAL(6,2) NOT NULL DEFAULT 10,
      points_per_tournament DECIMAL(6,2) NOT NULL DEFAULT 5,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  for (const sport of DEFAULT_SPORTS) {
    await pool.query(
      'INSERT IGNORE INTO ranking_settings (sport) VALUES (?)',
      [sport]
    );
  }
};
