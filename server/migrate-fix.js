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

  try {
    console.log('⏳ Adding missing columns to turfs table...');
    
    // Add open_time and close_time if they don't exist
    try {
      await connection.query("ALTER TABLE turfs ADD COLUMN open_time VARCHAR(10) DEFAULT '06:00'");
      console.log('✅ open_time added');
    } catch (e) {
      console.log('ℹ️ open_time already exists or failed:', e.message);
    }

    try {
      await connection.query("ALTER TABLE turfs ADD COLUMN close_time VARCHAR(10) DEFAULT '23:00'");
      console.log('✅ close_time added');
    } catch (e) {
      console.log('ℹ️ close_time already exists or failed:', e.message);
    }

    console.log('🎉 Migration fix completed!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    await connection.end();
  }
}

migrate();
