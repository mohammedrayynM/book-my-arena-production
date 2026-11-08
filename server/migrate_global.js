// Idempotent schema for the GLOBAL layer: countries (currency + timezones), payment configuration per country/currency,
// the versioned cancellation policy, and the unified refunds ledger (sports/turf AND activity bookings).
//
// Every new column defaults to the platform's existing behaviour (India / INR / Asia/Kolkata), so every existing venue and
// booking keeps working exactly as before until an owner chooses another country.
const pool = require('./config/db');

async function ensureColumn(table, columnSql) {
  try { await pool.query(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`); }
  catch (e) {
    if (!/Duplicate column name|already exists|doesn't exist|Unknown table/i.test(String(e?.message || ''))) console.error(`⚠️ Global: failed to add column on ${table}: ${columnSql}`, e.message);
  }
}

// [code, name, currency, native symbol, display prefix, currency name, minor digits, default tz, timezones, sort]
const COUNTRIES = [
  ['IN', 'India', 'INR', '₹', '₹', 'Indian Rupee', 2, 'Asia/Kolkata', ['Asia/Kolkata'], 1],
  ['AE', 'United Arab Emirates', 'AED', 'د.إ', 'AED', 'UAE Dirham', 2, 'Asia/Dubai', ['Asia/Dubai'], 2],
  ['GB', 'United Kingdom', 'GBP', '£', '£', 'Pound Sterling', 2, 'Europe/London', ['Europe/London'], 3],
  ['US', 'United States', 'USD', '$', '$', 'US Dollar', 2, 'America/New_York', ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'], 4],
  ['SA', 'Saudi Arabia', 'SAR', '﷼', 'SAR', 'Saudi Riyal', 2, 'Asia/Riyadh', ['Asia/Riyadh'], 5],
  ['QA', 'Qatar', 'QAR', 'ر.ق', 'QAR', 'Qatari Riyal', 2, 'Asia/Qatar', ['Asia/Qatar'], 6],
  ['KW', 'Kuwait', 'KWD', 'د.ك', 'KWD', 'Kuwaiti Dinar', 3, 'Asia/Kuwait', ['Asia/Kuwait'], 7],
  ['OM', 'Oman', 'OMR', 'ر.ع.', 'OMR', 'Omani Rial', 3, 'Asia/Muscat', ['Asia/Muscat'], 8],
  ['BH', 'Bahrain', 'BHD', '.د.ب', 'BHD', 'Bahraini Dinar', 3, 'Asia/Bahrain', ['Asia/Bahrain'], 9],
];

module.exports = async function ensureGlobalSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS countries (
        country_code CHAR(2) PRIMARY KEY,
        country_name VARCHAR(80) NOT NULL,
        currency_code CHAR(3) NOT NULL,
        currency_symbol VARCHAR(10) NOT NULL,
        display_prefix VARCHAR(10) NOT NULL,
        currency_name VARCHAR(60) NOT NULL,
        minor_digits TINYINT NOT NULL DEFAULT 2,
        default_timezone VARCHAR(64) NOT NULL,
        timezones JSON NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        sort_order INT NOT NULL DEFAULT 100,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const [code, name, cur, sym, prefix, curName, digits, tz, tzs, sort] of COUNTRIES) {
      await pool.query(
        'INSERT IGNORE INTO countries (country_code, country_name, currency_code, currency_symbol, display_prefix, currency_name, minor_digits, default_timezone, timezones, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [code, name, cur, sym, prefix, curName, digits, tz, JSON.stringify(tzs), sort]
      );
    }

    // Which country/currency/provider combinations may actually take payments. A currency is only switched on once the
    // merchant account has been confirmed to settle it — never assumed. Only India (INR) is on out of the box.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_configs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        country_code CHAR(2) NOT NULL,
        currency_code CHAR(3) NOT NULL,
        payment_provider VARCHAR(30) NOT NULL DEFAULT 'razorpay',
        provider_account VARCHAR(80) NULL,
        payment_methods JSON NULL,
        enabled BOOLEAN NOT NULL DEFAULT false,
        notes VARCHAR(255) NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_payment_config (country_code, currency_code, payment_provider)
      )
    `);
    for (const [code, , cur] of COUNTRIES) {
      await pool.query(
        'INSERT IGNORE INTO payment_configs (country_code, currency_code, payment_provider, payment_methods, enabled, notes) VALUES (?, ?, ?, ?, ?, ?)',
        [code, cur, 'razorpay', JSON.stringify(['card', 'upi', 'netbanking', 'wallet']), code === 'IN', code === 'IN' ? 'Live' : 'Off until the merchant account is confirmed to settle this currency']
      );
    }

    // Versioned cancellation policy. Editing it INSERTS a new version; bookings keep the version that applied when they were made.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cancellation_policies (
        id INT AUTO_INCREMENT PRIMARY KEY,
        cancellation_enabled BOOLEAN NOT NULL DEFAULT true,
        window_hours DECIMAL(6,2) NOT NULL DEFAULT 5,
        fee_percent DECIMAL(5,2) NOT NULL DEFAULT 20,
        customer_refund_enabled BOOLEAN NOT NULL DEFAULT true,
        owner_refund_percent DECIMAL(5,2) NOT NULL DEFAULT 100,
        is_active BOOLEAN NOT NULL DEFAULT false,
        created_by INT NULL,
        note VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const [[pc]] = await pool.query('SELECT COUNT(*) AS c FROM cancellation_policies');
    if (!pc.c) await pool.query("INSERT INTO cancellation_policies (cancellation_enabled, window_hours, fee_percent, customer_refund_enabled, owner_refund_percent, is_active, note) VALUES (true, 5, 20, true, 100, true, 'Default BookArena policy')");

    // The refund ledger for BOTH engines. Money in integer minor units + its currency, always.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS refunds (
        id INT AUTO_INCREMENT PRIMARY KEY,
        refund_code VARCHAR(24) NOT NULL UNIQUE,
        booking_type VARCHAR(10) NOT NULL,
        booking_id INT NOT NULL,
        payment_id VARCHAR(80) NOT NULL DEFAULT '',
        user_id INT NULL,
        owner_id INT NULL,
        venue_id INT NULL,
        venue_name VARCHAR(150) NULL,
        country_code CHAR(2) NULL,
        business_type VARCHAR(12) NULL,
        original_amount_minor BIGINT NOT NULL DEFAULT 0,
        amount_paid_minor BIGINT NOT NULL DEFAULT 0,
        cancellation_fee_minor BIGINT NOT NULL DEFAULT 0,
        refund_amount_minor BIGINT NOT NULL DEFAULT 0,
        currency_code CHAR(3) NOT NULL,
        refund_reason VARCHAR(255) NULL,
        cancelled_by VARCHAR(10) NOT NULL,
        cancellation_type VARCHAR(30) NOT NULL,
        refund_status VARCHAR(20) NOT NULL,
        gateway_refund_id VARCHAR(80) NULL UNIQUE,
        gateway_payment_id VARCHAR(80) NULL,
        idempotency_key VARCHAR(120) NOT NULL UNIQUE,
        policy_version INT NULL,
        policy_window_hours DECIMAL(6,2) NULL,
        policy_fee_percent DECIMAL(5,2) NULL,
        attempts INT NOT NULL DEFAULT 0,
        requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME NULL,
        completed_at DATETIME NULL,
        failure_reason VARCHAR(255) NULL,
        UNIQUE KEY uniq_refund_booking_payment (booking_type, booking_id, payment_id),
        INDEX idx_refunds_status (refund_status),
        INDEX idx_refunds_owner (owner_id),
        INDEX idx_refunds_user (user_id)
      )
    `);

    // venue geography + currency (defaults = India, so nothing existing changes)
    for (const table of ['turfs', 'activities']) {
      await ensureColumn(table, "country_code CHAR(2) NOT NULL DEFAULT 'IN'");
      await ensureColumn(table, "currency_code CHAR(3) NOT NULL DEFAULT 'INR'");
      await ensureColumn(table, "timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata'");
      await ensureColumn(table, 'state_province VARCHAR(80) NULL');
    }
    await ensureColumn('activities', 'city VARCHAR(80) NULL');

    // per-booking currency + the policy that applied when it was made + cancellation facts
    for (const table of ['bookings', 'activity_bookings']) {
      await ensureColumn(table, "currency_code CHAR(3) NOT NULL DEFAULT 'INR'");
      await ensureColumn(table, 'policy_version INT NULL');
      await ensureColumn(table, 'policy_window_hours DECIMAL(6,2) NULL');
      await ensureColumn(table, 'policy_fee_percent DECIMAL(5,2) NULL');
      await ensureColumn(table, 'cancelled_by VARCHAR(10) NULL');
      await ensureColumn(table, 'cancel_reason VARCHAR(255) NULL');
      await ensureColumn(table, 'cancelled_at DATETIME NULL');
    }
  } catch (e) {
    console.error('⚠️ Global schema migration error:', e.message);
  }
};
