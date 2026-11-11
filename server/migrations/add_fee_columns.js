// Migration: add service_fee_tax, fee_rule_id, fee_rule_snapshot columns to bookings & activity_bookings.
// Also ensures platform_fee_rules has apply_to, show_fee_at_checkout, is_active.
// Safe to re-run: uses IF NOT EXISTS / column-existence checks.
const pool = require('../config/db');

async function hasColumn(table, col) {
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [table, col]
    );
    return rows.length > 0;
  } catch { return false; }
}

async function addIfMissing(table, col, def) {
  if (!(await hasColumn(table, col))) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${def}`);
    console.log(`  ✓ Added ${table}.${col}`);
  } else {
    console.log(`  – ${table}.${col} already exists`);
  }
}

async function run() {
  console.log('[migration] add_fee_columns — start');

  // bookings table
  await addIfMissing('bookings', 'service_fee_tax', 'DECIMAL(10,2) DEFAULT 0 AFTER service_fee');
  await addIfMissing('bookings', 'fee_rule_id', 'INT DEFAULT NULL AFTER service_fee_tax');
  await addIfMissing('bookings', 'fee_rule_snapshot', 'JSON DEFAULT NULL AFTER fee_rule_id');

  // activity_bookings table (may not exist)
  try {
    await addIfMissing('activity_bookings', 'service_fee', 'DECIMAL(10,2) DEFAULT 0');
    await addIfMissing('activity_bookings', 'service_fee_tax', 'DECIMAL(10,2) DEFAULT 0');
    await addIfMissing('activity_bookings', 'fee_rule_id', 'INT DEFAULT NULL');
    await addIfMissing('activity_bookings', 'fee_rule_snapshot', 'JSON DEFAULT NULL');
  } catch (e) {
    console.log('  – activity_bookings table not found, skipping');
  }

  // platform_fee_rules extensions
  await addIfMissing('platform_fee_rules', 'apply_to', "VARCHAR(20) DEFAULT 'ALL'");
  await addIfMissing('platform_fee_rules', 'show_fee_at_checkout', 'TINYINT(1) DEFAULT 1');
  await addIfMissing('platform_fee_rules', 'is_active', 'TINYINT(1) DEFAULT 1');

  console.log('[migration] add_fee_columns — done');
}

module.exports = { run };

if (require.main === module) {
  run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
