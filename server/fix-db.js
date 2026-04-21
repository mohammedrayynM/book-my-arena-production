const mysql = require('mysql2/promise');
require('dotenv').config();

async function fix() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
  });

  try {
    // Try to modify the column if it exists
    await conn.query("ALTER TABLE bookings MODIFY COLUMN payment_status VARCHAR(50) DEFAULT 'pending'");
    console.log('✅ payment_status modified to VARCHAR');
  } catch(e) {
    console.log('⚠️ Modify failed, trying to add column');
    try {
      await conn.query("ALTER TABLE bookings ADD COLUMN payment_status VARCHAR(50) DEFAULT 'pending'");
      console.log('✅ payment_status added as VARCHAR');
    } catch(e2) {
      console.log('⚠️ Add column also failed:', e2.message);
    }
  }

  try {
    // Ensure 'is_approved' exists in owners table
    await conn.query("ALTER TABLE owners MODIFY COLUMN is_approved BOOLEAN DEFAULT FALSE");
    console.log('✅ is_approved confirmed');
  } catch(e) {
    try {
      await conn.query("ALTER TABLE owners ADD COLUMN is_approved BOOLEAN DEFAULT FALSE");
      console.log('✅ is_approved added');
    } catch(e2) {}
  }

  await conn.end();
}

fix();
