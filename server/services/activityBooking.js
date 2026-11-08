// The ticket-booking engine (Activities / amusement parks / events) — ENGINE 2, kept fully separate from the
// sports/turf slot-booking engine (ENGINE 1, routes/bookings.js). Nothing here reads or writes turfs/bookings/courts.
//
// Flow: price is always computed here, server-side, from the activity's own stored ticket types/offers/add-ons —
// never from a client-sent amount. Inventory (activity_inventory.sold / activity_time_windows.sold) is only ever
// incremented inside confirmBooking(), inside a real transaction with row locks, at the moment a payment is verified
// — exactly mirroring how routes/bookings.js resolves slot conflicts at /verify time rather than at order creation,
// so an abandoned checkout never permanently eats capacity.
const crypto = require('crypto');
const pool = require('../config/db');
const Razorpay = require('razorpay');
const globalConfig = require('./globalConfig');
const { toMinor } = require('../utils/money');
require('dotenv').config();

let razorpay = null;
function client() {
  if (!razorpay) razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  return razorpay;
}

const TICKET_STATUSES = ['UNUSED', 'VALID', 'SCANNED', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'BLOCKED'];

function dayOfWeek(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay(); // 0 = Sunday ... 6 = Saturday
}
const isWeekend = (ymd) => [0, 6].includes(dayOfWeek(ymd));
// mysql2 returns a DATE column as a local-midnight JS Date, not a string — normalize either shape to 'YYYY-MM-DD'.
function toDateString(v) {
  if (v instanceof Date) { const p = (n) => String(n).padStart(2, '0'); return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`; }
  return String(v).slice(0, 10);
}
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const nonNegativeAmount = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
};
function isValidDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3]);
}
function genToken() { return crypto.randomBytes(24).toString('base64url'); }
function genBookingCode(id) { return `BA-${new Date().getFullYear()}-${String(id).padStart(6, '0')}`; }


/**
 * QR validity for the booked date, using the MOST SPECIFIC configuration available:
 * timed-entry window > custom owner times > venue opening hours (default) / the whole day.
 */
function validityTimes(activity, timeWindow) {
  if (timeWindow && timeWindow.start_time && timeWindow.end_time) return { from: String(timeWindow.start_time), until: String(timeWindow.end_time) };
  if (activity.qr_validity_mode === 'custom' && activity.qr_valid_from && activity.qr_valid_until) return { from: String(activity.qr_valid_from), until: String(activity.qr_valid_until) };
  if (activity.qr_validity_mode === 'day') return { from: '00:00:00', until: '23:59:59' };
  return { from: String(activity.opening_time || '00:00:00'), until: String(activity.closing_time || '23:59:59') };
}

async function getActivity(activityId) {
  const [[a]] = await pool.query(
    `SELECT a.*, c.key_name AS category_key, c.label AS category_label, o.name AS owner_name
     FROM activities a JOIN activity_categories c ON c.id = a.category_id JOIN owners o ON o.id = a.owner_id
     WHERE a.id = ?`, [activityId]
  );
  return a || null;
}

/**
 * Server-authoritative price breakdown. `items` = [{ ticket_type_id, quantity }], `addons` = [{ addon_id, quantity }].
 * Never trusts a client-sent price/subtotal/discount/total — only ticket_type_id/addon_id/quantity/offer code, and
 * looks everything else up itself.
 */
async function calculatePrice({ activityId, bookingDate, items, addons = [], offerCode, customer = {} }) {
  const normalizedActivityId = Number(activityId);
  if (!Number.isInteger(normalizedActivityId) || normalizedActivityId <= 0) return { error: 'Invalid activity selection' };
  if (!isValidDateOnly(bookingDate)) return { error: 'Select a valid booking date' };

  const activity = await getActivity(normalizedActivityId);
  if (!activity) return { error: 'Activity not found' };
  if (!Array.isArray(items) || items.length === 0) return { error: 'Select at least one ticket' };

  const ids = items.map((item) => Number(item && item.ticket_type_id));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return { error: 'Invalid ticket selection' };
  if (new Set(ids).size !== ids.length) return { error: 'Each ticket type can only be selected once' };
  const [typeRows] = await pool.query(
    `SELECT * FROM activity_ticket_types WHERE id IN (${ids.map(() => '?').join(',')}) AND activity_id = ? AND is_active = true AND approval_status = 'APPROVED'`,
    [...ids, normalizedActivityId]
  );
  const typesById = new Map(typeRows.map((t) => [t.id, t]));

  const weekend = isWeekend(bookingDate);
  const lineItems = [];
  let subtotal = 0;
  for (const item of items) {
    const { ticket_type_id, quantity } = item;
    const t = typesById.get(Number(ticket_type_id));
    const qty = Number(quantity);
    if (!t) return { error: `Ticket type ${ticket_type_id} is not available for this activity` };
    if (!Number.isInteger(qty) || qty <= 0) return { error: `Invalid quantity for ${t.name}` };
    const minQuantity = Number(t.min_quantity ?? 1);
    const maxQuantity = Number(t.max_quantity ?? 100);
    if (!Number.isInteger(minQuantity) || minQuantity < 1 || !Number.isInteger(maxQuantity) || maxQuantity < minQuantity) {
      return { error: `Ticket limits for ${t.name} are invalid. Please contact the venue.` };
    }
    if (qty < minQuantity) return { error: `${t.name} requires at least ${minQuantity} ticket(s)` };
    if (qty > maxQuantity) return { error: `${t.name} allows at most ${maxQuantity} ticket(s) per booking` };

    // date-specific override (festival/peak pricing) beats weekend pricing, which beats base weekday price
    const [[inv]] = await pool.query('SELECT special_price, capacity, sold, is_closed FROM activity_inventory WHERE ticket_type_id = ? AND date = ?', [t.id, bookingDate]);
    if (inv && inv.is_closed) return { error: `${activity.name} is closed on this date` };

    const capacity = inv ? inv.capacity : (t.daily_capacity || 200);
    // Atomic check against confirmed bookings on that date
    const [[bookedRow]] = await pool.query(
      `SELECT COALESCE(SUM(bi.quantity), 0) AS total_booked
       FROM activity_booking_items bi
       JOIN activity_bookings b ON b.id = bi.booking_id
       WHERE bi.ticket_type_id = ? AND b.booking_date = ? AND b.status = 'confirmed'`,
      [t.id, bookingDate]
    );
    const booked = inv ? Math.max(inv.sold, Number(bookedRow?.total_booked || 0)) : Number(bookedRow?.total_booked || 0);
    const remaining = capacity - booked;
    if (qty > remaining) return { error: remaining <= 0 ? `${t.name} is sold out for this date` : `Only ${remaining} ${t.name} ticket(s) left for this date` };

    const rawUnitPrice = inv && inv.special_price != null
      ? inv.special_price
      : (weekend && t.weekend_price != null ? t.weekend_price : t.price);
    const unitPrice = nonNegativeAmount(rawUnitPrice);
    if (unitPrice === null) return { error: `A valid price is unavailable for ${t.name}. Please try again later.` };
    const lineTotal = round2(unitPrice * qty);
    subtotal = round2(subtotal + lineTotal);
    lineItems.push({ ticket_type_id: t.id, name: t.name, product_type: t.product_type || 'ENTRY', requires_entry: !!t.requires_entry, quantity: qty, unit_price: unitPrice, line_total: lineTotal });
  }

  // Commercial rule: if any selected ride requires entry, verify an entry ticket is present
  const hasEntryTicket = lineItems.some(i => (i.product_type || '').toUpperCase() === 'ENTRY');
  const rideNeedingEntry = lineItems.find(i => i.requires_entry);
  if (rideNeedingEntry && !hasEntryTicket) {
    const [[hasAnyEntry]] = await pool.query(
      "SELECT id FROM activity_ticket_types WHERE activity_id = ? AND product_type = 'ENTRY' AND is_active = true LIMIT 1",
      [activityId]
    );
    if (hasAnyEntry) {
      return { error: `An Entry Ticket is required to book ${rideNeedingEntry.name}. Please select an Entry Ticket before checking out.` };
    }
  }

  let addonAmount = 0;
  const addonItems = [];
  if (!Array.isArray(addons)) return { error: 'Invalid add-on selection' };
  if (addons.length) {
    const addonIds = addons.map((addon) => Number(addon && addon.addon_id));
    if (addonIds.some((id) => !Number.isInteger(id) || id <= 0)) return { error: 'Invalid add-on selection' };
    if (new Set(addonIds).size !== addonIds.length) return { error: 'Each add-on can only be selected once' };
    const [addonRows] = await pool.query(
      `SELECT * FROM activity_addons WHERE id IN (${addonIds.map(() => '?').join(',')}) AND activity_id = ? AND is_active = true`,
      [...addonIds, normalizedActivityId]
    );
    const addonsById = new Map(addonRows.map((a) => [a.id, a]));
    for (const { addon_id, quantity } of addons) {
      const a = addonsById.get(Number(addon_id));
      const qty = Number(quantity);
      if (!a) return { error: `Add-on ${addon_id} is not available for this activity` };
      if (!Number.isInteger(qty) || qty <= 0) return { error: `Invalid quantity for ${a.name}` };
      const unitPrice = nonNegativeAmount(a.price);
      if (unitPrice === null) return { error: `A valid price is unavailable for ${a.name}. Please try again later.` };
      const lineTotal = round2(unitPrice * qty);
      addonAmount = round2(addonAmount + lineTotal);
      addonItems.push({ addon_id: a.id, name: a.name, quantity: qty, unit_price: unitPrice, line_total: lineTotal });
    }
  }

  let discountAmount = 0; let offer = null;
  if (offerCode) {
    const [[o]] = await pool.query('SELECT * FROM activity_offers WHERE activity_id = ? AND code = ? AND is_active = true', [activityId, String(offerCode).trim().toUpperCase()]);
    const today = new Date().toISOString().slice(0, 10);
    if (!o) return { error: 'Invalid offer code' };
    if (o.valid_from && today < o.valid_from) return { error: 'This offer is not active yet' };
    if (o.valid_until && today > o.valid_until) return { error: 'This offer has expired' };
    if (o.max_uses != null && o.used_count >= o.max_uses) return { error: 'This offer has been fully redeemed' };
    if (subtotal < Number(o.min_amount)) return { error: `This offer needs a minimum of ₹${o.min_amount}` };
    if (o.per_user_limit && (customer.userId || customer.email || customer.phone)) {
      const [[usage]] = await pool.query(
        'SELECT COUNT(*) AS c FROM activity_offer_usages WHERE offer_id = ? AND ((user_id IS NOT NULL AND user_id = ?) OR (customer_email = ?) OR (customer_phone = ?))',
        [o.id, customer.userId || null, customer.email || null, customer.phone || null]
      );
      if (usage.c >= o.per_user_limit) return { error: 'You have already used this offer' };
    }
    const discountValue = nonNegativeAmount(o.discount_value);
    const maxDiscountCap = o.max_discount_cap == null ? null : nonNegativeAmount(o.max_discount_cap);
    if (!['flat', 'percentage'].includes(o.discount_type) || discountValue === null ||
      (o.discount_type === 'percentage' && discountValue > 100) || (o.max_discount_cap != null && maxDiscountCap === null)) {
      return { error: 'This offer is configured incorrectly. Please contact the venue.' };
    }
    discountAmount = o.discount_type === 'flat' ? Math.min(discountValue, subtotal) : round2(subtotal * discountValue / 100);
    if (maxDiscountCap !== null) discountAmount = Math.min(discountAmount, maxDiscountCap);
    discountAmount = round2(discountAmount);
    offer = o;
  }

  const taxPercent = nonNegativeAmount(activity.tax_percent ?? 0);
  if (taxPercent === null) return { error: 'The tax configuration is invalid. Please contact the venue.' };
  const taxable = round2(subtotal + addonAmount - discountAmount);
  const taxAmount = round2(taxable * taxPercent / 100);
  const total = round2(taxable + taxAmount);
  return { activity, lineItems, addonItems, subtotal, addonAmount, discountAmount, taxAmount, total, offer, weekend };
}

/** Creates the pending booking + a Razorpay order for the authoritative total. No ticket exists yet. */
async function createPendingBooking({ activityId, bookingDate, timeWindowId, items, addons, offerCode, customer }) {
  const priced = await calculatePrice({ activityId, bookingDate, items, addons, offerCode, customer });
  if (priced.error) return priced;
  const { activity, lineItems, addonItems, subtotal, addonAmount, discountAmount, taxAmount, total, offer } = priced;

  if (activity.status !== 'approved') return { error: 'This activity is not open for booking' };

  // A ticket for a venue that has already shut today could never be used
  const nowD = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  const todayStr = `${nowD.getFullYear()}-${p2(nowD.getMonth() + 1)}-${p2(nowD.getDate())}`;
  const nowHms = `${p2(nowD.getHours())}:${p2(nowD.getMinutes())}:${p2(nowD.getSeconds())}`;
  if (String(bookingDate).slice(0, 10) === todayStr && activity.closing_time && String(activity.closing_time) < nowHms) return { error: `${activity.name} has closed for today. Pick another date.` };

  if (timeWindowId) {
    const [[w]] = await pool.query('SELECT * FROM activity_time_windows WHERE id = ? AND activity_id = ? AND date = ?', [timeWindowId, activityId, bookingDate]);
    if (!w) return { error: 'Select a valid entry time' };
    if (String(bookingDate).slice(0, 10) === todayStr && String(w.end_time) < nowHms) return { error: 'That entry time has already ended' };
    const totalQty = lineItems.reduce((s, i) => s + i.quantity, 0);
    if (w.sold + totalQty > w.capacity) return { error: 'That entry time is sold out' };
  } else if (activity.timed_entry_enabled) {
    return { error: 'Select an entry time' };
  }

  let orderId = null;
  const currency = activity.currency_code || 'INR';
  if (total > 0) {
    if (!process.env.RAZORPAY_KEY_ID) return { error: 'Payments are not configured' };
    if (!(await globalConfig.paymentsEnabledFor(activity.country_code || 'IN', currency))) return { error: `Online payments in ${currency} are not available for this venue yet.` };
    const order = await client().orders.create({ amount: toMinor(total, currency), currency, notes: { activity_id: String(activityId) } });
    orderId = order.id;
  }

  const [ins] = await pool.query(
    `INSERT INTO activity_bookings (booking_code, activity_id, owner_id, user_id, customer_name, customer_phone, customer_email, booking_date, time_window_id, status, payment_status, razorpay_order_id, subtotal_amount, discount_amount, addon_amount, tax_amount, total_amount, offer_id)
     VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    [activityId, activity.owner_id, customer.userId || null, customer.name || null, customer.phone || null, customer.email || null, bookingDate, timeWindowId || null, orderId, subtotal, discountAmount, addonAmount, taxAmount, total, offer ? offer.id : null]
  );
  const bookingId = ins.insertId;
  await pool.query('UPDATE activity_bookings SET booking_code = ? WHERE id = ?', [genBookingCode(bookingId), bookingId]);
  for (const li of lineItems) {
    await pool.query(
      'INSERT INTO activity_booking_items (booking_id, ticket_type_id, quantity, redeemed_quantity, status, unit_price, line_total) VALUES (?, ?, ?, 0, \'VALID\', ?, ?)',
      [bookingId, li.ticket_type_id, li.quantity, li.unit_price, li.line_total]
    );
  }
  for (const ad of addonItems) {
    await pool.query(
      'INSERT INTO activity_booking_addons (booking_id, addon_id, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?)',
      [bookingId, ad.addon_id, ad.quantity, ad.unit_price, ad.line_total]
    );
  }

  const policy = await globalConfig.getActivePolicy();
  await pool.query('UPDATE activity_bookings SET currency_code = ?, policy_version = ?, policy_window_hours = ?, policy_fee_percent = ? WHERE id = ?', [currency, policy.version || null, policy.windowHours, policy.feePercent, bookingId]);
  return { bookingId, orderId, total, currency, amountMinor: toMinor(total, currency), skipPayment: total === 0 };
}

/**
 * The ONLY place capacity is actually reserved and tickets are created — inside one transaction, with row locks,
 * so two concurrent checkouts for the last seats can never both win.
 */
async function confirmBooking({ bookingId, paymentId }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[booking]] = await connection.query('SELECT * FROM activity_bookings WHERE id = ? FOR UPDATE', [bookingId]);
    if (!booking) { await connection.rollback(); return { error: 'Booking not found' }; }
    if (booking.status === 'confirmed') { await connection.rollback(); return { booking, already: true }; }
    if (booking.status !== 'pending') { await connection.rollback(); return { error: `Booking is ${booking.status}` }; }

    const [items] = await connection.query('SELECT * FROM activity_booking_items WHERE booking_id = ?', [bookingId]);
    for (const item of items) {
      // Ensure inventory row exists before locking
      await connection.query(
        `INSERT INTO activity_inventory (activity_id, ticket_type_id, date, capacity, sold, is_closed)
         VALUES (?, ?, ?, (SELECT COALESCE(daily_capacity, 200) FROM activity_ticket_types WHERE id = ?), 0, false)
         ON DUPLICATE KEY UPDATE id=id`,
        [booking.activity_id, item.ticket_type_id, booking.booking_date, item.ticket_type_id]
      );
      const [[inv]] = await connection.query('SELECT * FROM activity_inventory WHERE ticket_type_id = ? AND date = ? FOR UPDATE', [item.ticket_type_id, booking.booking_date]);
      if (!inv || inv.is_closed || inv.sold + item.quantity > inv.capacity) {
        await connection.rollback();
        await pool.query("UPDATE activity_bookings SET status = 'cancelled', payment_status = 'failed' WHERE id = ?", [bookingId]);
        return { error: 'sold_out', bookingId };
      }
    }
    if (booking.time_window_id) {
      const [[w]] = await connection.query('SELECT * FROM activity_time_windows WHERE id = ? FOR UPDATE', [booking.time_window_id]);
      const totalQty = items.reduce((s, i) => s + i.quantity, 0);
      if (!w || w.sold + totalQty > w.capacity) {
        await connection.rollback();
        await pool.query("UPDATE activity_bookings SET status = 'cancelled', payment_status = 'failed' WHERE id = ?", [bookingId]);
        return { error: 'sold_out', bookingId };
      }
    }

    for (const item of items) {
      await connection.query('UPDATE activity_inventory SET sold = sold + ? WHERE ticket_type_id = ? AND date = ?', [item.quantity, item.ticket_type_id, booking.booking_date]);
    }
    if (booking.time_window_id) {
      const totalQty = items.reduce((s, i) => s + i.quantity, 0);
      await connection.query('UPDATE activity_time_windows SET sold = sold + ? WHERE id = ?', [totalQty, booking.time_window_id]);
    }
    if (booking.offer_id) {
      await connection.query('UPDATE activity_offers SET used_count = used_count + 1 WHERE id = ?', [booking.offer_id]);
      await connection.query('INSERT INTO activity_offer_usages (offer_id, booking_id, user_id, customer_email, customer_phone, discount_amount) VALUES (?, ?, ?, ?, ?, ?)', [booking.offer_id, bookingId, booking.user_id, booking.customer_email, booking.customer_phone, booking.discount_amount]);
    }
    await connection.query("UPDATE activity_bookings SET status = 'confirmed', payment_status = 'success', razorpay_payment_id = ? WHERE id = ?", [paymentId, bookingId]);

    // ---- SINGLE QR CODE PER BOOKING (PHASE 5) ----
    const [[activity]] = await connection.query('SELECT ticket_qr_mode, opening_time, closing_time, qr_validity_mode, qr_valid_from, qr_valid_until FROM activities WHERE id = ?', [booking.activity_id]);
    const bookingDateStr = toDateString(booking.booking_date);
    let win = null;
    if (booking.time_window_id) [[win]] = await connection.query('SELECT start_time, end_time FROM activity_time_windows WHERE id = ?', [booking.time_window_id]);
    const { from: vFrom, until: vUntil } = validityTimes(activity, win);
    const validFrom = `${bookingDateStr} ${vFrom}`;
    const validUntil = `${bookingDateStr} ${vUntil}`;

    const totalQty = items.reduce((s, i) => s + i.quantity, 0);
    const token = genToken();

    // Check if ticket row exists for this booking
    const [[existingTicket]] = await connection.query('SELECT id FROM activity_tickets WHERE booking_id = ?', [bookingId]);
    if (existingTicket) {
      await connection.query(
        "UPDATE activity_tickets SET qr_token = ?, quantity_covered = ?, status = 'VALID', valid_from = ?, valid_until = ? WHERE id = ?",
        [token, totalQty, validFrom, validUntil, existingTicket.id]
      );
    } else {
      await connection.query(
        "INSERT INTO activity_tickets (booking_id, activity_id, owner_id, qr_token, quantity_covered, redeemed_quantity, status, valid_from, valid_until) VALUES (?, ?, ?, ?, ?, 0, 'VALID', ?, ?)",
        [bookingId, booking.activity_id, booking.owner_id, token, totalQty, validFrom, validUntil]
      );
    }

    // Ensure item-level status in activity_booking_items
    await connection.query(
      "UPDATE activity_booking_items SET redeemed_quantity = 0, status = 'VALID' WHERE booking_id = ?",
      [bookingId]
    );

    await connection.commit();
    return { booking: { ...booking, status: 'confirmed', payment_status: 'success' }, qr_token: token };
  } catch (e) {
    await connection.rollback();
    throw e;
  } finally {
    connection.release();
  }
}

/**
 * Validate + (optionally) redeem scanned QR token for an owner / staff.
 * Supports granular item-by-item redemption (e.g. entry vs go-karting vs trampoline)
 * using a single QR code!
 */
async function redeemTicket({ qrToken, ownerId, staffId = null, bookingItemId = null, quantity = null, redeemAll = false, markComplete = true, manual = false }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[ticket]] = await connection.query(
      `SELECT t.*, b.booking_code, b.booking_date, b.customer_name, b.customer_phone,
              b.status AS booking_status, b.payment_status,
              a.name AS activity_name, a.partial_entry_enabled
       FROM activity_tickets t JOIN activity_bookings b ON b.id = t.booking_id JOIN activities a ON a.id = t.activity_id
       WHERE t.qr_token = ? FOR UPDATE`, [qrToken]
    );

    const log = async (result, ticketId, qty, note, bItemId = null) => {
      await pool.query(
        'INSERT INTO activity_qr_scan_logs (ticket_id, qr_token_tried, scanned_by_owner_id, scanned_by_staff_id, result, quantity_redeemed, note, booking_item_id, venue_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [ticketId, qrToken ? String(qrToken).slice(0, 64) : null, ownerId, staffId, result, qty || 0, note || null, bItemId || null, ticket ? ticket.activity_id : null]
      );
    };
    const ticketResponse = (status) => ({
      id: ticket.id,
      booking_code: ticket.booking_code,
      activity_name: ticket.activity_name,
      status,
      first_scanned_at: ticket.first_scanned_at || new Date()
    });

    if (!ticket) { await connection.rollback(); await log('NOT_FOUND', null, 0, null); return { ok: false, reason: 'NOT_FOUND', message: "Ticket doesn't exist" }; }
    if (ticket.owner_id !== ownerId) { await connection.rollback(); await log('WRONG_OWNER', ticket.id, 0, null); return { ok: false, reason: 'WRONG_OWNER', message: 'This ticket belongs to a different activity' }; }
    if (ticket.booking_status === 'cancelled') { await connection.rollback(); await log('CANCELLED', ticket.id, 0, null); return { ok: false, reason: 'CANCELLED', message: 'This booking was cancelled' }; }
    if (ticket.booking_status === 'refunded' || ticket.payment_status === 'refunded') { await connection.rollback(); await log('REFUNDED', ticket.id, 0, null); return { ok: false, reason: 'REFUNDED', message: 'This booking was refunded' }; }
    if (ticket.payment_status !== 'success') {
      const reason = ['failed', 'failure'].includes(String(ticket.payment_status || '').toLowerCase()) ? 'PAYMENT_FAILED' : 'PAYMENT_PENDING';
      await connection.rollback(); await log(reason, ticket.id, 0, null);
      return { ok: false, reason, message: reason === 'PAYMENT_FAILED' ? 'Payment failed for this booking' : 'Payment has not been confirmed for this booking' };
    }
    if (ticket.booking_status !== 'confirmed') { await connection.rollback(); await log('BOOKING_NOT_CONFIRMED', ticket.id, 0, null); return { ok: false, reason: 'BOOKING_NOT_CONFIRMED', message: 'This booking has not been confirmed' }; }
    if (['CANCELLED', 'REFUNDED', 'BLOCKED', 'EXPIRED'].includes(ticket.status)) { await connection.rollback(); await log(ticket.status, ticket.id, 0, null); return { ok: false, reason: ticket.status, message: `Ticket is ${ticket.status.toLowerCase()}` }; }

    const now = new Date();
    if (now < new Date(ticket.valid_from)) { await connection.rollback(); await log('NOT_YET_VALID', ticket.id, 0, null); return { ok: false, reason: 'NOT_YET_VALID', message: 'This ticket is not valid yet' }; }
    if (now > new Date(ticket.valid_until)) {
      await connection.query("UPDATE activity_tickets SET status = 'EXPIRED' WHERE id = ?", [ticket.id]);
      await connection.commit(); await log('EXPIRED', ticket.id, 0, null);
      return { ok: false, reason: 'EXPIRED', message: 'This ticket has expired' };
    }

    // Fetch all item-level entitlements for this booking
    const [items] = await connection.query(
      `SELECT bi.id, bi.ticket_type_id, tt.name, tt.product_type, bi.quantity,
              COALESCE(bi.redeemed_quantity, 0) AS redeemed_quantity,
              (bi.quantity - COALESCE(bi.redeemed_quantity, 0)) AS remaining_quantity,
              COALESCE(bi.status, 'VALID') AS status
       FROM activity_booking_items bi
       JOIN activity_ticket_types tt ON tt.id = bi.ticket_type_id
       WHERE bi.booking_id = ?
       ORDER BY (tt.product_type = 'ENTRY') DESC, tt.sort_order, bi.id`,
      [ticket.booking_id]
    );

    const totalRemaining = items.reduce((s, i) => s + Math.max(0, i.remaining_quantity), 0);

    if (totalRemaining <= 0) {
      await connection.rollback(); await log('ALREADY_USED', ticket.id, 0, null);
      return { ok: false, reason: 'ALREADY_USED', message: 'All tickets and activities on this booking have already been redeemed', items, firstScannedAt: ticket.first_scanned_at };
    }

    // PREVIEW SCAN: show entire booking breakdown with all items and remaining counts
    if (!markComplete) {
      await connection.commit();
      return {
        ok: true,
        preview: true,
        booking_code: ticket.booking_code,
        customer_name: ticket.customer_name,
        customer_phone: ticket.customer_phone,
        booking_date: ticket.booking_date,
        valid_from: ticket.valid_from,
        valid_until: ticket.valid_until,
        activity_name: ticket.activity_name,
        items,
        total_remaining: totalRemaining,
        ticket: { ...ticket, items, remaining: totalRemaining }
      };
    }

    // REDEMPTION LOGIC:
    // Option A: Specific item redemption (e.g. gate checks in Entry, ride checks in Go-Kart)
    if (bookingItemId) {
      const targetItem = items.find((i) => i.id === Number(bookingItemId));
      if (!targetItem) {
        await connection.rollback();
        return { ok: false, reason: 'ITEM_NOT_FOUND', message: 'Selected activity item was not found in this booking' };
      }
      if (targetItem.remaining_quantity <= 0) {
        await connection.rollback();
        return { ok: false, reason: 'ITEM_ALREADY_USED', message: `${targetItem.name} has already been fully redeemed` };
      }

      if (quantity != null && Number(quantity) > targetItem.remaining_quantity) {
        await connection.rollback();
        return { ok: false, reason: 'INVALID_QUANTITY', message: `Requested quantity (${quantity}) exceeds available remaining (${targetItem.remaining_quantity})` };
      }

      const redeemQty = quantity != null ? Number(quantity) : 1;
      if (redeemQty <= 0) {
        await connection.rollback();
        return { ok: false, reason: 'INVALID_QUANTITY', message: 'Please specify a valid quantity to redeem' };
      }

      const newRedeemed = targetItem.redeemed_quantity + redeemQty;
      const isItemDone = newRedeemed >= targetItem.quantity;

      await connection.query(
        'UPDATE activity_booking_items SET redeemed_quantity = ?, status = ? WHERE id = ?',
        [newRedeemed, isItemDone ? 'COMPLETED' : 'PARTIAL', targetItem.id]
      );

      const newTotalRedeemed = ticket.redeemed_quantity + redeemQty;
      const allDone = newTotalRedeemed >= ticket.quantity_covered;

      await connection.query(
        `UPDATE activity_tickets SET redeemed_quantity = ?, status = ?, first_scanned_at = COALESCE(first_scanned_at, NOW()), first_scanned_by = COALESCE(first_scanned_by, ?), completed_at = ? WHERE id = ?`,
        [newTotalRedeemed, allDone ? 'COMPLETED' : 'SCANNED', ownerId, allDone ? new Date() : null, ticket.id]
      );

      await connection.commit();
      await log('VALID', ticket.id, redeemQty, `${manual ? 'MANUAL_VERIFICATION: ' : ''}Item: ${targetItem.name} (${redeemQty})`, targetItem.id);

      // Return updated state
      targetItem.redeemed_quantity = newRedeemed;
      targetItem.remaining_quantity = targetItem.quantity - newRedeemed;
      targetItem.status = isItemDone ? 'COMPLETED' : 'PARTIAL';

      return {
        ok: true,
        redeemed_item: targetItem,
        quantity_redeemed: redeemQty,
        items,
        total_remaining: totalRemaining - redeemQty,
        all_completed: allDone,
        first_scanned_at: ticket.first_scanned_at || new Date(),
        ticket: ticketResponse(allDone ? 'COMPLETED' : 'SCANNED')
      };
    }

    // Option B: Redeem all remaining entitlements
    if (redeemAll) {
      for (const item of items) {
        if (item.remaining_quantity > 0) {
          await connection.query(
            "UPDATE activity_booking_items SET redeemed_quantity = quantity, status = 'COMPLETED' WHERE id = ?",
            [item.id]
          );
        }
      }
      await connection.query(
        "UPDATE activity_tickets SET redeemed_quantity = quantity_covered, status = 'COMPLETED', first_scanned_at = COALESCE(first_scanned_at, NOW()), first_scanned_by = COALESCE(first_scanned_by, ?), completed_at = NOW() WHERE id = ?",
        [ownerId, ticket.id]
      );
      await connection.commit();
      await log('VALID', ticket.id, totalRemaining, `${manual ? 'MANUAL_VERIFICATION: ' : ''}All Remaining Redeemed`);

      items.forEach((i) => {
        i.redeemed_quantity = i.quantity;
        i.remaining_quantity = 0;
        i.status = 'COMPLETED';
      });

      return {
        ok: true,
        redeemed_all: true,
        quantity_redeemed: totalRemaining,
        items,
        total_remaining: 0,
        all_completed: true,
        first_scanned_at: ticket.first_scanned_at || new Date(),
        ticket: ticketResponse('COMPLETED')
      };
    }

    // Default: Redeem 1 entry or next available item
    const nextItem = items.find((i) => i.remaining_quantity > 0) || items[0];
    const redeemQty = quantity != null ? Math.min(Number(quantity), nextItem.remaining_quantity) : 1;
    const newRedeemed = nextItem.redeemed_quantity + redeemQty;
    const isItemDone = newRedeemed >= nextItem.quantity;

    await connection.query(
      'UPDATE activity_booking_items SET redeemed_quantity = ?, status = ? WHERE id = ?',
      [newRedeemed, isItemDone ? 'COMPLETED' : 'PARTIAL', nextItem.id]
    );

    const newTotalRedeemed = ticket.redeemed_quantity + redeemQty;
    const allDone = newTotalRedeemed >= ticket.quantity_covered;

    await connection.query(
      `UPDATE activity_tickets SET redeemed_quantity = ?, status = ?, first_scanned_at = COALESCE(first_scanned_at, NOW()), first_scanned_by = COALESCE(first_scanned_by, ?), completed_at = ? WHERE id = ?`,
      [newTotalRedeemed, allDone ? 'COMPLETED' : 'SCANNED', ownerId, allDone ? new Date() : null, ticket.id]
    );

    await connection.commit();
    await log('VALID', ticket.id, redeemQty, `${manual ? 'MANUAL_VERIFICATION: ' : ''}Item: ${nextItem.name}`, nextItem.id);

    nextItem.redeemed_quantity = newRedeemed;
    nextItem.remaining_quantity = nextItem.quantity - newRedeemed;
    nextItem.status = isItemDone ? 'COMPLETED' : 'PARTIAL';

    return {
      ok: true,
      redeemed_item: nextItem,
      quantity_redeemed: redeemQty,
      items,
      total_remaining: totalRemaining - redeemQty,
      all_completed: allDone,
      first_scanned_at: ticket.first_scanned_at || new Date(),
      ticket: ticketResponse(allDone ? 'COMPLETED' : 'SCANNED')
    };
  } catch (e) {
    await connection.rollback();
    throw e;
  } finally {
    connection.release();
  }
}

module.exports = {
  TICKET_STATUSES, validityTimes, isWeekend, dayOfWeek, genBookingCode,
  getActivity, calculatePrice, createPendingBooking, confirmBooking, redeemTicket,
};
