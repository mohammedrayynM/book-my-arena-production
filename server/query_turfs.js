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
    const [turfs] = await connection.query("SELECT id, name, open_time, close_time, price_per_hour, slot_duration, time_format FROM turfs");
    console.log('--- Turfs Table Rows ---');
    console.log(turfs);

    const [courts] = await connection.query("SELECT id, turf_id, name, open_time, close_time, price_per_hour, slot_duration, time_format FROM courts");
    console.log('--- Courts Table Rows ---');
    console.log(courts);
  } catch (err) {
    console.error('❌ Check FAILED:', err.message);
  } finally {
    await connection.end();
  }
}

check();
