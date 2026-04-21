/**
 * Fix All Missing Columns - Comprehensive Migration
 * Adds ALL columns that the application code expects but the DB is missing.
 */
const mysql = require('mysql2/promise');
require('dotenv').config();

async function fixAllColumns() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
  });

  console.log('✅ Connected to TiDB');
  console.log('🔧 Starting comprehensive column fix...\n');

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1. FIX TURFS TABLE — Missing columns
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const turfColumns = [
    ['open_time', "VARCHAR(10) DEFAULT '06:00'"],
    ['close_time', "VARCHAR(10) DEFAULT '23:00'"],
    ['markup_type', "VARCHAR(20) DEFAULT 'fixed'"],
    ['markup_value', "DECIMAL(10,2) DEFAULT 0"],
  ];

  console.log('━━━ TURFS TABLE ━━━');
  for (const [col, def] of turfColumns) {
    try {
      await connection.query(`ALTER TABLE turfs ADD COLUMN ${col} ${def}`);
      console.log(`  ✅ Added turfs.${col}`);
    } catch (e) {
      if (e.message.includes('Duplicate column')) {
        console.log(`  ℹ️  turfs.${col} already exists`);
      } else {
        console.log(`  ❌ turfs.${col}: ${e.message}`);
      }
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2. FIX BOOKINGS TABLE — Missing columns
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const bookingColumns = [
    ['original_price', "DECIMAL(10,2) DEFAULT NULL"],
    ['discount_amount', "DECIMAL(10,2) DEFAULT 0"],
    ['coupon_code', "VARCHAR(50) DEFAULT NULL"],
    ['markup_amount', "DECIMAL(10,2) DEFAULT 0"],
    ['service_fee', "DECIMAL(10,2) DEFAULT 0"],
    ['tax_amount', "DECIMAL(10,2) DEFAULT 0"],
  ];

  console.log('\n━━━ BOOKINGS TABLE ━━━');
  for (const [col, def] of bookingColumns) {
    try {
      await connection.query(`ALTER TABLE bookings ADD COLUMN ${col} ${def}`);
      console.log(`  ✅ Added bookings.${col}`);
    } catch (e) {
      if (e.message.includes('Duplicate column')) {
        console.log(`  ℹ️  bookings.${col} already exists`);
      } else {
        console.log(`  ❌ bookings.${col}: ${e.message}`);
      }
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 3. FIX BOOKINGS STATUS ENUM — needs 'pending'
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n━━━ BOOKINGS STATUS ENUM ━━━');
  try {
    await connection.query(
      "ALTER TABLE bookings MODIFY COLUMN status ENUM('pending','confirmed','cancelled','completed') DEFAULT 'confirmed'"
    );
    console.log("  ✅ Updated bookings.status enum to include 'pending'");
  } catch (e) {
    console.log(`  ℹ️  bookings.status enum: ${e.message}`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 4. FIX PAYMENT STATUS ENUM — needs 'expired'
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n━━━ BOOKINGS PAYMENT_STATUS ENUM ━━━');
  try {
    await connection.query(
      "ALTER TABLE bookings MODIFY COLUMN payment_status ENUM('pending','success','failed','expired') DEFAULT 'pending'"
    );
    console.log("  ✅ Updated bookings.payment_status enum to include 'expired'");
  } catch (e) {
    console.log(`  ℹ️  bookings.payment_status enum: ${e.message}`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 5. CREATE SPECIAL PRICING TABLE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n━━━ SPECIAL PRICING TABLE ━━━');
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS special_pricing (
        id INT AUTO_INCREMENT PRIMARY KEY,
        turf_id INT NOT NULL,
        day_of_week INT,
        specific_date DATE,
        time_slot VARCHAR(50) NOT NULL,
        special_price DECIMAL(10, 2) NOT NULL,
        offer_percentage INT DEFAULT NULL,
        offer_label VARCHAR(50) DEFAULT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (turf_id) REFERENCES turfs(id) ON DELETE CASCADE,
        UNIQUE KEY unique_pricing (turf_id, day_of_week, specific_date, time_slot)
      )
    `);
    console.log('  ✅ special_pricing table created/verified');
  } catch (e) {
    console.log(`  ℹ️  special_pricing: ${e.message}`);
  }

  // Add offer columns to special_pricing if missing
  const spCols = [
    ['offer_percentage', "INT DEFAULT NULL"],
    ['offer_label', "VARCHAR(50) DEFAULT NULL"],
  ];
  for (const [col, def] of spCols) {
    try {
      await connection.query(`ALTER TABLE special_pricing ADD COLUMN ${col} ${def}`);
      console.log(`  ✅ Added special_pricing.${col}`);
    } catch (e) {
      if (e.message.includes('Duplicate column')) {
        console.log(`  ℹ️  special_pricing.${col} already exists`);
      } else {
        console.log(`  ❌ special_pricing.${col}: ${e.message}`);
      }
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 6. CREATE COUPONS & COUPON_USAGES TABLES
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n━━━ COUPONS TABLES ━━━');
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS coupons (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        discount_type ENUM('flat', 'percentage') NOT NULL,
        discount_value DECIMAL(10, 2) NOT NULL,
        expiry_date DATE,
        turf_id INT NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        max_uses INT DEFAULT NULL,
        used_count INT DEFAULT 0,
        min_booking_amount DECIMAL(10, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (turf_id) REFERENCES turfs(id) ON DELETE CASCADE
      )
    `);
    console.log('  ✅ coupons table created/verified');
  } catch (e) {
    console.log(`  ℹ️  coupons: ${e.message}`);
  }

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS coupon_usages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        coupon_id INT NOT NULL,
        booking_id INT NOT NULL,
        customer_email VARCHAR(200),
        customer_phone VARCHAR(20),
        discount_amount DECIMAL(10, 2) NOT NULL,
        used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE CASCADE,
        FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
        UNIQUE KEY unique_booking_coupon (booking_id, coupon_id)
      )
    `);
    console.log('  ✅ coupon_usages table created/verified');
  } catch (e) {
    console.log(`  ℹ️  coupon_usages: ${e.message}`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 7. CREATE BLOCKED_SLOTS TABLE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n━━━ BLOCKED SLOTS TABLE ━━━');
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS blocked_slots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        turf_id INT NOT NULL,
        block_date DATE NOT NULL,
        time_slot VARCHAR(50) NOT NULL,
        reason VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (turf_id) REFERENCES turfs(id) ON DELETE CASCADE
      )
    `);
    console.log('  ✅ blocked_slots table created/verified');
  } catch (e) {
    console.log(`  ℹ️  blocked_slots: ${e.message}`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 8. ENSURE DEFAULT SETTINGS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n━━━ DEFAULT SETTINGS ━━━');
  const defaultSettings = [
    ['commission_percent', '10'],
    ['service_fee', '20'],
    ['service_fee_type', 'fixed'],
  ];

  for (const [key, value] of defaultSettings) {
    try {
      await connection.query(
        "INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_key = setting_key",
        [key, value]
      );
      console.log(`  ✅ Setting '${key}' = '${value}' ensured`);
    } catch (e) {
      console.log(`  ℹ️  Setting ${key}: ${e.message}`);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 9. VERIFY FINAL STATE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n━━━ VERIFICATION ━━━');
  try {
    const [turfCols] = await connection.query("SHOW COLUMNS FROM turfs");
    console.log(`  📋 Turfs table has ${turfCols.length} columns: ${turfCols.map(c => c.Field).join(', ')}`);
    
    const [bookingCols] = await connection.query("SHOW COLUMNS FROM bookings");
    console.log(`  📋 Bookings table has ${bookingCols.length} columns: ${bookingCols.map(c => c.Field).join(', ')}`);

    const [tables] = await connection.query("SHOW TABLES");
    console.log(`  📋 Total tables: ${tables.length}`);
    tables.forEach(t => {
      const tableName = Object.values(t)[0];
      console.log(`     - ${tableName}`);
    });
  } catch (e) {
    console.log(`  ❌ Verification error: ${e.message}`);
  }

  console.log('\n🎉 All database fixes complete!');
  await connection.end();
}

fixAllColumns().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
