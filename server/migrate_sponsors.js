// Idempotent schema setup for the tournament sponsor system (Phase 14).
const pool = require('./config/db');

module.exports = async function ensureTournamentSponsorsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_sponsors (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tournament_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      logo VARCHAR(500) NULL,
      website_url VARCHAR(500) NULL,
      sponsor_type ENUM('TITLE','GOLD','SILVER','BRONZE','PARTNER') NOT NULL DEFAULT 'PARTNER',
      package_amount DECIMAL(10,2) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tournament (tournament_id)
    )
  `);
};
