const pool = require('./config/db');

async function ensureTable(name, sql) {
  try {
    await pool.query(sql);
    console.log(`✅ Table verified: ${name}`);
  } catch (err) {
    console.error(`❌ Error creating table ${name}:`, err.message);
    throw err;
  }
}

async function ensureIndex(table, indexName, indexSql) {
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(1) as count FROM information_schema.statistics 
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [table, indexName]
    );
    if (rows[0].count === 0) {
      await pool.query(indexSql);
      console.log(`✅ Index created: ${indexName} on ${table}`);
    } else {
      console.log(`ℹ️  Index already exists: ${indexName} on ${table}`);
    }
  } catch (err) {
    console.warn(`⚠️  Could not create index ${indexName} on ${table}:`, err.message);
  }
}

async function runMigration() {
  console.log('🔄 Running Payment Reliability Database Migration...');

  // 1. Modify bookings enum columns to VARCHAR(50) for robust state machine transitions
  try {
    await pool.query(`
      ALTER TABLE bookings 
      MODIFY COLUMN payment_status VARCHAR(50) NOT NULL DEFAULT 'pending',
      MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'pending'
    `);
    console.log('✅ Altered bookings payment_status and status to VARCHAR(50)');
  } catch (err) {
    console.warn('⚠️  Could not modify columns (might already be modified):', err.message);
  }

  // 2. Add performance & search indexes on bookings
  await ensureIndex('bookings', 'idx_bookings_razorpay_order', 'CREATE INDEX idx_bookings_razorpay_order ON bookings (razorpay_order_id)');
  await ensureIndex('bookings', 'idx_bookings_payment_id', 'CREATE INDEX idx_bookings_payment_id ON bookings (payment_id)');
  await ensureIndex('bookings', 'idx_bookings_status_recon', 'CREATE INDEX idx_bookings_status_recon ON bookings (status, payment_status, created_at)');

  // 3. Create payment_reconciliation_logs table
  await ensureTable('payment_reconciliation_logs', `
    CREATE TABLE IF NOT EXISTS payment_reconciliation_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      booking_id INT NULL,
      razorpay_order_id VARCHAR(64) NULL,
      razorpay_payment_id VARCHAR(64) NULL,
      source VARCHAR(50) NOT NULL,
      action VARCHAR(50) NOT NULL,
      status VARCHAR(50) NOT NULL,
      amount DECIMAL(10,2) NULL,
      currency VARCHAR(10) DEFAULT 'INR',
      details TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_recon_order (razorpay_order_id),
      INDEX idx_recon_payment (razorpay_payment_id),
      INDEX idx_recon_booking (booking_id),
      INDEX idx_recon_status (status),
      INDEX idx_recon_created (created_at)
    )
  `);

  // 4. Create system_cron_leases table
  await ensureTable('system_cron_leases', `
    CREATE TABLE IF NOT EXISTS system_cron_leases (
      job_name VARCHAR(64) PRIMARY KEY,
      locked_by VARCHAR(128) NOT NULL,
      locked_at DATETIME NOT NULL,
      expires_at DATETIME NOT NULL,
      INDEX idx_lease_expires (expires_at)
    )
  `);

  // 5. Create booking_receipts table
  await ensureTable('booking_receipts', `
    CREATE TABLE IF NOT EXISTS booking_receipts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      booking_id INT NOT NULL,
      receipt_number VARCHAR(64) NOT NULL UNIQUE,
      turf_name VARCHAR(255) NOT NULL,
      court_name VARCHAR(255) NULL,
      booking_date DATE NOT NULL,
      time_slot VARCHAR(100) NOT NULL,
      customer_name VARCHAR(150) NOT NULL,
      customer_phone VARCHAR(20) NULL,
      customer_email VARCHAR(200) NULL,
      payment_type VARCHAR(20) NOT NULL,
      total_amount DECIMAL(10,2) NOT NULL,
      amount_paid DECIMAL(10,2) NOT NULL,
      pending_balance DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      razorpay_order_id VARCHAR(64) NULL,
      razorpay_payment_id VARCHAR(64) NOT NULL,
      payment_method VARCHAR(50) NULL,
      receipt_json TEXT NULL,
      email_sent TINYINT(1) DEFAULT 0,
      email_error TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_receipt_booking (booking_id),
      INDEX idx_receipt_payment (razorpay_payment_id),
      INDEX idx_receipt_email (customer_email)
    )
  `);

  console.log('🎉 Payment Reliability Migration Completed Successfully!');
}

if (require.main === module) {
  runMigration().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = runMigration;
