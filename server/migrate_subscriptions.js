// Idempotent schema for the hardened subscription system. Everything here EXTENDS the existing model
// (subscription_plans = the owner's OFFER, user_subscriptions = a customer's SUBSCRIPTION); nothing existing is dropped.
//
//   subscription_admin_plans   admin-controlled plan templates (name, months, price, currency, features, enabled)
//   subscription_payments      every payment ATTEMPT (purchase or renewal), separate from the subscription's own status
//   subscription_reservations  one row per reserved occurrence (venue + court + date + start time + seat). A DATABASE UNIQUE KEY
//                              (with an "active" marker) makes a double reservation of the same seat impossible.
//   subscription_audit_log     who did what, to which subscription, when, and why
//
// Columns that existed on the live database but in no repo migration (duration_days, available_days, eligible_slots, perks,
// selected_slot, selected_days) are added here too, so a database built from the repo matches production.
const pool = require('./config/db');

async function ensureColumn(table, columnSql) {
  try { await pool.query(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`); }
  catch (e) { if (!/Duplicate column name|already exists/i.test(String(e?.message || ''))) console.error(`⚠️ Subscriptions: failed to add column on ${table}: ${columnSql}`, e.message); }
}
async function ensureIndex(sql) {
  try { await pool.query(sql); } catch (e) { if (!/Duplicate key name|already exists|Duplicate entry/i.test(String(e?.message || ''))) console.error('⚠️ Subscriptions index:', e.message); }
}

module.exports = async function ensureSubscriptionSchema() {
  try {
    // ---- the owner's OFFER
    await ensureColumn('subscription_plans', 'duration_days INT NULL');
    await ensureColumn('subscription_plans', "available_days VARCHAR(40) NOT NULL DEFAULT 'all'"); // 'all' or weekday numbers "1,3,5" (0 = Sunday)
    await ensureColumn('subscription_plans', 'eligible_slots TEXT NULL');
    await ensureColumn('subscription_plans', 'perks TEXT NULL');
    await ensureColumn('subscription_plans', "currency_code CHAR(3) NOT NULL DEFAULT 'INR'");
    await ensureColumn('subscription_plans', 'admin_plan_id INT NULL');
    await ensureColumn('subscription_plans', "price_source VARCHAR(8) NOT NULL DEFAULT 'owner'"); // 'admin' = price/duration come from the admin plan

    // ---- admin-controlled plan templates
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_admin_plans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        duration_months INT NOT NULL,
        price DECIMAL(12,3) NOT NULL,
        currency_code CHAR(3) NOT NULL DEFAULT 'INR',
        billing_interval VARCHAR(10) NOT NULL DEFAULT 'monthly',
        features JSON NULL,
        is_enabled BOOLEAN NOT NULL DEFAULT true,
        created_by INT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_admin_plans_enabled (is_enabled, currency_code)
      )
    `);

    // ---- the customer SUBSCRIPTION (user_id becomes nullable: an owner can add a member who has no app account)
    try { await pool.query('ALTER TABLE user_subscriptions MODIFY COLUMN user_id INT NULL'); } catch (e) { if (!/Duplicate|already/i.test(e.message)) console.error('⚠️ Subscriptions user_id nullable:', e.message); }
    try {
      await pool.query("ALTER TABLE user_subscriptions MODIFY COLUMN status ENUM('pending','active','expired','pending_renewal','paused','cancelled','past_due','suspended','refunded') NOT NULL DEFAULT 'pending'");
    } catch (e) { console.error('⚠️ Subscriptions status enum:', e.message); }
    await ensureColumn('user_subscriptions', 'selected_slot VARCHAR(100) NULL');
    await ensureColumn('user_subscriptions', 'selected_days VARCHAR(255) NULL');
    const cols = [
      "currency_code CHAR(3) NOT NULL DEFAULT 'INR'",
      'amount_due_minor BIGINT NOT NULL DEFAULT 0',
      'amount_paid_minor BIGINT NOT NULL DEFAULT 0',
      "source VARCHAR(8) NOT NULL DEFAULT 'online'",           // online | manual
      "payment_type VARCHAR(8) NOT NULL DEFAULT 'online'",     // online | paid | offline | manual
      'member_name VARCHAR(120) NULL', 'member_phone VARCHAR(30) NULL', 'member_email VARCHAR(150) NULL',
      'subscription_start_date DATE NULL', 'current_period_start DATE NULL', 'current_period_end DATE NULL', 'next_billing_date DATE NULL',
      'months_total INT NOT NULL DEFAULT 0',                   // calendar months bought so far: period ends are anchored to the START date
      'weekdays VARCHAR(20) NULL',                             // snapshot of the schedule this subscription reserved ("1,3,5"; NULL = every day)
      'start_time TIME NULL', 'end_time TIME NULL',
      'activated_at DATETIME NULL', 'cancelled_at DATETIME NULL',
      'cancelled_by VARCHAR(8) NULL', 'cancelled_by_id INT NULL', 'cancel_reason VARCHAR(255) NULL',
      'renewal_of INT NULL',
      'period_months INT NOT NULL DEFAULT 1',
    ];
    for (const c of cols) await ensureColumn('user_subscriptions', c);
    await ensureIndex('ALTER TABLE user_subscriptions ADD UNIQUE KEY uniq_sub_payment (razorpay_payment_id)');
    await ensureIndex('ALTER TABLE user_subscriptions ADD INDEX idx_sub_turf_status (turf_id, status)');

    // ---- every payment attempt (kept for audit even when it fails or is abandoned)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        subscription_id INT NOT NULL,
        kind VARCHAR(10) NOT NULL DEFAULT 'purchase',          -- purchase | renewal
        gateway_order_id VARCHAR(80) NULL,
        gateway_payment_id VARCHAR(80) NULL,
        amount_minor BIGINT NOT NULL,
        currency_code CHAR(3) NOT NULL,
        period_months INT NOT NULL DEFAULT 1,
        status VARCHAR(10) NOT NULL DEFAULT 'created',          -- created | success | failed | cancelled | refunded
        failure_reason VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        paid_at DATETIME NULL,
        UNIQUE KEY uniq_subpay_order (gateway_order_id),
        UNIQUE KEY uniq_subpay_payment (gateway_payment_id),
        INDEX idx_subpay_sub (subscription_id)
      )
    `);

    // ---- reserved occurrences. court_key = court id, or 0 for "no court". seat_no < capacity of the plan.
    // active_key is 1 while the reservation holds the seat and NULL once it is released/used/expired, so the UNIQUE key only
    // constrains LIVE reservations and history is never deleted.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_reservations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        subscription_id INT NOT NULL,
        turf_id INT NOT NULL,
        court_key INT NOT NULL DEFAULT 0,
        court_id INT NULL,
        reservation_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        seat_no INT NOT NULL DEFAULT 1,
        status VARCHAR(10) NOT NULL DEFAULT 'active',            -- active | used | cancelled | expired
        active_key TINYINT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_live_seat (turf_id, court_key, reservation_date, start_time, seat_no, active_key),
        INDEX idx_resv_sub (subscription_id),
        INDEX idx_resv_lookup (turf_id, reservation_date, status)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        subscription_id INT NULL,
        venue_id INT NULL,
        actor_id INT NULL,
        actor_role VARCHAR(10) NOT NULL,                        -- user | owner | admin | system
        action VARCHAR(40) NOT NULL,
        reason VARCHAR(255) NULL,
        details JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_subaudit_sub (subscription_id),
        INDEX idx_subaudit_venue (venue_id, created_at)
      )
    `);

    // the refund ledger also carries subscription refunds
    try { await pool.query('ALTER TABLE refunds MODIFY COLUMN booking_type VARCHAR(20) NOT NULL'); } catch (e) { if (!/doesn't exist/i.test(e.message)) console.error('⚠️ Subscriptions refunds.booking_type:', e.message); }
  } catch (e) {
    console.error('⚠️ Subscription schema migration error:', e.message);
  }
};
