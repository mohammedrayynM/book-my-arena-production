const pool = require('../config/db');

async function migrate() {
  try {
    console.log('🚀 Updating subscription_plans table...');

    await pool.query(`
      ALTER TABLE subscription_plans 
      ADD COLUMN IF NOT EXISTS time_format VARCHAR(10) DEFAULT '12h'
    `);
    
    console.log('✅ Columns added successfully.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
