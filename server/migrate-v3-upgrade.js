/**
 * Migration V3 - Major Upgrade
 * Adds: 30-min slots, 24h mode, multi-court, advance payment
 * SAFE: All changes are additive (ADD COLUMN IF NOT EXISTS)
 */
const mysql = require('mysql2/promise');
require('dotenv').config();

async function migrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  });

  console.log('✅ Connected to database');
  console.log('🔧 Starting V3 Migration...\n');

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1. TURFS TABLE — Add slot_duration, time_format, advance_percent
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('━━━ TURFS TABLE UPGRADES ━━━');
  const turfCols = [
    ['slot_duration', "INT DEFAULT 60"],           // 30 or 60 minutes
    ['time_format', "VARCHAR(5) DEFAULT '12h'"],    // '12h' or '24h'
    ['advance_percent', "INT DEFAULT 100"],          // 20, 30, 50, 100
  ];

  for (const [col, def] of turfCols) {
    try {
      await connection.query(`ALTER TABLE turfs ADD COLUMN ${col} ${def}`);
      console.log(`  ✅ Added turfs.${col}`);
    } catch (e) {
      if (e.message.includes('Duplicate column') || e.message.includes('duplicate column')) {
        console.log(`  ℹ️  turfs.${col} already exists`);
      } else {
        console.log(`  ❌ turfs.${col}: ${e.message}`);
      }
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2. CREATE COURTS TABLE — Multi-court support
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n━━━ COURTS TABLE ━━━');
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS courts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        turf_id INT NOT NULL,
        name VARCHAR(200) NOT NULL,
        sport_type VARCHAR(100) NOT NULL,
        price_per_hour DECIMAL(10, 2) NOT NULL,
        description TEXT,
        images JSON,
        amenities JSON,
        slot_duration INT DEFAULT 60,
        time_format VARCHAR(5) DEFAULT '12h',
        advance_percent INT DEFAULT 100,
        is_active BOOLEAN DEFAULT TRUE,
        open_time VARCHAR(10) DEFAULT '06:00',
        close_time VARCHAR(10) DEFAULT '23:00',
        markup_type VARCHAR(20) DEFAULT 'fixed',
        markup_value DECIMAL(10,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (turf_id) REFERENCES turfs(id) ON DELETE CASCADE
      )
    `);
    console.log('  ✅ courts table created/verified');
  } catch (e) {
    console.log(`  ℹ️  courts: ${e.message}`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 3. BOOKINGS TABLE — Add court_id, advance payment fields
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n━━━ BOOKINGS TABLE UPGRADES ━━━');
  const bookingCols = [
    ['court_id', "INT DEFAULT NULL"],
    ['advance_amount', "DECIMAL(10,2) DEFAULT NULL"],
    ['pending_balance', "DECIMAL(10,2) DEFAULT 0"],
    ['payment_type', "VARCHAR(20) DEFAULT 'full'"],     // 'full' or 'advance'
  ];

  for (const [col, def] of bookingCols) {
    try {
      await connection.query(`ALTER TABLE bookings ADD COLUMN ${col} ${def}`);
      console.log(`  ✅ Added bookings.${col}`);
    } catch (e) {
      if (e.message.includes('Duplicate column') || e.message.includes('duplicate column')) {
        console.log(`  ℹ️  bookings.${col} already exists`);
      } else {
        console.log(`  ❌ bookings.${col}: ${e.message}`);
      }
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 4. BLOCKED_SLOTS — Add court_id support
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n━━━ BLOCKED SLOTS TABLE UPGRADE ━━━');
  try {
    await connection.query(`ALTER TABLE blocked_slots ADD COLUMN court_id INT DEFAULT NULL`);
    console.log('  ✅ Added blocked_slots.court_id');
  } catch (e) {
    if (e.message.includes('Duplicate column') || e.message.includes('duplicate column')) {
      console.log('  ℹ️  blocked_slots.court_id already exists');
    } else {
      console.log(`  ❌ blocked_slots.court_id: ${e.message}`);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 5. SPECIAL_PRICING — Add court_id support
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n━━━ SPECIAL PRICING TABLE UPGRADE ━━━');
  try {
    await connection.query(`ALTER TABLE special_pricing ADD COLUMN court_id INT DEFAULT NULL`);
    console.log('  ✅ Added special_pricing.court_id');
  } catch (e) {
    if (e.message.includes('Duplicate column') || e.message.includes('duplicate column')) {
      console.log('  ℹ️  special_pricing.court_id already exists');
    } else {
      console.log(`  ❌ special_pricing.court_id: ${e.message}`);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 6. VERIFICATION
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n━━━ VERIFICATION ━━━');
  try {
    const [turfCols] = await connection.query("SHOW COLUMNS FROM turfs");
    console.log(`  📋 Turfs: ${turfCols.map(c => c.Field).join(', ')}`);
    
    const [bookingCols] = await connection.query("SHOW COLUMNS FROM bookings");
    console.log(`  📋 Bookings: ${bookingCols.map(c => c.Field).join(', ')}`);

    const [courtCols] = await connection.query("SHOW COLUMNS FROM courts");
    console.log(`  📋 Courts: ${courtCols.map(c => c.Field).join(', ')}`);

    const [tables] = await connection.query("SHOW TABLES");
    console.log(`  📋 Total tables: ${tables.length}`);
  } catch (e) {
    console.log(`  ❌ Verification: ${e.message}`);
  }

  console.log('\n🎉 V3 Migration Complete!');
  await connection.end();
}

migrate().catch(err => {
  console.error('❌ Fatal migration error:', err.message);
  process.exit(1);
});
