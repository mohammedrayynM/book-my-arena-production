const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();

async function setupAdmin() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const password = 'admin123';
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    console.log('⏳ Ensuring admin account exists...');
    
    // Check if admin exists
    const [rows] = await connection.query('SELECT * FROM admins WHERE username = ?', ['admin']);
    
    if (rows.length === 0) {
      await connection.query('INSERT INTO admins (username, password_hash) VALUES (?, ?)', ['admin', hash]);
      console.log('✅ Admin account created: admin / admin123');
    } else {
      await connection.query('UPDATE admins SET password_hash = ? WHERE username = ?', [hash, 'admin']);
      console.log('✅ Admin password updated to: admin123');
    }

  } catch (err) {
    console.error('❌ Failed to setup admin:', err.message);
  } finally {
    await connection.end();
  }
}

setupAdmin();
