const mysql = require('mysql2/promise');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function migrate() {
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
    console.log('🚀 Running Migration V2...');
    const sql = fs.readFileSync(path.join(__dirname, '../database/migration_v2.sql'), 'utf8');
    
    // Split by semicolons and run individually to handle errors better
    const queries = sql.split(';').map(q => q.trim()).filter(q => q.length > 0);
    
    for (let query of queries) {
      try {
        await connection.query(query);
        console.log(`✅ Success: ${query.substring(0, 50)}...`);
      } catch (err) {
        if (err.message.includes('Duplicate column name') || err.message.includes('already exists')) {
          console.log(`ℹ️ Skipped (already exists): ${query.substring(0, 50)}...`);
        } else {
          console.error(`❌ Error in query: ${query.substring(0, 50)}...`, err.message);
        }
      }
    }

    console.log('🎉 Migration V2 completed!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    await connection.end();
  }
}

migrate();
