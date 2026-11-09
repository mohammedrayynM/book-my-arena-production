const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();

async function seedDemoAdmin() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const username = 'demo_admin';
    const password = 'demo_password123';
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    console.log('⏳ Seeding demo admin account...');
    
    // Check if demo admin exists
    const [rows] = await connection.query('SELECT * FROM admins WHERE username = ?', [username]);
    
    if (rows.length === 0) {
      await connection.query('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [username, hash]);
      console.log('✅ Demo admin account created!');
      console.log('-----------------------------------');
      console.log(`Username: ${username}`);
      console.log(`Password: ${password}`);
      console.log('-----------------------------------');
    } else {
      await connection.query('UPDATE admins SET password_hash = ? WHERE username = ?', [hash, username]);
      console.log('✅ Demo admin password updated!');
      console.log('-----------------------------------');
      console.log(`Username: ${username}`);
      console.log(`Password: ${password}`);
      console.log('-----------------------------------');
    }

  } catch (err) {
    console.error('❌ Failed to seed demo admin:', err.message);
  } finally {
    await connection.end();
  }
}

seedDemoAdmin();
