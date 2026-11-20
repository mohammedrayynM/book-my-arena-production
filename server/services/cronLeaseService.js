const pool = require('../config/db');
const os = require('os');

const INSTANCE_ID = `${os.hostname()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Acquires a distributed database lease for a scheduled cron/worker job.
 * Ensures only ONE node/process in a PM2 cluster or multi-server deployment runs the job at a time.
 * @param {string} jobName
 * @param {number} leaseSeconds
 * @returns {Promise<boolean>}
 */
async function acquireCronLease(jobName, leaseSeconds = 120) {
  try {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Check current lease
      const [rows] = await conn.query(
        'SELECT locked_by, expires_at, (expires_at > NOW()) AS is_active FROM system_cron_leases WHERE job_name = ? FOR UPDATE',
        [jobName]
      );

      if (rows.length === 0) {
        // Insert new lease
        await conn.query(
          'INSERT INTO system_cron_leases (job_name, locked_by, locked_at, expires_at) VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND))',
          [jobName, INSTANCE_ID, leaseSeconds]
        );
        await conn.commit();
        return true;
      }

      const lease = rows[0];
      if (Number(lease.is_active) === 1 && lease.locked_by !== INSTANCE_ID) {
        // Active lease held by another worker instance
        await conn.rollback();
        return false;
      }

      // Expired or held by this same instance: renew
      await conn.query(
        'UPDATE system_cron_leases SET locked_by = ?, locked_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE job_name = ?',
        [INSTANCE_ID, leaseSeconds, jobName]
      );
      await conn.commit();
      return true;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.warn(`[CronLease] Could not acquire lease for ${jobName}:`, err.message);
    return false;
  }
}

/**
 * Releases a lease early upon job completion.
 * @param {string} jobName
 */
async function releaseCronLease(jobName) {
  try {
    await pool.query(
      'UPDATE system_cron_leases SET expires_at = NOW() WHERE job_name = ? AND locked_by = ?',
      [jobName, INSTANCE_ID]
    );
  } catch (err) {
    console.warn(`[CronLease] Could not release lease for ${jobName}:`, err.message);
  }
}

module.exports = { acquireCronLease, releaseCronLease, INSTANCE_ID };
