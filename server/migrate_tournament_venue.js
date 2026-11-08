// Idempotent schema setup for linking a tournament to an existing Book Arena turf listing (Phase 17).
const pool = require('./config/db');

module.exports = async function ensureTournamentVenueColumn() {
  try {
    await pool.query('ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS venue_turf_id INT NULL');
  } catch (error) {
    console.error('Tournament venue column migration error:', error.message);
  }
};
