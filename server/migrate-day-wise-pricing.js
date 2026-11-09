const pool = require('./config/db');

async function migrate() {
  console.log('🚀 Starting day-wise pricing migration...\n');

  try {
    // Create day_wise_pricing table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS day_wise_pricing (
        id INT AUTO_INCREMENT PRIMARY KEY,
        turf_id INT NOT NULL,
        court_id INT DEFAULT NULL,
        day_of_week VARCHAR(15) NOT NULL,
        early_morning_price DECIMAL(10, 2) DEFAULT NULL,
        morning_price DECIMAL(10, 2) DEFAULT NULL,
        afternoon_price DECIMAL(10, 2) DEFAULT NULL,
        evening_price DECIMAL(10, 2) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (turf_id) REFERENCES turfs(id) ON DELETE CASCADE,
        FOREIGN KEY (court_id) REFERENCES courts(id) ON DELETE CASCADE
      )
    `);
    console.log('✅ day_wise_pricing table created/verified');

    // Create index on turf_id and court_id for fast lookup
    try {
      await pool.query('CREATE INDEX idx_day_wise_pricing_lookup ON day_wise_pricing(turf_id, court_id, day_of_week)');
      console.log('✅ Index idx_day_wise_pricing_lookup created');
    } catch (e) {
      if (e.code === 'ER_DUP_KEYNAME') {
        console.log('ℹ️ Index idx_day_wise_pricing_lookup already exists');
      } else {
        throw e;
      }
    }

    console.log('\n🎉 Migration completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    console.error(err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
