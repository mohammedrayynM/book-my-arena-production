const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { sendEmail } = require('../utils/email');
const { computeOwnerMarkup } = require('../utils/pricing');
const { processRouteTransfer } = require('../services/razorpayRoute'); // legacy, no longer called automatically — see services/razorpayRoute.js
const routeSplit = require('../services/routeSplit');
const routeProvider = require('../services/routeProvider');
const { optionalAuth, verifyCustomer } = require('../middleware/auth');
const globalConfig = require('../services/globalConfig');
const { toMinor, digitsFor } = require('../utils/money');
const { splitAmount } = require('../services/playerSplit');
// Notifications are a delivery layer only: fire() schedules the work and returns at once, and can never throw into this route.
const { fire: fireNotification } = require('../utils/notifications/events');
const subscriptionService = require('../services/subscriptionService');
const subscriptionReservations = require('../services/subscriptionReservations');
const availabilityService = require('../services/availabilityService');
const venueBillingRestrictions = require('../services/venueBillingRestrictions');
const activityBooking = require('../services/activityBooking');
const billingConfig = require('../services/billingConfig');
require('dotenv').config();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const columnCache = {};
async function hasColumn(table, column) {
  const cacheKey = `${table}.${column}`;
  if (columnCache[cacheKey] !== undefined) return columnCache[cacheKey];
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [process.env.DB_NAME, table, column]
  );
  const exists = rows.length > 0;
  columnCache[cacheKey] = exists;
  return exists;
}

function parseMinutes(timeStr = '06:00') {
  const cleanStr = String(timeStr).trim();
  const match = cleanStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (match) {
    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const ampm = match[3];
    if (ampm) {
      if (ampm.toUpperCase() === 'PM' && hours !== 12) hours += 12;
      if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
    }
    if (hours === 24 && minutes === 0) {
      return 24 * 60;
    }
    return (hours % 24) * 60 + minutes;
  }
  const [hours = '0', minutes = '0'] = cleanStr.split(':');
  return (parseInt(hours, 10) || 0) * 60 + (parseInt(minutes, 10) || 0);
}

function getSlotStartMinutes(slotRange) {
  const [start] = String(slotRange || '').split('-').map(s => s.trim());
  return parseMinutes(start);
}

function getSlotPeriod(slotStartMinutes) {
  const mins = slotStartMinutes % 1440;
  if (mins >= 0 && mins < 360) return 'earlyMorning';
  if (mins >= 360 && mins < 720) return 'morning';
  if (mins >= 720 && mins < 1080) return 'afternoon';
  return 'evening';
}

function resolveSlotPrice(slotStartMinutes, entity) {
  const period = getSlotPeriod(slotStartMinutes);
  let price = 0;
  if (period === 'earlyMorning') {
    price = parseFloat(entity.early_morning_price);
  } else if (period === 'morning') {
    price = parseFloat(entity.morning_price);
  } else if (period === 'afternoon') {
    price = parseFloat(entity.afternoon_price);
  } else if (period === 'evening') {
    price = parseFloat(entity.evening_price);
  }

  if (!price || price <= 0) {
    price = parseFloat(entity.default_price || entity.price_per_hour || 0);
  }
  return price;
}

function makePlaceholders(values) {
  return values.map(() => '?').join(', ');
}

function normalizeSlotValue(slot) {
  return String(slot || '').trim();
}


// A DATE column arrives as a JS Date (mysql2) — comparing a Date with a 'YYYY-MM-DD' string is always false, which silently skipped the
// coupon validity checks for manually-typed codes. Everything is compared as calendar dates in the venue country's day (India).
const ymd = (d) => {
  if (!d) return null;
  if (d instanceof Date) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return String(d).slice(0, 10);
};
const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const { acquireSlotLock, releaseSlotLock } = require('../services/slotLock');
const { refundConflictedPayment } = require('../services/conflictRefund');

function chooseSpecialPricingRows(rows) {
  const bestBySlot = new Map();
  for (const row of rows || []) {
    const slot = normalizeSlotValue(row.time_slot);
    if (!slot) continue;

    const current = bestBySlot.get(slot);
    const currentCourtPriority = current && current.court_id !== null && current.court_id !== undefined ? 1 : 0;
    const nextCourtPriority = row.court_id !== null && row.court_id !== undefined ? 1 : 0;
    const currentDatePriority = current && current.specific_date ? 1 : 0;
    const nextDatePriority = row.specific_date ? 1 : 0;

    if (
      !current ||
      nextCourtPriority > currentCourtPriority ||
      (nextCourtPriority === currentCourtPriority && nextDatePriority > currentDatePriority)
    ) {
      bestBySlot.set(slot, row);
    }
  }
  return bestBySlot;
}

async function getSpecialPricingBySlot({ turfId, courtId, bookingDate, dayOfWeek, targetSlots }) {
  const specialPricingHasCourtId = await hasColumn('special_pricing', 'court_id');
  const placeholders = makePlaceholders(targetSlots);
  let query = `
    SELECT time_slot, special_price, specific_date${specialPricingHasCourtId ? ', court_id' : ', NULL AS court_id'}
    FROM special_pricing
    WHERE turf_id = ? AND is_active = TRUE
    AND time_slot IN (${placeholders})
    AND (specific_date = ? OR (specific_date IS NULL AND day_of_week = ?))
  `;
  const params = [turfId, ...targetSlots, bookingDate, dayOfWeek];

  if (courtId && specialPricingHasCourtId) {
    query += ' AND (court_id IS NULL OR court_id = ?)';
    params.push(courtId);
  } else if (!courtId && specialPricingHasCourtId) {
    query += ' AND court_id IS NULL';
  }

  const [rows] = await pool.query(query, params);
  return chooseSpecialPricingRows(rows);
}

function getDayWisePrice(dayWiseRows, dayName, courtId, period) {
  const dw = (dayWiseRows || []).find(item =>
    item.day_of_week === dayName &&
    (courtId ? Number(item.court_id) === Number(courtId) : (item.court_id === null || item.court_id === undefined))
  );

  if (!dw) return null;
  if (period === 'earlyMorning' && dw.early_morning_price !== null) return parseFloat(dw.early_morning_price);
  if (period === 'morning' && dw.morning_price !== null) return parseFloat(dw.morning_price);
  if (period === 'afternoon' && dw.afternoon_price !== null) return parseFloat(dw.afternoon_price);
  if (period === 'evening' && dw.evening_price !== null) return parseFloat(dw.evening_price);
  return null;
}

async function calculateSlotBasePrices({ turfId, courtId, bookingDate, targetSlots, currentBookable }) {
  const dateObj = new Date(bookingDate + 'T00:00:00');
  const dayOfWeek = dateObj.getDay();
  const DAYS_OF_WEEK_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = DAYS_OF_WEEK_NAMES[dayOfWeek];

  const [specialPricingBySlot, dayWiseResult] = await Promise.all([
    getSpecialPricingBySlot({ turfId, courtId, bookingDate, dayOfWeek, targetSlots }),
    pool.query('SELECT * FROM day_wise_pricing WHERE turf_id = ?', [turfId])
  ]);
  const dayWiseRows = dayWiseResult[0] || [];

  let totalBasePrice = 0;
  const slotBasePrices = [];

  for (const ts of targetSlots) {
    const startMins = getSlotStartMinutes(ts);
    const period = getSlotPeriod(startMins);
    const dayWisePrice = getDayWisePrice(dayWiseRows, dayName, courtId, period);
    const periodPrice = resolveSlotPrice(startMins, currentBookable);
    const basePrice = dayWisePrice !== null && dayWisePrice > 0 ? dayWisePrice : periodPrice;
    const specialPricing = specialPricingBySlot.get(normalizeSlotValue(ts));
    const exactPrice = specialPricing ? parseFloat(specialPricing.special_price) : basePrice;

    totalBasePrice += exactPrice;
    slotBasePrices.push(exactPrice);
  }

  return { totalBasePrice, slotBasePrices };
}

async function checkSlotsAvailable({ turfId, courtId, bookingDate, targetSlots }) {
  if (!targetSlots || !Array.isArray(targetSlots) || targetSlots.length === 0) {
    return { ok: true };
  }

  const result = await availabilityService.checkMultipleSlotsAvailability({
    turfId,
    courtId: courtId || null,
    date: bookingDate,
    timeSlots: targetSlots
  });

  if (!result.available) {
    return {
      ok: false,
      status: 409,
      code: result.reason,
      error: result.message
    };
  }

  return { ok: true };
}

function formatCurrency(value) {
  const amount = Number(value || 0);
  return `₹${amount.toLocaleString('en-IN', {
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  })}`;
}

function formatDateLabel(dateValue) {
  if (!dateValue) return 'N/A';
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return String(dateValue);

  return parsed.toLocaleDateString('en-IN', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendBookingConfirmationEmails(bookingIds) {
  const ids = Array.isArray(bookingIds)
    ? bookingIds.map(id => parseInt(id, 10)).filter(id => !Number.isNaN(id))
    : [];

  if (ids.length === 0) {
    return { customer: null, owner: null };
  }

  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT b.*, t.name as turf_name,
            NULLIF(TRIM(t.owner_email), '') as turf_owner_email,
            NULLIF(TRIM(o.email), '') as owner_account_email
     FROM bookings b
     JOIN turfs t ON b.turf_id = t.id
     LEFT JOIN owners o ON t.owner_id = o.id
     WHERE b.id IN (${placeholders})
     ORDER BY b.id ASC`,
    [...ids]
  );

  if (rows.length === 0) {
    return { customer: null, owner: null };
  }

  const booking = rows[0];
  const allSlots = rows.map(row => row.time_slot).join(', ');
  const ownerEmail = booking.turf_owner_email || booking.owner_account_email || null;
  const formattedBookingDate = formatDateLabel(booking.booking_date);
  const slotDetails = rows.map((row, index) => {
    const fullAmount = parseFloat(row.amount || 0);
    const rawPendingBalance = parseFloat(row.pending_balance || 0);
    const pendingBalance = Number.isFinite(rawPendingBalance) && rawPendingBalance >= 0
      ? rawPendingBalance
      : 0;

    let amountPaidNow = parseFloat(row.advance_amount);
    if (!Number.isFinite(amountPaidNow) || amountPaidNow < 0) {
      amountPaidNow = Math.max(0, fullAmount - pendingBalance);
    }

    const paymentType = String(row.payment_type || '').toLowerCase() === 'advance' ? 'Advance' : 'Full';

    return {
      index: index + 1,
      slot: row.time_slot || 'N/A',
      fullAmount,
      amountPaidNow,
      pendingBalance,
      paymentType
    };
  });
  const totalBookingAmount = slotDetails.reduce((sum, item) => sum + item.fullAmount, 0);
  const totalPaidNow = slotDetails.reduce((sum, item) => sum + item.amountPaidNow, 0);
  const totalPendingBalance = slotDetails.reduce((sum, item) => sum + item.pendingBalance, 0);
  const paymentModeLabel = totalPendingBalance > 0 ? 'Advance payment' : 'Full payment';

  let customerResult = null;
  let ownerResult = null;

  if (booking.customer_email) {
    const customerMsg = `Dear ${booking.customer_name},

Your booking for ${booking.turf_name} on ${booking.booking_date} at ${allSlots} is confirmed.

Booking Details:
  Date: ${booking.booking_date}
  Time Slots: ${allSlots}
  Total Booking Amount: ₹${booking.final_full_amount || 'N/A'}
  Amount Paid: ₹${booking.amount_paid_now || 'N/A'}
  Balance Due: ₹${booking.pending_balance || 'N/A'}
  Payment ID: ${booking.payment_id || 'N/A'}

Thank you for choosing Book Arena!

Best regards,
Book Arena Team`;
    customerResult = await sendEmail(booking.customer_email, 'Booking Confirmed - BookArena', customerMsg);
  }

  if (ownerEmail) {
    const ownerSubject = `New Booking Confirmed - ${booking.turf_name}`;
    const slotLinesText = slotDetails
      .map(item =>
        `${item.index}. ${item.slot}
   Slot amount: ${formatCurrency(item.fullAmount)}
   Paid via Razorpay: ${formatCurrency(item.amountPaidNow)}
   Balance due: ${formatCurrency(item.pendingBalance)}
   Payment type: ${item.paymentType}`
      )
      .join('\n\n');

    const ownerMsg = `Hello Turf Owner,

A new booking has been confirmed for your turf: ${booking.turf_name}.

Booking Details:
- Customer Name: ${booking.customer_name}
- Customer Mobile No: ${booking.customer_phone}
- Customer Email: ${booking.customer_email || 'N/A'}
- Booking Date: ${formattedBookingDate}
- Payment Mode: ${paymentModeLabel}
- Total Booking Amount: ${formatCurrency(totalBookingAmount)}
- Paid via Razorpay: ${formatCurrency(totalPaidNow)}
- Balance Due at Turf: ${formatCurrency(totalPendingBalance)}
- Payment ID: ${booking.payment_id || 'N/A'}

Booked Slots:
${slotLinesText}

Thank you for using BookArena!`;
    const slotCardsHtml = slotDetails.map(item => `
      <tr>
        <td style="padding:14px 16px;border-bottom:1px solid #263041;color:#f8fafc;font-size:14px;font-weight:600;">${item.index}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #263041;color:#f8fafc;font-size:14px;">${escapeHtml(item.slot)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #263041;color:#cbd5e1;font-size:14px;">${formatCurrency(item.fullAmount)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #263041;color:#22c55e;font-size:14px;font-weight:700;">${formatCurrency(item.amountPaidNow)}</td>
        <td style="padding:14px 16px;border-bottom:1px solid #263041;color:#f59e0b;font-size:14px;font-weight:700;">${formatCurrency(item.pendingBalance)}</td>
      </tr>
    `).join('');

    const ownerHtml = `
      <div style="margin:0;padding:24px;background:#0f172a;font-family:Arial,sans-serif;color:#e2e8f0;">
        <div style="max-width:720px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:18px;overflow:hidden;">
          <div style="padding:28px 32px;background:linear-gradient(135deg,#111827 0%,#1e293b 100%);border-bottom:1px solid #263041;">
            <div style="font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:#94a3b8;">Book Arena</div>
            <h1 style="margin:10px 0 0;font-size:26px;line-height:1.3;color:#f8fafc;">New Booking Confirmed</h1>
            <p style="margin:10px 0 0;color:#cbd5e1;font-size:15px;">A customer has successfully booked <strong style="color:#ffffff;">${escapeHtml(booking.turf_name)}</strong>.</p>
          </div>

          <div style="padding:28px 32px;">
            <div style="background:#0b1220;border:1px solid #263041;border-radius:16px;padding:20px 22px;margin-bottom:22px;">
              <div style="font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Booking details</div>
              <table style="width:100%;border-collapse:collapse;">
                <tr>
                  <td style="padding:8px 0;color:#94a3b8;width:210px;">Customer name</td>
                  <td style="padding:8px 0;color:#f8fafc;font-weight:600;">${escapeHtml(booking.customer_name)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#94a3b8;">Customer mobile</td>
                  <td style="padding:8px 0;color:#f8fafc;font-weight:600;">${escapeHtml(booking.customer_phone || 'N/A')}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#94a3b8;">Customer email</td>
                  <td style="padding:8px 0;color:#f8fafc;font-weight:600;">${escapeHtml(booking.customer_email || 'N/A')}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#94a3b8;">Booking date</td>
                  <td style="padding:8px 0;color:#f8fafc;font-weight:600;">${escapeHtml(formattedBookingDate)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#94a3b8;">Payment mode</td>
                  <td style="padding:8px 0;color:#f8fafc;font-weight:600;">${escapeHtml(paymentModeLabel)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#94a3b8;">Payment ID</td>
                  <td style="padding:8px 0;color:#f8fafc;font-weight:600;">${escapeHtml(booking.payment_id || 'N/A')}</td>
                </tr>
              </table>
            </div>

            <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:22px;">
              <div style="background:#111827;border:1px solid #263041;border-radius:16px;padding:18px;">
                <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:8px;">Total booking amount</div>
                <div style="font-size:24px;font-weight:700;color:#f8fafc;">${formatCurrency(totalBookingAmount)}</div>
              </div>
              <div style="background:#052e1b;border:1px solid #14532d;border-radius:16px;padding:18px;">
                <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#86efac;margin-bottom:8px;">Paid via Razorpay</div>
                <div style="font-size:24px;font-weight:700;color:#dcfce7;">${formatCurrency(totalPaidNow)}</div>
              </div>
              <div style="background:#3b1d06;border:1px solid #9a3412;border-radius:16px;padding:18px;">
                <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#fdba74;margin-bottom:8px;">Balance due at turf</div>
                <div style="font-size:24px;font-weight:700;color:#ffedd5;">${formatCurrency(totalPendingBalance)}</div>
              </div>
            </div>

            <div style="background:#0b1220;border:1px solid #263041;border-radius:16px;overflow:hidden;">
              <div style="padding:18px 22px;border-bottom:1px solid #263041;">
                <div style="font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;">Booked slots</div>
              </div>
              <table style="width:100%;border-collapse:collapse;">
                <thead>
                  <tr style="background:#131c2e;">
                    <th align="left" style="padding:14px 16px;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:1px;">#</th>
                    <th align="left" style="padding:14px 16px;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Slot</th>
                    <th align="left" style="padding:14px 16px;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Amount</th>
                    <th align="left" style="padding:14px 16px;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Paid</th>
                    <th align="left" style="padding:14px 16px;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Due</th>
                  </tr>
                </thead>
                <tbody>
                  ${slotCardsHtml}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;

    ownerResult = await sendEmail(ownerEmail, ownerSubject, ownerMsg, ownerHtml);
  } else {
    console.warn(`⚠️ No owner notification email found for turf ${booking.turf_id}`);
  }

  return { customer: customerResult, owner: ownerResult, ownerEmail };
}

// POST /api/bookings — Create a new booking
router.post('/', verifyCustomer, async (req, res) => {
  let lockAcquired = false;
  let turfIdForUnlock = null;
  let courtIdForUnlock = null;
  let bookingDateForUnlock = null;

  try {
    const {
      turf_id, court_id, customer_name, customer_phone, customer_email,
      booking_date, time_slot, time_slots, coupon_code,
      payment_option, match_request_id,
      need_players, players_needed, contribution_amount,
      sport_type: booking_sport_type, match_type, skill_level, contact_phone, note
    } = req.body;

    const user_id = req.user.id;

    turfIdForUnlock = turf_id;
    courtIdForUnlock = court_id;
    bookingDateForUnlock = booking_date;

    let targetSlots = time_slots && time_slots.length > 0 ? time_slots : (time_slot ? [time_slot] : []);

    // Validate required fields
    if (!turf_id || !customer_name || !customer_phone || !customer_email || !booking_date || targetSlots.length === 0) {
      return res.status(400).json({ error: 'All fields are required, including email' });
    }

    lockAcquired = await acquireSlotLock(turf_id, court_id || null, booking_date);
    if (!lockAcquired) {
      return res.status(503).json({ error: 'Could not acquire slot lock. Please retry.' });
    }

    const availability = await checkSlotsAvailable({
      turfId: turf_id,
      courtId: court_id,
      bookingDate: booking_date,
      targetSlots
    });
    if (!availability.ok) {
      return res.status(availability.status).json({ error: availability.error, ...(availability.code ? { code: availability.code } : {}) });
    }

    // Get turf details
    const [turfRows] = await pool.query(
      `SELECT name, price_per_hour, markup_type, markup_value, advance_percent,
              early_morning_price, morning_price, afternoon_price, evening_price, default_price,
              sport_type, country_code, currency_code, approval_status, is_active, status
       FROM turfs WHERE id = ?`,
      [turf_id]
    );
    if (turfRows.length === 0) {
      console.log('❌ Booking fail: Turf not found', turf_id);
      return res.status(404).json({ error: 'Turf not found' });
    }
    const turf = turfRows[0];

    if (await venueBillingRestrictions.getActive(turf_id)) {
      return res.status(403).json({
        error: 'This venue is temporarily not accepting new bookings.',
        code: 'VENUE_BILLING_RESTRICTED',
      });
    }

    // Check approval status & active flag
    if (turf.approval_status && turf.approval_status !== 'APPROVED') {
      return res.status(400).json({ error: 'This venue is currently pending admin approval and cannot accept bookings yet.' });
    }
    if (turf.is_active === 0 || turf.is_active === false || turf.status === 'BLOCKED') {
      return res.status(400).json({ error: 'This venue is currently inactive or unavailable for bookings.' });
    }

    let currentBookable = turf;
    let markupType = turf.markup_type || 'fixed';
    let markupValue = parseFloat(turf.markup_value || 0);

    if (court_id) {
      const [courtRows] = await pool.query(
        `SELECT price_per_hour, markup_type, markup_value, advance_percent,
                early_morning_price, morning_price, afternoon_price, evening_price, default_price,
                sport_type, approval_status, is_active
         FROM courts WHERE id = ? AND turf_id = ?`,
        [court_id, turf_id]
      );
      if (courtRows.length > 0) {
        const court = courtRows[0];
        if (court.approval_status && court.approval_status !== 'APPROVED') {
          return res.status(400).json({ error: 'This court is currently pending admin approval and cannot be booked yet.' });
        }
        if (court.is_active === 0 || court.is_active === false) {
          return res.status(400).json({ error: 'This court is currently inactive.' });
        }
        currentBookable = court;
        markupType = currentBookable.markup_type || 'fixed';
        markupValue = parseFloat(currentBookable.markup_value || 0);
      }
    }

    const { totalBasePrice, slotBasePrices } = await calculateSlotBasePrices({
      turfId: turf_id,
      courtId: court_id,
      bookingDate: booking_date,
      targetSlots,
      currentBookable
    });

    const { markupAmount, displayPrice } = computeOwnerMarkup(
      totalBasePrice,
      markupType,
      markupValue,
      targetSlots.length
    );

    // Get service fee settings
    const [feeRows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('service_fee', 'service_fee_type')");
    const settingsMap = {};
    feeRows.forEach(row => settingsMap[row.setting_key] = row.setting_value);

    const feeValue = parseFloat(settingsMap['service_fee'] || '20');
    const feeType = settingsMap['service_fee_type'] || 'fixed';

    console.log(`🏟️ Pricing info for ${turf.name}: Base=${totalBasePrice}, Markup=${markupAmount}, Fee=${feeValue} (${feeType}) for ${targetSlots.length} slots`);

    // Handle coupon if provided
    let discountAmount = 0;
    let appliedCouponCode = null;
    let couponId = null;
    let isAdminCoupon = false;
    let appliedCoupon = null;

    if (coupon_code) {
      // 1. Try owner coupons first
      const [ownerCoupons] = await pool.query(
        `SELECT * FROM coupons WHERE code = ? AND turf_id = ? AND is_active = TRUE`,
        [coupon_code.toUpperCase(), turf_id]
      );

      if (ownerCoupons.length > 0) {
        appliedCoupon = ownerCoupons[0];
        isAdminCoupon = false;
      } else {
        // 2. Try admin coupons
        const [adminCoupons] = await pool.query(
          `SELECT * FROM admin_coupons WHERE code = ? AND is_active = TRUE`,
          [coupon_code.toUpperCase()]
        );
        if (adminCoupons.length > 0) {
          appliedCoupon = adminCoupons[0];
          isAdminCoupon = true;
        }
      }

      if (appliedCoupon) {
        const coupon = appliedCoupon;
        const now = new Date();
        const todayStr = todayYmd();

        // Check date ranges
        if (coupon.valid_from && ymd(coupon.valid_from) > todayStr) {
          return res.status(400).json({ error: 'This coupon is not active yet' });
        }
        if (coupon.valid_until && ymd(coupon.valid_until) < todayStr) {
          return res.status(400).json({ error: 'This coupon has expired' });
        }
        if (!isAdminCoupon && coupon.expiry_date && ymd(coupon.expiry_date) < todayStr) {
          return res.status(400).json({ error: 'This coupon has expired' });
        }

        // Check max uses
        if (coupon.max_uses && coupon.used_count >= coupon.max_uses) {
          return res.status(400).json({ error: 'This coupon has reached its usage limit' });
        }

        // Check min booking amount
        if (coupon.min_booking_amount && totalBasePrice < parseFloat(coupon.min_booking_amount)) {
          return res.status(400).json({ error: `Minimum booking amount for this coupon is ₹${coupon.min_booking_amount}` });
        }

        // Admin-specific checks
        if (isAdminCoupon) {
          // Check applicable sport
          if (coupon.applicable_sport && coupon.applicable_sport !== 'all') {
            const bookingSport = court_id && currentBookable.sport_type ? currentBookable.sport_type : turf.sport_type;
            if (String(bookingSport).toLowerCase() !== String(coupon.applicable_sport).toLowerCase()) {
              return res.status(400).json({ error: `This coupon is only applicable for ${coupon.applicable_sport} bookings` });
            }
          }

          // Check per user limit for admin coupon
          if (coupon.per_user_limit && (user_id || customer_email || customer_phone)) {
            const [usages] = await pool.query(
              `SELECT COUNT(*) as count FROM admin_coupon_usages 
               WHERE coupon_id = ? AND (
                 (user_id IS NOT NULL AND user_id = ?) OR 
                 (customer_email IS NOT NULL AND customer_email = ?) OR 
                 (customer_phone IS NOT NULL AND customer_phone = ?)
               )`,
              [coupon.id, user_id || null, customer_email || null, customer_phone || null]
            );
            if (usages[0].count >= coupon.per_user_limit) {
              return res.status(400).json({ error: 'You have reached the usage limit for this coupon' });
            }
          }
        } else {
          // Owner-specific checks
          // Check court specificity
          if (coupon.court_id && court_id && Number(coupon.court_id) !== Number(court_id)) {
            return res.status(400).json({ error: 'This coupon is not valid for the selected court' });
          }

          // Check per user limit for owner coupon
          if (coupon.per_user_limit && (user_id || customer_email || customer_phone)) {
            const [usages] = await pool.query(
              `SELECT COUNT(*) as count FROM coupon_usages 
               WHERE coupon_id = ? AND (
                 (user_id IS NOT NULL AND user_id = ?) OR 
                 (customer_email IS NOT NULL AND customer_email = ?) OR 
                 (customer_phone IS NOT NULL AND customer_phone = ?)
               )`,
              [coupon.id, user_id || null, customer_email || null, customer_phone || null]
            );
            if (usages[0].count >= coupon.per_user_limit) {
              return res.status(400).json({ error: 'You have reached the usage limit for this coupon' });
            }
          }
        }

        // Calculate discount (on totalBasePrice)
        if (coupon.discount_type === 'percentage') {
          discountAmount = (totalBasePrice * parseFloat(coupon.discount_value)) / 100;
          if (coupon.max_discount_cap && discountAmount > parseFloat(coupon.max_discount_cap)) {
            discountAmount = parseFloat(coupon.max_discount_cap);
          }
        } else {
          discountAmount = Math.min(parseFloat(coupon.discount_value), totalBasePrice);
        }

        discountAmount = Math.round(discountAmount * 100) / 100;
        appliedCouponCode = coupon.code;
        couponId = coupon.id;
        console.log(`🎟️ ${isAdminCoupon ? 'Admin' : 'Owner'} Coupon applied: ${coupon.code} - Discount: ₹${discountAmount}`);
      } else {
        return res.status(400).json({ error: 'Invalid coupon code' });
      }
    }

    // FINAL CALCULATION
    const priceAfterCoupon = totalBasePrice - discountAmount; // coupon applied FIRST
    
    // Fetch active customer fee rule for venues
    let serviceFee = 0;
    let serviceFeeTax = 0;
    let showFeeAtCheckout = true;
    let feeRuleId = null;
    let feeRuleSnapshot = null;
    try {
      const activeFeeRule = await billingConfig.getActiveFeeRule(turf.country_code || 'IN', venueCurrency, 'VENUE');
      const feeCalc = billingConfig.calculateCustomerFee(activeFeeRule, priceAfterCoupon);
      serviceFee = feeCalc.serviceFee;
      serviceFeeTax = feeCalc.serviceFeeTax;
      showFeeAtCheckout = feeCalc.showFeeAtCheckout;
      feeRuleId = feeCalc.feeRuleId;
      feeRuleSnapshot = feeCalc.feeRuleSnapshot;
    } catch (feeErr) {
      console.error('[Bookings] Error calculating customer fee:', feeErr);
    }

    // Find Players: the backend decides the split (services/playerSplit.js). Whatever contribution the client sends is ignored, so the
    // website, the app and the join link always show and charge the same share, worked out from the FINAL (post-coupon) amount.
    const isNeedPlayers = !!need_players;
    const numPlayersNeeded = Math.max(0, parseInt(players_needed || 0, 10));
    const split = isNeedPlayers && numPlayersNeeded > 0
      ? splitAmount({ totalMajor: priceAfterCoupon, playersNeeded: numPlayersNeeded, currency: turf.currency_code || 'INR' })
      : null;
    let perPlayerContrib = split ? split.playerShare : 0;

    let hostSplitShare = split ? split.hostShare : null;
    let totalPeople = split ? split.participants : null;
    let finalAmount = split ? split.hostShare : priceAfterCoupon;

    finalAmount = Math.max(0, finalAmount + serviceFee + serviceFeeTax);

    const advancePercent = parseInt(currentBookable.advance_percent || turf.advance_percent || 100, 10);
    // With Find Players on there is no advance option: the host pays their whole share online and each player pays theirs through the
    // join link, so the match is only "funded" by verified payments. Normal bookings keep the venue's advance/full rules untouched.
    const paymentType = (split || advancePercent === 100)
      ? 'full'
      : (String(payment_option || 'advance').toLowerCase() === 'full' ? 'full' : 'advance');

    const payableAmount = paymentType === 'advance'
      ? Math.round((finalAmount * (advancePercent / 100)) * 100) / 100
      : finalAmount;
    const pendingBalance = paymentType === 'advance'
      ? Math.round((finalAmount - payableAmount) * 100) / 100
      : 0;

    const payableNow = payableAmount;
    const finalFullAmount = finalAmount;
    const hostShareFull = hostSplitShare !== null ? hostSplitShare : priceAfterCoupon;
    const needPlayers = isNeedPlayers;

    console.log(`💰 Payment: type=${paymentType}, full=${finalFullAmount}, payNow=${payableNow}, pending=${pendingBalance}, needPlayers=${needPlayers}, hostShare=${hostShareFull}`);

    // The booking's currency is the VENUE's currency (never the customer's). Online payment is only taken for a
    // country/currency the admin has switched on (merchant account confirmed) — India/INR out of the box.
    const venueCurrency = turf.currency_code || 'INR';
    if (payableNow > 0 && !(await globalConfig.paymentsEnabledFor(turf.country_code || 'IN', venueCurrency))) {
      return res.status(400).json({ error: `Online payments in ${venueCurrency} are not available for this venue yet.` });
    }

    // Create Razorpay order with the ACTUAL amount user should pay now
    let order_id = null;
    try {
      if (payableNow <= 0) {
        console.warn('⚠️ Payable amount is not positive. Skipping Razorpay order creation.');
        order_id = null; // No order needed if amount is 0 or less
      } else {
        console.log(`Attempting to create Razorpay order for amount: ₹${payableNow}`);
        const order = await razorpay.orders.create({
          amount: toMinor(payableNow, venueCurrency), // minor units of the venue's currency
          currency: venueCurrency,
          receipt: `booking_${Date.now()}`
        });
        order_id = order.id;
      }
    } catch (e) {
      console.error('🔥 Razorpay Order Creation Failed:', e.message);
      return res.status(500).json({ error: 'Payment gateway error: ' + e.message });
    }

    // Insert booking records
    console.log('📝 Saving booking to DB...');
    const bookingIds = [];
    const numSlots = targetSlots.length;
    const perRowFinalAmount = finalFullAmount / numSlots;
    const perRowPayableNow = payableNow / numSlots;
    const perRowPendingBalance = pendingBalance / numSlots;
    const perRowDiscountAmount = discountAmount / numSlots;

    // Check if bookings table has matchmaking + advance columns.
    const [
      hasNeedPlayers,
      hasPaymentType,
      hasAdvanceAmount,
      hasPendingBalance,
      hasMatchRequestId,
      hasRazorpayOrderId,
      hasPlayersNeeded,
      hasContribAmount,
      hasSportType,
      hasMatchType,
      hasSkillLevel,
      hasContactPhone,
      hasNote
    ] = await Promise.all([
      hasColumn('bookings', 'need_players'),
      hasColumn('bookings', 'payment_type'),
      hasColumn('bookings', 'advance_amount'),
      hasColumn('bookings', 'pending_balance'),
      hasColumn('bookings', 'match_request_id'),
      hasColumn('bookings', 'razorpay_order_id'),
      hasColumn('bookings', 'players_needed'),
      hasColumn('bookings', 'contribution_amount'),
      hasColumn('bookings', 'sport_type'),
      hasColumn('bookings', 'match_type'),
      hasColumn('bookings', 'skill_level'),
      hasColumn('bookings', 'contact_phone'),
      hasColumn('bookings', 'note')
    ]);

    for (let i = 0; i < targetSlots.length; i++) {
      const ts = targetSlots[i];
      const spPrice = slotBasePrices[i];

      // Build insert dynamically based on available columns
      let cols = [
        'turf_id', 'court_id', 'customer_name', 'customer_phone', 'customer_email',
        'booking_date', 'time_slot', 'amount', 'original_price',
        'discount_amount', 'markup_amount', 'service_fee',
        'coupon_code', 'payment_status', 'status', 'user_id', 'currency_code'
      ];
      const perRowServiceFee = Math.round((serviceFee / targetSlots.length) * 100) / 100;
      const perRowServiceFeeTax = Math.round((serviceFeeTax / targetSlots.length) * 100) / 100;

      let vals = [
        turf_id, court_id || null, customer_name, customer_phone, customer_email || '',
        booking_date, ts, perRowFinalAmount, spPrice,
        perRowDiscountAmount, 0, perRowServiceFee,
        appliedCouponCode, 'pending', 'pending', user_id || null, venueCurrency
      ];

      cols.push('service_fee_tax', 'fee_rule_id', 'fee_rule_snapshot');
      vals.push(perRowServiceFeeTax, feeRuleId, feeRuleSnapshot);

      if (hasPaymentType) { cols.push('payment_type'); vals.push(paymentType); }
      if (hasAdvanceAmount) { cols.push('advance_amount'); vals.push(perRowPayableNow); }
      if (hasPendingBalance) { cols.push('pending_balance'); vals.push(perRowPendingBalance); }
      if (hasMatchRequestId && match_request_id) { cols.push('match_request_id'); vals.push(match_request_id); }
      if (hasRazorpayOrderId && order_id) { cols.push('razorpay_order_id'); vals.push(order_id); }

      if (hasNeedPlayers) {
        cols.push('need_players'); vals.push(needPlayers ? 1 : 0);
        if (hasPlayersNeeded) { cols.push('players_needed'); vals.push(numPlayersNeeded); }
        if (hasContribAmount) { cols.push('contribution_amount'); vals.push(perPlayerContrib); }
        if (hasSportType) { cols.push('sport_type'); vals.push(booking_sport_type || null); }
        if (hasMatchType) { cols.push('match_type'); vals.push(match_type || 'friendly'); }
        if (hasSkillLevel) { cols.push('skill_level'); vals.push(skill_level || 'all'); }
        if (hasContactPhone) { cols.push('contact_phone'); vals.push(contact_phone || null); }
        if (hasNote) { cols.push('note'); vals.push(note || null); }
      }

      const placeholders = cols.map(() => '?').join(', ');
      const [result] = await pool.query(
        `INSERT INTO bookings (${cols.join(', ')}) VALUES (${placeholders})`,
        vals
      );
      bookingIds.push(result.insertId);
    }

    console.log('✅ Bookings successfully saved! IDs:', bookingIds.join(', '));

    // Track coupon usage if coupon was applied
    if (appliedCouponCode && couponId) {
      try {
        if (isAdminCoupon) {
          await pool.query(
            `INSERT INTO admin_coupon_usages (coupon_id, booking_id, user_id, customer_email, customer_phone, discount_amount) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [couponId, bookingIds[0], user_id || null, customer_email || '', customer_phone, discountAmount]
          );
          const [claim] = await pool.query(
            'UPDATE admin_coupons SET used_count = used_count + 1 WHERE id = ? AND (max_uses IS NULL OR used_count < max_uses)',
            [couponId]
          );
          if (claim.affectedRows === 0) throw Object.assign(new Error('coupon limit reached'), { code: 'COUPON_LIMIT' });
        } else {
          await pool.query(
            `INSERT INTO coupon_usages (coupon_id, booking_id, user_id, customer_email, customer_phone, discount_amount) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [couponId, bookingIds[0], user_id || null, customer_email || '', customer_phone, discountAmount]
          );
          const [claim] = await pool.query(
            'UPDATE coupons SET used_count = used_count + 1 WHERE id = ? AND (max_uses IS NULL OR used_count < max_uses)',
            [couponId]
          );
          if (claim.affectedRows === 0) throw Object.assign(new Error('coupon limit reached'), { code: 'COUPON_LIMIT' });
        }
      } catch (couponErr) {
        if (couponErr && couponErr.code === 'COUPON_LIMIT') {
          // someone else took the last redemption between validation and now: do not honour a discount that is no longer available
          await pool.query(`UPDATE bookings SET payment_status = 'failed', status = 'cancelled' WHERE id IN (${bookingIds.map(() => '?').join(',')}) AND payment_status = 'pending'`, bookingIds).catch(() => {});
          return res.status(400).json({ error: 'This coupon has just reached its usage limit. Please remove it and try again.' });
        }
        console.warn('⚠️ Failed to track coupon usage:', couponErr.message);
      }
    }

    if (order_id) fireNotification('payment.initiated', { bookingIds });
    res.json({
      booking_id: bookingIds.join(','),
      order_id: order_id,
      amount: payableNow,            // ← amount Razorpay will charge
      fullAmount: finalFullAmount,    // ← total host owes after discount+split
      basePrice: totalBasePrice,
      displayPrice: displayPrice,
      markupAmount: markupAmount,
      discountAmount: discountAmount,
      serviceFee: serviceFee,
      couponCode: appliedCouponCode,
      currency: venueCurrency,
      key_id: process.env.RAZORPAY_KEY_ID,
      advancePercent: advancePercent,
      paymentType: paymentType,
      advanceAmount: payableNow,
      pendingBalance: pendingBalance
    });
  } catch (err) {
    console.error('🔥 Critical Booking Error:', err);
    res.status(500).json({ error: 'System error: ' + err.message });
  } finally {
    if (lockAcquired) {
      await releaseSlotLock(turfIdForUnlock, courtIdForUnlock || null, bookingDateForUnlock).catch((unlockErr) => {
        console.warn('⚠️ Failed to release booking slot lock:', unlockErr.message || unlockErr);
      });
    }
  }
});

// POST /api/bookings/calculate-price — Calculate price breakdown for real-time UI
router.post('/calculate-price', optionalAuth, async (req, res) => {
  try {
    const { turf_id, court_id, booking_date, time_slot, time_slots, coupon_code, need_players, players_needed, contribution_amount, payment_option } = req.body;
    let targetSlots = time_slots || (time_slot ? [time_slot] : []);

    if (!turf_id || !booking_date || targetSlots.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const [turfRows] = await pool.query(
      `SELECT name, price_per_hour, markup_type, markup_value, advance_percent,
              early_morning_price, morning_price, afternoon_price, evening_price, default_price,
              sport_type, currency_code, approval_status, is_active, status
       FROM turfs WHERE id = ?`,
      [turf_id]
    );
    if (turfRows.length === 0) return res.status(404).json({ error: 'Turf not found' });

    const turf = turfRows[0];
    if (turf.approval_status && turf.approval_status !== 'APPROVED') {
      return res.status(400).json({ error: 'This venue is currently pending admin approval.' });
    }
    if (turf.is_active === 0 || turf.is_active === false || turf.status === 'BLOCKED') {
      return res.status(400).json({ error: 'This venue is currently inactive.' });
    }

    let currentBookable = turf;
    let markupType = turf.markup_type || 'fixed';
    let markupValue = parseFloat(turf.markup_value || 0);

    if (court_id) {
      const [courtRows] = await pool.query(
        `SELECT price_per_hour, markup_type, markup_value, advance_percent,
                early_morning_price, morning_price, afternoon_price, evening_price, default_price,
                sport_type, approval_status, is_active
         FROM courts WHERE id = ? AND turf_id = ?`,
        [court_id, turf_id]
      );
      if (courtRows.length > 0) {
        const court = courtRows[0];
        if (court.approval_status && court.approval_status !== 'APPROVED') {
          return res.status(400).json({ error: 'This court is currently pending admin approval.' });
        }
        if (court.is_active === 0 || court.is_active === false) {
          return res.status(400).json({ error: 'This court is currently inactive.' });
        }
        currentBookable = court;
        markupType = currentBookable.markup_type || 'fixed';
        markupValue = parseFloat(currentBookable.markup_value || 0);
      }
    }

    const { totalBasePrice } = await calculateSlotBasePrices({
      turfId: turf_id,
      courtId: court_id,
      bookingDate: booking_date,
      targetSlots,
      currentBookable
    });

    const { markupAmount, displayPrice } = computeOwnerMarkup(
      totalBasePrice,
      markupType,
      markupValue,
      targetSlots.length
    );

    const [feeRows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('service_fee', 'service_fee_type')");
    const settingsMap = {};
    feeRows.forEach(row => settingsMap[row.setting_key] = row.setting_value);

    const feeValue = parseFloat(settingsMap['service_fee'] || '20');
    const feeType = settingsMap['service_fee_type'] || 'fixed';

    let discountAmount = 0;
    let appliedCoupon = null;
    let isAdminCoupon = false;

    if (coupon_code) {
      // 1. Try owner coupons first
      const [ownerCoupons] = await pool.query(
        `SELECT * FROM coupons WHERE code = ? AND turf_id = ? AND is_active = TRUE`,
        [coupon_code.toUpperCase(), turf_id]
      );

      if (ownerCoupons.length > 0) {
        appliedCoupon = ownerCoupons[0];
        isAdminCoupon = false;
      } else {
        // 2. Try admin coupons
        const [adminCoupons] = await pool.query(
          `SELECT * FROM admin_coupons WHERE code = ? AND is_active = TRUE`,
          [coupon_code.toUpperCase()]
        );
        if (adminCoupons.length > 0) {
          appliedCoupon = adminCoupons[0];
          isAdminCoupon = true;
        }
      }

      if (appliedCoupon) {
        const coupon = appliedCoupon;
        const now = new Date();
        const todayStr = todayYmd();

        // Check date ranges
        if (coupon.valid_from && ymd(coupon.valid_from) > todayStr) {
          return res.status(400).json({ error: 'This coupon is not active yet' });
        }
        if (coupon.valid_until && ymd(coupon.valid_until) < todayStr) {
          return res.status(400).json({ error: 'This coupon has expired' });
        }
        if (!isAdminCoupon && coupon.expiry_date && ymd(coupon.expiry_date) < todayStr) {
          return res.status(400).json({ error: 'This coupon has expired' });
        }

        // Check max uses
        if (coupon.max_uses && coupon.used_count >= coupon.max_uses) {
          return res.status(400).json({ error: 'This coupon has reached its usage limit' });
        }

        // Check min booking amount
        if (coupon.min_booking_amount && totalBasePrice < parseFloat(coupon.min_booking_amount)) {
          return res.status(400).json({ error: `Minimum booking amount for this coupon is ₹${coupon.min_booking_amount}` });
        }

        // Sport specificity (for admin coupons)
        if (isAdminCoupon) {
          if (coupon.applicable_sport && coupon.applicable_sport !== 'all') {
            const bookingSport = court_id && currentBookable.sport_type ? currentBookable.sport_type : turf.sport_type;
            if (String(bookingSport).toLowerCase() !== String(coupon.applicable_sport).toLowerCase()) {
              return res.status(400).json({ error: `This coupon is only applicable for ${coupon.applicable_sport} bookings` });
            }
          }

          // Check per user limit (optional/bonus validation)
          if (coupon.per_user_limit && ((req.user?.id || req.body.user_id) || req.body.email || req.body.phone)) {
            const [usages] = await pool.query(
              `SELECT COUNT(*) as count FROM admin_coupon_usages 
               WHERE coupon_id = ? AND (
                 (user_id IS NOT NULL AND user_id = ?) OR 
                 (customer_email IS NOT NULL AND customer_email = ?) OR 
                 (customer_phone IS NOT NULL AND customer_phone = ?)
               )`,
              [coupon.id, (req.user?.id || req.body.user_id) || null, req.body.email || null, req.body.phone || null]
            );
            if (usages[0].count >= coupon.per_user_limit) {
              return res.status(400).json({ error: 'You have reached the usage limit for this coupon' });
            }
          }
        } else {
          // Check court specificity (for owner coupons)
          if (coupon.court_id && court_id && Number(coupon.court_id) !== Number(court_id)) {
            return res.status(400).json({ error: 'This coupon is not valid for the selected court' });
          }

          // Check per user limit
          if (coupon.per_user_limit && ((req.user?.id || req.body.user_id) || req.body.email || req.body.phone)) {
            const [usages] = await pool.query(
              `SELECT COUNT(*) as count FROM coupon_usages 
               WHERE coupon_id = ? AND (
                 (user_id IS NOT NULL AND user_id = ?) OR 
                 (customer_email IS NOT NULL AND customer_email = ?) OR 
                 (customer_phone IS NOT NULL AND customer_phone = ?)
               )`,
              [coupon.id, (req.user?.id || req.body.user_id) || null, req.body.email || null, req.body.phone || null]
            );
            if (usages[0].count >= coupon.per_user_limit) {
              return res.status(400).json({ error: 'You have reached the usage limit for this coupon' });
            }
          }
        }

        // Calculate discount
        if (coupon.discount_type === 'percentage') {
          discountAmount = (totalBasePrice * parseFloat(coupon.discount_value)) / 100;
          if (coupon.max_discount_cap && discountAmount > parseFloat(coupon.max_discount_cap)) {
            discountAmount = parseFloat(coupon.max_discount_cap);
          }
        } else {
          discountAmount = Math.min(parseFloat(coupon.discount_value), totalBasePrice);
        }
        discountAmount = Math.round(discountAmount * 100) / 100;
      } else {
        return res.status(400).json({ error: 'Invalid coupon code' });
      }
    }

    const priceAfterCoupon = totalBasePrice - discountAmount; // coupon applied FIRST
    
    // Fetch active customer fee rule for venues
    let serviceFee = 0;
    let serviceFeeTax = 0;
    let showFeeAtCheckout = true;
    let feeRuleId = null;
    let feeRuleSnapshot = null;
    try {
      const activeFeeRule = await billingConfig.getActiveFeeRule(turf.country_code || 'IN', turf.currency_code || 'INR', 'VENUE');
      const feeCalc = billingConfig.calculateCustomerFee(activeFeeRule, priceAfterCoupon);
      serviceFee = feeCalc.serviceFee;
      serviceFeeTax = feeCalc.serviceFeeTax;
      showFeeAtCheckout = feeCalc.showFeeAtCheckout;
      feeRuleId = feeCalc.feeRuleId;
      feeRuleSnapshot = feeCalc.feeRuleSnapshot;
    } catch (feeErr) {
      console.error('[Bookings] Error calculating customer fee in calculate-price:', feeErr);
    }

    // Find Players: the backend decides the split (services/playerSplit.js). Whatever contribution the client sends is ignored, so the
    // website, the app and the join link always show and charge the same share, worked out from the FINAL (post-coupon) amount.
    const isNeedPlayers = !!need_players;
    const numPlayersNeeded = Math.max(0, parseInt(players_needed || 0, 10));
    const split = isNeedPlayers && numPlayersNeeded > 0
      ? splitAmount({ totalMajor: priceAfterCoupon, playersNeeded: numPlayersNeeded, currency: turf.currency_code || 'INR' })
      : null;
    let perPlayerContrib = split ? split.playerShare : 0;

    let hostSplitShare = split ? split.hostShare : null;
    let totalPeople = split ? split.participants : null;
    let finalAmount = split ? split.hostShare : priceAfterCoupon;

    finalAmount = Math.max(0, finalAmount + serviceFee);

    const advancePercent = parseInt(currentBookable.advance_percent || turf.advance_percent || 100, 10);
    // With Find Players on there is no advance option: the host pays their whole share online and each player pays theirs through the
    // join link, so the match is only "funded" by verified payments. Normal bookings keep the venue's advance/full rules untouched.
    const paymentType = (split || advancePercent === 100)
      ? 'full'
      : (String(payment_option || 'advance').toLowerCase() === 'full' ? 'full' : 'advance');

    const advanceAmount = paymentType === 'advance'
      ? Math.round((finalAmount * (advancePercent / 100)) * 100) / 100
      : finalAmount;
    const pendingBalance = paymentType === 'advance'
      ? Math.round((finalAmount - advanceAmount) * 100) / 100
      : 0;

    res.json({
      basePrice: totalBasePrice,
      displayPrice,
      markupAmount,
      discountAmount,
      serviceFee,
      serviceFeeTax,
      totalCustomerFee: Math.round((serviceFee + serviceFeeTax) * 100) / 100,
      showFeeAtCheckout,
      feeRuleId,
      finalAmount,                      // host's payable amount (after coupon + split + customer fee + tax)
      originalFinalAmount: priceAfterCoupon, // full slot cost after coupon (before split)
      contributionAmount: perPlayerContrib,  // per player contribution share
      advancePercent,
      advanceAmount,
      pendingBalance,
      paymentType,
      // Find Players split info
      hostSplitShare,
      totalPeople,
      advanceDisabled: !!split,            // Find Players on -> no advance payment
      playerShare: split ? split.playerShare : null,
      participants: split ? split.participants : 1,
      coupon: appliedCoupon ? {
        code: appliedCoupon.code,
        discount_value: appliedCoupon.discount_value,
        discount_type: appliedCoupon.discount_type,
        discountValue: parseFloat(appliedCoupon.discount_value),
        discountType: appliedCoupon.discount_type
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Calculation failed' });
  }
});

// Helper: confirm bookings and auto-create player_request for 'Need Players' bookings
async function confirmBookings(ids, razorpay_payment_id) {
  if (!ids || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await pool.query(
    `UPDATE bookings SET payment_id = ?, payment_status = 'success', status = 'confirmed' WHERE id IN (${placeholders})`,
    [razorpay_payment_id, ...ids]
  );

  // Auto-create player_request for 'Need Players' bookings (first booking row)
  try {
    const hasNeedPlayers = await hasColumn('bookings', 'need_players');
    const hasPlayerRequestCreated = await hasColumn('bookings', 'player_request_created');
    const hasMatchRequestIdCol = await hasColumn('bookings', 'match_request_id');
    if (hasNeedPlayers) {
      const [rows] = await pool.query(
        `SELECT b.*, t.name as turf_name, t.latitude as turf_lat, t.longitude as turf_lng, t.location as turf_loc
         FROM bookings b JOIN turfs t ON b.turf_id = t.id
         WHERE b.id IN (${placeholders})`,
        [...ids]
      );
      const booking = rows.find(r => r.need_players === 1 || r.need_players === true || r.need_players === '1');
      if (booking && (!hasPlayerRequestCreated || !booking.player_request_created || booking.player_request_created === 0 || booking.player_request_created === '0' || booking.player_request_created === false)) {
        const crypto2 = require('crypto');
        const share_token = crypto2.randomBytes(16).toString('hex');
        const neededCount = Math.max(1, parseInt(booking.players_needed || 1, 10));
        const totalSlots = neededCount + 1;

        // Derive match_time from time_slot
        const [slotStart] = String(booking.time_slot || '').split(' - ');
        const timeMatch = String(slotStart || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
        let match_time = '00:00';
        if (timeMatch) {
          let h = parseInt(timeMatch[1], 10);
          const m = timeMatch[2];
          const ampm = (timeMatch[3] || '').toUpperCase();
          if (ampm === 'PM' && h !== 12) h += 12;
          if (ampm === 'AM' && h === 12) h = 0;
          match_time = `${String(h).padStart(2, '0')}:${m}`;
        }

        // the match total is the FINAL booking amount (after the coupon) — never the pre-coupon price — and each player's share is the
        // one the backend computed when the booking was created (services/playerSplit.js); recomputed here only for legacy rows.
        const totalBookingPrice = Math.max(0, rows.reduce((sum, r) => sum + parseFloat(r.original_price || r.amount || 0) - parseFloat(r.discount_amount || 0), 0));
        const perPlayerAmount = parseFloat(booking.contribution_amount) > 0
          ? parseFloat(booking.contribution_amount)
          : splitAmount({ totalMajor: totalBookingPrice, playersNeeded: neededCount, currency: booking.currency_code || 'INR' }).playerShare;

        const [prResult] = await pool.query(
          `INSERT INTO player_requests (
            host_id, turf_id, court_id, sport_type, match_type, match_date, match_time,
            total_slots, filled_slots, skill_level,
            advance_amount, split_amount, visibility_radius, latitude, longitude,
            share_token, booking_time_slot, contact_phone, contribution_amount, booking_total_amount, note, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
          [
            booking.user_id || null,
            booking.turf_id,
            booking.court_id || null,
            booking.sport_type || 'other',
            booking.match_type || 'friendly',
            booking.booking_date,
            match_time,
            totalSlots,
            1, // host already counted
            booking.skill_level || 'all',
            0,
            0,
            25, // default radius km
            booking.turf_lat || null,
            booking.turf_lng || null,
            share_token,
            booking.time_slot,
            booking.contact_phone || booking.customer_phone || null,
            perPlayerAmount,
            totalBookingPrice,
            booking.note || null
          ]
        );
        const matchRequestId = prResult.insertId;

        // Update bookings to link player_request
        if (hasMatchRequestIdCol) {
          await pool.query(`UPDATE bookings SET match_request_id = ? WHERE id IN (${placeholders})`, [matchRequestId, ...ids]);
        }
        if (hasPlayerRequestCreated) {
          await pool.query(`UPDATE bookings SET player_request_created = TRUE WHERE id IN (${placeholders})`, [...ids]);
        }
        console.log(`✅ Auto-created player_request ${matchRequestId} for booking ${ids[0]}`);
        fireNotification('find_players.match_created', { matchRequestId });
      }
    }
  } catch (prErr) {
    console.warn('⚠️ Failed to auto-create player_request:', prErr.message);
  }

  // Announce it (deduplicated by booking, so verify + webhook both running still notifies once)
  fireNotification('booking.confirmed', { bookingIds: ids });
}

// GET /api/bookings/checkout-html — Render HTML Razorpay Checkout for Expo Go & Web
router.get('/checkout-html', (req, res) => {
  const {
    order_id, booking_id, amount, key_id,
    name = 'Book Arena User', email = '', phone = '',
    redirect_url = '',
    // Optional generalization so other features (tournament registration, etc.) can reuse this
    // same hosted checkout page instead of duplicating it. Defaults reproduce the original
    // booking-only behavior exactly.
    verify_url = '/api/bookings/verify',
    cancel_url = '/api/bookings/cancel-pending',
    item_label = 'Booking ID',
    currency: checkoutCurrencyParam
  } = req.query;

  if (!order_id || !booking_id || !amount) {
    return res.status(400).send('<h3>Error: Missing required checkout parameters (order_id, booking_id, amount).</h3>');
  }

  const razorpayKey = key_id || process.env.RAZORPAY_KEY_ID;
  const checkoutCurrency = /^[A-Z]{3}$/.test(String(checkoutCurrencyParam || '')) ? checkoutCurrencyParam : 'INR';
  const amountInPaise = toMinor(parseFloat(amount), checkoutCurrency); // minor units of the booking's own currency
  if (!Number.isSafeInteger(amountInPaise) || amountInPaise <= 0) {
    return res.status(400).send('<h3>Error: Invalid payment amount.</h3>');
  }
  const amountDisplay = parseFloat(amount).toFixed(digitsFor(checkoutCurrency));

  const origin = `${req.protocol}://${req.get('host')}`;
  const internalApiPath = (value, fallback, allowEmpty = false) => {
    if (allowEmpty && String(value || '').trim() === '') return '';
    try {
      const url = new URL(String(value || fallback), origin);
      if (url.origin !== origin || !url.pathname.startsWith('/api/')) return fallback;
      return `${url.pathname}${url.search}`;
    } catch {
      return fallback;
    }
  };
  const verifyPath = internalApiPath(verify_url, '/api/bookings/verify');
  const cancelPath = internalApiPath(cancel_url, '/api/bookings/cancel-pending', true);
  const makeReturnUrl = (status, paymentId) => {
    let url;
    try {
      url = redirect_url ? new URL(String(redirect_url)) : new URL(`bookmyarena://payment-${status}`);
    } catch {
      url = new URL(`bookmyarena://payment-${status}`);
    }
    if (!['bookmyarena:', 'exp:', 'exps:'].includes(url.protocol)) {
      url = new URL(`bookmyarena://payment-${status}`);
    }
    url.searchParams.set('status', status);
    url.searchParams.set('booking_id', String(booking_id));
    url.searchParams.set('order_id', String(order_id));
    if (paymentId) url.searchParams.set('payment_id', String(paymentId));
    return url.toString();
  };
  const successDeepLink = makeReturnUrl('success');
  const cancelDeepLink = makeReturnUrl('cancelled');
  const failedDeepLink = makeReturnUrl('failed');
  const pendingDeepLink = makeReturnUrl('pending');
  const scriptString = (value) => JSON.stringify(String(value ?? ''))
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>Complete Payment - Book Arena</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f172a; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; text-align: center; }
    .card { background: #1e293b; padding: 32px 24px; border-radius: 20px; box-shadow: 0 20px 40px rgba(0,0,0,0.6); max-width: 420px; width: 100%; border: 1px solid #334155; }
    .logo { font-size: 52px; margin-bottom: 16px; }
    h2 { color: #22c55e; font-size: 22px; margin-bottom: 8px; font-weight: 700; }
    .subtitle { color: #94a3b8; font-size: 13px; margin-bottom: 6px; }
    .amount { color: #f8fafc; font-size: 28px; font-weight: 800; margin: 16px 0; }
    .btn { background: #22c55e; color: #0f172a; border: none; padding: 16px 28px; border-radius: 12px; font-size: 16px; font-weight: 700; cursor: pointer; width: 100%; transition: all 0.2s; margin-top: 8px; letter-spacing: 0.3px; }
    .btn:hover { background: #16a34a; transform: translateY(-1px); }
    .btn:active { transform: translateY(0); }
    .btn-cancel { background: transparent; color: #94a3b8; border: 1px solid #334155; padding: 12px 28px; border-radius: 12px; font-size: 14px; cursor: pointer; width: 100%; margin-top: 10px; }
    .btn-cancel:hover { border-color: #ef4444; color: #ef4444; }
    .info-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #263041; color: #94a3b8; font-size: 13px; }
    .info-row:last-child { border-bottom: none; }
    .info-val { color: #f8fafc; font-weight: 600; }
    .info-box { background: #0b1220; border: 1px solid #263041; border-radius: 12px; padding: 14px 16px; margin-bottom: 20px; text-align: left; }
    .spinner { width: 40px; height: 40px; border: 4px solid #334155; border-top-color: #22c55e; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #status-msg { display: none; }
  </style>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
</head>
<body>
  <div class="card" id="main-card">
    <div class="logo">🏟️</div>
    <h2>Book Arena Payment</h2>
    <p class="subtitle">Secure payment powered by Razorpay</p>
    <div class="amount">${checkoutCurrency} ${amountDisplay}</div>

    <div class="info-box">
      <div class="info-row"><span>Customer</span><span class="info-val">${escapeHtml(name)}</span></div>
      ${email ? `<div class="info-row"><span>Email</span><span class="info-val">${escapeHtml(email)}</span></div>` : ''}
      ${phone ? `<div class="info-row"><span>Phone</span><span class="info-val">${escapeHtml(phone)}</span></div>` : ''}
      <div class="info-row"><span>${escapeHtml(item_label)}</span><span class="info-val">#${escapeHtml(booking_id)}</span></div>
    </div>

    <button id="pay-btn" class="btn">💳 Pay ${checkoutCurrency} ${amountDisplay} Now</button>
    <button class="btn-cancel" onclick="handleCancel()">✕ Cancel &amp; Go Back</button>
  </div>

  <div id="status-msg" class="card">
    <div class="spinner"></div>
    <h2 id="status-title">Processing...</h2>
    <p class="subtitle" id="status-text">Please do not close this window.</p>
  </div>

  <script>
    var paymentDone = false;
    var checkoutToken = new URLSearchParams(window.location.hash.slice(1)).get('auth');
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    function checkoutHeaders() {
      var headers = { 'Content-Type': 'application/json' };
      if (checkoutToken) headers.Authorization = 'Bearer ' + checkoutToken;
      return headers;
    }

    function showStatus(title, text, color) {
      document.getElementById('main-card').style.display = 'none';
      var sm = document.getElementById('status-msg');
      sm.style.display = 'block';
      sm.querySelector('.spinner').style.display = color ? 'none' : 'block';
      document.getElementById('status-title').innerText = title;
      document.getElementById('status-title').style.color = color || '#22c55e';
      document.getElementById('status-text').innerText = text;
    }

    function handleCancel() {
      if (paymentDone) return;
      showStatus('Cancelled', 'Returning to app...', '#94a3b8');
      // Release the pending slot reservation (booking flow) or just navigate back (other flows)
      var cancelUrl = ${scriptString(cancelPath)};
      if (cancelUrl) {
        fetch(cancelUrl, {
          method: 'POST',
          headers: checkoutHeaders(),
          body: JSON.stringify({ booking_id: ${scriptString(booking_id)} })
        }).finally(function() {
          setTimeout(function() {
            window.location.href = ${scriptString(cancelDeepLink)};
          }, 800);
        });
      } else {
        setTimeout(function() {
          window.location.href = ${scriptString(cancelDeepLink)};
        }, 800);
      }
    }

    var options = {
      key: ${scriptString(razorpayKey)},
      amount: ${amountInPaise},
      currency: '${checkoutCurrency}',
      name: 'Book Arena',
      description: 'Slot Booking Payment',
      order_id: ${scriptString(order_id)},
      prefill: { name: ${scriptString(name)}, email: ${scriptString(email)}, contact: ${scriptString(phone)} },
      theme: { color: '#22c55e' },
      handler: function(response) {
        paymentDone = true;
        showStatus('Verifying Payment...', 'Please do not close this window.', null);
        fetch(${scriptString(verifyPath)}, {
          method: 'POST',
          headers: checkoutHeaders(),
          body: JSON.stringify({
            booking_id: ${scriptString(booking_id)},
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature
          })
        })
        .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, status: r.status, data: data }; }); })
        .then(function(result) {
          if (result.ok && result.data.success) {
            showStatus('✅ Payment Confirmed!', 'Booking secured. Redirecting to your receipt...', '#22c55e');
            setTimeout(function() {
              window.location.href = ${scriptString(makeReturnUrl('success'))} + '&payment_id=' + encodeURIComponent(response.razorpay_payment_id);
            }, 1500);
          } else if (result.status === 409 || result.status === 503 || result.data.pending) {
            showStatus('Payment Processing', 'Your booking is not confirmed yet. Please check the status in Book Arena.', '#f59e0b');
            setTimeout(function() { window.location.href = ${scriptString(pendingDeepLink)}; }, 1200);
          } else {
            showStatus('❌ Payment Failed', (result.data.error || 'Payment could not be verified.'), '#ef4444');
            setTimeout(function() { window.location.href = ${scriptString(failedDeepLink)}; }, 1200);
          }
        })
        .catch(function(err) {
          showStatus('⚠️ Payment Processing', 'Could not verify payment yet. Your booking is not confirmed.', '#f59e0b');
          setTimeout(function() { window.location.href = ${scriptString(pendingDeepLink)}; }, 1200);
        });
      },
      modal: {
        ondismiss: function() {
          if (!paymentDone) handleCancel();
        }
      }
    };

    var rzp = new Razorpay(options);
    rzp.on('payment.failed', function() {
      paymentDone = true;
      showStatus('❌ Payment Failed', 'Your booking has not been confirmed.', '#ef4444');
      setTimeout(function() { window.location.href = ${scriptString(failedDeepLink)}; }, 1200);
    });
    document.getElementById('pay-btn').onclick = function() { rzp.open(); };
    // Auto-open after a brief delay so the page renders first
    setTimeout(function() { rzp.open(); }, 600);
  </script>
</body>
</html>`;

  res.send(html);
});


// POST /api/bookings/verify — Verify Razorpay payment
// What Razorpay says about a payment, checked against what THIS server asked the customer to pay. Returns
// { ok: true, capturedMinor, currency } or { ok: false, status, error, pending? }.
//  - the payment must belong to the supplied order (a signature only proves that order+payment go together);
//  - it must be CAPTURED (an authorization is not money in the bank);
//  - it must cover what the bookings on that order require (never accept an underpayment).
// If Razorpay itself cannot be reached the signature is still cryptographically valid, so the booking journey is not
// blocked: the caller proceeds without a captured amount and the split engine falls back to the booking rows.
async function checkPaymentWithRazorpay({ paymentId, orderId, bookingRows }) {
  let rp;
  try {
    rp = await routeProvider.fetchPayment(paymentId);
  } catch (e) {
    console.warn(`[Payments] could not fetch payment ${paymentId} from Razorpay (${e.message}); leaving the booking pending for reconciliation`);
    return { ok: false, status: 503, pending: true, error: 'Payment status is still being verified. Your booking is not confirmed yet.' };
  }
  if (!rp || rp.order_id !== orderId) return { ok: false, status: 400, error: 'Payment does not belong to this order' };
  if (rp.status !== 'captured') {
    return { ok: false, status: 409, pending: true, error: 'Your payment has not been captured yet. Your booking will be confirmed automatically as soon as it is.' };
  }
  const expectedCurrency = bookingRows[0]?.currency_code || 'INR';
  if (rp.currency !== expectedCurrency || bookingRows.some((row) => (row.currency_code || 'INR') !== expectedCurrency)) {
    return { ok: false, status: 400, error: 'Payment currency does not match this booking' };
  }
  const expectedMinor = bookingRows.reduce(
    (sum, r) => sum + toMinor(Number(r.advance_amount != null ? r.advance_amount : r.amount || 0), expectedCurrency),
    0
  );
  const capturedMinor = Number(rp.amount);
  if (!Number.isSafeInteger(capturedMinor) || (expectedMinor > 0 && capturedMinor < expectedMinor)) {
    console.error(`[Payments] payment ${paymentId} captured ${rp.amount} but the bookings need ${expectedMinor}; refusing to confirm`);
    return { ok: false, status: 400, error: 'Payment amount does not match this booking' };
  }
  return { ok: true, capturedMinor, currency: rp.currency };
}

router.post('/verify', verifyCustomer, async (req, res) => {
  try {
    let { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (![booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature].every((value) => typeof value === 'string' || typeof value === 'number')) {
      return res.status(400).json({ success: false, error: 'Payment details are required' });
    }
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const suppliedBuffer = Buffer.from(String(razorpay_signature), 'hex');
    const signatureIsValid = suppliedBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);

    if (signatureIsValid) {
      // Handle array of strings or single string
      const ids = String(booking_id).split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      if (ids.length === 0) {
        return res.status(400).json({ success: false, error: 'Valid booking IDs are required' });
      }

      let verifiedPayment = { ok: true };
      if (ids.length > 0) {
        // Retrieve booking details to check conflict
        const placeholders = ids.map(() => '?').join(',');
        const [bookingsToCheck] = await pool.query(
          `SELECT id, user_id, turf_id, court_id, booking_date, time_slot, razorpay_order_id, payment_id, payment_status, status, advance_amount, amount, currency_code FROM bookings WHERE id IN (${placeholders})`,
          [...ids]
        );

        // The signature only proves "this payment belongs to this order". The booking ids come from the client, so make
        // sure every one of them is actually on that order — otherwise a cheap paid order could confirm someone else's booking.
        if (bookingsToCheck.length !== ids.length || bookingsToCheck.some((b) =>
          Number(b.user_id) !== Number(req.user.id) || !razorpay_order_id || b.razorpay_order_id !== razorpay_order_id
        )) {
          console.error(`[Payments] /verify: bookings ${ids.join(',')} are not all on order ${razorpay_order_id}; refusing`);
          return res.status(400).json({ success: false, error: 'Payment does not belong to these bookings' });
        }
        // Already confirmed with this very payment (customer double-tapped, or the webhook got there first): just report success.
        if (bookingsToCheck.every((b) => b.payment_status === 'success' && b.payment_id === razorpay_payment_id)) {
          try { if (razorpay_payment_id) await routeSplit.processSplitTransfer({ paymentId: razorpay_payment_id, orderId: razorpay_order_id, bookingIds: ids }); } catch (e) { console.error('[RouteSplit] /verify (already confirmed):', e.message); }
          return res.json({ success: true, message: 'Payment verified successfully', already_confirmed: true });
        }

        verifiedPayment = await checkPaymentWithRazorpay({ paymentId: razorpay_payment_id, orderId: razorpay_order_id, bookingRows: bookingsToCheck });
        if (!verifiedPayment.ok) {
          return res.status(verifiedPayment.status).json({ success: false, pending: !!verifiedPayment.pending, error: verifiedPayment.error });
        }

        const alreadyPaidWithAnotherPayment = bookingsToCheck.some((b) =>
          b.payment_status === 'success' && b.payment_id !== razorpay_payment_id
        );
        if (alreadyPaidWithAnotherPayment) {
          const duplicateRefund = await refundConflictedPayment({ bookingIds: ids, paymentId: razorpay_payment_id });
          return res.status(409).json({
            success: false,
            code: 'DUPLICATE_PAYMENT_REFUNDED',
            refund_initiated: !!(duplicateRefund.refunds && duplicateRefund.refunds.length),
            error: 'This booking already has a verified payment. The additional payment is being refunded.'
          });
        }

        const venueIds = new Set(bookingsToCheck.map((booking) => Number(booking.turf_id)));
        if (venueIds.size !== 1) {
          return res.status(400).json({ success: false, error: 'Bookings must belong to one venue' });
        }
        const lockedTurfId = bookingsToCheck[0].turf_id;
        const slotLockAcquired = await acquireSlotLock(lockedTurfId);
        if (!slotLockAcquired) {
          return res.status(503).json({ success: false, pending: true, error: 'Payment is verified; your booking is still being finalized. Please check again shortly.' });
        }
        try {
        // Serialize with both new slot creation and subscription activation before checking and confirming.
        const vlock = await subscriptionReservations.lockVenue(lockedTurfId);
        try {
        let slotConflict = false;
        for (const b of bookingsToCheck) {
          // Check if another booking is confirmed for this slot
          let checkQuery = `
            SELECT id FROM bookings 
            WHERE turf_id = ? AND booking_date = ? AND time_slot = ? 
            AND status != 'cancelled' AND payment_status = 'success' 
            AND id NOT IN (${placeholders})
          `;
          const checkParams = [b.turf_id, b.booking_date, b.time_slot, ...ids];
          if (b.court_id) {
            checkQuery += ' AND court_id = ?';
            checkParams.push(b.court_id);
          } else {
            checkQuery += ' AND court_id IS NULL';
          }
          const [existing] = await pool.query(checkQuery, checkParams);
          if (existing.length > 0) {
            slotConflict = true;
            break;
          }

          // Check if slot is blocked by owner
          const blockedHasCourtId = await hasColumn('blocked_slots', 'court_id');
          let checkBlockedQuery = 'SELECT id FROM blocked_slots WHERE turf_id = ? AND block_date = ? AND time_slot = ?';
          const checkBlockedParams = [b.turf_id, b.booking_date, b.time_slot];
          if (b.court_id && blockedHasCourtId) {
            checkBlockedQuery += ' AND (court_id IS NULL OR court_id = ?)';
            checkBlockedParams.push(b.court_id);
          } else if (!b.court_id && blockedHasCourtId) {
            checkBlockedQuery += ' AND court_id IS NULL';
          }
          const [blocked] = await pool.query(checkBlockedQuery, checkBlockedParams);
          if (blocked.length > 0) {
            slotConflict = true;
            break;
          }

          // an active subscription holds this slot
          if (await subscriptionReservations.slotReserved({ turfId: b.turf_id, courtId: b.court_id, date: b.booking_date, slotLabel: b.time_slot })) {
            slotConflict = true;
            break;
          }
        }

        if (slotConflict) {
          // Update these bookings to failed/cancelled since the slot is no longer available
          await pool.query(
            `UPDATE bookings SET payment_status = 'failed', status = 'cancelled' WHERE id IN (${placeholders})`,
            [...ids]
          );
          fireNotification('booking.failed', { bookingIds: ids, reason: 'slot_unavailable', paymentId: razorpay_payment_id });
          // the customer paid for a slot that is gone: refund in full (idempotent; never blocks this response)
          const conflictRefund = await refundConflictedPayment({ bookingIds: ids, paymentId: razorpay_payment_id });
          return res.status(409).json({ success: false, code: 'SLOT_CONFLICT_REFUNDED', refund_initiated: !!(conflictRefund.refunds && conflictRefund.refunds.length), error: 'Sorry, one or more slots were taken just before your payment completed. Your payment is being refunded in full to your original payment method.' });
        }

        await confirmBookings(ids, razorpay_payment_id);
        } finally { if (vlock) await vlock.release(); }
        } finally { await releaseSlotLock(lockedTurfId); }

        try {
          const emailResults = await sendBookingConfirmationEmails(ids);
          if (emailResults?.owner && emailResults.owner.success === false) {
            console.warn(`⚠️ Owner booking email was not delivered to ${emailResults.ownerEmail || 'unknown'}: ${emailResults.owner.error || emailResults.owner.message}`);
          }
        } catch (emailErr) {
          console.error('Email Notification Error:', emailErr.message);
        }

        // --- Razorpay Route split transfer (new, per-turf, percentage-based; feature-gated by turfs.route_enabled) ---
        // Never allowed to affect booking confirmation either way: it always runs after confirmBookings() above,
        // wrapped so a Route failure is only ever logged, exactly like the legacy trigger it replaces.
        try {
          if (razorpay_payment_id) {
            const split = await routeSplit.processSplitTransfer({ paymentId: razorpay_payment_id, orderId: razorpay_order_id, bookingIds: ids, capturedMinor: verifiedPayment.capturedMinor, currency: verifiedPayment.currency });
            if (split && split.error) console.error(`[RouteSplit] /verify payment ${razorpay_payment_id}: ${split.error}`);
          }
        } catch (routeErr) {
          console.error('[RouteSplit] Route split transfer failed during /verify. Manual reconciliation may be required:', routeErr);
        }
      }

      res.json({ success: true, message: 'Payment verified successfully' });
    } else {
      res.status(400).json({ success: false, error: 'Payment verification failed' });
    }
  } catch (err) {
    console.error('Error verifying payment:', err);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// POST /api/bookings/confirm-demo — Confirm booking in demo mode (skip payment)
// Despite the name this is a real production path: it confirms a booking that needs no online payment (the venue's
// advance is 0%, so there is nothing to pay through Razorpay). It must never be usable to confirm a booking that
// actually has money due, and never for someone else's booking.
router.post('/confirm-demo', verifyCustomer, async (req, res) => {
  try {
    const { booking_id } = req.body;
    if (!booking_id) {
      return res.status(400).json({ error: 'booking_id is required' });
    }
    const ids = String(booking_id).split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    if (ids.length === 0) {
      return res.status(400).json({ error: 'booking_id is required' });
    }
    const placeholders = ids.map(() => '?').join(',');
    const hasAdvanceAmount = await hasColumn('bookings', 'advance_amount');
    const [rows] = await pool.query(
      `SELECT id, user_id, status, amount, ${hasAdvanceAmount ? 'advance_amount' : 'amount as advance_amount'} FROM bookings WHERE id IN (${placeholders})`,
      ids
    );
    if (rows.length !== ids.length) return res.status(404).json({ error: 'Booking not found' });
    if (rows.some((b) => b.status !== 'pending')) return res.status(409).json({ error: 'This booking is no longer pending' });

    if (rows.some((b) => Number(b.user_id) !== Number(req.user.id))) {
      return res.status(403).json({ error: 'Not authorized to confirm this booking' });
    }
    const due = rows.reduce((sum, b) => sum + Number(b.advance_amount != null ? b.advance_amount : b.amount || 0), 0);
    if (due > 0.01) {
      return res.status(400).json({ error: 'This booking has an amount due and must be paid through Razorpay' });
    }

    await confirmBookings(ids, 'demo_' + crypto.randomBytes(8).toString('hex'));
    try {
      await sendBookingConfirmationEmails(ids);
    } catch (emailErr) {
      console.error('Demo Confirmation Email Error:', emailErr.message);
    }
    res.json({ success: true, message: 'Booking confirmed successfully (demo mode)' });
  } catch (err) {
    console.error('Error confirming demo booking:', err);
    res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

// POST /api/bookings/cancel-pending — Cancel unverified pending bookings and release slots
router.post('/cancel-pending', verifyCustomer, async (req, res) => {
  try {
    const { booking_id } = req.body;
    if (!booking_id) {
      return res.status(400).json({ error: 'booking_id is required' });
    }
    const ids = String(booking_id).split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    if (ids.length === 0) {
      return res.status(400).json({ error: 'No valid booking IDs provided' });
    }
    const placeholders = ids.map(() => '?').join(',');
    const [owned] = await pool.query(
      `SELECT id FROM bookings WHERE id IN (${placeholders}) AND user_id = ?`,
      [...ids, req.user.id]
    );
    if (owned.length !== ids.length) return res.status(403).json({ error: 'Not authorized to cancel this booking' });
    // A client-side close/cancel signal is not proof that Razorpay did not capture the payment.
    // Keep the hold pending until Razorpay's verified result arrives or the normal expiry cleanup runs.
    const [bookingRows] = await pool.query(
      `SELECT id, razorpay_order_id, payment_status, status, coupon_code FROM bookings WHERE id IN (${placeholders})`,
      ids
    );

    // If already confirmed with verified payment
    if (bookingRows.some(b => b.status === 'confirmed' || b.payment_status === 'success')) {
      return res.json({ success: true, confirmed: true, message: 'Booking is already confirmed with verified payment.' });
    }

    const orderId = bookingRows.find(b => b.razorpay_order_id)?.razorpay_order_id;
    let hasCapturedPayment = false;
    let capturedPaymentId = null;

    if (orderId) {
      try {
        const payments = await routeProvider.fetchOrderPayments(orderId);
        const captured = payments.find(p => p.status === 'captured');
        if (captured) {
          hasCapturedPayment = true;
          capturedPaymentId = captured.id;
        }
      } catch (gatewayErr) {
        console.warn(`[Payments] Could not query Razorpay for order ${orderId}:`, gatewayErr.message);
      }
    }

    if (hasCapturedPayment && capturedPaymentId) {
      console.log(`[Payments] cancel-pending detected captured payment ${capturedPaymentId} for order ${orderId}. Confirming booking!`);
      await confirmBookings(ids, capturedPaymentId);
      try {
        await sendBookingConfirmationEmails(ids);
      } catch (emailErr) {
        console.warn('[Payments] Email send on reconciled confirmation failed:', emailErr.message);
      }
      return res.json({
        success: true,
        confirmed: true,
        message: 'Payment was verified. Your booking is confirmed.'
      });
    }

    // No captured payment exists on Razorpay!
    // Safely mark as cancelled and release the temporary hold immediately!
    await pool.query(
      `UPDATE bookings SET payment_status = 'cancelled', status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'payment_cancelled'
       WHERE id IN (${placeholders}) AND status = 'pending'`,
      ids
    );

    // Rollback coupon usage count if applied to pending booking
    try {
      const couponCodes = [...new Set(bookingRows.map(b => b.coupon_code).filter(Boolean))];
      for (const code of couponCodes) {
        await pool.query('UPDATE coupons SET used_count = GREATEST(0, used_count - 1) WHERE code = ?', [code]).catch(() => {});
        await pool.query('UPDATE admin_coupons SET used_count = GREATEST(0, used_count - 1) WHERE code = ?', [code]).catch(() => {});
        await pool.query(`DELETE FROM coupon_usages WHERE booking_id IN (${placeholders})`, ids).catch(() => {});
        await pool.query(`DELETE FROM admin_coupon_usages WHERE booking_id IN (${placeholders})`, ids).catch(() => {});
      }
    } catch (cErr) {
      console.warn('[Payments] Error releasing coupon usage on cancel:', cErr.message);
    }

    console.log(`[Payments] Successfully cancelled pending booking(s) ${ids.join(',')} and released slot hold.`);
    res.json({
      success: true,
      cancelled: true,
      message: 'Pending booking cancelled and slot released safely.'
    });
  } catch (err) {
    console.error('Error cancelling pending booking:', err);
    res.status(500).json({ error: 'Failed to cancel booking: ' + err.message });
  }
});

// GET /api/bookings/:id — Get booking details.
//
// Bookings can be made by a guest (no account), so this cannot simply require a login. Access is granted to: the
// booking's own signed-in customer, the venue's owner, an admin, or — for a guest with no account to sign in with —
// someone who can prove they were part of this payment by supplying the razorpay payment/order id (or the demo
// confirmation id) as a query parameter. A booking id alone (small, sequential, guessable) is never enough.
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    // Support comma-separated booking IDs (multi-slot bookings)
    const rawId = req.params.id;
    const ids = String(rawId).split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    if (ids.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT b.*, t.name as turf_name, t.location as turf_location, t.owner_id as turf_owner_id
       FROM bookings b
       JOIN turfs t ON b.turf_id = t.id
       WHERE b.id IN (${placeholders})`,
      [...ids]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const booking = rows[0];

    const proof = String(req.query.payment_id || req.query.order_id || '').trim();
    const authorized =
      (req.user?.role === 'admin') ||
      (req.user?.role === 'owner' && req.user.id === booking.turf_owner_id) ||
      (!req.user?.role && req.user?.id && booking.user_id != null && req.user.id === booking.user_id) ||
      (!!proof && rows.every((b) => proof === b.payment_id || proof === b.razorpay_order_id));
    if (!authorized) {
      // Same response as "doesn't exist" — this endpoint never reveals whether a booking id is valid to someone who
      // isn't allowed to see it.
      return res.status(404).json({ error: 'Booking not found' });
    }
    delete booking.turf_owner_id;

    // Fetch linked match request + players for the host tracking card
    let match = null;
    let players = [];
    try {
      const hasMatchRequestIdCol = await hasColumn('bookings', 'match_request_id');
      const matchRequestId = hasMatchRequestIdCol ? booking.match_request_id : null;
      if (matchRequestId) {
        const [[mr]] = await pool.query(
          'SELECT * FROM player_requests WHERE id = ?',
          [matchRequestId]
        );
        if (mr) {
          match = { ...mr, invite_url: mr.share_token ? require('../services/publicUrl').inviteUrl(mr.share_token) : null };
          const [mpRows] = await pool.query(
            `SELECT mp.*, u.name as player_name, u.name as user_name, u.email as player_email
             FROM match_players mp
             LEFT JOIN users u ON mp.user_id = u.id
             WHERE mp.match_id = ? AND mp.payment_status IN ('paid', 'success')`,
            [matchRequestId]
          );
          players = mpRows;
        }
      }
    } catch (matchErr) {
      console.warn('⚠️ Could not fetch match details:', matchErr.message);
    }

    res.json({ booking, match, players });
  } catch (err) {
    console.error('Error fetching booking:', err);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// POST /api/bookings/webhook — Razorpay Webhook for async verification
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  // the built-in fallback secret is public (it is in the repo): never accept it in production, or anyone could forge a "payment captured" event
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || (process.env.NODE_ENV === 'development' ? 'bookmyarena_secret' : null);
  const signature = req.headers['x-razorpay-signature'];
  if (!secret || !signature) return res.status(secret ? 400 : 503).send(secret ? 'Missing signature' : 'Webhook not configured');

  try {
    const isValid = Razorpay.validateWebhookSignature(
      req.body.toString(),
      signature,
      secret
    );

    if (!isValid) {
      return res.status(400).send('Invalid signature');
    }

    const event = JSON.parse(req.body);
    console.log('🔔 Razorpay Webhook:', event.event);

    // Refund lifecycle from the gateway: the ONLY thing that completes (or fails) a refund. Idempotent — a repeated
    // webhook delivery changes nothing (services/refunds.js applyGatewayEvent).
    if (event.event === 'refund.processed' || event.event === 'refund.failed') {
      const entity = event.payload && event.payload.refund && event.payload.refund.entity;
      if (entity && entity.id) {
        await require('../services/refunds').applyGatewayEvent({
          gatewayRefundId: entity.id, outcome: event.event === 'refund.processed' ? 'processed' : 'failed',
          reason: entity.error_description || (entity.notes && entity.notes.reason) || undefined,
        });
      }
      return res.json({ status: 'ok' });
    }

    if (event.event === 'payment.captured') {
      const { order_id, id: payment_id, amount: captured_amount, currency: captured_currency } = event.payload.payment.entity;

      // A customer's sport/activity subscription payment? Activate it from the webhook too (idempotent with /subscriptions/verify),
      // so a customer whose phone died right after paying still gets the subscription they paid for. The captured amount/currency
      // must equal what the server asked for; a mismatch activates nothing.
      const subscriptionResult = order_id ? await subscriptionService.activateByOrder({ orderId: order_id, paymentId: payment_id, amountMinor: captured_amount, currency: captured_currency }) : { notFound: true };
      if (!subscriptionResult.notFound) return res.json({ status: 'ok' });

      // A Find Players join payment (a player paying their share through an invite link)? Confirm it from the webhook too — idempotent with
      // /match-requests/join/verify, whichever arrives first wins. Only a payment the gateway itself reports as captured gets here.
      const matchJoinResult = order_id ? await require('../services/matchJoin').confirmByOrder({ orderId: order_id, paymentId: payment_id, amountMinor: captured_amount, currency: captured_currency }) : { notFound: true };
      if (!matchJoinResult.notFound) return res.json({ status: 'ok' });

      const tournamentFeeResult = order_id
        ? await require('../services/tournamentFeePayments').confirmCapturedFeePayment({
          orderId: order_id, paymentId: payment_id, amountMinor: captured_amount, currency: captured_currency,
        })
        : { notFound: true };
      if (!tournamentFeeResult.notFound) {
        if (!tournamentFeeResult.accepted) {
          console.error(`[Webhook] tournament creation fee payment ${payment_id} was not applied: ${tournamentFeeResult.error}`);
        }
        return res.json({ status: tournamentFeeResult.accepted ? 'ok' : 'ignored' });
      }

      const venueBillingResult = await require('../services/venueBillingPayments').applyCapturedPayment({
        orderId: order_id, paymentId: payment_id, amountMinor: Number(captured_amount), currency: captured_currency,
      });
      if (!venueBillingResult.notFound) {
        if (!venueBillingResult.accepted) console.error(`[Webhook] venue billing payment ${payment_id} needs review: ${venueBillingResult.error}`);
        return res.json({ status: venueBillingResult.accepted ? 'ok' : 'ignored' });
      }

      // An Amusement Park / Activity booking payment?
      if (order_id) {
        const [[actBooking]] = await pool.query(
          'SELECT id, status, payment_status, total_amount, currency_code FROM activity_bookings WHERE razorpay_order_id = ?',
          [order_id]
        );
        if (actBooking) {
          const expectedCurrency = actBooking.currency_code || 'INR';
          const expectedMinor = toMinor(Number(actBooking.total_amount), expectedCurrency);
          if (captured_currency === expectedCurrency && Number(captured_amount) >= expectedMinor) {
            const actResult = await activityBooking.confirmBooking({ bookingId: actBooking.id, paymentId: payment_id });
            if (!actResult.error && !actResult.already) {
              fireNotification('activity.booking_confirmed', { bookingId: actBooking.id });
            }
          } else {
            console.error(`[Webhook] activity payment ${payment_id} captured ${captured_amount} but booking needs ${expectedMinor}`);
          }
          return res.json({ status: 'ok' });
        }
      }

      const hasRazorpayOrderId = await hasColumn('bookings', 'razorpay_order_id');
      let rows = [];

      if (hasRazorpayOrderId && order_id) {
        const [orderRows] = await pool.query(
          `SELECT id, turf_id, court_id, booking_date, time_slot, customer_email, customer_name, currency_code
           FROM bookings
           WHERE razorpay_order_id = ?`,
          [order_id]
        );
        rows = orderRows;
      }

      if (rows.length === 0) {
        // Match ONLY on the payment id. (The old fallback also matched "any pending booking with the same amount",
        // which let one customer's payment confirm a stranger's booking.)
        const [fallbackRows] = await pool.query(
          `SELECT id, turf_id, court_id, booking_date, time_slot, customer_email, customer_name, currency_code
           FROM bookings
           WHERE payment_id = ?`,
          [payment_id]
        );
        rows = fallbackRows;
      }

      // Never confirm on an underpayment: the captured amount must cover what these bookings require.
      if (rows.length > 0) {
        const [amountRows] = await pool.query(
          `SELECT advance_amount, amount, currency_code FROM bookings WHERE id IN (${rows.map(() => '?').join(',')})`, rows.map((r) => r.id)
        );
        const expectedCurrency = amountRows[0]?.currency_code || 'INR';
        const expectedMinor = amountRows.reduce((sum, r) => sum + toMinor(Number(r.advance_amount != null ? r.advance_amount : r.amount || 0), expectedCurrency), 0);
        if (amountRows.some((r) => (r.currency_code || 'INR') !== expectedCurrency) || captured_currency !== expectedCurrency
          || !Number.isSafeInteger(Number(captured_amount)) || (expectedMinor > 0 && Number(captured_amount) < expectedMinor)) {
          console.error(`[Webhook] payment ${payment_id} captured ${captured_amount} but bookings ${rows.map((r) => r.id).join(',')} need ${expectedMinor}; not confirming`);
          return res.json({ status: 'ok' });
        }
      }

      if (rows.length > 0) {
        const ids = rows.map(row => row.id);
        const placeholders = ids.map(() => '?').join(',');
        let slotConflict = new Set(rows.map((booking) => Number(booking.turf_id))).size !== 1;

        // A repeated delivery of the same event (Razorpay retries) for bookings this payment already confirmed:
        // nothing to confirm or e-mail again — only make sure the (idempotent) split exists, then acknowledge.
        const [[alreadyDone]] = await pool.query(
          `SELECT COUNT(*) AS c FROM bookings WHERE id IN (${placeholders}) AND payment_status = 'success' AND payment_id = ?`, [...ids, payment_id]
        );
        if (Number(alreadyDone.c) === ids.length) {
          try { if (payment_id) await routeSplit.processSplitTransfer({ paymentId: payment_id, orderId: order_id, bookingIds: ids, capturedMinor: Number(captured_amount), currency: captured_currency }); }
          catch (routeErr) { console.error('[RouteSplit] duplicate webhook:', routeErr.message); }
          return res.json({ status: 'ok' });
        }

        const lockedTurfId = rows[0].turf_id;
        const slotLockAcquired = !slotConflict && await acquireSlotLock(lockedTurfId);
        if (!slotConflict && !slotLockAcquired) throw new Error(`Could not acquire slot lock for captured payment ${payment_id}; webhook will retry`);
        try {
        for (const booking of rows) {
          if (slotConflict) break;
          let checkQuery = `
            SELECT id FROM bookings 
            WHERE turf_id = ? AND booking_date = ? AND time_slot = ? 
            AND status != 'cancelled' AND payment_status = 'success' 
            AND id NOT IN (${placeholders})
          `;
          const checkParams = [booking.turf_id, booking.booking_date, booking.time_slot, ...ids];
          if (booking.court_id) {
            checkQuery += ' AND court_id = ?';
            checkParams.push(booking.court_id);
          } else {
            checkQuery += ' AND court_id IS NULL';
          }
          const [existing] = await pool.query(checkQuery, checkParams);

          const blockedHasCourtId = await hasColumn('blocked_slots', 'court_id');
          let checkBlockedQuery = 'SELECT id FROM blocked_slots WHERE turf_id = ? AND block_date = ? AND time_slot = ?';
          const checkBlockedParams = [booking.turf_id, booking.booking_date, booking.time_slot];
          if (booking.court_id && blockedHasCourtId) {
            checkBlockedQuery += ' AND (court_id IS NULL OR court_id = ?)';
            checkBlockedParams.push(booking.court_id);
          } else if (!booking.court_id && blockedHasCourtId) {
            checkBlockedQuery += ' AND court_id IS NULL';
          }
          const [blocked] = await pool.query(checkBlockedQuery, checkBlockedParams);

          if (existing.length > 0 || blocked.length > 0 || await subscriptionReservations.slotReserved({ turfId: booking.turf_id, courtId: booking.court_id, date: booking.booking_date, slotLabel: booking.time_slot })) {
            slotConflict = true;
            break;
          }
        }

        if (!slotConflict) {
          const vlock = await subscriptionReservations.lockVenue(rows[0].turf_id);
          try {
            // re-check under the venue lock: a subscription may have been activated while we were looking
            for (const booking of rows) {
              if (await subscriptionReservations.slotReserved({ turfId: booking.turf_id, courtId: booking.court_id, date: booking.booking_date, slotLabel: booking.time_slot })) { slotConflict = true; break; }
            }
            if (!slotConflict) await confirmBookings(ids, payment_id);
          } finally { await vlock.release(); }
        }
        } finally {
          if (slotLockAcquired) await releaseSlotLock(lockedTurfId);
        }

        if (!slotConflict) {
          try {
            await sendBookingConfirmationEmails(ids);
          } catch (emailErr) {
            console.error('Webhook Email Notification Error:', emailErr.message);
          }
          console.log(`✅ Webhook confirmed bookings ${ids.join(', ')}`);

          // --- Razorpay Route split transfer (new, per-turf, percentage-based; feature-gated by turfs.route_enabled) ---
          try {
            if (payment_id) {
              const split = await routeSplit.processSplitTransfer({ paymentId: payment_id, orderId: order_id, bookingIds: ids, capturedMinor: Number(captured_amount), currency: captured_currency });
              if (split && split.error) console.error(`[RouteSplit] webhook payment ${payment_id}: ${split.error}`);
            }
          } catch (routeErr) {
            console.error('[RouteSplit] Route split transfer failed during webhook:', routeErr);
          }
        } else {
          await pool.query(
            `UPDATE bookings SET payment_status = 'failed', status = 'cancelled' WHERE id IN (${placeholders})`,
            [...ids]
          );
          console.log(`❌ Webhook cancelled conflict bookings ${ids.join(', ')}`);
          if (payment_id) await refundConflictedPayment({ bookingIds: ids, paymentId: payment_id });
        }
      }
    } else if (event.event === 'payment.failed') {
      // One failed ATTEMPT (Razorpay lets the customer retry the same order): tell them, but leave the booking/subscription as it is
      const failedPayment = event.payload.payment.entity;
      const venueBillingFailure = failedPayment.order_id
        ? await require('../services/venueBillingPayments').markFailed({ orderId: failedPayment.order_id, reason: failedPayment.error_description || failedPayment.error_reason || 'Payment failed' })
        : { notFound: true };
      if (!venueBillingFailure.notFound) return res.json({ status: 'ok' });
      const failedSub = failedPayment.order_id ? await subscriptionService.reportPaymentFailed({ orderId: failedPayment.order_id, paymentId: failedPayment.id }) : { notFound: true };
      if (failedPayment.order_id) {
        await pool.query("UPDATE activity_bookings SET payment_status = 'failed' WHERE razorpay_order_id = ? AND status = 'pending'", [failedPayment.order_id]).catch(() => {});
      }
      if (failedSub.notFound && failedPayment.order_id) {
        const [failedBookings] = await pool.query('SELECT id FROM bookings WHERE razorpay_order_id = ?', [failedPayment.order_id]);
        if (failedBookings.length > 0) fireNotification('booking.failed', { bookingIds: failedBookings.map((b) => b.id), reason: 'payment_failed', paymentId: failedPayment.id });
      }
    } else if (event.event === 'transfer.processed') {
      const transferObj = event.payload.transfer.entity;
      if (transferObj && transferObj.id) {
        try {
          await pool.query(
            `UPDATE razorpay_transfers SET status = 'processed' WHERE razorpay_transfer_id = ?`,
            [transferObj.id]
          );
          await pool.query(
            `UPDATE route_split_transfers SET status = 'SUCCESS' WHERE razorpay_transfer_id = ?`,
            [transferObj.id]
          );
        } catch (e) { console.error('[Route] Failed to update transfer status', e); }
      }
    } else if (event.event === 'transfer.failed' || event.event === 'transfer.reversed') {
      const transferObj = event.payload.transfer.entity;
      if (transferObj && transferObj.id) {
        try {
          await pool.query(
            `UPDATE razorpay_transfers SET status = ?, error_message = ? WHERE razorpay_transfer_id = ?`,
            [event.event === 'transfer.failed' ? 'failed' : 'reversed', transferObj.error_description || 'Webhook reported failure/reversal', transferObj.id]
          );
          await pool.query(
            `UPDATE route_split_transfers SET status = ?, error_message = ? WHERE razorpay_transfer_id = ?`,
            [event.event === 'transfer.failed' ? 'RETRY_REQUIRED' : 'FAILED', transferObj.error_description || 'Webhook reported failure/reversal', transferObj.id]
          );
          fireNotification('payment.issue', { summary: `A Razorpay Route transfer was ${event.event === 'transfer.failed' ? 'declined' : 'reversed'}. Check Payouts.`, entityType: 'transfer', entityId: transferObj.id });
        } catch (e) { console.error('[Route] Failed to update transfer status', e); }
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook Error:', err.message);
    res.status(500).send('Webhook failed');
  }
});

// POST /api/bookings/cleanup-pending - Clean up expired pending bookings (call this every 15 mins via cron)
router.post('/cleanup-pending', async (req, res) => {
  try {
    const [expiredCandidates] = await pool.query(
      "SELECT id, razorpay_order_id FROM bookings WHERE status = 'pending' AND payment_status = 'pending' AND created_at < NOW() - INTERVAL 15 MINUTE"
    );
    const byOrder = new Map();
    const noOrderIds = [];
    for (const booking of expiredCandidates) {
      if (!booking.razorpay_order_id) noOrderIds.push(booking.id);
      else {
        const orderIds = byOrder.get(booking.razorpay_order_id) || [];
        orderIds.push(booking.id);
        byOrder.set(booking.razorpay_order_id, orderIds);
      }
    }

    const safeToExpire = [...noOrderIds];
    let deferred = 0;
    for (const [orderId, bookingIds] of byOrder) {
      try {
        const payments = await routeProvider.fetchOrderPayments(orderId);
        const hasUnresolvedPayment = payments.some((payment) => payment.status !== 'failed');
        if (hasUnresolvedPayment) deferred += bookingIds.length;
        else safeToExpire.push(...bookingIds);
      } catch (gatewayError) {
        deferred += bookingIds.length;
        console.warn(`[Payments] Could not reconcile stale order ${orderId}; keeping its booking hold: ${gatewayError.message}`);
      }
    }

    let expired = 0;
    if (safeToExpire.length) {
      const placeholders = safeToExpire.map(() => '?').join(',');
      const [result] = await pool.query(
        `UPDATE bookings SET status = 'cancelled', payment_status = 'expired'
         WHERE id IN (${placeholders}) AND status = 'pending' AND payment_status = 'pending'
           AND created_at < NOW() - INTERVAL 15 MINUTE`,
        safeToExpire
      );
      expired = result.affectedRows;
    }

    res.json({
      success: true,
      expired,
      deferred,
      message: `Expired ${expired} unpaid bookings; retained ${deferred} with unresolved payment status`
    });
  } catch (err) {
    console.error('Error cleaning up pending bookings:', err);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

// POST /api/bookings/release — Release or cancel a pending/temporary booking slot
// Reconciles with Razorpay first to avoid releasing a slot that was actually paid.
router.post('/release', verifyCustomer, async (req, res) => {
  try {
    const { booking_id } = req.body;
    if (!booking_id) {
      return res.status(400).json({ error: 'booking_id is required' });
    }
    const ids = String(booking_id).split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    if (ids.length === 0) return res.status(400).json({ error: 'No valid booking IDs provided' });

    const placeholders = ids.map(() => '?').join(',');
    const [owned] = await pool.query(
      `SELECT id FROM bookings WHERE id IN (${placeholders}) AND user_id = ?`,
      [...ids, req.user.id]
    );
    if (owned.length !== ids.length) return res.status(403).json({ error: 'Not authorized to release this booking' });

    // Check if any booking is already confirmed
    const [bookingRows] = await pool.query(
      `SELECT id, razorpay_order_id, payment_status, status FROM bookings WHERE id IN (${placeholders})`,
      ids
    );
    if (bookingRows.some(b => b.status === 'confirmed' || b.payment_status === 'success')) {
      return res.json({ success: true, confirmed: true, message: 'Booking is already confirmed with verified payment.' });
    }

    // Reconcile with Razorpay before releasing
    const orderId = bookingRows.find(b => b.razorpay_order_id)?.razorpay_order_id;
    if (orderId) {
      try {
        const payments = await routeProvider.fetchOrderPayments(orderId);
        const captured = payments.find(p => p.status === 'captured');
        if (captured) {
          console.log(`[Bookings/release] Found captured payment ${captured.id} for order ${orderId}. Confirming instead of releasing.`);
          await confirmBookings(ids, captured.id);
          try { await sendBookingConfirmationEmails(ids); } catch (e) { /* non-critical */ }
          return res.json({ success: true, confirmed: true, message: 'Payment was verified. Your booking is confirmed.' });
        }
      } catch (e) {
        console.warn('[Bookings/release] Razorpay query failed:', e.message);
      }
    }

    await pool.query(
      `UPDATE bookings SET payment_status = 'failed', status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'payment_cancelled' WHERE id IN (${placeholders}) AND status = 'pending'`,
      [...ids]
    );
    res.json({ success: true, message: 'Temporary booking slots released successfully' });
  } catch (err) {
    console.error('Error releasing slot:', err);
    res.status(500).json({ error: 'Failed to release slot: ' + err.message });
  }
});

module.exports = router;
