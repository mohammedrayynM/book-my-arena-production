const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyOwner } = require('../middleware/auth');

// ═══════════════════════════════════════════════════════════════
// OWNER ROUTES - Coupon Management
// ═══════════════════════════════════════════════════════════════

// POST /api/coupons/create — Owner creates a new coupon
router.post('/create', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { code, discount_type, discount_value, expiry_date, turf_id, max_uses, min_booking_amount } = req.body;

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

    // For percentage, ensure it's between 1-100
    if (discount_type === 'percentage' && (dv < 1 || dv > 100)) {
      return res.status(400).json({ error: 'Percentage discount must be between 1 and 100' });
    }

    // Check if coupon code already exists
    const [existing] = await pool.query('SELECT id FROM coupons WHERE code = ?', [code.toUpperCase()]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'This coupon code already exists' });
    }

    // Validate expiry date if provided
    let expiryDateValue = expiry_date || null;
    if (expiryDateValue) {
      const expiryDate = new Date(expiryDateValue);
      if (isNaN(expiryDate.getTime()) || expiryDate < new Date()) {
        return res.status(400).json({ error: 'Expiry date must be a valid future date' });
      }
    }

    // Insert coupon
    const [result] = await pool.query(
      `INSERT INTO coupons (code, discount_type, discount_value, expiry_date, turf_id, max_uses, min_booking_amount, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [code.toUpperCase(), discount_type, dv, expiryDateValue, turf_id, max_uses || null, min_booking_amount || 0]
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
});

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
      is_expired: coupon.expiry_date && new Date(coupon.expiry_date) < new Date(),
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
    const { discount_type, discount_value, expiry_date, max_uses, min_booking_amount, is_active } = req.body;

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

    // Build update query dynamically
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
      if (expiry_date) {
        const expiryDate = new Date(expiry_date);
        if (isNaN(expiryDate.getTime()) || expiryDate < new Date()) {
          return res.status(400).json({ error: 'Expiry date must be a valid future date' });
        }
      }
      updates.push('expiry_date = ?');
      params.push(expiry_date || null);
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

    await pool.query('DELETE FROM coupons WHERE id = ?', [id]);

    res.json({ success: true, message: 'Coupon deleted successfully' });
  } catch (err) {
    console.error('Error deleting coupon:', err);
    res.status(500).json({ error: 'Failed to delete coupon' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PUBLIC ROUTES - Coupon Validation & Display
// ═══════════════════════════════════════════════════════════════

// GET /api/coupons/turf/:turfId — Get active coupons for a turf (for display)
router.get('/turf/:turfId', async (req, res) => {
  try {
    const { turfId } = req.params;

    const [rows] = await pool.query(
      `SELECT code, discount_type, discount_value, expiry_date, min_booking_amount 
       FROM coupons 
       WHERE turf_id = ? AND is_active = TRUE 
       AND (expiry_date IS NULL OR expiry_date >= CURDATE())
       AND (max_uses IS NULL OR used_count < max_uses)
       ORDER BY created_at DESC`,
      [turfId]
    );

    const coupons = rows.map(coupon => ({
      code: coupon.code,
      discountType: coupon.discount_type,
      discountValue: parseFloat(coupon.discount_value),
      expiryDate: coupon.expiry_date,
      minBookingAmount: parseFloat(coupon.min_booking_amount),
      displayText: coupon.discount_type === 'flat'
        ? `Get ₹${coupon.discountValue} OFF`
        : `Get ${coupon.discountValue}% OFF`
    }));

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

    // Check if expired
    if (coupon.expiry_date && new Date(coupon.expiry_date) < new Date()) {
      return res.status(400).json({ error: 'This coupon has expired' });
    }

    // Check max uses
    if (coupon.max_uses && coupon.used_count >= coupon.max_uses) {
      return res.status(400).json({ error: 'This coupon has reached its usage limit' });
    }

    // Check minimum booking amount
    const bookingAmt = parseFloat(booking_amount) || 0;
    if (coupon.min_booking_amount > 0 && bookingAmt < coupon.min_booking_amount) {
      return res.status(400).json({ 
        error: `Minimum booking amount of ₹${coupon.min_booking_amount} required`,
        minAmount: parseFloat(coupon.min_booking_amount)
      });
    }

    // Calculate discount
    let discountAmount = 0;
    if (coupon.discount_type === 'flat') {
      discountAmount = Math.min(parseFloat(coupon.discount_value), bookingAmt);
    } else {
      discountAmount = (bookingAmt * parseFloat(coupon.discount_value)) / 100;
    }

    // Round to 2 decimal places
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
      discountAmount: discountAmount,
      finalAmount: finalAmount
    });
  } catch (err) {
    console.error('Error validating coupon:', err);
    res.status(500).json({ error: 'Failed to validate coupon' });
  }
});

module.exports = router;