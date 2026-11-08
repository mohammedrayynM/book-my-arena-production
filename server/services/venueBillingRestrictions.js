const pool = require('../config/db');
const billing = require('./billingConfig');

const EXPECTED_IMPACT = 'New bookings blocked; existing and confirmed bookings remain unchanged';

async function getActive(turfId, executor = pool) {
  const [[restriction]] = await executor.query(
    `SELECT id, turf_id, cycle_id, outstanding_minor, currency, reason, expected_impact, applied_by, applied_at
     FROM turf_billing_restrictions
     WHERE active_turf_id = ?
     ORDER BY id DESC LIMIT 1`,
    [turfId]
  );
  return restriction || null;
}

async function apply({ turfId, cycleId, adminId, reason }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[cycle]] = await conn.query(
      `SELECT c.*, h.grace_period_days
       FROM turf_subscription_cycles c
       LEFT JOIN turf_billing_config_history h ON h.id = c.config_history_id
       WHERE c.id = ? AND c.turf_id = ? FOR UPDATE`,
      [cycleId, turfId]
    );
    if (!cycle) throw Object.assign(new Error('Subscription cycle not found'), { status: 404 });
    if (cycle.policy !== 'SEPARATE') throw Object.assign(new Error('Only separately billed subscription cycles can restrict new bookings'), { status: 409 });

    const totals = await billing.cycleTotals(conn, cycle.id);
    const graceDays = Number(cycle.grace_period_days || 0);
    const [[age]] = await conn.query('SELECT DATEDIFF(CURDATE(), ?) AS days_overdue', [cycle.cycle_start]);
    if (totals.outstandingMinor <= 0 || Number(age.days_overdue) <= graceDays) {
      throw Object.assign(new Error('The subscription cycle must remain unpaid after its grace period before applying a restriction'), { status: 409 });
    }
    const active = await getActive(turfId, conn);
    if (active) throw Object.assign(new Error('This venue already has an active new-bookings restriction'), { status: 409 });

    const [insert] = await conn.query(
      `INSERT INTO turf_billing_restrictions
        (turf_id, active_turf_id, cycle_id, outstanding_minor, currency, reason, expected_impact, applied_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [turfId, turfId, cycle.id, totals.outstandingMinor, cycle.currency, reason, EXPECTED_IMPACT, adminId]
    );
    await conn.query(
      `INSERT INTO route_audit_log (turf_id, admin_id, action, field, old_value, new_value)
       VALUES (?, ?, 'billing_restriction_apply', 'new_bookings', NULL, ?)`,
      [turfId, adminId, `restriction_id=${insert.insertId}; cycle_id=${cycle.id}; ${reason}`.slice(0, 255)]
    );
    await conn.commit();
    return {
      id: insert.insertId,
      cycle_id: cycle.id,
      outstanding_minor: totals.outstandingMinor,
      currency: cycle.currency,
      expected_impact: EXPECTED_IMPACT,
    };
  } catch (error) {
    try { await conn.rollback(); } catch (_) { /* transaction may already be committed */ }
    throw error;
  } finally {
    conn.release();
  }
}

async function remove({ turfId, adminId, reason }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const active = await getActive(turfId, conn);
    if (!active) throw Object.assign(new Error('This venue has no active new-bookings restriction'), { status: 409 });
    await conn.query(
      `UPDATE turf_billing_restrictions
       SET active_turf_id = NULL, removed_by = ?, removed_at = NOW(), remove_reason = ?
       WHERE id = ? AND active_turf_id = ?`,
      [adminId, reason, active.id, turfId]
    );
    await conn.query(
      `INSERT INTO route_audit_log (turf_id, admin_id, action, field, old_value, new_value)
       VALUES (?, ?, 'billing_restriction_remove', 'new_bookings', ?, ?)`,
      [turfId, adminId, `restriction_id=${active.id}; cycle_id=${active.cycle_id}`, reason.slice(0, 255)]
    );
    await conn.commit();
    return { id: active.id };
  } catch (error) {
    try { await conn.rollback(); } catch (_) { /* transaction may already be committed */ }
    throw error;
  } finally {
    conn.release();
  }
}

async function releaseForPaidCycle(conn, turfId, cycleId) {
  await conn.query(
    `UPDATE turf_billing_restrictions
     SET active_turf_id = NULL, removed_at = NOW(), remove_reason = 'Automatically removed after verified subscription payment'
     WHERE active_turf_id = ? AND cycle_id = ?`,
    [turfId, cycleId]
  );
}

module.exports = { EXPECTED_IMPACT, getActive, apply, remove, releaseForPaidCycle };
