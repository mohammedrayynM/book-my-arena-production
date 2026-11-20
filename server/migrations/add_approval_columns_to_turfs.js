const pool = require('../config/db');

async function hasColumn(table, col) {
  try {
    const [rows] = await pool.query(
      'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
      [table, col]
    );
    return rows.length > 0;
  } catch { return false; }
}

async function addIfMissing(table, col, def) {
  if (!(await hasColumn(table, col))) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`  ✓ Added ${table}.${col}`);
  } else {
    console.log(`  – ${table}.${col} already exists`);
  }
}

async function run() {
  console.log('[migration] add_approval_columns_to_turfs — start');
  await addIfMissing('turfs', 'approved_by', 'INT DEFAULT NULL');
  await addIfMissing('turfs', 'approved_at', 'DATETIME DEFAULT NULL');
  console.log('[migration] add_approval_columns_to_turfs — done');
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
