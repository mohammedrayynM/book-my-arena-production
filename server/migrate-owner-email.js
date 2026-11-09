const pool = require('./config/db');

async function runMigration() {
  try {
    console.log('🚀 Running database migration to add owner_email to turfs and reset_otp to owners...');
    
    // Add owner_email to turfs table
    try {
      await pool.query('ALTER TABLE turfs ADD COLUMN owner_email VARCHAR(200) DEFAULT NULL');
      console.log('✅ Added owner_email column to turfs table');
    } catch (err) {
      if (err.message.includes('Duplicate column') || err.message.includes('already exists')) {
        console.log('ℹ️ Column owner_email already exists in turfs table');
      } else {
        console.error('❌ Error adding owner_email to turfs table:', err.message);
      }
    }

    // Add reset_otp to owners table
    try {
      await pool.query('ALTER TABLE owners ADD COLUMN reset_otp VARCHAR(10) DEFAULT NULL');
      console.log('✅ Added reset_otp column to owners table');
    } catch (err) {
      if (err.message.includes('Duplicate column') || err.message.includes('already exists')) {
        console.log('ℹ️ Column reset_otp already exists in owners table');
      } else {
        console.error('❌ Error adding reset_otp to owners table:', err.message);
      }
    }

    // Add reset_otp_expires to owners table
    try {
      await pool.query('ALTER TABLE owners ADD COLUMN reset_otp_expires TIMESTAMP DEFAULT NULL');
      console.log('✅ Added reset_otp_expires column to owners table');
    } catch (err) {
      if (err.message.includes('Duplicate column') || err.message.includes('already exists')) {
        console.log('ℹ️ Column reset_otp_expires already exists in owners table');
      } else {
        console.error('❌ Error adding reset_otp_expires to owners table:', err.message);
      }
    }

    console.log('🎉 Migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

runMigration();
