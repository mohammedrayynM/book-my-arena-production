// Idempotent schema setup for tournament view/share tracking (Phase 16 analytics).
const pool = require('./config/db');

module.exports = async function ensureTournamentAnalyticsColumns() {
  try {
    await pool.query('ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS view_count INT NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS share_count INT NOT NULL DEFAULT 0');
  } catch (error) {
    console.error('Tournament analytics column migration error:', error.message);
  }
};
