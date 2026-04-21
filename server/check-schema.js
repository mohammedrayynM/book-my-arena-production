const pool = require('./config/db');

async function checkSchema() {
  try {
    const [rows] = await pool.query('DESCRIBE turfs');
    console.log('Columns in turfs table:');
    console.table(rows);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

checkSchema();
