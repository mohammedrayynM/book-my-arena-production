const mysql = require('mysql2/promise');
require('dotenv').config();

async function test() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('⏳ Attempting manual booking insert...');
    const [result] = await connection.query(
      `INSERT INTO bookings (turf_id, customer_name, customer_phone, customer_email, booking_date, time_slot, amount, payment_status, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, 'Test Debug', '1234567890', 'test@test.com', '2026-04-07', '12:00 - 13:00', 1200, 'success', 'confirmed']
    );
    console.log('✅ Manual insert success! ID:', result.insertId);
  } catch (err) {
    console.error('❌ Manual insert FAILED:', err.message);
    if (err.sql) console.log('SQL:', err.sql);
  } finally {
    await connection.end();
  }
}

test();
