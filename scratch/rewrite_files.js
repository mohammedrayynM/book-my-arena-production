const fs = require('fs');
const path = require('path');

const pagePath = path.join(__dirname, '../client/app/turfs/[id]/page.js');
let pageContent = fs.readFileSync(pagePath, 'utf8');

// 1. Array state
pageContent = pageContent.replace(
  "const [selectedSlot, setSelectedSlot] = useState('');",
  "const [selectedSlots, setSelectedSlots] = useState([]);"
);

// 2. update setSelectedSlot calls
pageContent = pageContent.replace(
  "setSelectedSlot('');",
  "setSelectedSlots([]);"
);

// 3. calculatePricing signature
pageContent = pageContent.replace(
  "async function calculatePricing(currentSlot, currentCoupon) {",
  "async function calculatePricing(currentSlots, currentCoupon) {"
);
pageContent = pageContent.replace(
  "if (!currentSlot || !selectedDate) return;",
  "if (!currentSlots || currentSlots.length === 0 || !selectedDate) return;"
);
pageContent = pageContent.replace(
  "time_slot: currentSlot,",
  "time_slots: currentSlots,"
);

// 4. apply coupon
pageContent = pageContent.replace(
  "if (!selectedSlot) {",
  "if (selectedSlots.length === 0) {"
);
pageContent = pageContent.replace(
  "calculatePricing(selectedSlot, couponCode.trim());",
  "calculatePricing(selectedSlots, couponCode.trim());"
);
pageContent = pageContent.replace(
  "calculatePricing(selectedSlot, null);",
  "calculatePricing(selectedSlots, null);"
);

// 5. handleBooking check
pageContent = pageContent.replace(
  "if (!selectedSlot || !bookingData.name || !bookingData.phone) return;",
  "if (selectedSlots.length === 0 || !bookingData.name || !bookingData.phone) return;"
);
pageContent = pageContent.replace(
  "time_slot: selectedSlot,",
  "time_slots: selectedSlots,"
);

// 6. email notification slot format
pageContent = pageContent.replace(
  "time_slot: selectedSlot,",
  "time_slot: selectedSlots.join(', '),"
);

// 7. rendering capsules
const oldCapsule = `                         className={\`slot-capsule \${
                           slot.status === 'available'
                             ? selectedSlot === slot.time ? 'available selected' : 'available'
                             : slot.status === 'booked' ? 'booked' : 'blocked'
                         }\`}
                         onClick={() => {
                           if (slot.status === 'available') {
                             setSelectedSlot(slot.time);
                             setSelectedSlotPrice(slot.price);
                             setShowBookingForm(true);
                             calculatePricing(slot.time, appliedCoupon?.code);
                           }
                         }}`;

const newCapsule = `                         className={\`slot-capsule \${
                           slot.status === 'available'
                             ? selectedSlots.includes(slot.time) ? 'available selected' : 'available'
                             : slot.status === 'booked' ? 'booked' : 'blocked'
                         }\`}
                         onClick={() => {
                           if (slot.status === 'available') {
                             let newSlots = [...selectedSlots];
                             if (newSlots.includes(slot.time)) {
                               newSlots = newSlots.filter(t => t !== slot.time);
                             } else {
                               newSlots.push(slot.time);
                             }
                             setSelectedSlots(newSlots);
                             if (newSlots.length > 0) {
                               setShowBookingForm(true);
                               calculatePricing(newSlots, appliedCoupon?.code);
                             } else {
                               setShowBookingForm(false);
                               setPricingBreakdown(null);
                             }
                           }
                         }}`;

pageContent = pageContent.replace(oldCapsule, newCapsule);

// 8. Auto-trigger coupon calc
const oldAutoCoupon = `                            apiPost('/bookings/calculate-price', {
                              turf_id: parseInt(params.id),
                              booking_date: selectedDate,
                              time_slot: selectedSlot,
                              coupon_code: coupon.code
                            }).then(data => {`;

const newAutoCoupon = `                            apiPost('/bookings/calculate-price', {
                              turf_id: parseInt(params.id),
                              booking_date: selectedDate,
                              time_slots: selectedSlots,
                              coupon_code: coupon.code
                            }).then(data => {`;

pageContent = pageContent.replace(oldAutoCoupon, newAutoCoupon);

// 9. Right side displays
pageContent = pageContent.replace(
  "showBookingForm && selectedSlot",
  "showBookingForm && selectedSlots.length > 0"
);
pageContent = pageContent.replace(
  "showBookingForm && selectedSlot",
  "showBookingForm && selectedSlots.length > 0"
);
pageContent = pageContent.replace(
  "{selectedSlot || 'Select a slot'}",
  "{selectedSlots.length > 0 ? selectedSlots.join(', ') : 'Select slots'}"
);
pageContent = pageContent.replace(
  "selectedSlot ? 'var(--emerald-400)'",
  "selectedSlots.length > 0 ? 'var(--emerald-400)'"
);

fs.writeFileSync(pagePath, pageContent, 'utf8');
console.log('client modified successfully');


// Now Server Side:
const backendPath = path.join(__dirname, '../server/routes/bookings.js');
let backendContent = fs.readFileSync(backendPath, 'utf8');

// Replace standard booking
const oldBookingStr = `// POST /api/bookings — Create a new booking
router.post('/', async (req, res) => {
  try {
    const { turf_id, customer_name, customer_phone, customer_email, booking_date, time_slot, coupon_code, user_id } = req.body;

    // Validate required fields
    if (!turf_id || !customer_name || !customer_phone || !customer_email || !booking_date || !time_slot) {
      return res.status(400).json({ error: 'All fields are required, including email' });
    }

    // Check if slot is already booked - only count confirmed/successful payments
    const [existingBooking] = await pool.query(
      'SELECT id FROM bookings WHERE turf_id = ? AND booking_date = ? AND time_slot = ? AND status != ? AND payment_status = ?',
      [turf_id, booking_date, time_slot, 'cancelled', 'success']
    );
    if (existingBooking.length > 0) {
      return res.status(409).json({ error: 'This slot is already booked' });
    }

    // Check if slot is blocked
    const [blockedSlot] = await pool.query(
      'SELECT id FROM blocked_slots WHERE turf_id = ? AND block_date = ? AND time_slot = ?',
      [turf_id, booking_date, time_slot]
    );
    if (blockedSlot.length > 0) {
      return res.status(409).json({ error: 'This slot is blocked by the owner' });
    }

    // Get turf details
    const [turfRows] = await pool.query('SELECT name, price_per_hour, markup_type, markup_value FROM turfs WHERE id = ?', [turf_id]);
    if (turfRows.length === 0) {
      console.log('❌ Booking fail: Turf not found', turf_id);
      return res.status(404).json({ error: 'Turf not found' });
    }
    const turf = turfRows[0];
    const basePriceFromTurf = parseFloat(turf.price_per_hour);
    
    // Check for special pricing for this date and time slot
    const dateObj = new Date(booking_date + 'T00:00:00');
    const dayOfWeek = dateObj.getDay(); // 0=Sunday, 1=Monday, etc.

    const [specialPricing] = await pool.query(
      \`SELECT special_price FROM special_pricing 
       WHERE turf_id = ? AND is_active = TRUE 
       AND ((specific_date = ? AND time_slot = ?) OR (specific_date IS NULL AND day_of_week = ? AND time_slot = ?))
       ORDER BY specific_date DESC LIMIT 1\`,
      [turf_id, booking_date, time_slot, dayOfWeek, time_slot]
    );

    // BASE_PRICE is the price the owner set (either default or special)
    const basePrice = specialPricing.length > 0 ? parseFloat(specialPricing[0].special_price) : basePriceFromTurf;

    // Calculate Markup (Minimum 200 for display psychology as per user request)
    let markupAmount = 0;
    const ownerMarkupValue = parseFloat(turf.markup_value || 0);
    
    if (turf.markup_type === 'percentage') {
      markupAmount = (basePrice * ownerMarkupValue) / 100;
      if (markupAmount < 200) markupAmount = 200;
    } else {
      markupAmount = Math.max(200, ownerMarkupValue);
    }
    const displayPrice = basePrice + markupAmount;

    // Get service fee settings
    const [feeRows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('service_fee', 'service_fee_type')");
    const settingsMap = {};
    feeRows.forEach(row => settingsMap[row.setting_key] = row.setting_value);
    
    const feeValue = parseFloat(settingsMap['service_fee'] || '20');
    const feeType = settingsMap['service_fee_type'] || 'fixed';

    console.log(\`🏟️ Pricing info for \${turf.name}: Base=\${basePrice}, Markup=\${markupAmount}, Fee=\${feeValue} (\${feeType})\`);

    // Handle coupon if provided
    let discountAmount = 0;
    let appliedCouponCode = null;

    if (coupon_code) {
      const [coupons] = await pool.query(
        \`SELECT c.* FROM coupons c 
         WHERE c.code = ? AND c.turf_id = ? AND c.is_active = TRUE\`,
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
        if (coupon.min_booking_amount && basePrice < parseFloat(coupon.min_booking_amount)) {
          return res.status(400).json({ error: \`Minimum booking amount for this coupon is ₹\${coupon.min_booking_amount}\` });
        }

        // Calculate discount (on basePrice)
        if (coupon.discount_type === 'percentage') {
          discountAmount = (basePrice * parseFloat(coupon.discount_value)) / 100;
        } else {
          discountAmount = Math.min(parseFloat(coupon.discount_value), basePrice);
        }
        
        discountAmount = Math.round(discountAmount * 100) / 100;
        appliedCouponCode = coupon.code;
        console.log(\`🎟️ Coupon applied: \${coupon.code} - Discount: ₹\${discountAmount}\`);
      } else {
        return res.status(400).json({ error: 'Invalid coupon code for this turf' });
      }
    }

    // FINAL CALCULATION
    const priceAfterCoupon = basePrice - discountAmount;
    
    let serviceFee = 0;
    if (feeType === 'percentage') {
      serviceFee = (priceAfterCoupon * feeValue) / 100;
    } else {
      serviceFee = feeValue;
    }
    
    const finalAmount = Math.max(0, priceAfterCoupon + serviceFee);

    // Create Razorpay order
    let order_id = null;
    try {
      const order = await razorpay.orders.create({
        amount: Math.round(finalAmount * 100), // Amount in paisa
        currency: 'INR',
        receipt: \`booking_\${Date.now()}\`
      });
      order_id = order.id;
    } catch (e) {
      console.error('🔥 Razorpay Order Creation Failed:', e.message);
      return res.status(500).json({ error: 'Payment gateway error: ' + e.message });
    }

    // Insert booking
    try {
      console.log('📝 Saving booking to DB...');
      const [result] = await pool.query(
        \`INSERT INTO bookings (
          turf_id, customer_name, customer_phone, customer_email, 
          booking_date, time_slot, amount, original_price, 
          discount_amount, markup_amount, service_fee, 
          coupon_code, payment_status, status, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
        [
          turf_id, customer_name, customer_phone, customer_email || '', 
          booking_date, time_slot, finalAmount, basePrice, 
          discountAmount, markupAmount, serviceFee, 
          appliedCouponCode, 'pending', 'pending', user_id || null
        ]
      );
      
      const bookingId = result.insertId;
      console.log('✅ Booking successfully saved! ID:', bookingId);

      // Track coupon usage if coupon was applied
      if (appliedCouponCode) {
        try {
          const [couponData] = await pool.query(
            'SELECT id FROM coupons WHERE code = ?',
            [appliedCouponCode]
          );
          if (couponData.length > 0) {
            await pool.query(
              \`INSERT INTO coupon_usages (coupon_id, booking_id, customer_email, customer_phone, discount_amount)
               VALUES (?, ?, ?, ?, ?)\`,
              [couponData[0].id, bookingId, customer_email || '', customer_phone, discountAmount]
            );
            // Increment coupon usage count
            await pool.query(
              'UPDATE coupons SET used_count = used_count + 1 WHERE id = ?',
              [couponData[0].id]
            );
          }
        } catch (couponErr) {
          console.warn('⚠️ Failed to track coupon usage:', couponErr.message);
        }
      }

      res.json({
        booking_id: bookingId,
        order_id: order_id,
        amount: finalAmount,
        basePrice: basePrice,
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
});`;

const newBookingStr = `// POST /api/bookings — Create a new booking
router.post('/', async (req, res) => {
  try {
    const { turf_id, customer_name, customer_phone, customer_email, booking_date, time_slot, time_slots, coupon_code, user_id } = req.body;
    let targetSlots = time_slots || (time_slot ? [time_slot] : []);

    // Validate required fields
    if (!turf_id || !customer_name || !customer_phone || !customer_email || !booking_date || targetSlots.length === 0) {
      return res.status(400).json({ error: 'All fields are required, including email' });
    }

    for (const ts of targetSlots) {
      // Check if slot is already booked
      const [existingBooking] = await pool.query(
        'SELECT id FROM bookings WHERE turf_id = ? AND booking_date = ? AND time_slot = ? AND status != ? AND payment_status = ?',
        [turf_id, booking_date, ts, 'cancelled', 'success']
      );
      if (existingBooking.length > 0) return res.status(409).json({ error: \`Slot \${ts} is already booked\` });

      // Check if slot is blocked
      const [blockedSlot] = await pool.query(
        'SELECT id FROM blocked_slots WHERE turf_id = ? AND block_date = ? AND time_slot = ?',
        [turf_id, booking_date, ts]
      );
      if (blockedSlot.length > 0) return res.status(409).json({ error: \`Slot \${ts} is blocked by the owner\` });
    }

    // Get turf details
    const [turfRows] = await pool.query('SELECT name, price_per_hour, markup_type, markup_value FROM turfs WHERE id = ?', [turf_id]);
    if (turfRows.length === 0) return res.status(404).json({ error: 'Turf not found' });
    const turf = turfRows[0];
    const basePriceFromTurf = parseFloat(turf.price_per_hour);
    
    // Check for special pricing for this date and time slot
    const dateObj = new Date(booking_date + 'T00:00:00');
    const dayOfWeek = dateObj.getDay(); 

    let totalBasePrice = 0;
    let slotPrices = {};

    for (const ts of targetSlots) {
      const [specialPricing] = await pool.query(
        \`SELECT special_price FROM special_pricing 
         WHERE turf_id = ? AND is_active = TRUE 
         AND ((specific_date = ? AND time_slot = ?) OR (specific_date IS NULL AND day_of_week = ? AND time_slot = ?))
         ORDER BY specific_date DESC LIMIT 1\`,
        [turf_id, booking_date, ts, dayOfWeek, ts]
      );
      let sPrice = specialPricing.length > 0 ? parseFloat(specialPricing[0].special_price) : basePriceFromTurf;
      totalBasePrice += sPrice;
      slotPrices[ts] = sPrice;
    }

    let totalMarkupAmount = 0;
    const ownerMarkupValue = parseFloat(turf.markup_value || 0);
    if (turf.markup_type === 'percentage') {
      totalMarkupAmount = (totalBasePrice * ownerMarkupValue) / 100;
      if (totalMarkupAmount < (200 * targetSlots.length)) totalMarkupAmount = (200 * targetSlots.length);
    } else {
      totalMarkupAmount = Math.max(200 * targetSlots.length, ownerMarkupValue * targetSlots.length);
    }
    const displayPrice = totalBasePrice + totalMarkupAmount;

    // Get service fee settings
    const [feeRows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('service_fee', 'service_fee_type')");
    const settingsMap = {};
    feeRows.forEach(row => settingsMap[row.setting_key] = row.setting_value);
    
    const feeValue = parseFloat(settingsMap['service_fee'] || '20');
    const feeType = settingsMap['service_fee_type'] || 'fixed';

    let totalDiscountAmount = 0;
    let appliedCouponCode = null;

    if (coupon_code) {
      const [coupons] = await pool.query(
        \`SELECT c.* FROM coupons c WHERE c.code = ? AND c.turf_id = ? AND c.is_active = TRUE\`,
        [coupon_code.toUpperCase(), turf_id]
      );
      if (coupons.length > 0) {
        const coupon = coupons[0];
        const now = new Date();
        if (coupon.expiry_date && new Date(coupon.expiry_date) < now) return res.status(400).json({ error: 'This coupon has expired' });
        if (coupon.min_booking_amount && totalBasePrice < parseFloat(coupon.min_booking_amount)) return res.status(400).json({ error: \`Minimum booking amount for this coupon is ₹\${coupon.min_booking_amount}\` });

        if (coupon.discount_type === 'percentage') {
          totalDiscountAmount = (totalBasePrice * parseFloat(coupon.discount_value)) / 100;
        } else {
          totalDiscountAmount = Math.min(parseFloat(coupon.discount_value), totalBasePrice);
        }
        totalDiscountAmount = Math.round(totalDiscountAmount * 100) / 100;
        appliedCouponCode = coupon.code;
      } else {
        return res.status(400).json({ error: 'Invalid coupon code for this turf' });
      }
    }

    const priceAfterCoupon = totalBasePrice - totalDiscountAmount;
    let totalServiceFee = 0;
    if (feeType === 'percentage') {
      totalServiceFee = (priceAfterCoupon * feeValue) / 100;
    } else {
      totalServiceFee = feeValue * targetSlots.length;
    }
    
    const finalAmount = Math.max(0, priceAfterCoupon + totalServiceFee);

    // Create Razorpay order
    let order_id = null;
    try {
      const order = await razorpay.orders.create({
        amount: Math.round(finalAmount * 100),
        currency: 'INR',
        receipt: \`booking_\${Date.now()}\`
      });
      order_id = order.id;
    } catch (e) {
      return res.status(500).json({ error: 'Payment gateway error: ' + e.message });
    }

    // Insert all bookings! We divide the fees proportionally
    let bookingIds = [];
    try {
      for (let i = 0; i < targetSlots.length; i++) {
         const ts = targetSlots[i];
         const fraction = slotPrices[ts] / totalBasePrice; // roughly divide
         const singleDiscount = fraction * totalDiscountAmount;
         const singleMarkup = fraction * totalMarkupAmount;
         const singleFee = fraction * totalServiceFee;
         const singleFinal = (slotPrices[ts] - singleDiscount) + singleFee;

         const [result] = await pool.query(
           \`INSERT INTO bookings (
             turf_id, customer_name, customer_phone, customer_email, 
             booking_date, time_slot, amount, original_price, 
             discount_amount, markup_amount, service_fee, 
             coupon_code, payment_status, status, user_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
           [
             turf_id, customer_name, customer_phone, customer_email || '', 
             booking_date, ts, singleFinal, slotPrices[ts], 
             singleDiscount, singleMarkup, singleFee, 
             appliedCouponCode, 'pending', 'pending', user_id || null
           ]
         );
         bookingIds.push(result.insertId);
      }
      
      // Store usages for the first booking to avoid duplicates
      if (appliedCouponCode && bookingIds.length > 0) {
        const [couponData] = await pool.query('SELECT id FROM coupons WHERE code = ?', [appliedCouponCode]);
        if (couponData.length > 0) {
          await pool.query(
            \`INSERT INTO coupon_usages (coupon_id, booking_id, customer_email, customer_phone, discount_amount) VALUES (?, ?, ?, ?, ?)\`,
            [couponData[0].id, bookingIds[0], customer_email || '', customer_phone, totalDiscountAmount]
          );
          await pool.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?', [couponData[0].id]);
        }
      }

      res.json({
        booking_id: bookingIds.join(','), // comma separated so frontend logic works mostly seamlessly
        order_id: order_id,
        amount: finalAmount,
        basePrice: totalBasePrice,
        displayPrice: displayPrice,
        markupAmount: totalMarkupAmount,
        discountAmount: totalDiscountAmount,
        serviceFee: totalServiceFee,
        couponCode: appliedCouponCode,
        currency: 'INR',
        key_id: process.env.RAZORPAY_KEY_ID
      });
    } catch (insertErr) {
      res.status(500).json({ error: 'Database failed to save booking: ' + insertErr.message });
    }
  } catch (err) {
    res.status(500).json({ error: 'System error: ' + err.message });
  }
});`;


// Replace calculate-price
const oldCalcStr = `// POST /api/bookings/calculate-price — Calculate price breakdown for real-time UI
router.post('/calculate-price', async (req, res) => {
  try {
    const { turf_id, booking_date, time_slot, coupon_code } = req.body;

    if (!turf_id || !booking_date || !time_slot) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const [turfRows] = await pool.query('SELECT name, price_per_hour, markup_type, markup_value FROM turfs WHERE id = ?', [turf_id]);
    if (turfRows.length === 0) return res.status(404).json({ error: 'Turf not found' });
    
    const turf = turfRows[0];
    const basePriceFromTurf = parseFloat(turf.price_per_hour);
    
    const dateObj = new Date(booking_date + 'T00:00:00');
    const dayOfWeek = dateObj.getDay();

    const [specialPricing] = await pool.query(
      \`SELECT special_price FROM special_pricing 
       WHERE turf_id = ? AND is_active = TRUE 
       AND ((specific_date = ? AND time_slot = ?) OR (specific_date IS NULL AND day_of_week = ? AND time_slot = ?))
       ORDER BY specific_date DESC LIMIT 1\`,
      [turf_id, booking_date, time_slot, dayOfWeek, time_slot]
    );

    const basePrice = specialPricing.length > 0 ? parseFloat(specialPricing[0].special_price) : basePriceFromTurf;

    // Calculate Markup (Minimum 200 for display psychology)
    let markupAmount = 0;
    const ownerMarkupValue = parseFloat(turf.markup_value || 0);
    
    if (turf.markup_type === 'percentage') {
      markupAmount = (basePrice * ownerMarkupValue) / 100;
      if (markupAmount < 200) markupAmount = 200;
    } else {
      markupAmount = Math.max(200, ownerMarkupValue);
    }
    const displayPrice = basePrice + markupAmount;

    const [feeRows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('service_fee', 'service_fee_type')");
    const settingsMap = {};
    feeRows.forEach(row => settingsMap[row.setting_key] = row.setting_value);
    
    const feeValue = parseFloat(settingsMap['service_fee'] || '20');
    const feeType = settingsMap['service_fee_type'] || 'fixed';

    let discountAmount = 0;
    let appliedCoupon = null;

    if (coupon_code) {
      const [coupons] = await pool.query(
        \`SELECT * FROM coupons WHERE code = ? AND turf_id = ? AND is_active = TRUE\`,
        [coupon_code.toUpperCase(), turf_id]
      );

      if (coupons.length > 0) {
        const coupon = coupons[0];
        const now = new Date();

        if (coupon.expiry_date && new Date(coupon.expiry_date) < now) {
          return res.status(400).json({ error: 'Coupon expired' });
        }
        if (coupon.min_booking_amount && basePrice < parseFloat(coupon.min_booking_amount)) {
          return res.status(400).json({ error: \`Min amount ₹\${coupon.min_booking_amount} required\` });
        }

        if (coupon.discount_type === 'percentage') {
          discountAmount = (basePrice * parseFloat(coupon.discount_value)) / 100;
        } else {
          discountAmount = Math.min(parseFloat(coupon.discount_value), basePrice);
        }
        discountAmount = Math.round(discountAmount * 100) / 100;
        appliedCoupon = coupon;
      } else {
        return res.status(400).json({ error: 'Invalid coupon code' });
      }
    }

    const priceAfterCoupon = basePrice - discountAmount;
    let serviceFee = 0;
    if (feeType === 'percentage') {
      serviceFee = (priceAfterCoupon * feeValue) / 100;
    } else {
      serviceFee = feeValue;
    }
    
    const finalAmount = Math.max(0, priceAfterCoupon + serviceFee);

    res.json({
      basePrice,
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
});`;

const newCalcStr = `// POST /api/bookings/calculate-price — Calculate price breakdown for real-time UI
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
        \`SELECT special_price FROM special_pricing 
         WHERE turf_id = ? AND is_active = TRUE 
         AND ((specific_date = ? AND time_slot = ?) OR (specific_date IS NULL AND day_of_week = ? AND time_slot = ?))
         ORDER BY specific_date DESC LIMIT 1\`,
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
        \`SELECT * FROM coupons WHERE code = ? AND turf_id = ? AND is_active = TRUE\`,
        [coupon_code.toUpperCase(), turf_id]
      );

      if (coupons.length > 0) {
        const coupon = coupons[0];
        const now = new Date();

        if (coupon.expiry_date && new Date(coupon.expiry_date) < now) return res.status(400).json({ error: 'Coupon expired' });
        if (coupon.min_booking_amount && totalBasePrice < parseFloat(coupon.min_booking_amount)) return res.status(400).json({ error: \`Min amount ₹\${coupon.min_booking_amount} required\` });

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
});`;


// Add verify modifications
const verifyOld = `// POST /api/bookings/verify — Verify Razorpay payment
router.post('/verify', async (req, res) => {
  try {
    const { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature === razorpay_signature) {
      // Payment verified — update booking to confirmed
      await pool.query(
        "UPDATE bookings SET payment_id = ?, payment_status = 'success', status = 'confirmed' WHERE id = ?",
        [razorpay_payment_id, booking_id]
      );

      // Send Confirmation Email
      try {
        const [rows] = await pool.query(
          \`SELECT b.*, t.name as turf_name FROM bookings b JOIN turfs t ON b.turf_id = t.id WHERE b.id = ?\`,
          [booking_id]
        );
        if (rows.length > 0) {
          const b = rows[0];
          const msg = \`Payment Successful! Your booking for \${b.turf_name} on \${b.booking_date} at \${b.time_slot} is confirmed.\`;
          if (b.customer_email) {
            await sendEmail(b.customer_email, 'Booking Confirmed - BookArena', msg);
          } else {
            console.warn('⚠️ No customer_email found for booking, skipping email notification.');
          }
        }
      } catch (emailErr) {
        console.error('Email Notification Error:', emailErr.message);
      }

      res.json({ success: true, message: 'Payment verified successfully' });
    } else {
      await pool.query(
        "UPDATE bookings SET payment_status = 'failed', status = 'cancelled' WHERE id = ?",
        [booking_id]
      );
      res.status(400).json({ success: false, error: 'Payment verification failed' });
    }
  } catch (err) {
    console.error('Error verifying payment:', err);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});`;

const verifyNew = `// POST /api/bookings/verify — Verify Razorpay payment
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
          \`UPDATE bookings SET payment_id = ?, payment_status = 'success', status = 'confirmed' WHERE id IN (\${placeholders})\`,
          [razorpay_payment_id, ...ids]
        );

        // Send Confirmation Email
        try {
          const [rows] = await pool.query(
            \`SELECT b.*, t.name as turf_name FROM bookings b JOIN turfs t ON b.turf_id = t.id WHERE b.id IN (\${placeholders})\`,
            [...ids]
          );
          if (rows.length > 0) {
            const b = rows[0]; // just send one email outlining the first slot's turf details
            const allSlots = rows.map(r => r.time_slot).join(', ');
            const msg = \`Payment Successful! Your booking for \${b.turf_name} on \${b.booking_date} at \${allSlots} is confirmed. Total Amount: \${rows.reduce((sum, r) => sum + parseFloat(r.amount), 0)}\`;
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
           \`UPDATE bookings SET payment_status = 'failed', status = 'cancelled' WHERE id IN (\${placeholders})\`,
           [...ids]
         );
      }
      res.status(400).json({ success: false, error: 'Payment verification failed' });
    }
  } catch (err) {
    console.error('Error verifying payment:', err);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});`;

backendContent = backendContent.replace(oldBookingStr, newBookingStr);
backendContent = backendContent.replace(oldCalcStr, newCalcStr);
backendContent = backendContent.replace(verifyOld, verifyNew);

fs.writeFileSync(backendPath, backendContent, 'utf8');
console.log('backend modified successfully');
