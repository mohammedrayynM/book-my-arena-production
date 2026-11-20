const pool = require('../config/db');
const { sendEmail } = require('../utils/email');

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

/**
 * Creates or updates durable receipt in `booking_receipts` table.
 * Guaranteed to persist regardless of whether email transport works.
 */
async function generateAndSaveReceipt({ bookingRows, paymentId, paymentMethod = 'Razorpay' }) {
  if (!bookingRows || bookingRows.length === 0) return null;
  const first = bookingRows[0];
  const bookingId = first.id;
  const receiptNumber = `RCP-${bookingId}-${first.razorpay_order_id ? first.razorpay_order_id.replace(/^order_/, '') : Date.now()}`;

  // Fetch venue and court details
  const [[turf]] = await pool.query(
    'SELECT t.name as turf_name, t.location, c.name as court_name FROM turfs t LEFT JOIN courts c ON c.id = ? WHERE t.id = ?',
    [first.court_id || null, first.turf_id]
  );
  const turfName = turf?.turf_name || 'Book Arena Venue';
  const courtName = turf?.court_name || null;

  const allSlots = bookingRows.map(r => r.time_slot).join(', ');
  const totalAmount = bookingRows.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);
  const isAdvance = String(first.payment_type || '').toLowerCase() === 'advance';
  const amountPaid = isAdvance
    ? bookingRows.reduce((sum, r) => sum + parseFloat(r.advance_amount || 0), 0)
    : totalAmount;
  const pendingBalance = Math.max(0, totalAmount - amountPaid);

  const receiptJson = JSON.stringify({
    receiptNumber,
    bookingIds: bookingRows.map(r => r.id),
    turfName,
    courtName,
    bookingDate: first.booking_date,
    timeSlots: bookingRows.map(r => r.time_slot),
    customer: {
      name: first.customer_name,
      phone: first.customer_phone,
      email: first.customer_email
    },
    pricing: {
      totalAmount,
      amountPaid,
      pendingBalance,
      paymentType: isAdvance ? 'advance' : 'full',
      paymentId,
      paymentMethod
    },
    generatedAt: new Date().toISOString()
  });

  try {
    await pool.query(
      `INSERT INTO booking_receipts 
        (booking_id, receipt_number, turf_name, court_name, booking_date, time_slot,
         customer_name, customer_phone, customer_email, payment_type, total_amount,
         amount_paid, pending_balance, razorpay_order_id, razorpay_payment_id,
         payment_method, receipt_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE 
         amount_paid = VALUES(amount_paid),
         pending_balance = VALUES(pending_balance),
         razorpay_payment_id = VALUES(razorpay_payment_id),
         payment_method = VALUES(payment_method),
         receipt_json = VALUES(receipt_json)`,
      [
        bookingId,
        receiptNumber,
        turfName,
        courtName,
        first.booking_date,
        allSlots,
        first.customer_name,
        first.customer_phone || null,
        first.customer_email || null,
        isAdvance ? 'advance' : 'full',
        totalAmount,
        amountPaid,
        pendingBalance,
        first.razorpay_order_id || null,
        paymentId,
        paymentMethod,
        receiptJson
      ]
    );
    console.log(`[Receipt] Persisted durable receipt ${receiptNumber} for booking ${bookingId}`);
  } catch (err) {
    console.error(`[Receipt] Failed to persist receipt for booking ${bookingId}:`, err.message);
  }

  return {
    receiptNumber,
    turfName,
    courtName,
    bookingDate: first.booking_date,
    allSlots,
    totalAmount,
    amountPaid,
    pendingBalance,
    customerName: first.customer_name,
    customerEmail: first.customer_email,
    customerPhone: first.customer_phone
  };
}

/**
 * Dispatches confirmation emails asynchronously.
 * Catches all errors safely so email issues NEVER break the booking confirmation response.
 */
async function sendConfirmationEmailsSafely(bookingIds) {
  const ids = Array.isArray(bookingIds)
    ? bookingIds.map(id => parseInt(id, 10)).filter(id => !Number.isNaN(id))
    : [];

  if (ids.length === 0) return { customer: null, owner: null };

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

  if (rows.length === 0) return { customer: null, owner: null };

  const booking = rows[0];
  const allSlots = rows.map(row => row.time_slot).join(', ');
  const ownerEmail = booking.turf_owner_email || booking.owner_account_email || null;
  const formattedBookingDate = formatDateLabel(booking.booking_date);

  const slotDetails = rows.map((row, index) => {
    const fullAmount = parseFloat(row.amount || 0);
    const rawPendingBalance = parseFloat(row.pending_balance || 0);
    const pendingBalance = Number.isFinite(rawPendingBalance) && rawPendingBalance >= 0 ? rawPendingBalance : 0;
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

  // Send Customer Email
  if (booking.customer_email) {
    const customerMsg = `Dear ${booking.customer_name},

Your booking for ${booking.turf_name} on ${booking.booking_date} at ${allSlots} is CONFIRMED.

Booking Details:
  Date: ${booking.booking_date}
  Time Slots: ${allSlots}
  Total Booking Amount: ₹${totalBookingAmount.toFixed(2)}
  Amount Paid: ₹${totalPaidNow.toFixed(2)}
  Balance Due at Venue: ₹${totalPendingBalance.toFixed(2)}
  Payment ID: ${booking.payment_id || 'N/A'}

Thank you for choosing Book Arena!

Best regards,
Book Arena Team`;

    try {
      customerResult = await sendEmail(booking.customer_email, 'Booking Confirmed - BookArena', customerMsg);
      if (customerResult?.success) {
        await pool.query('UPDATE booking_receipts SET email_sent = 1, email_error = NULL WHERE booking_id = ?', [booking.id]);
      } else {
        await pool.query('UPDATE booking_receipts SET email_sent = 0, email_error = ? WHERE booking_id = ?', [customerResult?.error || 'Email send failed', booking.id]);
      }
    } catch (e) {
      console.warn(`[Receipt] Customer email send exception for booking ${booking.id}:`, e.message);
      await pool.query('UPDATE booking_receipts SET email_sent = 0, email_error = ? WHERE booking_id = ?', [e.message, booking.id]).catch(() => {});
    }
  }

  // Send Owner Email
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
- Customer Mobile No: ${booking.customer_phone || 'N/A'}
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

    try {
      ownerResult = await sendEmail(ownerEmail, ownerSubject, ownerMsg);
    } catch (e) {
      console.warn(`[Receipt] Owner email send exception for booking ${booking.id}:`, e.message);
    }
  }

  return { customer: customerResult, owner: ownerResult };
}

module.exports = {
  generateAndSaveReceipt,
  sendConfirmationEmailsSafely,
  formatCurrency,
  formatDateLabel
};
