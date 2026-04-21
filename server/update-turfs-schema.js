const pool = require('./config/db');

async function updateTurfsTable() {
  try {
    const [rows] = await pool.query('DESCRIBE turfs');
    const columns = rows.map(r => r.Field);
    
    if (!columns.includes('latitude')) {
      console.log('Adding latitude column...');
      await pool.query('ALTER TABLE turfs ADD COLUMN latitude DECIMAL(10, 8)');
    }
    
    if (!columns.includes('longitude')) {
      console.log('Adding longitude column...');
      await pool.query('ALTER TABLE turfs ADD COLUMN longitude DECIMAL(11, 8)');
    }
    
    console.log('✅ Turfs table schema updated with coordinates');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

updateTurfsTable();
