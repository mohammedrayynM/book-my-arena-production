const mysql = require('mysql2/promise');
require('dotenv').config();

async function run() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT || 4000,
        ssl: { minVersion: 'TLSv1.2' }
    });

    try {
        await pool.query('ALTER TABLE turfs ADD COLUMN razorpay_linked_account_id VARCHAR(255) NULL');
        console.log('Added razorpay_linked_account_id');
    } catch (e) {
        if (!e.message.includes('Duplicate column name')) console.error(e);
    }

    try {
        await pool.query('ALTER TABLE turfs ADD COLUMN monthly_subscription_amount DECIMAL(10,2) DEFAULT 0');
        console.log('Added monthly_subscription_amount');
    } catch (e) {
        if (!e.message.includes('Duplicate column name')) console.error(e);
    }

    try {
        await pool.query(`
      CREATE TABLE IF NOT EXISTS turf_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        turf_id INT NOT NULL,
        cycle_month VARCHAR(7) NOT NULL,
        subscription_amount DECIMAL(10,2) DEFAULT 0,
        collected_amount DECIMAL(10,2) DEFAULT 0,
        status ENUM('UNPAID', 'PAID') DEFAULT 'UNPAID',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_turf_cycle (turf_id, cycle_month)
      )
    `);
        console.log('Created turf_subscriptions');
    } catch (e) { console.error('turf_subscriptions error', e); }

    try {
        await pool.query(`
      CREATE TABLE IF NOT EXISTS razorpay_transfers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        booking_id INT,
        turf_id INT NOT NULL,
        razorpay_payment_id VARCHAR(255),
        razorpay_order_id VARCHAR(255),
        razorpay_transfer_id VARCHAR(255),
        gross_amount DECIMAL(10,2) DEFAULT 0,
        platform_amount DECIMAL(10,2) DEFAULT 0,
        owner_amount DECIMAL(10,2) DEFAULT 0,
        status VARCHAR(50) DEFAULT 'pending',
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_payment (razorpay_payment_id)
      )
    `);
        console.log('Created razorpay_transfers');
    } catch (e) { console.error('razorpay_transfers error', e); }

    console.log('Migration complete');
    process.exit(0);
}
run();
