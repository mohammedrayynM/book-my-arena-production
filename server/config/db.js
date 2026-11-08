const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 4000,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  connectTimeout: 30000, // cold TLS connections to the cloud DB can exceed the 10s default (startup migrations timed out)
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test connection
pool.getConnection()
  .then(conn => {
    console.log('✅ Connected to TiDB database');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Database connection failed:', err.message);
    if (err.code === 'ENOTFOUND') {
      console.error('');
      console.error('🔧 The database host could not be resolved:');
      console.error(`   DB_HOST = ${process.env.DB_HOST}`);
      console.error('');
      console.error('   Possible fixes:');
      console.error('   1. Log into TiDB Cloud Console → your cluster → Connect');
      console.error('   2. Copy the updated hostname and update DB_HOST in server/.env');
      console.error('   3. Restart the server');
      console.error('');
    }
  });

module.exports = pool;
