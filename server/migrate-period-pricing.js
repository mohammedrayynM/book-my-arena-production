const mysql = require('mysql2/promise');
require('dotenv').config();

async function migrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
  });

  console.log('✅ Connected to database');
  console.log('🔧 Starting Period Pricing Migration...\n');

  const newCols = [
    ['early_morning_price', "DECIMAL(10,2) DEFAULT NULL"],
    ['morning_price', "DECIMAL(10,2) DEFAULT NULL"],
    ['afternoon_price', "DECIMAL(10,2) DEFAULT NULL"],
    ['evening_price', "DECIMAL(10,2) DEFAULT NULL"],
    ['default_price', "DECIMAL(10,2) DEFAULT NULL"]
  ];

  // 1. Alter turfs table
  console.log('━━━ ALTERING TURFS TABLE ━━━');
  for (const [col, def] of newCols) {
    try {
      await connection.query(`ALTER TABLE turfs ADD COLUMN ${col} ${def}`);
      console.log(`  ✅ Added turfs.${col}`);
    } catch (e) {
      if (e.message.includes('Duplicate column') || e.message.includes('duplicate column')) {
        console.log(`  ℹ️  turfs.${col} already exists`);
      } else {
        console.error(`  ❌ turfs.${col}: ${e.message}`);
      }
    }
  }

  // 2. Alter courts table
  console.log('\n━━━ ALTERING COURTS TABLE ━━━');
  for (const [col, def] of newCols) {
    try {
      await connection.query(`ALTER TABLE courts ADD COLUMN ${col} ${def}`);
      console.log(`  ✅ Added courts.${col}`);
    } catch (e) {
      if (e.message.includes('Duplicate column') || e.message.includes('duplicate column')) {
        console.log(`  ℹ️  courts.${col} already exists`);
      } else {
        console.error(`  ❌ courts.${col}: ${e.message}`);
      }
    }
  }

  // 3. Sync default_price with existing price_per_hour
  try {
    console.log('\n━━━ SYNCING DEFAULT PRICES ━━━');
    await connection.query('UPDATE turfs SET default_price = price_per_hour WHERE default_price IS NULL');
    await connection.query('UPDATE courts SET default_price = price_per_hour WHERE default_price IS NULL');
    console.log('  ✅ Synchronized default_price with price_per_hour');
  } catch (e) {
    console.error('  ❌ Sync error:', e.message);
  }

  console.log('\n🎉 Period Pricing Migration Complete!');
  await connection.end();
}

migrate().catch(err => {
  console.error('❌ Fatal migration error:', err.message);
  process.exit(1);
});
