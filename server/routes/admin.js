const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { generateToken, verifyToken, verifyAdmin } = require('../middleware/auth');

// POST /api/admin/login — Admin login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const [rows] = await pool.query('SELECT * FROM admins WHERE username = ?', [username]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const admin = rows[0];
    const validPassword = await bcrypt.compare(password, admin.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken({ id: admin.id, username: admin.username, role: 'admin' });

    res.json({ token, admin: { id: admin.id, username: admin.username } });
  } catch (err) {
    console.error('Error logging in admin:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/admin/dashboard — Dashboard stats
router.get('/dashboard', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [totalUsers] = await pool.query("SELECT COUNT(DISTINCT customer_phone) as count FROM bookings WHERE payment_status = 'success'");
    const [totalTurfs] = await pool.query('SELECT COUNT(*) as count FROM turfs');
    const [totalBookings] = await pool.query("SELECT COUNT(*) as count FROM bookings WHERE payment_status = 'success'");
    const [totalOwners] = await pool.query('SELECT COUNT(*) as count FROM owners');
    const [totalRevenueResult] = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM bookings WHERE status = 'confirmed' AND payment_status = 'success'"
    );

    const [monthlyRevenueResult] = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM bookings 
       WHERE status = 'confirmed' AND payment_status = 'success' 
       AND MONTH(booking_date) = MONTH(CURDATE()) AND YEAR(booking_date) = YEAR(CURDATE())`
    );

    // Get commission and service fee settings
    const [settings] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('commission_percent', 'service_fee', 'service_fee_type')");
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.setting_key] = s.setting_value);
    
    const commission = parseFloat(settingsMap['commission_percent'] || '10');
    const serviceFeeVal = parseFloat(settingsMap['service_fee'] || '20');
    const serviceFeeType = settingsMap['service_fee_type'] || 'fixed';

    const [platformRevenueResult] = await pool.query(
      `SELECT COALESCE(SUM(service_fee + (original_price - discount_amount) * (? / 100)), 0) as platform_total 
       FROM bookings WHERE status = 'confirmed' AND payment_status = 'success'`,
       [commission]
    );

    const [monthlyPlatformResult] = await pool.query(
      `SELECT COALESCE(SUM(service_fee + (original_price - discount_amount) * (? / 100)), 0) as platform_total 
       FROM bookings WHERE status = 'confirmed' AND payment_status = 'success'
       AND MONTH(booking_date) = MONTH(CURDATE()) AND YEAR(booking_date) = YEAR(CURDATE())`,
       [commission]
    );

    const revenue = parseFloat(totalRevenueResult[0].total);
    const platformRevenue = parseFloat(platformRevenueResult[0].platform_total);
    const monthlyRevenue = parseFloat(monthlyRevenueResult[0].total);
    const monthlyPlatform = parseFloat(monthlyPlatformResult[0].platform_total);

    const [dailyRevenueResult] = await pool.query(
      `SELECT DATE(booking_date) as date, COALESCE(SUM(amount), 0) as total
       FROM bookings WHERE status = 'confirmed' AND payment_status = 'success'
       AND MONTH(booking_date) = MONTH(CURDATE()) AND YEAR(booking_date) = YEAR(CURDATE())
       GROUP BY DATE(booking_date)
       ORDER BY DATE(booking_date) ASC`
    );

    res.json({
      stats: {
        total_users: Number(totalUsers[0].count),
        total_turfs: Number(totalTurfs[0].count),
        total_bookings: Number(totalBookings[0].count),
        total_owners: Number(totalOwners[0].count),
        total_revenue: revenue,
        monthly_revenue: monthlyRevenue,
        platform_revenue: platformRevenue,
        monthly_platform_revenue: monthlyPlatform,
        commission_percent: commission,
        service_fee: serviceFeeVal,
        service_fee_type: serviceFeeType,
        daily_revenue: dailyRevenueResult.map(d => ({ date: d.date, total: parseFloat(d.total) }))
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

// ========= TURF MANAGEMENT =========
// GET /api/admin/turfs — Get all turfs with owner info and monthly revenue
router.get('/turfs', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT t.*, o.name as owner_name, o.email as owner_email,
             COALESCE(m.monthly_revenue, 0) as monthly_revenue
      FROM turfs t 
      LEFT JOIN owners o ON t.owner_id = o.id 
      LEFT JOIN (
        SELECT turf_id, SUM(amount) as monthly_revenue
        FROM bookings
        WHERE status = 'confirmed' AND payment_status = 'success'
        AND MONTH(booking_date) = MONTH(CURDATE()) AND YEAR(booking_date) = YEAR(CURDATE())
        GROUP BY turf_id
      ) m ON t.id = m.turf_id
      ORDER BY t.created_at DESC
    `);
    const turfs = rows.map(t => ({
      ...t,
      images: typeof t.images === 'string' ? JSON.parse(t.images) : t.images || [],
      amenities: typeof t.amenities === 'string' ? JSON.parse(t.amenities) : t.amenities || []
    }));
    res.json({ turfs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch turfs' });
  }
});

// POST /api/admin/turfs — Add turf (admin)
router.post('/turfs', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { name, location, address, sport_type, price_per_hour, description, images, amenities, owner_id, open_time, close_time } = req.body;

    const [result] = await pool.query(
      `INSERT INTO turfs (name, location, address, sport_type, price_per_hour, description, images, amenities, owner_id, open_time, close_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, location, address || '', sport_type, price_per_hour, description || '', JSON.stringify(images || []), JSON.stringify(amenities || []), owner_id || null, open_time || '06:00', close_time || '23:00']
    );

    res.json({ success: true, turf_id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add turf' });
  }
});

// PUT /api/admin/turfs/:id — Edit turf (admin)
router.put('/turfs/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { name, location, address, sport_type, price_per_hour, description, images, amenities, is_active, open_time, close_time } = req.body;

    await pool.query(
      `UPDATE turfs SET name = ?, location = ?, address = ?, sport_type = ?, price_per_hour = ?, description = ?, images = ?, amenities = ?, is_active = ?, open_time = ?, close_time = ?
       WHERE id = ?`,
      [name, location, address, sport_type, price_per_hour, description, JSON.stringify(images || []), JSON.stringify(amenities || []), is_active !== false, open_time || '06:00', close_time || '23:00', req.params.id]
    );

    res.json({ success: true, message: 'Turf updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update turf' });
  }
});

// DELETE /api/admin/turfs/:id — Delete turf
router.delete('/turfs/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM turfs WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Turf deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete turf' });
  }
});

// ========= OWNER MANAGEMENT =========
// GET /api/admin/owners — View all owners
router.get('/owners', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, email, phone, is_approved, is_blocked, created_at FROM owners ORDER BY created_at DESC');
    res.json({ owners: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch owners' });
  }
});

// PUT /api/admin/owners/:id/approve — Approve owner
router.put('/owners/:id/approve', verifyToken, verifyAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE owners SET is_approved = TRUE WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Owner approved' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve owner' });
  }
});

// PUT /api/admin/owners/:id/reject — Reject owner
router.put('/owners/:id/reject', verifyToken, verifyAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE owners SET is_approved = FALSE WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Owner rejected' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject owner' });
  }
});

// PUT /api/admin/owners/:id/block — Block/unblock owner
router.put('/owners/:id/block', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { is_blocked } = req.body;
    await pool.query('UPDATE owners SET is_blocked = ? WHERE id = ?', [is_blocked, req.params.id]);
    res.json({ success: true, message: is_blocked ? 'Owner blocked' : 'Owner unblocked' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update owner status' });
  }
});

// ========= BOOKING MANAGEMENT =========
// GET /api/admin/bookings — View all bookings
router.get('/bookings', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.*, t.name as turf_name, t.location as turf_location
       FROM bookings b
       JOIN turfs t ON b.turf_id = t.id
       WHERE b.payment_status = 'success' OR b.payment_status = 'failed' OR b.payment_status = 'expired'
       ORDER BY b.created_at DESC`
    );
    res.json({ bookings: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// PUT /api/admin/bookings/:id/cancel — Cancel booking
router.put('/bookings/:id/cancel', verifyToken, verifyAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE bookings SET status = 'cancelled' WHERE id = ?", [req.params.id]);
    res.json({ success: true, message: 'Booking cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

// DELETE /api/admin/bookings/:id — Delete booking permanently
router.delete('/bookings/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM bookings WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Booking deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

// POST /api/admin/bookings/bulk-delete — Delete multiple bookings
router.post('/bookings/bulk-delete', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { bookingIds } = req.body;
    if (!bookingIds || !Array.isArray(bookingIds) || bookingIds.length === 0) {
      return res.status(400).json({ error: 'Booking IDs array is required' });
    }
    
    const placeholders = bookingIds.map(() => '?').join(',');
    await pool.query(`DELETE FROM bookings WHERE id IN (${placeholders})`, bookingIds);
    
    res.json({ success: true, message: `${bookingIds.length} bookings deleted` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete bookings' });
  }
});

// ========= SETTINGS =========
// PUT /api/admin/settings/commission — Update commission
router.put('/settings/commission', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { commission_percent } = req.body;
    await pool.query(
      "INSERT INTO settings (setting_key, setting_value) VALUES ('commission_percent', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
      [commission_percent.toString(), commission_percent.toString()]
    );
    res.json({ success: true, message: 'Commission updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update commission' });
  }
});

// GET /api/admin/settings — Get all settings
router.get('/settings', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT setting_key, setting_value FROM settings");
    const settings = {};
    rows.forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /api/admin/settings/service-fee — Update service fee
router.put('/settings/service-fee', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { service_fee, service_fee_type } = req.body;
    
    // Save amount
    await pool.query(
      "INSERT INTO settings (setting_key, setting_value) VALUES ('service_fee', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
      [service_fee.toString(), service_fee.toString()]
    );
    
    // Save type
    if (service_fee_type) {
      await pool.query(
        "INSERT INTO settings (setting_key, setting_value) VALUES ('service_fee_type', ?) ON DUPLICATE KEY UPDATE setting_value = ?",
        [service_fee_type, service_fee_type]
      );
    }
    
    res.json({ success: true, message: 'Service fee updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update service fee' });
  }
});

// GET /api/admin/turfs/:id/earnings - Get daily/monthly earnings for specific turf
router.get('/turfs/:id/earnings', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { period = 'month' } = req.query;
    
    // Daily earnings for last 30 days
    const [dailyEarnings] = await pool.query(
      "SELECT DATE(booking_date) as date, COALESCE(SUM(amount), 0) as total FROM bookings WHERE turf_id = ? AND status = 'confirmed' AND payment_status = 'success' AND booking_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) GROUP BY DATE(booking_date) ORDER BY DATE(booking_date) ASC",
      [req.params.id]
    );
    
    // Monthly earnings
    const [monthlyEarnings] = await pool.query(
      "SELECT MONTH(booking_date) as month, YEAR(booking_date) as year, COALESCE(SUM(amount), 0) as total FROM bookings WHERE turf_id = ? AND status = 'confirmed' AND payment_status = 'success' GROUP BY YEAR(booking_date), MONTH(booking_date) ORDER BY YEAR(booking_date) DESC, MONTH(booking_date) DESC LIMIT 12",
      [req.params.id]
    );
    
    // Total earnings for this turf
    const [totalResult] = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total FROM bookings WHERE turf_id = ? AND status = 'confirmed' AND payment_status = 'success'",
      [req.params.id]
    );
    
    res.json({
      daily: dailyEarnings.map(d => ({ date: d.date, total: parseFloat(d.total) })),
      monthly: monthlyEarnings.map(m => ({ 
        month: m.month, 
        year: m.year, 
        total: parseFloat(m.total) 
      })),
      total: parseFloat(totalResult[0].total)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch turf earnings' });
  }
});

// DELETE /api/admin/turfs/:id/bookings - Delete all bookings for a specific turf
router.delete('/turfs/:id/bookings', verifyToken, verifyAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM bookings WHERE turf_id = ?', [req.params.id]);
    res.json({ success: true, message: 'All bookings for this turf deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete turf bookings' });
  }
});

module.exports = router;
