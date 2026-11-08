// Idempotent, additive schema for admin-controlled financial configuration. Nothing is dropped or rewritten:
// every statement is CREATE TABLE IF NOT EXISTS or ADD COLUMN (errors for "already exists" are ignored), so running it
// twice, or on a database that already has these objects, is safe. Existing turfs/bookings/transfers keep their data.
//
//   turf_billing_config_history   one row per admin change to a turf's billing model (versioned, with effective date)
//   platform_fee_rules            central customer service-fee + tax rules per country/currency (versioned)
//   turf_subscription_cycles      one ledger row per subscription cycle, pricing frozen at creation
//   turf_subscription_deductions  every amount deducted from booking proceeds toward a cycle (idempotent per transfer)
//   turf_billing_restrictions    audited admin actions that block new bookings for an overdue cycle only
//   admin_payment_actions         audit trail for the admin Payment-ID lookup / reconciliation tool
//   route_transfer_reversals      one row per refund whose share of an owner transfer was reversed (unique per refund)
//   route_split_transfers         + integer-minor snapshot columns of the exact calculation used for each transfer
//
// To roll back: the new tables can simply be dropped and the new route_split_transfers columns ignored; no pre-existing
// column is changed. Dropping turf_billing_restrictions restores booking access because enforcement reads only that table.
const pool = require('./config/db');

async function ensureColumn(table, columnSql) {
  try { await pool.query(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`); }
  catch (e) {
    if (!/Duplicate column name|already exists/i.test(String(e?.message || ''))) console.error(`⚠️ Billing config: failed to add column on ${table}: ${columnSql}`, e.message);
  }
}
async function ensureIndex(table, indexSql) {
  try { await pool.query(`ALTER TABLE ${table} ADD ${indexSql}`); }
  catch (e) {
    if (!/Duplicate key name|already exists/i.test(String(e?.message || ''))) console.error(`⚠️ Billing config: failed to add index on ${table}: ${indexSql}`, e.message);
  }
}

module.exports = async function ensureBillingConfigSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS turf_billing_config_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        turf_id INT NOT NULL,
        version INT NOT NULL,
        billing_model VARCHAR(20) NOT NULL,
        commission_bps INT NULL,
        flat_fee_minor BIGINT NULL,
        subscription_amount_minor BIGINT NULL,
        subscription_period VARCHAR(12) NULL,
        subscription_policy VARCHAR(24) NULL,
        subscription_anchor_date DATE NULL,
        grace_period_days INT NULL,
        min_fee_minor BIGINT NULL,
        max_fee_minor BIGINT NULL,
        tax_mode VARCHAR(12) NOT NULL DEFAULT 'NONE',
        tax_bps INT NULL,
        currency VARCHAR(3) NOT NULL,
        effective_from DATETIME NOT NULL,
        created_by INT NULL,
        reason VARCHAR(500) NULL,
        previous_snapshot TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_billing_version (turf_id, version),
        INDEX idx_billing_effective (turf_id, effective_from, id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_fee_rules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        country_code VARCHAR(2) NOT NULL,
        currency_code VARCHAR(3) NOT NULL,
        fee_type VARCHAR(8) NOT NULL DEFAULT 'NONE',
        fee_fixed_minor BIGINT NULL,
        fee_bps INT NULL,
        tax_bps INT NULL,
        tax_inclusive BOOLEAN NOT NULL DEFAULT false,
        refund_fee_policy VARCHAR(16) NOT NULL DEFAULT 'NON_REFUNDABLE',
        coupon_applies_before_fee BOOLEAN NOT NULL DEFAULT true,
        effective_from DATETIME NOT NULL,
        created_by INT NULL,
        note VARCHAR(500) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_fee_rule_lookup (country_code, currency_code, effective_from, id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS turf_subscription_cycles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        turf_id INT NOT NULL,
        cycle_start DATE NOT NULL,
        cycle_end DATE NOT NULL,
        amount_minor BIGINT NOT NULL,
        currency VARCHAR(3) NOT NULL,
        policy VARCHAR(24) NOT NULL,
        config_history_id INT NULL,
        paid_separately_minor BIGINT NOT NULL DEFAULT 0,
        status VARCHAR(12) NOT NULL DEFAULT 'UNPAID',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_turf_cycle (turf_id, cycle_start)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS venue_billing_payments (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        cycle_id INT NOT NULL,
        turf_id INT NOT NULL,
        owner_id INT NOT NULL,
        razorpay_order_id VARCHAR(64) NOT NULL,
        razorpay_payment_id VARCHAR(64) NULL,
        amount_minor BIGINT NOT NULL,
        currency VARCHAR(3) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        active_cycle_id INT NULL,
        failure_reason VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        paid_at TIMESTAMP NULL,
        UNIQUE KEY uniq_venue_billing_order (razorpay_order_id),
        UNIQUE KEY uniq_venue_billing_payment (razorpay_payment_id),
        UNIQUE KEY uniq_venue_billing_active_cycle (active_cycle_id),
        INDEX idx_venue_billing_cycle (cycle_id, id),
        INDEX idx_venue_billing_owner (owner_id, id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS turf_billing_restrictions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        turf_id INT NOT NULL,
        active_turf_id INT NULL,
        cycle_id INT NOT NULL,
        outstanding_minor BIGINT NOT NULL,
        currency VARCHAR(3) NOT NULL,
        reason VARCHAR(500) NOT NULL,
        expected_impact VARCHAR(255) NOT NULL,
        applied_by INT NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        removed_by INT NULL,
        removed_at TIMESTAMP NULL,
        remove_reason VARCHAR(500) NULL,
        UNIQUE KEY uniq_active_turf_billing_restriction (active_turf_id),
        INDEX idx_turf_billing_restriction_history (turf_id, id),
        INDEX idx_turf_billing_restriction_cycle (cycle_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS turf_subscription_deductions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        cycle_id INT NOT NULL,
        turf_id INT NOT NULL,
        amount_minor BIGINT NOT NULL,
        idempotency_key VARCHAR(190) NOT NULL,
        split_transfer_id INT NULL,
        reversed_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_deduction_key (idempotency_key),
        INDEX idx_deduction_cycle (cycle_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_payment_actions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        admin_id INT NOT NULL,
        action VARCHAR(32) NOT NULL,
        razorpay_payment_id VARCHAR(64) NOT NULL,
        turf_id INT NULL,
        outcome VARCHAR(24) NOT NULL,
        details TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_apa_payment (razorpay_payment_id, id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS route_transfer_reversals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        refund_id INT NOT NULL,
        transfer_record_id INT NOT NULL,
        razorpay_transfer_id VARCHAR(64) NULL,
        razorpay_reversal_id VARCHAR(64) NULL,
        amount_minor BIGINT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
        error_message TEXT NULL,
        created_by INT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_reversal_refund (refund_id)
      )
    `);

    // 'subscription' (12 chars) did not fit the original VARCHAR(10) columns, so choosing it failed in strict SQL mode.
    // Widening a VARCHAR never changes existing data.
    for (const [table, col, def] of [['turfs', 'route_commission_type', "VARCHAR(16) NOT NULL DEFAULT 'percentage'"], ['route_split_transfers', 'commission_type', "VARCHAR(16) NOT NULL DEFAULT 'percentage'"]]) {
      try { await pool.query(`ALTER TABLE ${table} MODIFY COLUMN ${col} ${def}`); }
      catch (e) { console.error(`⚠️ Billing config: could not widen ${table}.${col}:`, e.message); }
    }

    // exact integer snapshot of how each Route transfer was calculated (the legacy DECIMAL columns stay filled too)
    await ensureColumn('route_split_transfers', "currency VARCHAR(3) NULL");
    await ensureColumn('route_split_transfers', 'captured_minor BIGINT NULL');
    await ensureColumn('route_split_transfers', 'platform_fee_minor BIGINT NULL');
    await ensureColumn('route_split_transfers', 'tax_minor BIGINT NULL');
    await ensureColumn('route_split_transfers', 'customer_fee_minor BIGINT NULL');
    await ensureColumn('route_split_transfers', 'subscription_deduction_minor BIGINT NULL');
    await ensureColumn('route_split_transfers', 'owner_transfer_minor BIGINT NULL');
    await ensureColumn('route_split_transfers', 'billing_model VARCHAR(20) NULL');
    await ensureColumn('route_split_transfers', 'config_history_id INT NULL');
    await ensureColumn('route_split_transfers', 'config_snapshot TEXT NULL');
    await ensureColumn('route_split_transfers', "source VARCHAR(16) NOT NULL DEFAULT 'auto'"); // auto | admin_reconcile
    await ensureColumn('route_split_transfers', 'reconciled_by INT NULL');
    await ensureIndex('route_split_transfers', 'UNIQUE KEY uniq_route_razorpay_transfer (razorpay_transfer_id)');
  } catch (e) {
    console.error('⚠️ Billing config migration error:', e.message);
  }
};
