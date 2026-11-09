const pool = require('./config/db');

async function migrate() {
  console.log('🚀 Starting Booking Fields Migration...');
  const columns = [
    ['need_players', 'BOOLEAN DEFAULT FALSE'],
    ['players_needed', 'INT DEFAULT 0'],
    ['contribution_amount', 'DECIMAL(10, 2) DEFAULT 0.00'],
    ['sport_type', 'VARCHAR(50) DEFAULT NULL'],
    ['match_type', "VARCHAR(50) DEFAULT 'friendly'"],
    ['skill_level', "VARCHAR(50) DEFAULT 'all'"],
    ['contact_phone', 'VARCHAR(20) DEFAULT NULL'],
    ['note', 'TEXT DEFAULT NULL'],
    ['player_request_created', 'BOOLEAN DEFAULT FALSE']
  ];

  for (const [col, def] of columns) {
    try {
      await pool.query(`ALTER TABLE bookings ADD COLUMN ${col} ${def}`);
      console.log(`  ✅ Added bookings.${col}`);
    } catch (e) {
      if (e.message.includes('Duplicate column')) {
        console.log(`  ℹ️  bookings.${col} already exists`);
      } else {
        console.log(`  ❌ bookings.${col}: ${e.message}`);
      }
    }
  }

  console.log('🎉 Migration finished!');
  process.exit(0);
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
