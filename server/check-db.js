const mysql = require('mysql2/promise');
require('dotenv').config();

async function check() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const [rows] = await connection.query("DESCRIBE bookings");
    console.log('--- Bookings Table Schema ---');
    rows.forEach(row => {
      console.log(`${row.Field}: ${row.Type} (Null: ${row.Null}, Key: ${row.Key}, Default: ${row.Default})`);
    });
  } catch (err) {
    console.error('❌ DB Check FAILED:', err.message);
  } finally {
    await connection.end();
  }
}

check();
