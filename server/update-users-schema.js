const pool = require('./config/db');

async function updateSchema() {
  try {
    const [rows] = await pool.query('DESCRIBE users');
    const columns = rows.map(r => r.Field);
    
    if (!columns.includes('google_id')) {
      console.log('Adding google_id column...');
      await pool.query('ALTER TABLE users ADD COLUMN google_id VARCHAR(255)');
    }
    
    if (!columns.includes('profile_pic')) {
      console.log('Adding profile_pic column...');
      await pool.query('ALTER TABLE users ADD COLUMN profile_pic TEXT');
    }
    
    console.log('✅ Users table schema updated');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

updateSchema();
