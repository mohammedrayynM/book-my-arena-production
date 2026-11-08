// Slot-control / 24-hour scheduling / cancellation-policy migration. Idempotent and ADDITIVE ONLY:
//  - turfs.is_24_hours / courts.is_24_hours  TINYINT(1) NOT NULL DEFAULT 0. Existing venues keep their current open/close
//    configuration untouched (legacy 00:00–00:00 rows already behaved as all-day and are flagged so the forms show it).
//  - one new cancellation-policy VERSION (8h window, 10% retained) so existing bookings keep the terms they were booked under
//    (per-booking policy snapshots already freeze window/fee).
//  - read indexes for availability checks and paginated booking history (skipped silently if present / table missing).
const pool = require('./config/db');

async function columnExists(table, col) {
  const [r] = await pool.query('SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1', [table, col]);
  return r.length > 0;
}
async function tableExists(table) {
  const [r] = await pool.query('SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1', [table]);
  return r.length > 0;
}
async function addIndex(table, name, cols) {
  try {
    if (!(await tableExists(table))) return;
    for (const c of cols) if (!(await columnExists(table, c))) return;
    const [r] = await pool.query('SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1', [table, name]);
    if (r.length) return;
    await pool.query(`CREATE INDEX ${name} ON ${table} (${cols.join(', ')})`);
  } catch (e) { console.warn(`[slots-migration] index ${name} skipped: ${e.message}`); }
}

const POLICY_NOTE = 'Customer cancellation: 90% refund at least 8 hours before slot start';

module.exports = async function migrateSlotsPolicy() {
  for (const t of ['turfs', 'courts']) {
    try {
      if (await tableExists(t) && !(await columnExists(t, 'is_24_hours'))) {
        await pool.query(`ALTER TABLE ${t} ADD COLUMN is_24_hours TINYINT(1) NOT NULL DEFAULT 0`);
      }
      if (await tableExists(t) && await columnExists(t, 'is_24_hours')) {
        // legacy all-day rows (00:00 → 00:00/23:59/24:00) are flagged; nothing else is changed
        await pool.query(`UPDATE ${t} SET is_24_hours = 1 WHERE is_24_hours = 0 AND open_time IN ('00:00','00:00:00') AND close_time IN ('00:00','00:00:00','23:59','23:59:00','24:00')`);
      }
    } catch (e) { console.warn(`[slots-migration] ${t}.is_24_hours: ${e.message}`); }
  }

  try {
    if (await tableExists('cancellation_policies')) {
      const [[have]] = await pool.query('SELECT id FROM cancellation_policies WHERE note = ? LIMIT 1', [POLICY_NOTE]);
      if (!have) {
        // This is a policy version, not a replacement. Keep prior active flags and
        // booking snapshots intact; globalConfig selects the newest policy by id.
        await pool.query(
          'INSERT INTO cancellation_policies (cancellation_enabled, window_hours, fee_percent, customer_refund_enabled, owner_refund_percent, is_active, created_by, note) VALUES (true, 8, 10, true, 100, true, NULL, ?)',
          [POLICY_NOTE]);
      }
    }
  } catch (e) { console.warn('[slots-migration] policy version: ' + e.message); }

  await addIndex('bookings', 'idx_bookings_slot_lookup', ['turf_id', 'booking_date', 'status']);
  await addIndex('blocked_slots', 'idx_blocked_slot_lookup', ['turf_id', 'block_date']);
  await addIndex('bookings', 'idx_bookings_user_history', ['user_id', 'booking_date']);
};
