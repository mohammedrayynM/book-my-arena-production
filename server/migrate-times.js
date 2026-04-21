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
    console.log('⏳ Running migrations...');
    
    // Add open_time and close_time to turfs
    await connection.query(`
      ALTER TABLE turfs 
      ADD COLUMN IF NOT EXISTS open_time VARCHAR(10) DEFAULT '06:00',
      ADD COLUMN IF NOT EXISTS close_time VARCHAR(10) DEFAULT '23:00'
    `);
    
    console.log('✅ Migrations completed!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    await connection.end();
  }
}

migrate();
