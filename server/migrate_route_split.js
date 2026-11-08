// Idempotent schema for the NEW per-turf, percentage-based Razorpay Route split system.
//
// This is deliberately separate from the pre-existing (and currently unused) monthly-subscription-ledger Route mechanism
// in services/razorpayRoute.js / turf_subscriptions / turfs.razorpay_linked_account_id / turfs.monthly_subscription_amount.
// That mechanism is a different business model (a flat monthly platform fee deducted from booking revenue) and is left
// completely untouched here — no column it uses is renamed, altered or read by this migration.
//
// Every new turfs column defaults to the "off" state (route_enabled = false, route_status = 'not_configured'), so every
// existing turf keeps behaving exactly as it does today until an admin explicitly configures and enables Route for it.
const pool = require('./config/db');

async function ensureColumn(table, columnSql) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
  } catch (e) {
    if (!/Duplicate column name|already exists/i.test(String(e?.message || ''))) {
      console.error(`⚠️ Route split: failed to add column on ${table}: ${columnSql}`, e.message);
    }
  }
}

module.exports = async function ensureRouteSplitSchema() {
  try {
    // ---- per-turf Route configuration (columns on turfs, matching how the legacy Route fields already live there) ----
    await ensureColumn('turfs', 'route_enabled BOOLEAN NOT NULL DEFAULT false');
    await ensureColumn('turfs', "route_status VARCHAR(20) NOT NULL DEFAULT 'not_configured'"); // not_configured | configured | approved | active | suspended
    await ensureColumn('turfs', 'route_linked_account_id VARCHAR(255) NULL');
    await ensureColumn('turfs', "route_commission_type VARCHAR(10) NOT NULL DEFAULT 'percentage'"); // percentage | flat
    await ensureColumn('turfs', 'route_split_percentage DECIMAL(5,2) NULL'); // Book Arena's share when commission_type='percentage', e.g. 10.00 = 10%
    await ensureColumn('turfs', 'route_flat_amount DECIMAL(10,2) NULL'); // Book Arena's fixed ₹ per booking when commission_type='flat'
    await ensureColumn('turfs', "route_environment VARCHAR(10) NOT NULL DEFAULT 'test'"); // test | live — 'live' is the only value that ever calls the real Razorpay Route API
    await ensureColumn('turfs', 'route_configured_at DATETIME NULL');
    await ensureColumn('turfs', 'route_approved_at DATETIME NULL');
    await ensureColumn('turfs', 'route_approved_by INT NULL'); // admins.id

    // ---- the new split-transfer ledger, parallel to (and independent of) the legacy razorpay_transfers table ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS route_split_transfers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        booking_id INT NULL,
        subscription_id INT NULL,
        turf_id INT NOT NULL,
        razorpay_payment_id VARCHAR(64) NOT NULL,
        razorpay_order_id VARCHAR(64) NULL,
        razorpay_transfer_id VARCHAR(64) NULL,
        linked_account_id VARCHAR(255) NULL,
        split_percentage DECIMAL(5,2) NOT NULL,
        gross_amount DECIMAL(10,2) NOT NULL,
        platform_amount DECIMAL(10,2) NOT NULL,
        owner_amount DECIMAL(10,2) NOT NULL,
        environment VARCHAR(10) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        error_message TEXT NULL,
        idempotency_key VARCHAR(190) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_route_transfer_key (idempotency_key),
        INDEX idx_route_transfer_turf (turf_id, id),
        INDEX idx_route_transfer_booking (booking_id),
        INDEX idx_route_transfer_status (status)
      )
    `);
    // route_split_transfers existed before flat-commission support was added; these two columns extend it in place.
    await ensureColumn('route_split_transfers', "commission_type VARCHAR(10) NOT NULL DEFAULT 'percentage'");
    await ensureColumn('route_split_transfers', 'flat_amount DECIMAL(10,2) NULL'); // the turf's flat ₹ at the time of this transfer, when commission_type='flat'

    // ---- audit trail: every admin change to a turf's Route configuration ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS route_audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        turf_id INT NOT NULL,
        admin_id INT NOT NULL,
        action VARCHAR(40) NOT NULL,
        field VARCHAR(40) NULL,
        old_value VARCHAR(255) NULL,
        new_value VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_route_audit_turf (turf_id, id)
      )
    `);
  } catch (e) {
    console.error('⚠️ Route split migration error:', e.message);
  }
};
