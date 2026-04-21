const mysql = require('mysql2/promise');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function reset() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
    multipleStatements: true
  });

  try {
    console.log('🚮 Cleaning database tables...');
    await connection.query('DROP TABLE IF EXISTS blocked_slots, bookings, turfs, owners, admins, settings;');
    
    console.log('⏳ Re-initializing schema...');
    const schema = fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8');
    await connection.query(schema);
    
    console.log('✅ Database reset successfully!');
  } catch (err) {
    console.error('❌ Failed to reset database:', err.message);
  } finally {
    await connection.end();
  }
}

reset();
