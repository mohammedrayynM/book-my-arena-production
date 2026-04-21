/**
 * Migration script to add special_pricing table to the database
 * Run with: node server/migrate-special-pricing.js
 */

const pool = require('./config/db');

async function migrate() {
  console.log('🚀 Starting special pricing migration...\n');

  try {
    // Create special_pricing table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS special_pricing (
        id INT AUTO_INCREMENT PRIMARY KEY,
        turf_id INT NOT NULL,
        day_of_week INT,
        specific_date DATE,
        time_slot VARCHAR(50) NOT NULL,
        special_price DECIMAL(10, 2) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (turf_id) REFERENCES turfs(id) ON DELETE CASCADE,
        UNIQUE KEY unique_pricing (turf_id, day_of_week, specific_date, time_slot)
      )
    `);
    console.log('✅ special_pricing table created/verified');

    // Create indexes for better performance
    try {
      await pool.query('CREATE INDEX idx_special_pricing_turf_date ON special_pricing(turf_id, specific_date)');
      console.log('✅ Index idx_special_pricing_turf_date created');
    } catch (e) {
      if (e.code === 'ER_DUP_KEYNAME') {
        console.log('ℹ️  Index idx_special_pricing_turf_date already exists');
      } else {
        throw e;
      }
    }

    try {
      await pool.query('CREATE INDEX idx_special_pricing_turf_day ON special_pricing(turf_id, day_of_week)');
      console.log('✅ Index idx_special_pricing_turf_day created');
    } catch (e) {
      if (e.code === 'ER_DUP_KEYNAME') {
        console.log('ℹ️  Index idx_special_pricing_turf_day already exists');
      } else {
        throw e;
      }
    }

    console.log('\n🎉 Migration completed successfully!');
    console.log('   Owners can now set special prices for specific days, dates, and time slots.');
    
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    console.error(err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();