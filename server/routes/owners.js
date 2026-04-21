const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { generateToken, verifyToken, verifyOwner } = require('../middleware/auth');

// POST /api/owners/register — Owner registration
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Check if owner already exists
    const [existing] = await pool.query('SELECT id FROM owners WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO owners (name, email, phone, password_hash, is_approved) VALUES (?, ?, ?, ?, ?)',
      [name, email, phone, password_hash, 1] // Auto-approving for initial rollout as per user request for smooth signup
    );

    res.json({ success: true, message: 'Registration successful! You can now log in.', owner_id: result.insertId });
  } catch (err) {
    console.error('Error registering owner:', err);
    res.status(500).json({ error: 'Registration failed', details: err.message });
  }
});

// POST /api/owners/login — Owner login
router.post('/login', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    // Support email login specifically for better security/uniqueness
    const loginIdentifier = email || username;

    if (!loginIdentifier || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const [rows] = await pool.query('SELECT * FROM owners WHERE email = ?', [loginIdentifier]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Owner account not found with this email' });
    }

    const owner = rows[0];

    if (owner.is_blocked) {
      return res.status(403).json({ error: 'Your account has been blocked. Contact admin.' });
    }

    if (!owner.is_approved) {
      return res.status(403).json({ error: 'Your account is pending admin approval.' });
    }

    const validPassword = await bcrypt.compare(password, owner.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken({ id: owner.id, email: owner.email, role: 'owner' });

    res.json({
      token,
      owner: { id: owner.id, name: owner.name, email: owner.email, phone: owner.phone }
    });
  } catch (err) {
    console.error('Error logging in owner:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/owners/profile — Get owner profile
router.get('/profile', verifyToken, verifyOwner, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, email, phone, created_at FROM owners WHERE id = ?', [req.user.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Owner not found' });
    }
    res.json({ owner: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// GET /api/owners/turfs — Get owner's turfs
router.get('/turfs', verifyToken, verifyOwner, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM turfs WHERE owner_id = ? ORDER BY created_at DESC', [req.user.id]);
    const turfs = rows.map(turf => ({
      ...turf,
      images: typeof turf.images === 'string' ? JSON.parse(turf.images) : turf.images || [],
      amenities: typeof turf.amenities === 'string' ? JSON.parse(turf.amenities) : turf.amenities || []
    }));
    res.json({ turfs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch turfs' });
  }
});

// POST /api/owners/turfs — Add a new turf
router.post('/turfs', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { name, location, address, sport_type, price_per_hour, description, images, amenities, open_time, close_time, markup_type, markup_value, latitude, longitude } = req.body;

    if (!name || !location || !sport_type || !price_per_hour) {
      return res.status(400).json({ error: 'Name, location, sport type, and price are required' });
    }

    // Generate unique slug
    const baseSlug = name.toLowerCase()
      .trim()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    
    const locationSlug = location.toLowerCase().trim().replace(/[^a-z0-9]/g, '-');
    const randomSalt = Math.random().toString(36).substring(2, 6);
    let slug = `${baseSlug}-${locationSlug}-${randomSalt}`;
    
    const [result] = await pool.query(
      `INSERT INTO turfs (name, location, address, sport_type, price_per_hour, description, images, amenities, owner_id, open_time, close_time, markup_type, markup_value, slug, latitude, longitude)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, location, address || '', sport_type, price_per_hour, description || '', JSON.stringify(images || []), JSON.stringify(amenities || []), req.user.id, open_time || '06:00', close_time || '23:00', markup_type || 'fixed', markup_value || 0, slug, latitude || 13.0827, longitude || 80.2707]
    );

    res.json({ success: true, turf_id: result.insertId, slug });
  } catch (err) {
    console.error('Error adding turf:', err);
    res.status(500).json({ error: 'Failed to add turf', details: err.message });
  }
});

// PUT /api/owners/turfs/:id — Edit a turf
router.put('/turfs/:id', verifyToken, verifyOwner, async (req, res) => {
  try {
    // Verify owner owns the turf
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    const { name, location, address, sport_type, price_per_hour, description, images, amenities, is_active, open_time, close_time, markup_type, markup_value, latitude, longitude } = req.body;

    // Optional: Update slug if name changes
    const baseSlug = name.toLowerCase().trim().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    const locationSlug = location.toLowerCase().trim().replace(/[^a-z0-9]/g, '-');
    const randomSalt = Math.random().toString(36).substring(2, 6);
    const slug = `${baseSlug}-${locationSlug}-${randomSalt}`;

    await pool.query(
      `UPDATE turfs SET name = ?, location = ?, address = ?, sport_type = ?, price_per_hour = ?, description = ?, images = ?, amenities = ?, is_active = ?, open_time = ?, close_time = ?, markup_type = ?, markup_value = ?, slug = ?, latitude = ?, longitude = ?
       WHERE id = ? AND owner_id = ?`,
      [name, location, address, sport_type, price_per_hour, description, JSON.stringify(images || []), JSON.stringify(amenities || []), is_active !== false, open_time || '06:00', close_time || '23:00', markup_type || 'fixed', markup_value || 0, slug, latitude || 13.0827, longitude || 80.2707, req.params.id, req.user.id]
    );

    res.json({ success: true, message: 'Turf updated successfully', slug });
  } catch (err) {
    console.error('Error updating turf:', err);
    res.status(500).json({ error: 'Failed to update turf' });
  }
});

// DELETE /api/owners/turfs/:id — Delete a turf
router.delete('/turfs/:id', verifyToken, verifyOwner, async (req, res) => {
  try {
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    await pool.query('DELETE FROM turfs WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true, message: 'Turf deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete turf' });
  }
});

// POST /api/owners/turfs/:id/block-slot — Block a slot
router.post('/turfs/:id/block-slot', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { block_date, time_slot, reason } = req.body;

    // Verify owner owns the turf
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    // Check max 5 blocked slots per day
    const [blockedCount] = await pool.query(
      'SELECT COUNT(*) as count FROM blocked_slots WHERE turf_id = ? AND block_date = ?',
      [req.params.id, block_date]
    );
    if (blockedCount[0].count >= 5) {
      return res.status(400).json({ error: 'Maximum 5 blocked slots per day reached' });
    }

    await pool.query(
      'INSERT INTO blocked_slots (turf_id, block_date, time_slot, reason) VALUES (?, ?, ?, ?)',
      [req.params.id, block_date, time_slot, reason || '']
    );

    res.json({ success: true, message: 'Slot blocked successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to block slot' });
  }
});

// DELETE /api/owners/turfs/:id/unblock-slot — Unblock a slot
router.delete('/turfs/:id/unblock-slot', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { block_date, time_slot } = req.body;

    await pool.query(
      'DELETE FROM blocked_slots WHERE turf_id = ? AND block_date = ? AND time_slot = ?',
      [req.params.id, block_date, time_slot]
    );

    res.json({ success: true, message: 'Slot unblocked successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unblock slot' });
  }
});

// GET /api/owners/bookings — Get all bookings for owner's turfs
router.get('/bookings', verifyToken, verifyOwner, async (req, res) => {
  try {
    // Get commission percentage
    const [settings] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'commission_percent'");
    const commission = settings.length > 0 ? parseFloat(settings[0].setting_value) : 10;

    const [rows] = await pool.query(
      `SELECT b.id, b.payment_id, b.customer_name, b.customer_phone, b.customer_email, b.booking_date, b.time_slot, b.amount, b.payment_status, b.status, b.created_at, t.name as turf_name
       FROM bookings b
       JOIN turfs t ON b.turf_id = t.id
       WHERE t.owner_id = ? AND b.payment_status = 'success' AND b.status = 'confirmed'
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );

    // Calculate net amount for each booking (amount after commission deduction)
    const bookings = rows.map(booking => {
      const netAmount = booking.amount - ((booking.amount * commission) / 100);
      return {
        ...booking,
        netAmount: Math.round(netAmount * 100) / 100 // Round to 2 decimal places
      };
    });

    res.json({ bookings });
  } catch (err) {
    console.error('Error fetching owner bookings:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SPECIAL PRICING ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/owners/turfs/:id/special-pricing — Get all special pricing for a turf
router.get('/turfs/:id/special-pricing', verifyToken, verifyOwner, async (req, res) => {
  try {
    // Verify owner owns the turf
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    const [rows] = await pool.query(
      'SELECT * FROM special_pricing WHERE turf_id = ? ORDER BY day_of_week, specific_date, time_slot',
      [req.params.id]
    );

    res.json({ specialPricing: rows });
  } catch (err) {
    console.error('Error fetching special pricing:', err);
    res.status(500).json({ error: 'Failed to fetch special pricing' });
  }
});

// POST /api/owners/turfs/:id/special-pricing — Set special pricing for a slot
router.post('/turfs/:id/special-pricing', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { day_of_week, specific_date, time_slot, special_price, offer_percentage, offer_label } = req.body;

    // Verify owner owns the turf
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    if (!time_slot || !special_price) {
      return res.status(400).json({ error: 'Time slot and special price are required' });
    }

    // Validate day_of_week (0-6) or null
    const day = day_of_week !== undefined && day_of_week !== null ? parseInt(day_of_week) : null;
    if (day !== null && (day < 0 || day > 6)) {
      return res.status(400).json({ error: 'Invalid day of week. Must be 0-6 (Sunday-Saturday)' });
    }

    await pool.query(
      `INSERT INTO special_pricing (turf_id, day_of_week, specific_date, time_slot, special_price, offer_percentage, offer_label)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE special_price = VALUES(special_price), offer_percentage = VALUES(offer_percentage), offer_label = VALUES(offer_label)`,
      [req.params.id, day, specific_date || null, time_slot, special_price, offer_percentage || null, offer_label || null]
    );

    res.json({ success: true, message: 'Special pricing and offers saved successfully' });
  } catch (err) {
    console.error('Error saving special pricing:', err);
    res.status(500).json({ error: 'Failed to save special pricing' });
  }
});

// POST /api/owners/turfs/:id/special-pricing/bulk — Set special pricing for multiple slots
router.post('/turfs/:id/special-pricing/bulk', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { entries } = req.body; // Array of { day_of_week, specific_date, time_slot, special_price, offer_percentage, offer_label }

    // Verify owner owns the turf
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'Entries array is required' });
    }

    // Process each entry
    for (const entry of entries) {
      const { day_of_week, specific_date, time_slot, special_price, offer_percentage, offer_label } = entry;
      if (!time_slot || special_price === undefined || special_price === null) continue;

      const day = day_of_week !== undefined && day_of_week !== null ? parseInt(day_of_week) : null;

      await pool.query(
        `INSERT INTO special_pricing (turf_id, day_of_week, specific_date, time_slot, special_price, offer_percentage, offer_label)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE special_price = VALUES(special_price), offer_percentage = VALUES(offer_percentage), offer_label = VALUES(offer_label)`,
        [req.params.id, day, specific_date || null, time_slot, special_price, offer_percentage || null, offer_label || null]
      );
    }

    res.json({ success: true, message: `${entries.length} special prices and offers saved successfully` });
  } catch (err) {
    console.error('Error saving bulk special pricing:', err);
    res.status(500).json({ error: 'Failed to save special pricing' });
  }
});

// DELETE /api/owners/turfs/:id/special-pricing — Delete special pricing
router.delete('/turfs/:id/special-pricing', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { day_of_week, specific_date, time_slot } = req.body;

    // Verify owner owns the turf
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    let query = 'DELETE FROM special_pricing WHERE turf_id = ?';
    const params = [req.params.id];

    if (day_of_week !== undefined) {
      query += ' AND day_of_week = ?';
      params.push(day_of_week);
    }
    if (specific_date) {
      query += ' AND specific_date = ?';
      params.push(specific_date);
    }
    if (time_slot) {
      query += ' AND time_slot = ?';
      params.push(time_slot);
    }

    await pool.query(query, params);

    res.json({ success: true, message: 'Special pricing deleted successfully' });
  } catch (err) {
    console.error('Error deleting special pricing:', err);
    res.status(500).json({ error: 'Failed to delete special pricing' });
  }
});

// DELETE /api/owners/turfs/:id/special-pricing/:pricingId — Delete specific pricing by ID
router.delete('/turfs/:id/special-pricing/:pricingId', verifyToken, verifyOwner, async (req, res) => {
  try {
    // Verify owner owns the turf
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    await pool.query(
      'DELETE FROM special_pricing WHERE id = ? AND turf_id = ?',
      [req.params.pricingId, req.params.id]
    );

    res.json({ success: true, message: 'Special pricing deleted successfully' });
  } catch (err) {
    console.error('Error deleting special pricing:', err);
    res.status(500).json({ error: 'Failed to delete special pricing' });
  }
});

// ═══════════════════════════════════════════════════════════════
// EARNINGS ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/owners/earnings — Get earnings data (NET amounts only - commission hidden from owner)
router.get('/earnings', verifyToken, verifyOwner, async (req, res) => {
  try {
    // Get commission percentage (used internally, NOT exposed to owner)
    const [settings] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'commission_percent'");
    const commission = settings.length > 0 ? parseFloat(settings[0].setting_value) : 10;

    // Calculate NET earnings (after commission and service fee deduction)
    // Formula: (original_price - discount_amount) * ((100 - commission) / 100)
    
    // Total net earnings
    const [totalResult] = await pool.query(
      `SELECT COALESCE(SUM((original_price - discount_amount) * ((100 - ?) / 100)), 0) as total
       FROM bookings b JOIN turfs t ON b.turf_id = t.id
       WHERE t.owner_id = ? AND b.status = 'confirmed' AND b.payment_status = 'success'`,
      [commission, req.user.id]
    );

    // Today's net earnings
    const [todayResult] = await pool.query(
      `SELECT COALESCE(SUM((original_price - discount_amount) * ((100 - ?) / 100)), 0) as total
       FROM bookings b JOIN turfs t ON b.turf_id = t.id
       WHERE t.owner_id = ? AND b.status = 'confirmed' AND b.payment_status = 'success' AND DATE(b.created_at) = CURDATE()`,
      [commission, req.user.id]
    );

    // Monthly net earnings
    const [monthlyResult] = await pool.query(
      `SELECT COALESCE(SUM((original_price - discount_amount) * ((100 - ?) / 100)), 0) as total
       FROM bookings b JOIN turfs t ON b.turf_id = t.id
       WHERE t.owner_id = ? AND b.status = 'confirmed' AND b.payment_status = 'success'
       AND MONTH(b.booking_date) = MONTH(CURDATE()) AND YEAR(b.booking_date) = YEAR(CURDATE())`,
      [commission, req.user.id]
    );

    // Daily breakdown for the current month
    const [dailyStats] = await pool.query(
      `SELECT DATE(booking_date) as date, 
              COALESCE(SUM((original_price - discount_amount) * ((100 - ?) / 100)), 0) as earnings
       FROM bookings b JOIN turfs t ON b.turf_id = t.id
       WHERE t.owner_id = ? AND b.status = 'confirmed' AND b.payment_status = 'success'
       AND MONTH(booking_date) = MONTH(CURDATE()) AND YEAR(booking_date) = YEAR(CURDATE())
       GROUP BY DATE(booking_date)
       ORDER BY DATE(booking_date) ASC`,
      [commission, req.user.id]
    );

    res.json({
      total: parseFloat(totalResult[0].total),
      today: parseFloat(todayResult[0].total),
      monthly: parseFloat(monthlyResult[0].total),
      daily: dailyStats.map(d => ({
        date: d.date,
        earnings: parseFloat(d.earnings)
      }))
    });
  } catch (err) {
    console.error('Error fetching owner earnings:', err);
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

module.exports = router;
