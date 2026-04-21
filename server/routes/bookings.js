const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { sendEmail } = require('../utils/email');
require('dotenv').config();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// POST /api/bookings — Create a new booking
router.post('/', async (req, res) => {
  try {
    const { turf_id, customer_name, customer_phone, customer_email, booking_date, time_slot, time_slots, coupon_code, user_id } = req.body;

    let targetSlots = time_slots && time_slots.length > 0 ? time_slots : (time_slot ? [time_slot] : []);

    // Validate required fields
    if (!turf_id || !customer_name || !customer_phone || !customer_email || !booking_date || targetSlots.length === 0) {
      return res.status(400).json({ error: 'All fields are required, including email' });
    }

    // Check if slots are already booked - only count confirmed/successful payments
    for (const ts of targetSlots) {
      const [existingBooking] = await pool.query(
        'SELECT id FROM bookings WHERE turf_id = ? AND booking_date = ? AND time_slot = ? AND status != ? AND payment_status = ?',
        [turf_id, booking_date, ts, 'cancelled', 'success']
      );
      if (existingBooking.length > 0) {
        return res.status(409).json({ error: `This slot (${ts}) is already booked` });
      }

      // Check if slot is blocked
      const [blockedSlot] = await pool.query(
        'SELECT id FROM blocked_slots WHERE turf_id = ? AND block_date = ? AND time_slot = ?',
        [turf_id, booking_date, ts]
      );
      if (blockedSlot.length > 0) {
        return res.status(409).json({ error: `This slot (${ts}) is blocked by the owner` });
      }
    }

    // Get turf details
    const [turfRows] = await pool.query('SELECT name, price_per_hour, markup_type, markup_value FROM turfs WHERE id = ?', [turf_id]);
    if (turfRows.length === 0) {
      console.log('❌ Booking fail: Turf not found', turf_id);
      return res.status(404).json({ error: 'Turf not found' });
    }
    const turf = turfRows[0];
    const basePriceFromTurf = parseFloat(turf.price_per_hour);
    
    // Check for special pricing for this date and time slots
    const dateObj = new Date(booking_date + 'T00:00:00');
    const dayOfWeek = dateObj.getDay(); // 0=Sunday, 1=Monday, etc.

    let totalBasePrice = 0;
    const slotBasePrices = [];
    for (const ts of targetSlots) {
      const [specialPricing] = await pool.query(
        `SELECT special_price FROM special_pricing 
         WHERE turf_id = ? AND is_active = TRUE 
         AND ((specific_date = ? AND time_slot = ?) OR (specific_date IS NULL AND day_of_week = ? AND time_slot = ?))
         ORDER BY specific_date DESC LIMIT 1`,
        [turf_id, booking_date, ts, dayOfWeek, ts]
      );

      const basePrice = specialPricing.length > 0 ? parseFloat(specialPricing[0].special_price) : basePriceFromTurf;
      totalBasePrice += basePrice;
      slotBasePrices.push(basePrice);
    }

    // Calculate Markup (Minimum 200 per slot for display psychology as per user request)
    let markupAmount = 0;
    const ownerMarkupValue = parseFloat(turf.markup_value || 0);
    
    if (turf.markup_type === 'percentage') {
      markupAmount = (totalBasePrice * ownerMarkupValue) / 100;
      if (markupAmount < (200 * targetSlots.length)) markupAmount = 200 * targetSlots.length;
    } else {
      markupAmount = Math.max(200 * targetSlots.length, ownerMarkupValue * targetSlots.length);
    }
    const displayPrice = totalBasePrice + markupAmount;

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

    if (coupon_code) {
      const [coupons] = await pool.query(
        `SELECT c.* FROM coupons c 
         WHERE c.code = ? AND c.turf_id = ? AND c.is_active = TRUE`,
        [coupon_code.toUpperCase(), turf_id]
      );

      if (coupons.length > 0) {
        const coupon = coupons[0];
        const now = new Date();

        // Check expiry
        if (coupon.expiry_date && new Date(coupon.expiry_date) < now) {
          return res.status(400).json({ error: 'This coupon has expired' });
        }

        // Check min amount
        if (coupon.min_booking_amount && totalBasePrice < parseFloat(coupon.min_booking_amount)) {
          return res.status(400).json({ error: `Minimum booking amount for this coupon is ₹${coupon.min_booking_amount}` });
        }

        // Calculate discount (on totalBasePrice)
        if (coupon.discount_type === 'percentage') {
          discountAmount = (totalBasePrice * parseFloat(coupon.discount_value)) / 100;
        } else {
          discountAmount = Math.min(parseFloat(coupon.discount_value), totalBasePrice);
        }
        
        discountAmount = Math.round(discountAmount * 100) / 100;
        appliedCouponCode = coupon.code;
        couponId = coupon.id;
        console.log(`🎟️ Coupon applied: ${coupon.code} - Discount: ₹${discountAmount}`);
      } else {
        return res.status(400).json({ error: 'Invalid coupon code for this turf' });
      }
    }

    // FINAL CALCULATION
    const priceAfterCoupon = totalBasePrice - discountAmount;
    
    let serviceFee = 0;
    if (feeType === 'percentage') {
      serviceFee = (priceAfterCoupon * feeValue) / 100;
    } else {
      serviceFee = feeValue * targetSlots.length;
    }
    
    const finalAmount = Math.max(0, priceAfterCoupon + serviceFee);

    // Create Razorpay order
    let order_id = null;
    try {
      const order = await razorpay.orders.create({
        amount: Math.round(finalAmount * 100), // Amount in paisa
        currency: 'INR',
        receipt: `booking_${Date.now()}`
      });
      order_id = order.id;
    } catch (e) {
      console.error('🔥 Razorpay Order Creation Failed:', e.message);
      return res.status(500).json({ error: 'Payment gateway error: ' + e.message });
    }

    // Insert booking records
    try {
      console.log('📝 Saving booking to DB...');
      const bookingIds = [];
      const numSlots = targetSlots.length;
      
      const perRowFinalAmount = finalAmount / numSlots;
      const perRowMarkupAmount = markupAmount / numSlots;
      const perRowDiscountAmount = discountAmount / numSlots;
      const perRowServiceFee = serviceFee / numSlots;

      for (let i = 0; i < targetSlots.length; i++) {
        const ts = targetSlots[i];
        const spPrice = slotBasePrices[i];

        const [result] = await pool.query(
          `INSERT INTO bookings (
            turf_id, customer_name, customer_phone, customer_email, 
            booking_date, time_slot, amount, original_price, 
            discount_amount, markup_amount, service_fee, 
            coupon_code, payment_status, status, user_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            turf_id, customer_name, customer_phone, customer_email || '', 
            booking_date, ts, perRowFinalAmount, spPrice, 
            perRowDiscountAmount, perRowMarkupAmount, perRowServiceFee, 
            appliedCouponCode, 'pending', 'pending', user_id || null
          ]
        );
        bookingIds.push(result.insertId);
      }
      
      console.log('✅ Bookings successfully saved! IDs:', bookingIds.join(', '));

      // Track coupon usage if coupon was applied
      if (appliedCouponCode && couponId) {
        try {
          await pool.query(
            `INSERT INTO coupon_usages (coupon_id, booking_id, customer_email, customer_phone, discount_amount)
             VALUES (?, ?, ?, ?, ?)`,
            [couponId, bookingIds[0], customer_email || '', customer_phone, discountAmount]
          );
          // Increment coupon usage count
          await pool.query(
            'UPDATE coupons SET used_count = used_count + 1 WHERE id = ?',
            [couponId]
          );
        } catch (couponErr) {
          console.warn('⚠️ Failed to track coupon usage:', couponErr.message);
        }
      }

      res.json({
        booking_id: bookingIds.join(','),
        order_id: order_id,
        amount: finalAmount,
        basePrice: totalBasePrice,
        displayPrice: displayPrice,
        markupAmount: markupAmount,
        discountAmount: discountAmount,
        serviceFee: serviceFee,
        couponCode: appliedCouponCode,
        currency: 'INR',
        key_id: process.env.RAZORPAY_KEY_ID
      });
    } catch (insertErr) {
      console.log('❌ DB Insert Error:', insertErr.message);
      res.status(500).json({ error: 'Database failed to save booking: ' + insertErr.message });
    }
  } catch (err) {
    console.error('🔥 Critical Booking Error:', err);
    res.status(500).json({ error: 'System error: ' + err.message });
  }
});

// POST /api/bookings/calculate-price — Calculate price breakdown for real-time UI
router.post('/calculate-price', async (req, res) => {
  try {
    const { turf_id, booking_date, time_slot, time_slots, coupon_code } = req.body;
    let targetSlots = time_slots || (time_slot ? [time_slot] : []);

    if (!turf_id || !booking_date || targetSlots.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const [turfRows] = await pool.query('SELECT name, price_per_hour, markup_type, markup_value FROM turfs WHERE id = ?', [turf_id]);
    if (turfRows.length === 0) return res.status(404).json({ error: 'Turf not found' });
    
    const turf = turfRows[0];
    const basePriceFromTurf = parseFloat(turf.price_per_hour);
    
    const dateObj = new Date(booking_date + 'T00:00:00');
    const dayOfWeek = dateObj.getDay();

    let totalBasePrice = 0;
    for (const ts of targetSlots) {
      const [specialPricing] = await pool.query(
        `SELECT special_price FROM special_pricing 
         WHERE turf_id = ? AND is_active = TRUE 
         AND ((specific_date = ? AND time_slot = ?) OR (specific_date IS NULL AND day_of_week = ? AND time_slot = ?))
         ORDER BY specific_date DESC LIMIT 1`,
        [turf_id, booking_date, ts, dayOfWeek, ts]
      );
      totalBasePrice += specialPricing.length > 0 ? parseFloat(specialPricing[0].special_price) : basePriceFromTurf;
    }

    let markupAmount = 0;
    const ownerMarkupValue = parseFloat(turf.markup_value || 0);
    
    if (turf.markup_type === 'percentage') {
      markupAmount = (totalBasePrice * ownerMarkupValue) / 100;
      if (markupAmount < (200 * targetSlots.length)) markupAmount = (200 * targetSlots.length);
    } else {
      markupAmount = Math.max(200 * targetSlots.length, ownerMarkupValue * targetSlots.length);
    }
    const displayPrice = totalBasePrice + markupAmount;

    const [feeRows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('service_fee', 'service_fee_type')");
    const settingsMap = {};
    feeRows.forEach(row => settingsMap[row.setting_key] = row.setting_value);
    
    const feeValue = parseFloat(settingsMap['service_fee'] || '20');
    const feeType = settingsMap['service_fee_type'] || 'fixed';

    let discountAmount = 0;
    let appliedCoupon = null;

    if (coupon_code) {
      const [coupons] = await pool.query(
        `SELECT * FROM coupons WHERE code = ? AND turf_id = ? AND is_active = TRUE`,
        [coupon_code.toUpperCase(), turf_id]
      );

      if (coupons.length > 0) {
        const coupon = coupons[0];
        const now = new Date();

        if (coupon.expiry_date && new Date(coupon.expiry_date) < now) return res.status(400).json({ error: 'Coupon expired' });
        if (coupon.min_booking_amount && totalBasePrice < parseFloat(coupon.min_booking_amount)) return res.status(400).json({ error: `Min amount ₹${coupon.min_booking_amount} required` });

        if (coupon.discount_type === 'percentage') {
          discountAmount = (totalBasePrice * parseFloat(coupon.discount_value)) / 100;
        } else {
          discountAmount = Math.min(parseFloat(coupon.discount_value), totalBasePrice);
        }
        discountAmount = Math.round(discountAmount * 100) / 100;
        appliedCoupon = coupon;
      } else {
        return res.status(400).json({ error: 'Invalid coupon code' });
      }
    }

    const priceAfterCoupon = totalBasePrice - discountAmount;
    let serviceFee = 0;
    if (feeType === 'percentage') {
      serviceFee = (priceAfterCoupon * feeValue) / 100;
    } else {
      serviceFee = feeValue * targetSlots.length;
    }
    
    const finalAmount = Math.max(0, priceAfterCoupon + serviceFee);

    res.json({
      basePrice: totalBasePrice,
      displayPrice,
      markupAmount,
      discountAmount,
      serviceFee,
      finalAmount,
      coupon: appliedCoupon ? { code: appliedCoupon.code, discount_value: appliedCoupon.discount_value, discount_type: appliedCoupon.discount_type } : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Calculation failed' });
  }
});

// POST /api/bookings/verify — Verify Razorpay payment
router.post('/verify', async (req, res) => {
  try {
    let { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature === razorpay_signature) {
      // Handle array of strings or single string
      const ids = String(booking_id).split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        await pool.query(
          `UPDATE bookings SET payment_id = ?, payment_status = 'success', status = 'confirmed' WHERE id IN (${placeholders})`,
          [razorpay_payment_id, ...ids]
        );

        // Send Confirmation Email
        try {
          const [rows] = await pool.query(
            `SELECT b.*, t.name as turf_name FROM bookings b JOIN turfs t ON b.turf_id = t.id WHERE b.id IN (${placeholders})`,
            [...ids]
          );
          if (rows.length > 0) {
            const b = rows[0]; // just send one email outlining the first slot's turf details
            const allSlots = rows.map(r => r.time_slot).join(', ');
            const msg = `Payment Successful! Your booking for ${b.turf_name} on ${b.booking_date} at ${allSlots} is confirmed. Total Amount: ${rows.reduce((sum, r) => sum + parseFloat(r.amount), 0)}`;
            if (b.customer_email) {
              await sendEmail(b.customer_email, 'Booking Confirmed - BookArena', msg);
            }
          }
        } catch (emailErr) {
          console.error('Email Notification Error:', emailErr.message);
        }
      }

      res.json({ success: true, message: 'Payment verified successfully' });
    } else {
      const ids = String(booking_id).split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      if (ids.length > 0) {
         const placeholders = ids.map(() => '?').join(',');
         await pool.query(
           `UPDATE bookings SET payment_status = 'failed', status = 'cancelled' WHERE id IN (${placeholders})`,
           [...ids]
         );
      }
      res.status(400).json({ success: false, error: 'Payment verification failed' });
    }
  } catch (err) {
    console.error('Error verifying payment:', err);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// GET /api/bookings/:id — Get booking details
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.*, t.name as turf_name, t.location as turf_location
       FROM bookings b
       JOIN turfs t ON b.turf_id = t.id
       WHERE b.id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.json({ booking: rows[0] });
  } catch (err) {
    console.error('Error fetching booking:', err);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// POST /api/bookings/webhook — Razorpay Webhook for async verification
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'bookmyarena_secret';
  const signature = req.headers['x-razorpay-signature'];

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

    if (event.event === 'payment.captured') {
      const { order_id, id: payment_id } = event.payload.payment.entity;

      // Find booking by order_id (Note: We should probably store order_id in bookings table)
      // Check if we already have it
      const [rows] = await pool.query('SELECT id, customer_email, customer_name FROM bookings WHERE payment_id = ? OR id IN (SELECT id FROM bookings WHERE payment_status = "pending" AND amount = ?)', 
        [payment_id, event.payload.payment.entity.amount / 100]);

      // Optimization: In a real app, query by a unique order reference
      // For now, we update if found
      if (rows.length > 0) {
        const booking = rows[0];
        await pool.query(
          "UPDATE bookings SET payment_status = 'success', status = 'confirmed', payment_id = ? WHERE id = ? AND payment_status != 'success'",
          [payment_id, booking.id]
        );
        console.log(`✅ Webhook confirmed booking ${booking.id}`);
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
    // Cancel all pending bookings older than 15 minutes
    const [result] = await pool.query(
      "UPDATE bookings SET status = 'cancelled', payment_status = 'expired' WHERE status = 'pending' AND payment_status = 'pending' AND created_at < NOW() - INTERVAL 15 MINUTE"
    );
    
    res.json({ 
      success: true, 
      message: `Cleaned up ${result.affectedRows} expired pending bookings` 
    });
  } catch (err) {
    console.error('Error cleaning up pending bookings:', err);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

module.exports = router;
