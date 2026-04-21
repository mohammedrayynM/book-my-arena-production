const mysql = require('mysql2/promise');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function setup() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }, // Use false to bypass certificate issues for initial setup
    multipleStatements: true
  });

  try {
    console.log('⏳ Setting up database schema on TiDB...');
    const schema = fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8');
    
    // Split into individual queries to handle potential errors better if needed, 
    // but multipleStatements is true here.
    await connection.query(schema);
    
    console.log('✅ Database schema initialized successfully!');
  } catch (err) {
    console.error('❌ Failed to setup database:', err.message);
  } finally {
    await connection.end();
  }
}

setup();
