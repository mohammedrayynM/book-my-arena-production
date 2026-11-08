// Admin-controlled tournament configuration: creation fee, duration limits, allowed formats, discount offers,
// a payment ledger for creation fees, and an audit trail of every settings change.
//
// Additive and idempotent. Existing rows keep working: the new tournament_settings columns all default to the
// behaviour that was already in force (creation enabled, INR, no duration restriction).
const pool = require('./config/db');

async function addColumn(table, definition) {
  // ADD COLUMN IF NOT EXISTS is supported by MariaDB and tolerated here; the catch keeps older engines working.
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${definition}`);
  } catch (e) {
    if (!/duplicate column|already exists/i.test(e.message)) throw e;
  }
}

async function addIndex(table, definition) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD ${definition}`);
  } catch (e) {
    if (!/duplicate key name|already exists/i.test(e.message)) throw e;
  }
}

module.exports = async function ensureTournamentConfigSchema() {
  // ---- 1. Richer admin settings (one row, as before) -------------------------------------------------------
  await addColumn('tournament_settings', 'creation_enabled TINYINT(1) NOT NULL DEFAULT 1');
  await addColumn('tournament_settings', "currency_code VARCHAR(3) NOT NULL DEFAULT 'INR'");
  await addColumn('tournament_settings', 'min_duration_days INT NOT NULL DEFAULT 1');
  await addColumn('tournament_settings', 'max_duration_days INT NOT NULL DEFAULT 30');
  await addColumn('tournament_settings', 'allowed_formats TEXT NULL');     // JSON array; NULL = allow all
  await addColumn('tournament_settings', 'allowed_sports TEXT NULL');      // JSON array; NULL = allow all
  await addColumn('tournament_settings', 'disabled_message VARCHAR(255) NULL');
  await addColumn('tournament_settings', 'updated_by INT NULL');
  await addColumn('tournament_settings', "updated_by_role VARCHAR(10) NULL");
  // How far from a tournament's venue people are told about it. 0 turns distance targeting off and falls back
  // to matching on the venue's city, which is what happened before coordinates existed.
  await addColumn('tournament_settings', 'notify_radius_km INT NOT NULL DEFAULT 25');

  // Coordinates so "near me" can mean an actual distance. Inherited from the Book Arena venue when the host
  // picks one; NULL for a free-text venue, which simply falls back to city matching.
  await addColumn('tournaments', 'latitude DOUBLE NULL');
  await addColumn('tournaments', 'longitude DOUBLE NULL');

  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM tournament_settings');
  if (!row || !row.n) {
    await pool.query('INSERT INTO tournament_settings (fee_amount, is_active) VALUES (0, true)');
  }

  // ---- 2. Discount offers on the creation fee --------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_offers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(40) NOT NULL UNIQUE,
      title VARCHAR(120) NOT NULL,
      description VARCHAR(255) NULL,
      discount_type ENUM('percentage','fixed') NOT NULL DEFAULT 'percentage',
      discount_value DECIMAL(10,2) NOT NULL DEFAULT 0,
      max_discount DECIMAL(10,2) NULL,
      min_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      valid_from DATE NULL,
      valid_until DATE NULL,
      max_uses INT NULL,
      per_user_limit INT NOT NULL DEFAULT 1,
      used_count INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_offer_active (is_active, valid_until)
    )
  `);

  // One row per actually-charged redemption. Enforces per-user limits and makes a repeated webhook
  // or verify call unable to consume a second use of the same coupon.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_offer_redemptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      offer_id INT NOT NULL,
      tournament_id INT NOT NULL,
      user_id INT NOT NULL,
      user_role VARCHAR(10) NOT NULL DEFAULT 'user',
      discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_offer_tournament (offer_id, tournament_id),
      INDEX idx_offer_user (offer_id, user_id, user_role)
    )
  `);

  // ---- 3. Creation-fee payment ledger ----------------------------------------------------------------------
  // The tournament row keeps its own order/payment ids (unchanged); this is the auditable record admins
  // reconcile against, and razorpay_payment_id is UNIQUE so one payment can never be credited twice.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_fee_payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tournament_id INT NOT NULL,
      payer_id INT NOT NULL,
      payer_role VARCHAR(10) NOT NULL DEFAULT 'user',
      razorpay_order_id VARCHAR(100) NULL,
      razorpay_payment_id VARCHAR(100) NULL,
      base_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      offer_code VARCHAR(40) NULL,
      status ENUM('created','paid','failed','cancelled','refunded') NOT NULL DEFAULT 'created',
      verified_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_fee_tournament (tournament_id),
      INDEX idx_fee_status (status)
    )
  `);
  await addIndex('tournament_fee_payments', 'UNIQUE KEY uniq_fee_order (razorpay_order_id)');
  await addIndex('tournament_fee_payments', 'UNIQUE KEY uniq_fee_payment (razorpay_payment_id)');

  // ---- 4. Settings audit trail -------------------------------------------------------------------------------
  // Pricing changes never rewrite history: completed payments keep the amount that was actually charged.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_settings_audit (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NULL,
      entity VARCHAR(30) NOT NULL,
      entity_id INT NULL,
      action VARCHAR(30) NOT NULL,
      before_json TEXT NULL,
      after_json TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_entity (entity, entity_id),
      INDEX idx_audit_created (created_at)
    )
  `);
};
