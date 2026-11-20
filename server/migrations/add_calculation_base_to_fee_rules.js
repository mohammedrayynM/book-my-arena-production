// Migration: add calculation_base column to platform_fee_rules.
// Values: 'FULL' (default) = fee/tax on full booking amount, 'ONLINE' = fee/tax on online payment amount only.
// Safe to re-run: checks if the column already exists.
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

async function run() {
  console.log('[migration] add_calculation_base_to_fee_rules — start');

  if (!(await hasColumn('platform_fee_rules', 'calculation_base'))) {
    await pool.query(`ALTER TABLE platform_fee_rules ADD COLUMN calculation_base VARCHAR(20) NOT NULL DEFAULT 'FULL'`);
    console.log('  ✓ Added platform_fee_rules.calculation_base');
  } else {
    console.log('  – platform_fee_rules.calculation_base already exists');
  }

  console.log('[migration] add_calculation_base_to_fee_rules — done');
}

module.exports = { run };

if (require.main === module) {
  run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
