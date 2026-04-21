const pool = require('./config/db');

async function updateEnum() {
  try {
    console.log('Connecting to TiDB...');
    await pool.query("ALTER TABLE bookings MODIFY COLUMN status ENUM('pending', 'confirmed', 'cancelled', 'failed', 'completed') DEFAULT 'pending'");
    console.log('✅ Status ENUM updated successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to update ENUM:', err.message);
    process.exit(1);
  }
}

updateEnum();
