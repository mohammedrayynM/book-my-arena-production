const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { generateToken, verifyToken, verifyAdmin } = require('../middleware/auth');
const billingConfig = require('../services/billingConfig');
const pricingService = require('../services/pricing');
const { fire: fireNotification } = require('../utils/notifications/events');

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
      "SELECT COALESCE(SUM(COALESCE(original_price, amount)), 0) as total FROM bookings WHERE status = 'confirmed' AND payment_status = 'success'"
    );

    const [monthlyRevenueResult] = await pool.query(
      `SELECT COALESCE(SUM(COALESCE(original_price, amount)), 0) as total FROM bookings 
       WHERE status = 'confirmed' AND payment_status = 'success' 
       AND MONTH(booking_date) = MONTH(CURDATE()) AND YEAR(booking_date) = YEAR(CURDATE())`
    );

    // Get commission and service fee settings
    const [settings] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('commission_percent', 'service_fee', 'service_fee_type')");
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.setting_key] = s.setting_value);
    
    const commission = 0;
    const serviceFeeVal = 0;
    const serviceFeeType = 'fixed';

    // Platform revenue = what the platform actually kept from SETTLED payments (the Route ledger), net of the tax it must
    // remit. It is never derived from gross booking value or from a percentage typed into a settings screen.
    const SETTLED_REVENUE_SQL = `SELECT COALESCE(SUM(COALESCE(captured_minor - owner_transfer_minor - COALESCE(tax_minor, 0), ROUND(platform_amount * 100))), 0) / 100 AS platform_total
       FROM route_split_transfers WHERE status IN ('SUCCESS', 'NOT_REQUIRED')`;
    const [platformRevenueResult] = await pool.query(SETTLED_REVENUE_SQL);
    const [monthlyPlatformResult] = await pool.query(
      SETTLED_REVENUE_SQL + ` AND MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())`
    );

    const revenue = parseFloat(totalRevenueResult[0].total);
    const platformRevenue = parseFloat(platformRevenueResult[0].platform_total);
    const monthlyRevenue = parseFloat(monthlyRevenueResult[0].total);
    const monthlyPlatform = parseFloat(monthlyPlatformResult[0].platform_total);

    const [dailyRevenueResult] = await pool.query(
      `SELECT DATE(booking_date) as date, COALESCE(SUM(COALESCE(original_price, amount)), 0) as total
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
      SELECT t.*, o.name as owner_name, o.email as owner_account_email, t.owner_email as turf_owner_email,
             COALESCE(m.monthly_revenue, 0) as monthly_revenue
      FROM turfs t 
      LEFT JOIN owners o ON t.owner_id = o.id 
      LEFT JOIN (
        SELECT turf_id, SUM(COALESCE(original_price, amount)) as monthly_revenue
        FROM bookings
        WHERE status = 'confirmed' AND payment_status = 'success'
        AND MONTH(booking_date) = MONTH(CURDATE()) AND YEAR(booking_date) = YEAR(CURDATE())
        GROUP BY turf_id
      ) m ON t.id = m.turf_id
      ORDER BY t.created_at DESC
    `);
    const turfs = rows.map(t => ({
      ...t,
      owner_email: t.turf_owner_email || t.owner_account_email || '',
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
    const { name, location, address, sport_type, price_per_hour, description, images, amenities, owner_id, open_time, close_time, owner_email, monthly_subscription_amount, razorpay_linked_account_id } = req.body;

    if (!name || !location || !sport_type || price_per_hour === undefined || price_per_hour === '') {
      return res.status(400).json({ error: 'Name, location, sport and price are required' });
    }

    // turfs.slug is NOT NULL with no default — build it the same way owner-created turfs do
    const slugify = (v) => String(v).toLowerCase().trim().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const slug = `${slugify(name)}-${slugify(location)}-${Math.random().toString(36).substring(2, 6)}`;

    const [result] = await pool.query(
      `INSERT INTO turfs (name, location, address, sport_type, price_per_hour, description, images, amenities, owner_id, open_time, close_time, owner_email, slug, razorpay_linked_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, location, address || '', sport_type, price_per_hour, description || '', JSON.stringify(images || []), JSON.stringify(amenities || []), owner_id || null, open_time || '06:00', close_time || '23:00', owner_email || null, slug, razorpay_linked_account_id || null]
    );

    res.json({ success: true, turf_id: result.insertId });
  } catch (err) {
    console.error('Admin add turf failed:', err.message);
    res.status(500).json({ error: 'Failed to add turf' });
  }
});

// PUT /api/admin/turfs/:id — Edit turf (admin)
router.put('/turfs/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { name, location, address, sport_type, price_per_hour, description, images, amenities, is_active, open_time, close_time, owner_email, monthly_subscription_amount, razorpay_linked_account_id } = req.body;

    // Billing is NOT edited here any more: monthly_subscription_amount (and every other price) now lives in the versioned,
    // audited billing configuration, so a venue edit can no longer overwrite it (it used to reset it to 0 when omitted).
    // The legacy linked-account column is only changed when the request actually carries it.
    const sets = ['name = ?', 'location = ?', 'address = ?', 'sport_type = ?', 'price_per_hour = ?', 'description = ?', 'images = ?', 'amenities = ?', 'is_active = ?', 'open_time = ?', 'close_time = ?', 'owner_email = ?'];
    const params = [name, location, address, sport_type, price_per_hour, description, JSON.stringify(images || []), JSON.stringify(amenities || []), is_active !== false, open_time || '06:00', close_time || '23:00', owner_email || null];
    if (razorpay_linked_account_id !== undefined) { sets.push('razorpay_linked_account_id = ?'); params.push(razorpay_linked_account_id || null); }
    await pool.query(`UPDATE turfs SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);

    res.json({ success: true, message: 'Turf updated' });
  } catch (err) {
    console.error('Admin update turf failed:', err.message);
    res.status(500).json({ error: 'Failed to update turf' });
  }
});

// PUT /api/admin/turfs/:id/billing — Configure billing model for venue (admin only)
router.put('/turfs/:id/billing', verifyToken, verifyAdmin, async (req, res) => {
  // Compatibility shim for the older admin screens. It no longer writes the turfs columns directly (which silently reset
  // any field that was left out and kept no history): it publishes a validated, versioned, audited configuration through
  // services/billingConfig.js — the same single path the new Billing screens use.
  try {
    const b = req.body || {};
    const isSub = String(b.billing_model || '').toUpperCase() === 'MONTHLY' || String(b.billing_model || '').toUpperCase() === 'SUBSCRIPTION';
    const input = isSub
      ? { billing_model: 'SUBSCRIPTION', subscription_amount: b.monthly_amount, subscription_period: 'MONTHLY', subscription_policy: b.subscription_policy || 'DEDUCT_FROM_PROCEEDS', subscription_start_date: b.subscription_start_date }
      : { billing_model: String(b.billing_model || 'PERCENTAGE').toUpperCase(), commission_percent: b.commission_percentage, flat_fee: b.flat_fee };
    const cfg = await billingConfig.publishConfig({ turfId: Number(req.params.id), input, adminId: req.user.id, reason: b.reason || 'Updated from the admin venue screen' });
    if (b.subscription_status) await pool.query('UPDATE turfs SET subscription_status = ? WHERE id = ?', [String(b.subscription_status).slice(0, 50), req.params.id]);
    if (b.next_billing_date) await pool.query('UPDATE turfs SET next_billing_date = ? WHERE id = ?', [b.next_billing_date, req.params.id]);
    res.json({ success: true, message: 'Venue billing configuration updated', config_version: cfg.version });
  } catch (err) {
    if (err instanceof pricingService.PricingConfigError) return res.status(400).json({ error: err.message, errors: err.errors });
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('Error updating venue billing:', err);
    res.status(500).json({ error: 'Failed to update venue billing configuration' });
  }
});

// PUT /api/admin/turfs/:id/status — Block/unblock venue (admin only)
router.put('/turfs/:id/status', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status, is_active } = req.body;
    const newStatus = status || (is_active === false ? 'BLOCKED' : 'ACTIVE');
    const isActive = newStatus === 'ACTIVE';

    await pool.query(
      'UPDATE turfs SET status = ?, is_active = ? WHERE id = ?',
      [newStatus, isActive, req.params.id]
    );

    res.json({ success: true, message: `Venue status set to ${newStatus}` });
  } catch (err) {
    console.error('Error setting venue status:', err);
    res.status(500).json({ error: 'Failed to update venue status' });
  }
});

// GET /api/admin/pending-approvals — List all venues and courts awaiting approval
router.get('/pending-approvals', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [turfs] = await pool.query(
      `SELECT t.*, o.name as owner_name, o.email as owner_email, o.phone as owner_phone
       FROM turfs t
       JOIN owners o ON t.owner_id = o.id
       WHERE t.approval_status IN ('PENDING_APPROVAL', 'ACTION_REQUIRED')
       ORDER BY t.created_at DESC`
    );

    const [courts] = await pool.query(
      `SELECT c.*, t.name as turf_name, t.location as turf_location, t.currency_code, o.name as owner_name, o.email as owner_email
       FROM courts c
       JOIN turfs t ON c.turf_id = t.id
       JOIN owners o ON t.owner_id = o.id
       WHERE c.approval_status IN ('PENDING_APPROVAL', 'ACTION_REQUIRED')
       ORDER BY c.created_at DESC`
    );

    res.json({
      success: true,
      pending_turfs: turfs,
      pending_courts: courts,
      total_pending: turfs.length + courts.length
    });
  } catch (err) {
    console.error('Error fetching pending approvals:', err);
    res.status(500).json({ error: 'Failed to fetch pending approvals' });
  }
});

// PUT /api/admin/turfs/:id/approval — Approve, reject, or request changes on a venue
router.put('/turfs/:id/approval', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status, admin_feedback } = req.body;
    const validStatuses = ['APPROVED', 'REJECTED', 'ACTION_REQUIRED', 'PENDING_APPROVAL'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid approval status' });
    }

    const isApproved = status === 'APPROVED';
    await pool.query(
      `UPDATE turfs SET 
         approval_status = ?, 
         admin_feedback = ?, 
         is_active = ?, 
         status = ?,
         approved_by = ?,
         approved_at = ?
       WHERE id = ?`,
      [
        status,
        admin_feedback || null,
        isApproved,
        isApproved ? 'ACTIVE' : status,
        isApproved ? req.user.id : null,
        isApproved ? new Date() : null,
        req.params.id
      ]
    );

    res.json({ success: true, message: `Venue status set to ${status}`, approval_status: status });
  } catch (err) {
    console.error('Error approving venue:', err);
    res.status(500).json({ error: 'Failed to update venue approval status' });
  }
});

// PUT /api/admin/courts/:id/approval — Approve, reject, or request changes on a court
router.put('/courts/:id/approval', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status, admin_feedback } = req.body;
    const validStatuses = ['APPROVED', 'REJECTED', 'ACTION_REQUIRED', 'PENDING_APPROVAL'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid approval status' });
    }

    const isApproved = status === 'APPROVED';
    await pool.query(
      `UPDATE courts SET 
         approval_status = ?, 
         admin_feedback = ?, 
         is_active = ?,
         approved_by = ?,
         approved_at = ?
       WHERE id = ?`,
      [
        status,
        admin_feedback || null,
        isApproved,
        isApproved ? req.user.id : null,
        isApproved ? new Date() : null,
        req.params.id
      ]
    );

    res.json({ success: true, message: `Court status set to ${status}`, approval_status: status });
  } catch (err) {
    console.error('Error approving court:', err);
    res.status(500).json({ error: 'Failed to update court approval status' });
  }
});

// ========= OWNER MANAGEMENT =========
// GET /api/admin/owners — View all owners
router.get('/owners', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, email, phone, is_approved, is_blocked, status, is_deleted, created_at 
       FROM owners 
       WHERE is_deleted = FALSE OR is_deleted IS NULL 
       ORDER BY created_at DESC`
    );
    res.json({ owners: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch owners' });
  }
});

// PUT /api/admin/owners/:id/approve — Approve owner
router.put('/owners/:id/approve', verifyToken, verifyAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE owners SET is_approved = TRUE, status = 'ACTIVE' WHERE id = ?", [req.params.id]);
    fireNotification('owner.decided', { ownerId: req.params.id, decision: 'approved' });
    res.json({ success: true, message: 'Owner approved' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve owner' });
  }
});

// PUT /api/admin/owners/:id/reject — Reject owner
router.put('/owners/:id/reject', verifyToken, verifyAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE owners SET is_approved = FALSE, status = 'REJECTED' WHERE id = ?", [req.params.id]);
    fireNotification('owner.decided', { ownerId: req.params.id, decision: 'rejected' });
    res.json({ success: true, message: 'Owner rejected' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject owner' });
  }
});

// PUT /api/admin/owners/:id/block — Block/unblock owner
router.put('/owners/:id/block', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { is_blocked } = req.body;
    await pool.query("UPDATE owners SET is_blocked = ?, status = ? WHERE id = ?", [is_blocked, is_blocked ? 'BLOCKED' : 'ACTIVE', req.params.id]);
    // Also block owner's turfs if blocking owner
    if (is_blocked) {
      await pool.query("UPDATE turfs SET status = 'BLOCKED', is_active = FALSE WHERE owner_id = ?", [req.params.id]);
    }
    res.json({ success: true, message: is_blocked ? 'Owner and associated venues blocked' : 'Owner unblocked' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update owner status' });
  }
});

// DELETE /api/admin/owners/:id — Deactivate/delete owner safely (admin only)
router.delete('/owners/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const ownerId = req.params.id;
    // Soft delete owner and turfs to preserve historical bookings/payments
    await pool.query("UPDATE owners SET is_deleted = TRUE, is_blocked = TRUE, status = 'DEACTIVATED' WHERE id = ?", [ownerId]);
    await pool.query("UPDATE turfs SET is_deleted = TRUE, is_active = FALSE, status = 'BLOCKED' WHERE owner_id = ?", [ownerId]);
    
    res.json({ success: true, message: 'Owner and associated venues deactivated. Historical records preserved.' });
  } catch (err) {
    console.error('Error deactivating owner:', err);
    res.status(500).json({ error: 'Failed to deactivate owner' });
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
    const [[bookingBefore]] = await pool.query('SELECT status FROM bookings WHERE id = ?', [req.params.id]);
    if (bookingBefore && bookingBefore.status === 'confirmed') {
      // a CONFIRMED (paid) booking goes through the cancellation engine: admin cancels refund the amount actually paid in full,
      // the reason is stored, the refund is tracked in the ledger. (Unpaid holds below keep the old simple cancel.)
      const r = await require('../services/cancellation').cancel({ type: 'turf', id: Number(req.params.id), actor: { kind: 'admin', id: req.user.id }, reason: (req.body && req.body.reason) || 'Other' });
      if (r.error) return res.status(r.status || 400).json({ error: r.error });
      return res.json({ success: true, message: 'Booking cancelled', refunds: (r.refunds || []).map((x) => ({ id: x.id, status: x.refund_status, amount_minor: Number(x.refund_amount_minor), currency: x.currency_code })) });
    }
    await pool.query("UPDATE bookings SET status = 'cancelled' WHERE id = ?", [req.params.id]);
    // only a booking that WAS confirmed is news to the customer and the venue
    fireNotification('booking.cancelled', { bookingIds: [req.params.id], wasConfirmed: !!bookingBefore && bookingBefore.status === 'confirmed' });
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
router.put('/settings/commission', verifyToken, verifyAdmin, (req, res) => {
  // This global value was never used by checkout, settlement or reports, so saving it only gave the impression that a
  // commission had changed. Commission is now configured per venue, versioned and audited (PUT /api/admin/billing/turfs/:id/billing-config).
  res.status(410).json({ error: 'The global commission setting has been retired. Configure the billing model for each venue under Billing.' });
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
router.put('/settings/service-fee', verifyToken, verifyAdmin, (req, res) => {
  // Retired for the same reason: customer service fees and their tax are now central, versioned rules
  // (POST /api/admin/billing/fee-rules) evaluated by the one pricing service.
  res.status(410).json({ error: 'The global service-fee setting has been retired. Configure fee and tax rules under Billing.' });
});

function parseAdminDateOnly(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  date.setHours(0, 0, 0, 0);
  return date;
}

function formatAdminDateOnly(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function diffAdminDaysInclusive(startDate, endDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((endDate.getTime() - startDate.getTime()) / msPerDay) + 1;
}

function resolveAdminRange(query) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const ninetyDaysAgo = new Date(today);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 89);

  const hasCustomRange = !!(query.start_date || query.end_date);
  const rawRangeDays = query.range_days ? parseInt(query.range_days, 10) : 30;

  if (hasCustomRange) {
    if (!query.start_date || !query.end_date) {
      return { error: 'Both start_date and end_date are required for custom range' };
    }

    const startDate = parseAdminDateOnly(query.start_date);
    const endDate = parseAdminDateOnly(query.end_date);

    if (!startDate || !endDate) {
      return { error: 'Invalid date format. Use YYYY-MM-DD' };
    }
    if (startDate > endDate) {
      return { error: 'start_date cannot be after end_date' };
    }
    if (startDate < ninetyDaysAgo) {
      return { error: 'Custom range can only include the last 90 days' };
    }
    if (diffAdminDaysInclusive(startDate, endDate) > 90) {
      return { error: 'Custom range cannot exceed 90 days' };
    }

    return {
      filter_type: 'custom',
      start_date: formatAdminDateOnly(startDate),
      end_date: formatAdminDateOnly(endDate),
      days: diffAdminDaysInclusive(startDate, endDate)
    };
  }

  if (Number.isNaN(rawRangeDays) || rawRangeDays < 1 || rawRangeDays > 90) {
    return { error: 'range_days must be between 1 and 90' };
  }

  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (rawRangeDays - 1));

  return {
    filter_type: 'preset',
    start_date: formatAdminDateOnly(startDate),
    end_date: formatAdminDateOnly(today),
    days: rawRangeDays
  };
}

// GET /api/admin/turfs/:id/earnings - Get daily/monthly earnings for specific turf
router.get('/turfs/:id/earnings', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { period = 'month' } = req.query;
    
    // Daily earnings for last 30 days
    const [dailyEarnings] = await pool.query(
      "SELECT DATE(booking_date) as date, COALESCE(SUM(COALESCE(original_price, amount)), 0) as total FROM bookings WHERE turf_id = ? AND status = 'confirmed' AND payment_status = 'success' AND booking_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) GROUP BY DATE(booking_date) ORDER BY DATE(booking_date) ASC",
      [req.params.id]
    );
    
    // Monthly earnings
    const [monthlyEarnings] = await pool.query(
      "SELECT MONTH(booking_date) as month, YEAR(booking_date) as year, COALESCE(SUM(COALESCE(original_price, amount)), 0) as total FROM bookings WHERE turf_id = ? AND status = 'confirmed' AND payment_status = 'success' GROUP BY YEAR(booking_date), MONTH(booking_date) ORDER BY YEAR(booking_date) DESC, MONTH(booking_date) DESC LIMIT 12",
      [req.params.id]
    );
    
    // Total earnings for this turf
    const [totalResult] = await pool.query(
      "SELECT COALESCE(SUM(COALESCE(original_price, amount)), 0) as total FROM bookings WHERE turf_id = ? AND status = 'confirmed' AND payment_status = 'success'",
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

// GET /api/admin/payouts - Get daily payouts status for all turfs
router.get('/payouts', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const range = resolveAdminRange(req.query);
    if (range.error) {
      return res.status(400).json({ error: range.error });
    }

    // Zero-commission model: owner receives full original_price
    const query = `
      SELECT 
        DATE(b.booking_date) as date,
        t.id as turf_id,
        t.name as turf_name,
        o.name as owner_name,
        COALESCE(SUM(COALESCE(b.original_price, b.amount)), 0) as total_earnings,
        0 as commission_amount,
        COALESCE(SUM(COALESCE(b.advance_amount, b.amount)), 0) as razorpay_collected,
        COALESCE(SUM(COALESCE(b.pending_balance, 0)), 0) as pending_balance,
        COALESCE(SUM(COALESCE(b.pending_balance, GREATEST(COALESCE(b.original_price, b.amount) - COALESCE(b.advance_amount, b.amount), 0))), 0) as venue_cash,
        COALESCE(SUM(COALESCE(b.advance_amount, b.amount)), 0) as owner_payout,
        COALESCE(dp.status, 'not_paid') as status,
        dp.paid_at
      FROM bookings b
      JOIN turfs t ON b.turf_id = t.id
      JOIN owners o ON t.owner_id = o.id
      LEFT JOIN daily_payouts dp ON dp.turf_id = t.id AND dp.payout_date = DATE(b.booking_date)
      WHERE b.status = 'confirmed' AND b.payment_status = 'success' 
        AND DATE(b.booking_date) BETWEEN ? AND ?
      GROUP BY DATE(b.booking_date), t.id, t.name, o.name, dp.status, dp.paid_at
      ORDER BY DATE(b.booking_date) DESC, t.name ASC
    `;
    
    const [rows] = await pool.query(query, [range.start_date, range.end_date]);
    const summary = rows.reduce((acc, row) => {
      acc.total_slot_value += parseFloat(row.total_earnings || 0);
      acc.razorpay_collected += parseFloat(row.razorpay_collected || 0);
      acc.venue_cash += parseFloat(row.venue_cash || row.pending_balance || 0);
      acc.paid_count += row.status === 'paid' ? 1 : 0;
      acc.not_paid_count += row.status === 'paid' ? 0 : 1;
      return acc;
    }, {
      total_slot_value: 0,
      razorpay_collected: 0,
      venue_cash: 0,
      paid_count: 0,
      not_paid_count: 0
    });
    
    res.json({
      payouts: rows,
      summary: {
        filter_type: range.filter_type,
        start_date: range.start_date,
        end_date: range.end_date,
        days: range.days,
        total_slot_value: Math.round(summary.total_slot_value * 100) / 100,
        razorpay_collected: Math.round(summary.razorpay_collected * 100) / 100,
        venue_cash: Math.round(summary.venue_cash * 100) / 100,
        paid_count: summary.paid_count,
        not_paid_count: summary.not_paid_count
      }
    });
  } catch (err) {
    console.error('Error fetching payouts:', err);
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

// POST /api/admin/payouts/mark-paid - Mark a specific day for a turf as paid
router.post('/payouts/mark-paid', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { turf_id, date, status } = req.body;
    
    if (!turf_id || !date || !status) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (status === 'paid') {
      await pool.query(
        `INSERT INTO daily_payouts (turf_id, payout_date, status, paid_at) 
         VALUES (?, ?, 'paid', CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE status = 'paid', paid_at = CURRENT_TIMESTAMP`,
        [turf_id, date]
      );
    } else {
      await pool.query(
        `INSERT INTO daily_payouts (turf_id, payout_date, status, paid_at) 
         VALUES (?, ?, 'not_paid', NULL)
         ON DUPLICATE KEY UPDATE status = 'not_paid', paid_at = NULL`,
        [turf_id, date]
      );
    }
    
    res.json({ success: true, message: 'Payout status updated' });
  } catch (err) {
    console.error('Error updating payout status:', err);
    res.status(500).json({ error: 'Failed to update payout status' });
  }
});

// GET /api/admin/match-requests — Get all match requests for admin
router.get('/match-requests', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [requests] = await pool.query(`
      SELECT r.*, t.name as turf_name, u.name as host_name,
      (SELECT COUNT(*) FROM match_players WHERE match_id = r.id) as player_count
      FROM player_requests r
      JOIN turfs t ON r.turf_id = t.id
      JOIN users u ON r.host_id = u.id
      ORDER BY r.created_at DESC
      LIMIT 100
    `);

    res.json({ requests });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch match requests' });
  }
});


// ========= RAZORPAY & ROUTE MANAGEMENT =========
// GET /api/admin/razorpay-transfers
router.get('/razorpay-transfers', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [transfers] = await pool.query(`
      SELECT r.*, t.name as turf_name, o.name as owner_name
      FROM razorpay_transfers r
      JOIN turfs t ON r.turf_id = t.id
      JOIN owners o ON t.owner_id = o.id
      ORDER BY r.created_at DESC LIMIT 200
    `);
    res.json({ transfers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch razorpay transfers' });
  }
});

// GET /api/admin/turf-subscriptions
router.get('/turf-subscriptions', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [subscriptions] = await pool.query(`
      SELECT s.*, t.name as turf_name, t.monthly_subscription_amount as expected_amount, t.razorpay_linked_account_id
      FROM turf_subscriptions s
      JOIN turfs t ON s.turf_id = t.id
      ORDER BY s.cycle_month DESC, t.name ASC
    `);
    res.json({ subscriptions });
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch turf subscriptions' });
  }
});

module.exports = router;

