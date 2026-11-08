const pool = require('../config/db');
const subscriptionReservations = require('./subscriptionReservations');
const { labelsConflict } = require('./slotSchedule');

/**
 * Common source of truth for slot availability checking across:
 * - Customer Bookings (confirmed or active 15-minute pending locks)
 * - Owner Blocks (blocked_slots)
 * - Subscription Reservations (subscription_reservations)
 */

/**
 * Checks availability of a single slot.
 * @param {Object} params
 * @param {number|string} params.turfId
 * @param {number|string|null} [params.courtId]
 * @param {string} params.date - YYYY-MM-DD
 * @param {string} params.timeSlot - Slot label e.g. "06:00 AM - 07:00 AM" or "18:00 - 19:00"
 * @param {number|string|null} [params.excludeBookingId] - Optional booking ID to exclude (e.g. during payment verification)
 * @param {Object} [params.dbConn] - Optional database connection/transaction
 * @returns {Promise<{available: boolean, reason?: string, message?: string, bookingDetails?: Object}>}
 */
async function checkSingleSlotAvailability({ turfId, courtId = null, date, timeSlot, excludeBookingId = null, dbConn = pool }) {
  const normalizedTurfId = Number(turfId);
  const normalizedCourtId = courtId ? Number(courtId) : null;
  const normalizedSlot = String(timeSlot || '').trim();

  // 0. Check if Turf itself is BLOCKED or inactive
  const [turfRows] = await dbConn.query('SELECT status, is_active, is_deleted FROM turfs WHERE id = ?', [normalizedTurfId]);
  if (turfRows.length > 0) {
    const turf = turfRows[0];
    if (turf.is_deleted || turf.status === 'BLOCKED' || turf.is_active === 0 || turf.is_active === false) {
      return {
        available: false,
        reason: 'VENUE_BLOCKED',
        message: 'This venue has been blocked by Admin.'
      };
    }
  }

  // 1. Check Customer Bookings
  let bookingQuery = `
    SELECT id, customer_name, court_id, status, payment_status, time_slot
    FROM bookings
    WHERE turf_id = ? AND booking_date = ?
    AND (
      (payment_status = 'success' AND status != 'cancelled')
      OR
      (payment_status = 'pending' AND status = 'pending' AND created_at > NOW() - INTERVAL 15 MINUTE)
    )
  `;
  const bookingParams = [normalizedTurfId, date];

  if (excludeBookingId) {
    if (Array.isArray(excludeBookingId)) {
      bookingQuery += ' AND id NOT IN (?)';
      bookingParams.push(excludeBookingId);
    } else {
      bookingQuery += ' AND id != ?';
      bookingParams.push(excludeBookingId);
    }
  }

  if (normalizedCourtId !== null) {
    bookingQuery += ' AND (court_id IS NULL OR court_id = ?)';
    bookingParams.push(normalizedCourtId);
  }
  // If normalizedCourtId is null (venue-wide), any booking for this turf/date/slot conflicts.

  // conflicts are decided on the TIME RANGE (12h vs 24h labels, 30 vs 60 min slots), never on label text
  const [bookingRowsAll] = await dbConn.query(bookingQuery, bookingParams);
  const bookingRows = bookingRowsAll.filter((r) => labelsConflict(r.time_slot, normalizedSlot));
  if (bookingRows.length > 0) {
    return {
      available: false,
      reason: 'BOOKED',
      message: `Slot ${normalizedSlot} is already booked by a customer.`,
      bookingDetails: bookingRows[0]
    };
  }

  // 2. Check Owner Blocked Slots
  let blockQuery = `
    SELECT id, reason, court_id, time_slot
    FROM blocked_slots
    WHERE turf_id = ? AND block_date = ?
  `;
  const blockParams = [normalizedTurfId, date];

  if (normalizedCourtId !== null) {
    blockQuery += ' AND (court_id IS NULL OR court_id = ?)';
    blockParams.push(normalizedCourtId);
  }
  // If normalizedCourtId is null (venue-wide), any blocked slot for this turf/date/slot conflicts.

  const [blockRowsAll] = await dbConn.query(blockQuery, blockParams);
  const blockRows = blockRowsAll.filter((r) => labelsConflict(r.time_slot, normalizedSlot));
  if (blockRows.length > 0) {
    return {
      available: false,
      reason: 'BLOCKED',
      message: `Slot ${normalizedSlot} is blocked by the venue.`,
      blockDetails: blockRows[0]
    };
  }

  // 3. Check Subscription Reservations
  const isSubReserved = await subscriptionReservations.slotReserved({
    turfId: normalizedTurfId,
    courtId: normalizedCourtId,
    date,
    slotLabel: normalizedSlot
  });

  if (isSubReserved) {
    return {
      available: false,
      reason: 'SUBSCRIPTION_RESERVED',
      message: 'This slot is reserved by an active subscription.'
    };
  }

  return { available: true };
}

/**
 * Checks availability of multiple slots for a booking or bulk block operation.
 * @param {Object} params
 * @param {number|string} params.turfId
 * @param {number|string|null} [params.courtId]
 * @param {string} params.date
 * @param {string[]} params.timeSlots
 * @param {number|string|null} [params.excludeBookingId]
 * @param {Object} [params.dbConn]
 * @returns {Promise<{available: boolean, conflictingSlot?: string, reason?: string, message?: string}>}
 */
async function checkMultipleSlotsAvailability({ turfId, courtId = null, date, timeSlots, excludeBookingId = null, dbConn = pool }) {
  if (!Array.isArray(timeSlots) || timeSlots.length === 0) {
    return { available: true };
  }

  for (const slot of timeSlots) {
    const result = await checkSingleSlotAvailability({
      turfId,
      courtId,
      date,
      timeSlot: slot,
      excludeBookingId,
      dbConn
    });

    if (!result.available) {
      return {
        available: false,
        conflictingSlot: slot,
        reason: result.reason,
        message: result.message
      };
    }
  }

  return { available: true };
}

module.exports = {
  checkSingleSlotAvailability,
  checkMultipleSlotsAvailability
};
