// Lets users and admins host tournaments, not only turf owners. Existing rows are all owner-hosted,
// so the column defaults to 'owner' and nothing already in the database changes meaning.
const pool = require('./config/db');

module.exports = async function ensureTournamentHostTypeColumn() {
  try {
    await pool.query("ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS owner_type VARCHAR(10) NOT NULL DEFAULT 'owner'");
  } catch (error) {
    console.error('Tournament host type migration error:', error.message);
  }
};
