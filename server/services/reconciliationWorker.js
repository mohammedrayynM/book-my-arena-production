const pool = require('../config/db');
const { acquireCronLease, releaseCronLease } = require('./cronLeaseService');
const { reconcileOrderByOrderId } = require('./paymentConfirmationService');

const LEASE_NAME = 'pending_booking_reconciliation';
const RECON_INTERVAL_MS = 2 * 60 * 1000; // Run every 2 minutes
const PENDING_TIMEOUT_MINUTES = 5;       // Unpaid checkout attempts expire after 5 minutes

let isRunning = false;

/**
 * Executes one reconciliation cycle.
 * Backed by distributed database lease to ensure zero concurrency conflicts across clustered PM2 workers.
 */
async function runReconciliationCycle() {
  if (isRunning) return;
  isRunning = true;

  try {
    const hasLease = await acquireCronLease(LEASE_NAME, 120);
    if (!hasLease) {
      // Another instance is currently executing the reconciliation cycle
      return;
    }

    // Find pending bookings older than the timeout threshold
    const [pendingRows] = await pool.query(
      `SELECT id, razorpay_order_id, turf_id, time_slot, booking_date, created_at 
       FROM bookings 
       WHERE status = 'pending' AND payment_status = 'pending' 
         AND created_at < NOW() - INTERVAL ? MINUTE 
       ORDER BY created_at ASC LIMIT 100`,
      [PENDING_TIMEOUT_MINUTES]
    );

    if (pendingRows.length === 0) {
      await releaseCronLease(LEASE_NAME);
      return;
    }

    console.log(`[Reconciler] Found ${pendingRows.length} pending booking(s) older than ${PENDING_TIMEOUT_MINUTES}m to reconcile.`);

    // Group bookings by razorpay_order_id
    const orderMap = new Map();
    const withoutOrder = [];

    for (const b of pendingRows) {
      if (b.razorpay_order_id) {
        const list = orderMap.get(b.razorpay_order_id) || [];
        list.push(b.id);
        orderMap.set(b.razorpay_order_id, list);
      } else {
        withoutOrder.push(b.id);
      }
    }

    // 1. Reconcile bookings that have a Razorpay order ID
    for (const [orderId, bookingIds] of orderMap) {
      try {
        const result = await reconcileOrderByOrderId({ orderId, source: 'auto_reconciler' });
        if (result.confirmed) {
          console.log(`[Reconciler] Auto-confirmed booking(s) ${bookingIds.join(',')} for paid order ${orderId}!`);
        } else if (result.cancelled) {
          console.log(`[Reconciler] Safely expired unpaid booking(s) ${bookingIds.join(',')} for order ${orderId}.`);
        }
      } catch (err) {
        console.error(`[Reconciler] Error reconciling order ${orderId}:`, err.message);
      }
    }

    // 2. Expire bookings that never generated a Razorpay order ID
    if (withoutOrder.length > 0) {
      const placeholders = withoutOrder.map(() => '?').join(',');
      await pool.query(
        `UPDATE bookings 
         SET status = 'cancelled', payment_status = 'expired', cancel_reason = 'no_order_created', cancelled_at = NOW() 
         WHERE id IN (${placeholders}) AND status = 'pending'`,
        withoutOrder
      );
      console.log(`[Reconciler] Cancelled ${withoutOrder.length} orphan pending booking(s) with no order ID.`);
    }

    await releaseCronLease(LEASE_NAME);
  } catch (err) {
    console.error('[Reconciler] Unexpected error during reconciliation cycle:', err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background reconciliation worker.
 */
function startReconciliationWorker() {
  console.log(`🔄 [Reconciler] Background reconciliation worker started (Interval: ${RECON_INTERVAL_MS / 1000}s, Timeout: ${PENDING_TIMEOUT_MINUTES}m)`);
  // Run first cycle shortly after boot
  setTimeout(runReconciliationCycle, 5000);
  // Schedule periodic cycles
  setInterval(runReconciliationCycle, RECON_INTERVAL_MS);
}

module.exports = {
  startReconciliationWorker,
  runReconciliationCycle
};
