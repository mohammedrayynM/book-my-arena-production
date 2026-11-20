const pool = require('../config/db');
const routeProvider = require('./routeProvider');
const subscriptionReservations = require('./subscriptionReservations');
const availabilityService = require('./availabilityService');
const { acquireSlotLock, releaseSlotLock } = require('./slotLock');
const { refundConflictedPayment } = require('./conflictRefund');
const receiptService = require('./receiptService');
const routeSplit = require('./routeSplit');
const { toMinor } = require('../utils/money');
const { fire: fireNotification } = require('../utils/notifications/events');

/**
 * Audit logger for all payment confirmations, reconciliations, and exception events.
 */
async function logReconciliation({
  bookingId = null,
  orderId = null,
  paymentId = null,
  source = 'unknown',
  action = 'INFO',
  status = 'INFO',
  amount = null,
  currency = 'INR',
  details = null
}) {
  try {
    const detailStr = typeof details === 'object' && details !== null ? JSON.stringify(details) : String(details || '');
    await pool.query(
      `INSERT INTO payment_reconciliation_logs 
        (booking_id, razorpay_order_id, razorpay_payment_id, source, action, status, amount, currency, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [bookingId, orderId, paymentId, source, action, status, amount, currency, detailStr]
    );
  } catch (err) {
    console.error('[ReconciliationLog] Failed to record log entry:', err.message);
  }
}

/**
 * Checks whether any of the slots in `rows` conflicts with an already paid booking.
 */
async function checkSlotConflict(rows, ownIds) {
  for (const b of rows) {
    const r = await availabilityService.checkSingleSlotAvailability({
      turfId: b.turf_id,
      courtId: b.court_id || null,
      date: b.booking_date,
      timeSlot: b.time_slot,
      excludeBookingId: ownIds,
      paidOnly: true,
      skipVenueStatus: true,
    });
    if (!r.available) return true;
  }
  return false;
}

/**
 * Follow-up tasks executed immediately after booking confirmation (Find Players requests, notifications).
 */
async function afterBookingsConfirmed(ids) {
  const placeholders = ids.map(() => '?').join(',');

  try {
    const [rows] = await pool.query(
      `SELECT b.*, t.name as turf_name, t.latitude as turf_lat, t.longitude as turf_lng, t.location as turf_loc
       FROM bookings b JOIN turfs t ON b.turf_id = t.id
       WHERE b.id IN (${placeholders})`,
      [...ids]
    );
    const booking = rows.find(r => r.need_players === 1 || r.need_players === true || r.need_players === '1');

    if (booking && !booking.player_request_created) {
      let matchRequestId = booking.match_request_id;
      if (!matchRequestId) {
        const [result] = await pool.query(
          `INSERT INTO player_requests
            (user_id, turf_id, court_id, match_date, time_slot, sport_type,
             players_needed, match_type, skill_level, contact_phone, note, status,
             venue_name, venue_address, latitude, longitude, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NOW())`,
          [
            booking.user_id,
            booking.turf_id,
            booking.court_id || null,
            booking.booking_date,
            booking.time_slot,
            booking.sport_type || 'all',
            booking.players_needed || 1,
            booking.match_type || 'friendly',
            booking.skill_level || 'all',
            booking.contact_phone || booking.customer_phone || null,
            booking.note || null,
            booking.turf_name,
            booking.turf_loc || 'Venue Address',
            booking.turf_lat || null,
            booking.turf_lng || null
          ]
        );
        matchRequestId = result.insertId;
        await pool.query(
          `UPDATE bookings SET match_request_id = ? WHERE id IN (${placeholders})`,
          [matchRequestId, ...ids]
        );
      }
      await pool.query(
        `UPDATE bookings SET player_request_created = TRUE WHERE id IN (${placeholders})`,
        [...ids]
      );
      fireNotification('find_players.match_created', { matchRequestId });
    }
  } catch (prErr) {
    console.warn('⚠️  Failed to handle after-confirmation player request:', prErr.message);
  }

  fireNotification('booking.confirmed', { bookingIds: ids });
}

/**
 * THE SINGLE AUTHORITATIVE CONFIRMATION SERVICE.
 * Shared by Frontend /verify, Razorpay Webhook, and Scheduled Background Reconciler.
 *
 * Invariants enforced:
 * - Rule A: Captured payment is never lost.
 * - Rule B: No unpaid booking is confirmed.
 * - Rule C: No conflicting confirmed bookings.
 * - Rule D: Concurrency race conditions are safely locked and resolved.
 * - Rule E: Idempotency is strictly guaranteed.
 */
async function confirmPaymentAndAllocateSlot({
  orderId,
  paymentId,
  bookingIds = null,
  source = 'unknown',
  expectedUserId = null,
  razorpayPaymentObj = null
}) {
  let ids = Array.isArray(bookingIds) ? bookingIds.map(Number).filter(Boolean) : [];

  // 1. Resolve booking rows
  let bookingRows = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT * FROM bookings WHERE id IN (${placeholders}) ORDER BY id ASC`,
      ids
    );
    bookingRows = rows;
  } else if (orderId) {
    const [rows] = await pool.query(
      `SELECT * FROM bookings WHERE razorpay_order_id = ? ORDER BY id ASC`,
      [orderId]
    );
    bookingRows = rows;
    ids = rows.map(r => r.id);
  } else if (paymentId) {
    const [rows] = await pool.query(
      `SELECT * FROM bookings WHERE payment_id = ? ORDER BY id ASC`,
      [paymentId]
    );
    bookingRows = rows;
    ids = rows.map(r => r.id);
  }

  if (bookingRows.length === 0) {
    await logReconciliation({
      orderId,
      paymentId,
      source,
      action: 'RESOLVE_BOOKING',
      status: 'NOT_FOUND',
      details: 'No bookings found matching orderId/paymentId/bookingIds'
    });
    return { success: false, notFound: true, error: 'No bookings found for this payment' };
  }

  const primaryBooking = bookingRows[0];
  const turfId = primaryBooking.turf_id;

  // 2. Security check: User authorization if expectedUserId is specified (frontend /verify)
  if (expectedUserId != null) {
    const isOwner = bookingRows.every(b => Number(b.user_id) === Number(expectedUserId));
    if (!isOwner) {
      await logReconciliation({
        bookingId: primaryBooking.id,
        orderId,
        paymentId,
        source,
        action: 'USER_CHECK',
        status: 'UNAUTHORIZED',
        details: `Caller userId ${expectedUserId} does not match booking user_id ${primaryBooking.user_id}`
      });
      return { success: false, status: 403, error: 'Payment does not belong to your account' };
    }
  }

  // 3. Strict Idempotency Check: Already confirmed with this exact payment ID?
  const allAlreadyConfirmed = bookingRows.every(
    b => b.status === 'confirmed' && b.payment_status === 'success' && b.payment_id === paymentId
  );
  if (allAlreadyConfirmed) {
    // Process route split if not yet executed
    try {
      if (paymentId) {
        await routeSplit.processSplitTransfer({
          paymentId,
          orderId: orderId || primaryBooking.razorpay_order_id,
          bookingIds: ids
        });
      }
    } catch (e) {
      console.error('[RouteSplit] already_confirmed split transfer check:', e.message);
    }

    await logReconciliation({
      bookingId: primaryBooking.id,
      orderId: orderId || primaryBooking.razorpay_order_id,
      paymentId,
      source,
      action: 'IDEMPOTENCY',
      status: 'ALREADY_CONFIRMED',
      details: 'Booking is already confirmed with this verified payment'
    });
    return { success: true, alreadyConfirmed: true, message: 'Booking is already confirmed' };
  }

  // 4. Verify payment with Razorpay directly
  let rpPayment = razorpayPaymentObj;
  if (!rpPayment && paymentId) {
    try {
      rpPayment = await routeProvider.fetchPayment(paymentId);
    } catch (err) {
      console.error(`[PaymentService] Could not fetch payment ${paymentId} from Razorpay:`, err.message);
      return { success: false, pending: true, error: `Could not verify payment with gateway: ${err.message}` };
    }
  }

  if (!rpPayment) {
    return { success: false, pending: true, error: 'No payment record available from gateway' };
  }

  // Verify payment status
  if (rpPayment.status === 'failed') {
    await pool.query(
      `UPDATE bookings SET payment_status = 'failed', status = 'cancelled', cancel_reason = 'gateway_payment_failed'
       WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'pending'`,
      ids
    );
    await logReconciliation({
      bookingId: primaryBooking.id,
      orderId: rpPayment.order_id || orderId,
      paymentId: rpPayment.id,
      source,
      action: 'PAYMENT_VERIFIED',
      status: 'FAILED',
      amount: Number(rpPayment.amount) / 100,
      currency: rpPayment.currency,
      details: rpPayment.error_description || rpPayment.error_reason || 'Payment failed on gateway'
    });
    return { success: false, paymentFailed: true, error: 'Payment failed on gateway' };
  }

  if (rpPayment.status !== 'captured') {
    // If authorized but not yet captured, we don't confirm yet
    return {
      success: false,
      pending: true,
      error: `Payment is currently ${rpPayment.status}; waiting for capture`
    };
  }

  // 5. Amount & Currency Matching
  const expectedCurrency = primaryBooking.currency_code || 'INR';
  const expectedMinor = bookingRows.reduce(
    (sum, r) => sum + toMinor(Number(r.advance_amount != null ? r.advance_amount : r.amount || 0), expectedCurrency),
    0
  );
  const capturedMinor = Number(rpPayment.amount);

  if (
    rpPayment.currency !== expectedCurrency ||
    !Number.isSafeInteger(capturedMinor) ||
    (expectedMinor > 0 && capturedMinor < expectedMinor)
  ) {
    const errorMsg = `Payment ${rpPayment.id} captured ${capturedMinor} ${rpPayment.currency} but bookings need ${expectedMinor} ${expectedCurrency}`;
    console.error(`[PaymentService] Amount mismatch: ${errorMsg}`);
    await pool.query(
      `UPDATE bookings SET payment_status = 'reconciliation_required', status = 'reconciliation_required' WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    await logReconciliation({
      bookingId: primaryBooking.id,
      orderId: rpPayment.order_id,
      paymentId: rpPayment.id,
      source,
      action: 'AMOUNT_CHECK',
      status: 'AMOUNT_MISMATCH',
      amount: capturedMinor / 100,
      currency: rpPayment.currency,
      details: errorMsg
    });
    return { success: false, error: 'Payment amount mismatch. Marked for admin reconciliation.' };
  }

  // 6. Double payment protection: If already paid with another payment ID
  const alreadyPaidWithAnotherPayment = bookingRows.some(
    b => b.payment_status === 'success' && b.payment_id && b.payment_id !== paymentId
  );
  if (alreadyPaidWithAnotherPayment) {
    console.warn(`[PaymentService] Booking ${primaryBooking.id} is already paid; refunding extra payment ${paymentId}`);
    const duplicateRefund = await refundConflictedPayment({ bookingIds: ids, paymentId });
    await logReconciliation({
      bookingId: primaryBooking.id,
      orderId: rpPayment.order_id,
      paymentId,
      source,
      action: 'DUPLICATE_PAYMENT',
      status: 'REFUNDED',
      amount: capturedMinor / 100,
      currency: rpPayment.currency,
      details: 'Booking already paid with another payment ID. Additional payment refunded.'
    });
    return {
      success: false,
      code: 'DUPLICATE_PAYMENT_REFUNDED',
      refundInitiated: !!(duplicateRefund.refunds && duplicateRefund.refunds.length),
      error: 'This booking already has a verified payment. The additional payment is being refunded in full.'
    };
  }

  // 7. Atomic Concurrency Lock: Venue Slot Lock + Subscription Lock
  const slotLockAcquired = await acquireSlotLock(turfId);
  if (!slotLockAcquired) {
    return {
      success: false,
      pending: true,
      error: 'Payment is verified; slot allocation is currently finalizing. Please check again in moments.'
    };
  }

  let lostSlot = false;
  let confirmFollowUp = null;

  try {
    const vlock = await subscriptionReservations.lockVenue(turfId);
    try {
      // 8. Slot Conflict Check: Did someone else take the slot during a late payment?
      const conflictFound = await checkSlotConflict(bookingRows, ids);

      if (conflictFound) {
        lostSlot = true;
        // Mark as cancelled due to conflict
        await vlock.conn.query(
          `UPDATE bookings SET payment_status = 'failed', status = 'cancelled', cancel_reason = 'slot_conflict_refunded', cancelled_at = NOW() WHERE id IN (${ids.map(() => '?').join(',')})`,
          ids
        );
      } else {
        // Re-check subscription reservations under the lock
        for (const b of bookingRows) {
          const isSubReserved = await subscriptionReservations.slotReserved({
            turfId: b.turf_id,
            courtId: b.court_id,
            date: b.booking_date,
            slotLabel: b.time_slot
          });
          if (isSubReserved) {
            lostSlot = true;
            await vlock.conn.query(
              `UPDATE bookings SET payment_status = 'failed', status = 'cancelled', cancel_reason = 'subscription_conflict_refunded', cancelled_at = NOW() WHERE id IN (${ids.map(() => '?').join(',')})`,
              ids
            );
            break;
          }
        }
      }

      if (!lostSlot) {
        // CONFIRM THE BOOKINGS ATOMICALLY
        const placeholders = ids.map(() => '?').join(',');
        await vlock.conn.query(
          `UPDATE bookings 
           SET payment_id = ?, payment_status = 'success', status = 'confirmed', cancel_reason = NULL, cancelled_at = NULL 
           WHERE id IN (${placeholders})`,
          [paymentId, ...ids]
        );
        confirmFollowUp = () => afterBookingsConfirmed(ids);
      }
    } finally {
      if (vlock) await vlock.release();
    }
  } finally {
    await releaseSlotLock(turfId);
  }

  // 9. Handle Slot Loss / Race Conflict (Automatic Full Refund)
  if (lostSlot) {
    fireNotification('booking.failed', {
      bookingIds: ids,
      reason: 'slot_unavailable',
      paymentId
    });

    const conflictRefund = await refundConflictedPayment({
      bookingIds: ids,
      paymentId,
      reason: 'Slot conflict: slot was allocated prior to payment completion'
    });

    await logReconciliation({
      bookingId: primaryBooking.id,
      orderId: rpPayment.order_id,
      paymentId,
      source,
      action: 'SLOT_CONFLICT',
      status: 'REFUND_INITIATED',
      amount: capturedMinor / 100,
      currency: rpPayment.currency,
      details: 'Slot was taken before payment completed. Full refund initiated.'
    });

    return {
      success: false,
      code: 'SLOT_CONFLICT_REFUNDED',
      refundInitiated: !!(conflictRefund.refunds && conflictRefund.refunds.length),
      error: 'Sorry, this slot was reserved just before payment was finalized. Your payment has been refunded in full.'
    };
  }

  // 10. Execute Follow-up Tasks (Find Players, Notifications)
  if (confirmFollowUp) {
    try {
      await confirmFollowUp();
    } catch (e) {
      console.warn('[PaymentService] Error in confirmFollowUp:', e.message);
    }
  }

  // 11. Generate and Save Durable Receipt in Database
  try {
    await receiptService.generateAndSaveReceipt({
      bookingRows,
      paymentId,
      paymentMethod: rpPayment.method || 'upi'
    });
  } catch (e) {
    console.error('[PaymentService] Error generating receipt:', e.message);
  }

  // 12. Send Confirmation Emails Safely (Non-blocking)
  try {
    receiptService.sendConfirmationEmailsSafely(ids).catch(e => {
      console.warn('[PaymentService] Async email dispatch error:', e.message);
    });
  } catch (e) {
    console.warn('[PaymentService] Failed to queue confirmation emails:', e.message);
  }

  // 13. Process Razorpay Route Split Transfer (Non-blocking)
  try {
    if (paymentId) {
      routeSplit.processSplitTransfer({
        paymentId,
        orderId: rpPayment.order_id || orderId,
        bookingIds: ids,
        capturedMinor,
        currency: rpPayment.currency
      }).catch(e => {
        console.error('[PaymentService] Async route split error:', e.message);
      });
    }
  } catch (routeErr) {
    console.error('[PaymentService] Error triggering route split transfer:', routeErr.message);
  }

  // 14. Durable Audit Log
  await logReconciliation({
    bookingId: primaryBooking.id,
    orderId: rpPayment.order_id,
    paymentId,
    source,
    action: 'CONFIRM_BOOKING',
    status: 'SUCCESS',
    amount: capturedMinor / 100,
    currency: rpPayment.currency,
    details: `Confirmed booking(s) ${ids.join(',')} for slot ${primaryBooking.time_slot}`
  });

  console.log(`✅ [PaymentService] Successfully confirmed booking(s) ${ids.join(',')} for payment ${paymentId} (Source: ${source})`);

  return {
    success: true,
    confirmed: true,
    bookingIds: ids,
    paymentId,
    orderId: rpPayment.order_id
  };
}

/**
 * Reconciles an entire order by checking Razorpay for captured payments.
 * Called by the background reconciler or admin tools.
 */
async function reconcileOrderByOrderId({ orderId, source = 'auto_reconciler' }) {
  if (!orderId) return { error: 'orderId is required' };

  const [bookingRows] = await pool.query(
    'SELECT * FROM bookings WHERE razorpay_order_id = ? ORDER BY id ASC',
    [orderId]
  );
  if (bookingRows.length === 0) return { error: 'No bookings found for order' };

  const ids = bookingRows.map(b => b.id);

  // If already confirmed, nothing to do
  if (bookingRows.every(b => b.status === 'confirmed' && b.payment_status === 'success')) {
    return { success: true, alreadyConfirmed: true };
  }

  try {
    const payments = await routeProvider.fetchOrderPayments(orderId);
    const captured = payments.find(p => p.status === 'captured');

    if (captured) {
      // Payment captured on Razorpay! Confirm booking!
      return await confirmPaymentAndAllocateSlot({
        orderId,
        paymentId: captured.id,
        bookingIds: ids,
        source,
        razorpayPaymentObj: captured
      });
    }

    const hasAuthorized = payments.some(p => p.status === 'authorized');
    if (hasAuthorized) {
      // Still in authorization / pending capture: defer release
      return { success: false, pending: true, message: 'Payment is currently authorized; waiting for capture' };
    }

    // All attempts failed or no payments attempted
    const placeholders = ids.map(() => '?').join(',');
    await pool.query(
      `UPDATE bookings 
       SET payment_status = 'expired', status = 'cancelled', cancel_reason = 'timeout_expired', cancelled_at = NOW() 
       WHERE id IN (${placeholders}) AND status = 'pending'`,
      ids
    );

    // Rollback coupon usages
    const couponCodes = [...new Set(bookingRows.map(b => b.coupon_code).filter(Boolean))];
    for (const code of couponCodes) {
      await pool.query('UPDATE coupons SET used_count = GREATEST(0, used_count - 1) WHERE code = ?', [code]).catch(() => {});
      await pool.query('UPDATE admin_coupons SET used_count = GREATEST(0, used_count - 1) WHERE code = ?', [code]).catch(() => {});
      await pool.query(`DELETE FROM coupon_usages WHERE booking_id IN (${placeholders})`, ids).catch(() => {});
      await pool.query(`DELETE FROM admin_coupon_usages WHERE booking_id IN (${placeholders})`, ids).catch(() => {});
    }

    await logReconciliation({
      bookingId: ids[0],
      orderId,
      source,
      action: 'EXPIRE_UNPAID',
      status: 'EXPIRED',
      details: 'All payments failed or abandoned; reservation released safely.'
    });

    return { success: true, cancelled: true, message: 'Unpaid reservation expired safely' };
  } catch (err) {
    console.error(`[ReconcileOrder] Failed to reconcile order ${orderId}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  confirmPaymentAndAllocateSlot,
  reconcileOrderByOrderId,
  logReconciliation
};
