// Idempotent schema setup for the Live Match experience:
//  - tournament_fixtures gets a real match clock (accumulated seconds + epoch-ms the clock last started),
//    so pauses/breaks do not count as playing time
//  - tournament_scorers: user accounts a host has assigned to run the live score for one tournament
const pool = require('./config/db');

module.exports = async function ensureLiveMatchSchema() {
  try {
    await pool.query('ALTER TABLE tournament_fixtures ADD COLUMN IF NOT EXISTS clock_elapsed_sec INT NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE tournament_fixtures ADD COLUMN IF NOT EXISTS clock_started_ms BIGINT NULL');
    await pool.query('ALTER TABLE tournament_fixtures ADD COLUMN IF NOT EXISTS duration_min INT NULL');
    await pool.query('ALTER TABLE tournament_fixtures ADD COLUMN IF NOT EXISTS format_label VARCHAR(60) NULL');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_scorers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tournament_id INT NOT NULL,
        user_id INT NOT NULL,
        assigned_by_id INT NULL,
        assigned_by_type VARCHAR(10) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_tournament_scorer (tournament_id, user_id),
        INDEX (user_id)
      )
    `);
  } catch (error) {
    console.error('Live match schema migration error:', error.message);
  }
};
