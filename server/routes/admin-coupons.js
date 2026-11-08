const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Ensure admin coupons tables exist (idempotent, safe in production too).
async function ensureAdminCouponsTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_coupons (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        label VARCHAR(120) DEFAULT NULL,
        discount_type ENUM('flat', 'percentage') NOT NULL,
        discount_value DECIMAL(10,2) NOT NULL,
        min_booking_amount DECIMAL(10,2) DEFAULT 0,
        max_discount_cap DECIMAL(10,2) DEFAULT NULL,
        valid_from DATE DEFAULT NULL,
        valid_until DATE DEFAULT NULL,
        applicable_sport VARCHAR(100) DEFAULT 'all',
        per_user_limit INT DEFAULT NULL,
        max_uses INT DEFAULT NULL,
        used_count INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_admin_coupons_code (code),
        INDEX idx_admin_coupons_active (is_active),
        INDEX idx_admin_coupons_dates (valid_from, valid_until)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_coupon_usages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        coupon_id INT NOT NULL,
        booking_id INT NOT NULL,
        user_id INT DEFAULT NULL,
        customer_email VARCHAR(200),
        customer_phone VARCHAR(20),
        discount_amount DECIMAL(10,2) NOT NULL,
        used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (coupon_id) REFERENCES admin_coupons(id) ON DELETE CASCADE,
        UNIQUE KEY unique_booking_admin_coupon (booking_id, coupon_id),
        INDEX idx_admin_coupon_usages_user_id (user_id)
      )
    `);
  } catch (e) {
    console.error('⚠️ Failed to ensure admin coupon tables:', e.message);
  }
}

ensureAdminCouponsTables();

// GET /api/admin/coupons — list all admin coupons
router.get('/', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM admin_coupons ORDER BY created_at DESC`
    );
    const coupons = rows.map(c => ({
      ...c,
      is_expired: (c.valid_until && new Date(c.valid_until) < new Date()) ? 1 : 0
    }));
    res.json({ coupons });
  } catch (err) {
    console.error('Admin coupons fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch admin coupons' });
  }
});

// POST /api/admin/coupons — create admin coupon
router.post('/', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim().toUpperCase();
    const label = String(req.body?.label || '').trim() || null;
    const discount_type = String(req.body?.discount_type || '').trim();
    const discount_value = parseFloat(req.body?.discount_value);
    const min_booking_amount = parseFloat(req.body?.min_booking_amount || 0) || 0;
    const max_discount_cap = req.body?.max_discount_cap != null && String(req.body.max_discount_cap).trim() !== ''
      ? (parseFloat(req.body.max_discount_cap) || 0)
      : null;
    const valid_from = req.body?.valid_from ? String(req.body.valid_from).slice(0, 10) : null;
    const valid_until = req.body?.valid_until ? String(req.body.valid_until).slice(0, 10) : null;
    const applicable_sport = String(req.body?.applicable_sport || 'all').trim().toLowerCase();
    const per_user_limit = req.body?.per_user_limit != null && String(req.body.per_user_limit).trim() !== ''
      ? (parseInt(req.body.per_user_limit, 10) || 0)
      : null;
    const max_uses = req.body?.max_uses != null && String(req.body.max_uses).trim() !== ''
      ? (parseInt(req.body.max_uses, 10) || 0)
      : null;

    if (!code) return res.status(400).json({ error: 'Coupon code is required' });
    if (!['flat', 'percentage'].includes(discount_type)) return res.status(400).json({ error: 'Discount type must be "flat" or "percentage"' });
    if (!Number.isFinite(discount_value) || discount_value <= 0) return res.status(400).json({ error: 'Discount value must be a positive number' });
    if (discount_type === 'percentage' && (discount_value < 1 || discount_value > 100)) return res.status(400).json({ error: 'Percentage discount must be between 1 and 100' });
    if (max_discount_cap != null && discount_type !== 'percentage') return res.status(400).json({ error: 'Max discount cap applies only to percentage coupons' });

    // Date validation
    if (valid_from && isNaN(new Date(valid_from).getTime())) return res.status(400).json({ error: 'Valid from date is invalid' });
    if (valid_until && isNaN(new Date(valid_until).getTime())) return res.status(400).json({ error: 'Valid until date is invalid' });
    if (valid_from && valid_until && new Date(valid_from) > new Date(valid_until)) return res.status(400).json({ error: 'Valid until must be after valid from' });

    const [existing] = await pool.query('SELECT id FROM admin_coupons WHERE code = ?', [code]);
    if (existing.length > 0) return res.status(409).json({ error: 'This coupon code already exists' });

    const [result] = await pool.query(
      `INSERT INTO admin_coupons
        (code, label, discount_type, discount_value, min_booking_amount, max_discount_cap, valid_from, valid_until, applicable_sport, per_user_limit, max_uses, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [code, label, discount_type, discount_value, min_booking_amount, max_discount_cap, valid_from, valid_until, applicable_sport || 'all', per_user_limit, max_uses]
    );

    res.json({ success: true, coupon_id: result.insertId });
  } catch (err) {
    console.error('Admin coupon create error:', err);
    res.status(500).json({ error: 'Failed to create admin coupon', details: err.message });
  }
});

// PUT /api/admin/coupons/:id — update (activate/deactivate + edit)
router.put('/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid coupon id' });

    const updates = [];
    const params = [];

    const push = (sql, val) => { updates.push(sql); params.push(val); };

    if (req.body?.label !== undefined) push('label = ?', String(req.body.label || '').trim() || null);
    if (req.body?.discount_type !== undefined) {
      const dt = String(req.body.discount_type || '').trim();
      if (!['flat', 'percentage'].includes(dt)) return res.status(400).json({ error: 'Discount type must be "flat" or "percentage"' });
      push('discount_type = ?', dt);
    }
    if (req.body?.discount_value !== undefined) {
      const dv = parseFloat(req.body.discount_value);
      if (!Number.isFinite(dv) || dv <= 0) return res.status(400).json({ error: 'Discount value must be a positive number' });
      push('discount_value = ?', dv);
    }
    if (req.body?.min_booking_amount !== undefined) push('min_booking_amount = ?', parseFloat(req.body.min_booking_amount) || 0);
    if (req.body?.max_discount_cap !== undefined) {
      const v = req.body.max_discount_cap;
      push('max_discount_cap = ?', v != null && String(v).trim() !== '' ? (parseFloat(v) || 0) : null);
    }
    if (req.body?.valid_from !== undefined) push('valid_from = ?', req.body.valid_from ? String(req.body.valid_from).slice(0, 10) : null);
    if (req.body?.valid_until !== undefined) push('valid_until = ?', req.body.valid_until ? String(req.body.valid_until).slice(0, 10) : null);
    if (req.body?.applicable_sport !== undefined) push('applicable_sport = ?', String(req.body.applicable_sport || 'all').trim().toLowerCase());
    if (req.body?.per_user_limit !== undefined) {
      const v = req.body.per_user_limit;
      push('per_user_limit = ?', v != null && String(v).trim() !== '' ? (parseInt(v, 10) || 0) : null);
    }
    if (req.body?.max_uses !== undefined) {
      const v = req.body.max_uses;
      push('max_uses = ?', v != null && String(v).trim() !== '' ? (parseInt(v, 10) || 0) : null);
    }
    if (req.body?.is_active !== undefined) push('is_active = ?', req.body.is_active ? 1 : 0);

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(id);

    await pool.query(`UPDATE admin_coupons SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin coupon update error:', err);
    res.status(500).json({ error: 'Failed to update admin coupon' });
  }
});

// DELETE /api/admin/coupons/:id
router.delete('/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid coupon id' });
    await pool.query('DELETE FROM admin_coupons WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin coupon delete error:', err);
    res.status(500).json({ error: 'Failed to delete admin coupon' });
  }
});

module.exports = router;

