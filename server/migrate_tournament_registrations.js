// Idempotent schema setup for paid team registration (Phase 7).
// Mirrors the pattern used by migrate_tournaments.js — required and invoked once at server boot.
const pool = require('./config/db');

module.exports = async function ensureTournamentRegistrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_registrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tournament_id INT NOT NULL,
      user_id INT NOT NULL,
      team_id INT NULL,
      team_name VARCHAR(255) NOT NULL,
      amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      razorpay_order_id VARCHAR(100) NULL,
      razorpay_payment_id VARCHAR(100) NULL,
      status ENUM('PENDING','PAID','FAILED','REFUNDED','CANCELLED') NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tournament (tournament_id),
      INDEX idx_user (user_id),
      INDEX idx_status (status)
    )
  `);
};
