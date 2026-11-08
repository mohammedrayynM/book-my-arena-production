// Idempotent schema setup for tournament pricing tiers (Phase 15).
// Deliberately scaffolding only: seeds Free/Pro/Premium plans, admin-editable.
// Not yet wired into tournament creation or used to gate any feature — per the product
// spec's own guidance ("do not implement all monetization immediately, prioritize PMF first").
const pool = require('./config/db');

module.exports = async function ensureTournamentPlansTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_plans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) NOT NULL UNIQUE,
      price DECIMAL(10,2) NOT NULL DEFAULT 0,
      features JSON NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  const defaults = [
    ['Free', 0, JSON.stringify(['Basic tournament', 'Teams', 'Fixtures', 'Results']), 0],
    ['Pro', 799, JSON.stringify(['Live scoring', 'Public tournament page', 'Points table', 'Player statistics', 'Registration', 'Sharing', 'Tournament poster']), 1],
    ['Premium', 1999, JSON.stringify(['Advanced statistics', 'Live scoreboard', 'Sponsor support', 'Tournament promotion', 'Advanced analytics', 'Custom branding']), 2],
  ];
  for (const [name, price, features, sort_order] of defaults) {
    await pool.query(
      'INSERT IGNORE INTO tournament_plans (name, price, features, sort_order) VALUES (?, ?, ?, ?)',
      [name, price, features, sort_order]
    );
  }
};
