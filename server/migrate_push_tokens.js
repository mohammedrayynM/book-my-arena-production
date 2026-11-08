// Adds the push_token column that routes/users.js POST /push-token has always tried to write to.
// The column never existed, so every push-token save has silently no-op'd since launch (Phase 18 fix).
const pool = require('./config/db');

module.exports = async function ensurePushTokenColumn() {
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token VARCHAR(255) NULL');
  } catch (error) {
    console.error('push_token column migration error:', error.message);
  }
};
