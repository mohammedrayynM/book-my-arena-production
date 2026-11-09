const pool = require('../config/db');

async function migrate() {
  try {
    console.log('🚀 Starting Subscriptions Migration...');

    // 1. Subscription Plans Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_id INT NOT NULL,
        turf_id INT NOT NULL,
        court_id INT,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL,
        duration_months INT DEFAULT 1,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        max_subscribers INT DEFAULT 1,
        current_subscribers INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        popular_badge BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_id) REFERENCES owners(id),
        FOREIGN KEY (turf_id) REFERENCES turfs(id)
      )
    `);
    console.log('✅ subscription_plans table created.');

    // 2. User Subscriptions Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        plan_id INT NOT NULL,
        turf_id INT NOT NULL,
        court_id INT,
        start_date DATE NOT NULL,
        expiry_date DATE NOT NULL,
        status ENUM('active', 'expired', 'pending_renewal', 'paused') DEFAULT 'active',
        payment_status ENUM('paid', 'pending', 'failed') DEFAULT 'pending',
        razorpay_payment_id VARCHAR(255),
        razorpay_order_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
      )
    `);
    console.log('✅ user_subscriptions table created.');

    // 3. Subscription Attendance / Log (Optional but good for history)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_usage (
        id INT AUTO_INCREMENT PRIMARY KEY,
        subscription_id INT NOT NULL,
        usage_date DATE NOT NULL,
        status ENUM('attended', 'missed') DEFAULT 'attended',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (subscription_id) REFERENCES user_subscriptions(id)
      )
    `);
    console.log('✅ subscription_usage table created.');

    console.log('✨ Migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
