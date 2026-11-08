const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyOwner } = require('../middleware/auth');

// ─── Idempotent table creation ──────────────────────────────────────────────
async function ensurePromotionsTables() {
    try {
        await pool.query(`
      CREATE TABLE IF NOT EXISTS promotions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        turf_id INT NOT NULL,
        owner_id INT NOT NULL,
        name VARCHAR(120) NOT NULL,
        description TEXT,
        promo_type ENUM('bogo', 'multi_slot', 'flat', 'percentage') NOT NULL DEFAULT 'bogo',
        buy_quantity INT NOT NULL DEFAULT 1,
        free_quantity INT NOT NULL DEFAULT 1,
        discount_type ENUM('flat','percentage') DEFAULT NULL,
        discount_value DECIMAL(10,2) DEFAULT NULL,
        applicable_sport VARCHAR(100) DEFAULT 'all',
        start_date DATE DEFAULT NULL,
        end_date DATE DEFAULT NULL,
        max_uses INT DEFAULT NULL,
        used_count INT DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_promo_turf (turf_id),
        INDEX idx_promo_active (is_active),
        INDEX idx_promo_dates (start_date, end_date)
      )
    `);
        await pool.query(`
      CREATE TABLE IF NOT EXISTS promotion_usages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        promotion_id INT NOT NULL,
        user_id INT DEFAULT NULL,
        booking_id INT DEFAULT NULL,
        used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_promo_usage_promo (promotion_id),
        INDEX idx_promo_usage_user (user_id)
      )
    `);
    } catch (e) {
        console.error('⚠️ Failed to ensure promotions tables:', e.message);
    }
}
ensurePromotionsTables();

// ─── OWNER: Create promotion ────────────────────────────────────────────────
router.post('/', verifyToken, verifyOwner, async (req, res) => {
    try {
        const {
            turf_id, name, description, promo_type = 'bogo',
            buy_quantity = 1, free_quantity = 1,
            discount_type, discount_value,
            applicable_sport = 'all',
            start_date, end_date, max_uses,
        } = req.body;

        if (!turf_id || !name) {
            return res.status(400).json({ error: 'turf_id and name are required' });
        }

        // Verify ownership
        const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [turf_id]);
        if (!turfCheck.length || turfCheck[0].owner_id !== req.user.id) {
            return res.status(403).json({ error: 'You do not own this turf' });
        }

        const cleanDate = (d) => {
            if (!d) return null;
            const s = String(d).slice(0, 10);
            return isNaN(new Date(s).getTime()) ? null : s;
        };

        const [result] = await pool.query(
            `INSERT INTO promotions
        (turf_id, owner_id, name, description, promo_type,
         buy_quantity, free_quantity, discount_type, discount_value,
         applicable_sport, start_date, end_date, max_uses, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
                turf_id, req.user.id, name.trim(), description || null,
                promo_type,
                parseInt(buy_quantity, 10) || 1,
                parseInt(free_quantity, 10) || 1,
                discount_type || null,
                discount_value != null ? parseFloat(discount_value) : null,
                applicable_sport || 'all',
                cleanDate(start_date), cleanDate(end_date),
                max_uses != null ? parseInt(max_uses, 10) : null,
            ]
        );

        res.json({ success: true, promotion_id: result.insertId });
    } catch (err) {
        console.error('create promotion error:', err);
        res.status(500).json({ error: 'Failed to create promotion', details: err.message });
    }
});

// ─── OWNER: List own promotions ─────────────────────────────────────────────
router.get('/mine', verifyToken, verifyOwner, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT p.*, t.name AS turf_name
       FROM promotions p
       JOIN turfs t ON p.turf_id = t.id
       WHERE p.owner_id = ?
       ORDER BY p.created_at DESC`,
            [req.user.id]
        );
        res.json({ promotions: rows });
    } catch (err) {
        console.error('list promotions error:', err);
        res.status(500).json({ error: 'Failed to list promotions' });
    }
});

// ─── OWNER: Update promotion ────────────────────────────────────────────────
router.put('/:id', verifyToken, verifyOwner, async (req, res) => {
    try {
        const { id } = req.params;
        const [[promo]] = await pool.query('SELECT owner_id FROM promotions WHERE id = ?', [id]);
        if (!promo || promo.owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const updates = [];
        const params = [];
        const push = (sql, val) => { updates.push(sql); params.push(val); };

        const fields = [
            ['name', v => String(v).trim()],
            ['description', v => v || null],
            ['promo_type', v => v],
            ['buy_quantity', v => parseInt(v, 10) || 1],
            ['free_quantity', v => parseInt(v, 10) || 1],
            ['discount_type', v => v || null],
            ['discount_value', v => v != null ? parseFloat(v) : null],
            ['applicable_sport', v => v || 'all'],
            ['start_date', v => v ? String(v).slice(0, 10) : null],
            ['end_date', v => v ? String(v).slice(0, 10) : null],
            ['max_uses', v => v != null ? parseInt(v, 10) : null],
            ['is_active', v => v ? 1 : 0],
        ];

        for (const [field, transform] of fields) {
            if (req.body[field] !== undefined) push(`${field} = ?`, transform(req.body[field]));
        }

        if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
        params.push(id);
        await pool.query(`UPDATE promotions SET ${updates.join(', ')} WHERE id = ?`, params);
        res.json({ success: true });
    } catch (err) {
        console.error('update promotion error:', err);
        res.status(500).json({ error: 'Failed to update promotion' });
    }
});

// ─── OWNER: Delete promotion ────────────────────────────────────────────────
router.delete('/:id', verifyToken, verifyOwner, async (req, res) => {
    try {
        const { id } = req.params;
        const [[promo]] = await pool.query('SELECT owner_id FROM promotions WHERE id = ?', [id]);
        if (!promo || promo.owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        await pool.query('DELETE FROM promotions WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('delete promotion error:', err);
        res.status(500).json({ error: 'Failed to delete promotion' });
    }
});

// ─── PUBLIC: Active promotions for a turf ───────────────────────────────────
router.get('/turf/:turfId', async (req, res) => {
    try {
        const { turfId } = req.params;
        const today = new Date().toISOString().slice(0, 10);

        const [rows] = await pool.query(
            `SELECT id, name, description, promo_type,
              buy_quantity, free_quantity, discount_type, discount_value,
              applicable_sport, start_date, end_date, max_uses, used_count
       FROM promotions
       WHERE turf_id = ? AND is_active = 1
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
         AND (max_uses IS NULL OR used_count < max_uses)
       ORDER BY created_at DESC`,
            [turfId, today, today]
        );

        res.json({ promotions: rows });
    } catch (err) {
        console.error('fetch turf promotions error:', err);
        res.status(500).json({ error: 'Failed to fetch promotions' });
    }
});

// ─── PUBLIC: Apply a promotion to a booking calculation ─────────────────────
// POST /api/promotions/apply  { promotion_id, turf_id, slots_booked, booking_amount }
router.post('/apply', async (req, res) => {
    try {
        const { promotion_id, turf_id, slots_booked = 1, booking_amount = 0 } = req.body;

        if (!promotion_id || !turf_id) {
            return res.status(400).json({ error: 'promotion_id and turf_id required' });
        }

        const today = new Date().toISOString().slice(0, 10);
        const [[promo]] = await pool.query(
            `SELECT * FROM promotions
       WHERE id = ? AND turf_id = ? AND is_active = 1
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
         AND (max_uses IS NULL OR used_count < max_uses)`,
            [promotion_id, turf_id, today, today]
        );

        if (!promo) {
            return res.status(404).json({ error: 'Promotion not found or expired' });
        }

        const amt = parseFloat(booking_amount);
        const slotsBooked = parseInt(slots_booked, 10) || 1;
        let discountAmount = 0;
        let freeSlots = 0;
        let summary = '';

        if (promo.promo_type === 'bogo') {
            // Buy `buy_quantity`, get `free_quantity` free
            const sets = Math.floor(slotsBooked / (promo.buy_quantity + promo.free_quantity));
            const remainder = slotsBooked % (promo.buy_quantity + promo.free_quantity);
            const freeFromSets = sets * promo.free_quantity;
            const freeFromRemainder = Math.max(0, remainder - promo.buy_quantity);
            freeSlots = freeFromSets + freeFromRemainder;
            const slotPrice = slotsBooked > 0 ? amt / slotsBooked : 0;
            discountAmount = Math.round(freeSlots * slotPrice * 100) / 100;
            summary = `BOGO: Buy ${promo.buy_quantity} get ${promo.free_quantity} free — ${freeSlots} slot(s) free`;
        } else if (promo.promo_type === 'flat') {
            discountAmount = Math.min(parseFloat(promo.discount_value || 0), amt);
            summary = `Flat ₹${discountAmount} off`;
        } else if (promo.promo_type === 'percentage') {
            discountAmount = (amt * parseFloat(promo.discount_value || 0)) / 100;
            summary = `${promo.discount_value}% off = ₹${discountAmount.toFixed(2)}`;
        }

        discountAmount = Math.round(discountAmount * 100) / 100;
        const finalAmount = Math.max(0, amt - discountAmount);

        res.json({
            valid: true,
            promotion: { id: promo.id, name: promo.name, promo_type: promo.promo_type },
            originalAmount: amt,
            discountAmount,
            finalAmount,
            freeSlots,
            summary,
        });
    } catch (err) {
        console.error('apply promotion error:', err);
        res.status(500).json({ error: 'Failed to apply promotion' });
    }
});

module.exports = router;
