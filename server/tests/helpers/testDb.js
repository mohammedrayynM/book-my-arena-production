// Test-only database helper. SAFETY: refuses to run unless DB_NAME ends with "_test", so these tests can never touch
// the real (TiDB) database even if server/.env points at it. Point DB_* at a throwaway MySQL/MariaDB/TiDB database:
//   DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=... DB_PASSWORD=... DB_NAME=bookarena_test node --test tests/
const pool = require('../../config/db');

function assertTestDb() {
  if (!/_test$/.test(String(process.env.DB_NAME || ''))) {
    throw new Error(`Refusing to run: DB_NAME must end with "_test" (got "${process.env.DB_NAME}")`);
  }
}

async function setup() {
  assertTestDb();
  await pool.query(`CREATE TABLE IF NOT EXISTS owners (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), email VARCHAR(100))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS admins (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(100))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS turfs (
    id INT AUTO_INCREMENT PRIMARY KEY, owner_id INT, name VARCHAR(100), country_code VARCHAR(2) DEFAULT 'IN', currency_code VARCHAR(3) DEFAULT 'INR',
    approval_status VARCHAR(20) DEFAULT 'APPROVED', is_active BOOLEAN DEFAULT true, status VARCHAR(20) DEFAULT 'active',
    billing_model ENUM('MONTHLY','PERCENTAGE') DEFAULT 'PERCENTAGE', commission_percentage DECIMAL(5,2) DEFAULT 5.00,
    monthly_subscription_amount DECIMAL(10,2) DEFAULT 0, subscription_status VARCHAR(50) DEFAULT 'ACTIVE', subscription_start_date DATE NULL, next_billing_date DATE NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS bookings (
    id INT AUTO_INCREMENT PRIMARY KEY, turf_id INT, amount DECIMAL(10,2), original_price DECIMAL(10,2), advance_amount DECIMAL(10,2) NULL, pending_balance DECIMAL(10,2) NULL, currency_code VARCHAR(3) DEFAULT 'INR',
    service_fee DECIMAL(10,2) DEFAULT 0, razorpay_order_id VARCHAR(64) NULL, payment_id VARCHAR(64) NULL, payment_status VARCHAR(20) DEFAULT 'pending',
    status VARCHAR(20) DEFAULT 'pending', customer_name VARCHAR(100), customer_email VARCHAR(100) NULL, customer_phone VARCHAR(20) NULL, court_id INT NULL, booking_date DATE, time_slot VARCHAR(40), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS subscription_reservations (id INT AUTO_INCREMENT PRIMARY KEY, turf_id INT, court_key VARCHAR(40), reservation_date DATE, start_time VARCHAR(10), end_time VARCHAR(10), status VARCHAR(12) DEFAULT 'active', active_key TINYINT DEFAULT 1)`);
  await require('../../migrate_route_split')();
  await require('../../migrate_billing_config')();
}

async function reset() {
  assertTestDb();
  for (const t of ['turf_billing_restrictions', 'venue_billing_payments', 'turf_subscription_deductions', 'turf_subscription_cycles', 'turf_billing_config_history', 'platform_fee_rules', 'admin_payment_actions',
    'route_audit_log', 'route_transfer_reversals', 'route_split_transfers', 'subscription_reservations', 'bookings', 'turfs', 'owners', 'admins']) await pool.query(`DELETE FROM ${t}`);
}

async function seedTurf(fields = {}) {
  const [o] = await pool.query("INSERT INTO owners (name, email) VALUES ('Owner', 'o@x.test')");
  const f = { owner_id: o.insertId, name: 'Turf', ...fields };
  const cols = Object.keys(f);
  const [t] = await pool.query(`INSERT INTO turfs (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => f[c]));
  return t.insertId;
}
async function routeOn(turfId, acct = 'acc_TESTACCOUNT01') {
  await pool.query("UPDATE turfs SET route_enabled = true, route_status = 'active', route_linked_account_id = ?, route_environment = 'test' WHERE id = ?", [acct, turfId]);
}
async function seedBooking(turfId, { amount = 1000, advance = null, order = 'order_1' } = {}) {
  const [b] = await pool.query(
    "INSERT INTO bookings (turf_id, amount, original_price, advance_amount, razorpay_order_id, payment_status, status, customer_name) VALUES (?, ?, ?, ?, ?, 'success', 'confirmed', 'Cust')",
    [turfId, amount, amount, advance, order]
  );
  return b.insertId;
}

module.exports = { pool, setup, reset, seedTurf, routeOn, seedBooking };
