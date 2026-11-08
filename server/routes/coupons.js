const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyOwner } = require('../middleware/auth');

// ═══════════════════════════════════════════════════════════════
// OWNER ROUTES - Coupon Management
// ═══════════════════════════════════════════════════════════════

// Shared coupon creation handler (used by both POST /create and POST /)
const createCouponHandler = async (req, res) => {
  try {
    const {
      code,
      discount_type,
      discount_value,
      expiry_date,
      turf_id,
      max_uses,
      min_booking_amount,
      valid_from,
      valid_until,
      max_discount_cap,
      per_user_limit,
      court_id
    } = req.body;

    // Validate required fields
    if (!code || !discount_type || !discount_value || !turf_id) {
      return res.status(400).json({ error: 'Code, discount type, discount value, and turf ID are required' });
    }

    // Verify owner owns the turf
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [turf_id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    // Validate discount type
    if (!['flat', 'percentage'].includes(discount_type)) {
      return res.status(400).json({ error: 'Discount type must be "flat" or "percentage"' });
    }

    // Validate discount value
    const dv = parseFloat(discount_value);
    if (isNaN(dv) || dv <= 0) {
      return res.status(400).json({ error: 'Discount value must be a positive number' });
    }

    if (discount_type === 'percentage' && (dv < 1 || dv > 100)) {
      return res.status(400).json({ error: 'Percentage discount must be between 1 and 100' });
    }

    // Check if coupon code already exists
    const [existing] = await pool.query('SELECT id FROM coupons WHERE code = ?', [code.toUpperCase()]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'This coupon code already exists' });
    }

    // Normalize dates — convert empty strings to null
    const cleanDate = (d) => {
      if (d === undefined || d === null) return null;
      const s = String(d).trim();
      return s === '' ? null : s.slice(0, 10);
    };

    const validFromValue = cleanDate(valid_from);
    const validUntilValue = cleanDate(valid_until) || cleanDate(expiry_date);
    const expiryDateValue = cleanDate(expiry_date);

    if (validFromValue && isNaN(new Date(validFromValue).getTime())) {
      return res.status(400).json({ error: 'Valid from date is invalid' });
    }
    if (validUntilValue && isNaN(new Date(validUntilValue).getTime())) {
      return res.status(400).json({ error: 'Valid until date is invalid' });
    }
    if (validFromValue && validUntilValue && new Date(validFromValue) > new Date(validUntilValue)) {
      return res.status(400).json({ error: 'Valid until must be after valid from' });
    }

    // Insert coupon
    const [result] = await pool.query(
      `INSERT INTO coupons (
        code, discount_type, discount_value, expiry_date, valid_from, valid_until,
        turf_id, court_id, max_uses, min_booking_amount, max_discount_cap, per_user_limit, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [
        code.toUpperCase(),
        discount_type,
        dv,
        expiryDateValue,
        validFromValue,
        validUntilValue,
        turf_id,
        court_id != null && String(court_id).trim() !== '' ? court_id : null,
        max_uses != null && String(max_uses).trim() !== '' ? parseInt(max_uses, 10) : null,
        min_booking_amount != null && String(min_booking_amount).trim() !== '' ? parseFloat(min_booking_amount) : 0,
        max_discount_cap != null && String(max_discount_cap).trim() !== '' ? (parseFloat(max_discount_cap) || 0) : null,
        per_user_limit != null && String(per_user_limit).trim() !== '' ? (parseInt(per_user_limit, 10) || 0) : null
      ]
    );

    res.json({
      success: true,
      message: 'Coupon created successfully',
      coupon_id: result.insertId
    });
  } catch (err) {
    console.error('Error creating coupon:', err);
    res.status(500).json({ error: 'Failed to create coupon', details: err.message });
  }
};

// POST /api/coupons/create — Owner creates a new coupon
router.post('/create', verifyToken, verifyOwner, createCouponHandler);

// Backward-compatible alias — frontend may POST to /api/coupons directly
router.post('/', verifyToken, verifyOwner, createCouponHandler);

// GET /api/coupons — Get all coupons for owner's turfs
router.get('/', verifyToken, verifyOwner, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, t.name as turf_name 
       FROM coupons c 
       JOIN turfs t ON c.turf_id = t.id 
       WHERE t.owner_id = ? 
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );

    const coupons = rows.map(coupon => ({
      ...coupon,
      is_expired: (coupon.valid_until && new Date(coupon.valid_until) < new Date())
        || (!coupon.valid_until && coupon.expiry_date && new Date(coupon.expiry_date) < new Date()),
      usage_rate: coupon.max_uses ? (coupon.used_count / coupon.max_uses * 100).toFixed(1) : null
    }));

    res.json({ coupons });
  } catch (err) {
    console.error('Error fetching coupons:', err);
    res.status(500).json({ error: 'Failed to fetch coupons' });
  }
});

// PUT /api/coupons/:id — Update a coupon
router.put('/:id', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      discount_type,
      discount_value,
      expiry_date,
      max_uses,
      min_booking_amount,
      is_active,
      valid_from,
      valid_until,
      max_discount_cap,
      per_user_limit,
      court_id
    } = req.body;

    // Verify owner owns the coupon's turf
    const [couponCheck] = await pool.query(
      `SELECT c.turf_id, t.owner_id FROM coupons c 
       JOIN turfs t ON c.turf_id = t.id 
       WHERE c.id = ?`,
      [id]
    );

    if (couponCheck.length === 0 || couponCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this coupon' });
    }

    const updates = [];
    const params = [];

    if (discount_type !== undefined) {
      if (!['flat', 'percentage'].includes(discount_type)) {
        return res.status(400).json({ error: 'Discount type must be "flat" or "percentage"' });
      }
      updates.push('discount_type = ?');
      params.push(discount_type);
    }

    if (discount_value !== undefined) {
      const dv = parseFloat(discount_value);
      if (isNaN(dv) || dv <= 0) {
        return res.status(400).json({ error: 'Discount value must be a positive number' });
      }
      if (discount_type === 'percentage' && (dv < 1 || dv > 100)) {
        return res.status(400).json({ error: 'Percentage discount must be between 1 and 100' });
      }
      updates.push('discount_value = ?');
      params.push(dv);
    }

    if (expiry_date !== undefined) {
      updates.push('expiry_date = ?');
      params.push(expiry_date || null);
    }

    if (valid_from !== undefined) {
      if (valid_from) {
        const d = new Date(valid_from);
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'Valid from date is invalid' });
      }
      updates.push('valid_from = ?');
      params.push(valid_from || null);
    }

    if (valid_until !== undefined) {
      if (valid_until) {
        const d = new Date(valid_until);
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'Valid until date is invalid' });
      }
      updates.push('valid_until = ?');
      params.push(valid_until || null);
    }

    if (max_discount_cap !== undefined) {
      updates.push('max_discount_cap = ?');
      params.push(max_discount_cap != null && String(max_discount_cap).trim() !== '' ? (parseFloat(max_discount_cap) || 0) : null);
    }

    if (per_user_limit !== undefined) {
      updates.push('per_user_limit = ?');
      params.push(per_user_limit != null && String(per_user_limit).trim() !== '' ? (parseInt(per_user_limit, 10) || 0) : null);
    }

    if (court_id !== undefined) {
      updates.push('court_id = ?');
      params.push(court_id || null);
    }

    if (max_uses !== undefined) {
      updates.push('max_uses = ?');
      params.push(max_uses || null);
    }

    if (min_booking_amount !== undefined) {
      updates.push('min_booking_amount = ?');
      params.push(parseFloat(min_booking_amount) || 0);
    }

    if (is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(is_active ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(id);
    await pool.query(
      `UPDATE coupons SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    res.json({ success: true, message: 'Coupon updated successfully' });
  } catch (err) {
    console.error('Error updating coupon:', err);
    res.status(500).json({ error: 'Failed to update coupon' });
  }
});

// DELETE /api/coupons/:id — Delete a coupon
router.delete('/:id', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { id } = req.params;

    const [couponCheck] = await pool.query(
      `SELECT c.turf_id, t.owner_id FROM coupons c 
       JOIN turfs t ON c.turf_id = t.id 
       WHERE c.id = ?`,
      [id]
    );

    if (couponCheck.length === 0 || couponCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this coupon' });
    }

    await pool.query('DELETE FROM coupons WHERE id = ?', [id]);

    res.json({ success: true, message: 'Coupon deleted successfully' });
  } catch (err) {
    console.error('Error deleting coupon:', err);
    res.status(500).json({ error: 'Failed to delete coupon' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PUBLIC ROUTES - Coupon Suggestions & Validation
// ═══════════════════════════════════════════════════════════════

// GET /api/coupons/turf/:turfId — Active coupons for a turf (owner + admin)
// Used by the suggestion list shown at checkout
router.get('/turf/:turfId', async (req, res) => {
  try {
    const { turfId } = req.params;

    // Get turf sport type for admin coupon sport-filtering
    const [turfRows] = await pool.query('SELECT sport_type FROM turfs WHERE id = ?', [turfId]);
    const turfSportType = turfRows.length > 0 ? (turfRows[0].sport_type || '').toLowerCase() : '';

    // Owner coupons for this specific turf
    const [ownerRows] = await pool.query(
      `SELECT code, discount_type, discount_value, min_booking_amount, max_discount_cap, NULL as label, 'owner' as source,
              valid_from, COALESCE(valid_until, expiry_date) AS valid_until, court_id
       FROM coupons
       WHERE turf_id = ? AND is_active = TRUE
         AND (valid_from IS NULL OR valid_from <= CURDATE())
         AND (
           (valid_until IS NULL AND (expiry_date IS NULL OR expiry_date >= CURDATE()))
           OR (valid_until IS NOT NULL AND valid_until >= CURDATE())
         )
         AND (max_uses IS NULL OR used_count < max_uses)
       ORDER BY created_at DESC`,
      [turfId]
    );

    // Admin coupons applicable to all turfs or this sport
    let adminRows = [];
    try {
      const [aRows] = await pool.query(
        `SELECT code, discount_type, discount_value, min_booking_amount, max_discount_cap, label, 'admin' as source,
                valid_from, valid_until, applicable_sport, NULL AS court_id
         FROM admin_coupons
         WHERE is_active = TRUE
           AND (valid_from IS NULL OR valid_from <= CURDATE())
           AND (valid_until IS NULL OR valid_until >= CURDATE())
           AND (max_uses IS NULL OR used_count < max_uses)
           AND (applicable_sport = 'all' OR applicable_sport = ?)
         ORDER BY created_at DESC`,
        [turfSportType]
      );
      adminRows = aRows;
    } catch (adminErr) {
      // admin_coupons table may not exist on older deployments — skip gracefully
      console.warn('Admin coupons fetch skipped:', adminErr.message);
    }

    const dateOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    const formatCoupon = (coupon) => {
      const isPct = String(coupon.discount_type || '').toLowerCase().startsWith('percent');
      const value = parseFloat(coupon.discount_value);
      const min = parseFloat(coupon.min_booking_amount || 0);
      const cap = coupon.max_discount_cap ? parseFloat(coupon.max_discount_cap) : null;
      return {
        code: coupon.code,
        discountType: coupon.discount_type,
        discountValue: value,
        // snake_case twins: the mobile app has always read these names
        discount_type: coupon.discount_type,
        discount_value: value,
        isPercentage: isPct,
        minBookingAmount: min,
        maxDiscountCap: cap,
        validFrom: dateOnly(coupon.valid_from),
        validUntil: dateOnly(coupon.valid_until),
        courtId: coupon.court_id || null,
        applicableSport: coupon.applicable_sport && coupon.applicable_sport !== 'all' ? coupon.applicable_sport : null,
        label: coupon.label || null,
        source: coupon.source,
        displayText: isPct ? `${value}% OFF` : `₹${value} OFF`
      };
    };

    const coupons = [
      ...ownerRows.map(formatCoupon),
      ...adminRows.map(formatCoupon)
    ];

    res.json({ coupons });
  } catch (err) {
    console.error('Error fetching turf coupons:', err);
    res.status(500).json({ error: 'Failed to fetch coupons' });
  }
});

// POST /api/coupons/validate — Validate a coupon code
router.post('/validate', async (req, res) => {
  try {
    const { code, turf_id, booking_amount } = req.body;

    if (!code || !turf_id) {
      return res.status(400).json({ error: 'Coupon code and turf ID are required' });
    }

    // Find the coupon
    const [coupons] = await pool.query(
      `SELECT c.*, t.price_per_hour as base_price
       FROM coupons c 
       JOIN turfs t ON c.turf_id = t.id 
       WHERE c.code = ? AND c.turf_id = ? AND c.is_active = TRUE`,
      [code.toUpperCase(), turf_id]
    );

    if (coupons.length === 0) {
      return res.status(404).json({ error: 'Invalid coupon code' });
    }

    const coupon = coupons[0];

    if (coupon.expiry_date && new Date(coupon.expiry_date) < new Date()) {
      return res.status(400).json({ error: 'This coupon has expired' });
    }

    if (coupon.max_uses && coupon.used_count >= coupon.max_uses) {
      return res.status(400).json({ error: 'This coupon has reached its usage limit' });
    }

    const bookingAmt = parseFloat(booking_amount) || 0;
    if (coupon.min_booking_amount > 0 && bookingAmt < coupon.min_booking_amount) {
      return res.status(400).json({
        error: `Minimum booking amount of ₹${coupon.min_booking_amount} required`,
        minAmount: parseFloat(coupon.min_booking_amount)
      });
    }

    let discountAmount = 0;
    if (coupon.discount_type === 'flat') {
      discountAmount = Math.min(parseFloat(coupon.discount_value), bookingAmt);
    } else {
      discountAmount = (bookingAmt * parseFloat(coupon.discount_value)) / 100;
      if (coupon.max_discount_cap) {
        discountAmount = Math.min(discountAmount, parseFloat(coupon.max_discount_cap));
      }
    }

    discountAmount = Math.round(discountAmount * 100) / 100;
    const finalAmount = Math.max(0, bookingAmt - discountAmount);

    res.json({
      valid: true,
      coupon: {
        code: coupon.code,
        discountType: coupon.discount_type,
        discountValue: parseFloat(coupon.discount_value)
      },
      originalAmount: bookingAmt,
      discountAmount,
      finalAmount
    });
  } catch (err) {
    console.error('Error validating coupon:', err);
    res.status(500).json({ error: 'Failed to validate coupon' });
  }
});

module.exports = router;
