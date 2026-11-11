// /api/owner-activities — everything an OWNER (or their scoped scan staff) manages for the ticket-booking engine:
// create/edit activities, ticket types, date inventory, timed-entry windows, add-ons, offers, staff, bookings, and
// QR scanning. Every route below is scoped to the signed-in owner's own activities — never trusts an owner/activity id
// relationship from the body, always re-checks it against the database.
const express = require('express');
const router = express.Router();
router.use((req, res, next) => activityDates(req, res, next));
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { verifyToken, verifyOwner } = require('../middleware/auth');
const { verifyOwnerOrStaff } = require('../middleware/activityAuth');
const activityBooking = require('../services/activityBooking');
const globalConfig = require('../services/globalConfig');
const reports = require('../services/activityReports');
const { rateLimit } = require('../middleware/rateLimit');
const { fire: fireNotification } = require('../utils/notifications/events');

const { makeDateOnlyResponses } = require('../utils/tournamentValidation');
// DATE columns come back as local-midnight Dates that JSON-serialise a day EARLY on an IST server; emit plain YYYY-MM-DD instead.
const activityDates = makeDateOnlyResponses(['booking_date', 'date', 'last_visit']);
// brute-force brakes on the endpoints that take an attacker-guessable token/code (keyed by who is signed in)
const scanLimiter = rateLimit({ windowMs: 60000, max: 120, keyFn: (req) => `${req.ownerId}:${req.staffId || 'owner'}`, message: 'Too many scans. Slow down for a moment.' });
const bad = (res, status, error) => res.status(status).json({ success: false, error });
const slugify = (s, suffix) => `${String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 140)}-${suffix}`;

// Ownership guard used by every /:id/* route below.
async function loadOwnedActivity(req, res, next) {
  const ownerId = req.ownerId || req.user?.id;
  const param = req.params.id;
  const isNum = /^\d+$/.test(String(param));
  const [matches] = await pool.query(
    'SELECT * FROM activities WHERE (id = ? OR slug = ?)',
    [isNum ? Number(param) : 0, param]
  );
  if (matches.length === 0) return bad(res, 404, 'Activity not found');
  const a = matches[0];
  if (Number(a.owner_id) !== Number(ownerId)) {
    return bad(res, 403, 'You do not have permission to manage this venue or activity.');
  }
  req.activity = a;
  req.params.id = a.id;
  next();
}

// ================================================================= activities
router.get('/', verifyToken, verifyOwner, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, c.key_name AS category, c.label AS category_label,
              (SELECT COUNT(*) FROM activity_bookings WHERE activity_id = a.id AND status = 'confirmed') AS confirmed_bookings
       FROM activities a JOIN activity_categories c ON c.id = a.category_id WHERE a.owner_id = ? ORDER BY a.id DESC`, [req.user.id]
    );
    res.json({ success: true, activities: rows });
  } catch (e) { console.error('owner activities list:', e.message); bad(res, 500, 'Could not load your activities'); }
});

router.post('/', verifyToken, verifyOwner, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.category_id) return bad(res, 400, 'Name and category are required');
    const [[cat]] = await pool.query('SELECT id FROM activity_categories WHERE id = ? AND is_active = true', [b.category_id]);
    if (!cat) return bad(res, 400, 'Invalid category');
    const geo = await globalConfig.resolveVenueGeo({ country_code: b.country_code, timezone: b.timezone });
    if (geo.error) return bad(res, 400, geo.error);
    const slug = slugify(b.name, crypto.randomBytes(3).toString('hex'));
    const [ins] = await pool.query(
      `INSERT INTO activities (owner_id, category_id, name, slug, description, location, address, latitude, longitude, phone, email, images, videos, opening_days, opening_time, closing_time, age_restriction_min, rules, facilities, cancellation_policy, terms, timed_entry_enabled, ticket_qr_mode, partial_entry_enabled, cancellation_hours_before, refund_percent, tax_percent, qr_validity_mode, qr_valid_from, qr_valid_until, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [req.user.id, b.category_id, String(b.name).slice(0, 150), slug, b.description || null, b.location || null, b.address || null,
        b.latitude || null, b.longitude || null, b.phone || null, b.email || null, JSON.stringify(b.images || []), JSON.stringify(b.videos || []),
        JSON.stringify(b.opening_days || []), b.opening_time || '09:00:00', b.closing_time || '20:00:00', b.age_restriction_min || null,
        b.rules || null, JSON.stringify(b.facilities || []), b.cancellation_policy || null, b.terms || null,
        !!b.timed_entry_enabled, ['single', 'per_ticket'].includes(b.ticket_qr_mode) ? b.ticket_qr_mode : 'single', !!b.partial_entry_enabled,
        b.cancellation_hours_before === '' ? null : (b.cancellation_hours_before ?? null), b.refund_percent ?? 100, b.tax_percent ?? 0,
        ['day', 'hours', 'custom'].includes(b.qr_validity_mode) ? b.qr_validity_mode : 'hours', b.qr_valid_from || null, b.qr_valid_until || null]
    );
    await pool.query('UPDATE activities SET country_code = ?, currency_code = ?, timezone = ?, city = ?, state_province = ? WHERE id = ?', [geo.country_code, geo.currency_code, geo.timezone, b.city ? String(b.city).slice(0, 80) : null, b.state_province ? String(b.state_province).slice(0, 80) : null, ins.insertId]);
    fireNotification('owner.activity_created', { activityId: ins.insertId });
    const activity = {
      id: ins.insertId,
      name: String(b.name).slice(0, 150),
      slug,
      images: Array.isArray(b.images) ? b.images : [],
      location: b.location || null,
      city: b.city ? String(b.city).slice(0, 80) : null,
      status: 'pending',
      country_code: geo.country_code,
      currency_code: geo.currency_code,
      timezone: geo.timezone,
    };
    res.json({ success: true, activity_id: ins.insertId, slug, activity, country_code: geo.country_code, currency_code: geo.currency_code, timezone: geo.timezone });
  } catch (e) { console.error('create activity:', e.message); bad(res, 500, 'Could not create this activity'); }
});

// Single-segment GET routes declared before /:id — otherwise Express would treat them as an activity id.
router.get('/today', verifyToken, verifyOwner, async (req, res) => {
  try {
    // 'today' is the server's local calendar day, not the DB's (UTC) CURDATE(): they differ for the first 5.5h of an IST day
    const where = ["b.owner_id = ?", "b.booking_date = ?", "b.status = 'confirmed'"]; const params = [req.user.id, reports.ymd(new Date())];
    if (req.query.activity_id) { where.push('b.activity_id = ?'); params.push(req.query.activity_id); }
    const [[stats]] = await pool.query(`SELECT COUNT(*) AS bookings, COALESCE(SUM(b.total_amount),0) AS revenue FROM activity_bookings b WHERE ${where.join(' AND ')}`, params);
    const [[tix]] = await pool.query(
      `SELECT COALESCE(SUM(t.quantity_covered),0) AS tickets, COALESCE(SUM(t.redeemed_quantity),0) AS entries
       FROM activity_tickets t JOIN activity_bookings b ON b.id = t.booking_id WHERE ${where.join(' AND ')}`, params
    );
    const currencies = await reports.ownerCurrencies(req.user.id, req.query.activity_id ? Number(req.query.activity_id) : null);
    res.json({
      success: true,
      currency: (currencies && currencies[0]) || 'INR',
      bookings: (stats && stats.bookings) || 0,
      revenue: Number((stats && stats.revenue) || 0),
      tickets: Number((tix && tix.tickets) || 0),
      entries: Number((tix && tix.entries) || 0)
    });
  } catch (e) {
    console.error('owner activities today stats error:', e.message);
    res.json({ success: true, currency: 'INR', bookings: 0, revenue: 0, tickets: 0, entries: 0 });
  }
});
// ---- single/two-segment routes: all declared before /:id so they are never mistaken for an activity id ----
router.get('/analytics', verifyToken, verifyOwner, async (req, res) => {
  try {
    res.json({ success: true, ...(await reports.analytics({ ownerId: req.user.id, activityId: req.query.activity_id ? Number(req.query.activity_id) : null })) });
  } catch (e) { console.error('activity analytics:', e.message); bad(res, 500, 'Could not load analytics'); }
});
router.get('/reports/:type', verifyToken, verifyOwner, async (req, res) => {
  try {
    const r = await reports.buildReport({ ownerId: req.user.id, activityId: req.query.activity_id ? Number(req.query.activity_id) : null, type: req.params.type, from: req.query.from, to: req.query.to, format: req.query.format === 'xls' ? 'xls' : 'csv' });
    if (r.error) return bad(res, 400, r.error);
    res.set('Content-Type', r.contentType);
    res.set('Content-Disposition', `attachment; filename="${r.filename}"`);
    res.send(r.body);
  } catch (e) { console.error('activity report:', e.message); bad(res, 500, 'Could not build this report'); }
});
const YMD = /^\d{4}-\d{2}-\d{2}$/;
// All the owner's bookings (every activity) with filters: range=today|tomorrow|week, from/to (entry date), q=search, status, activity_id
router.get('/bookings', verifyToken, verifyOwner, async (req, res) => {
  try {
    const where = ['b.owner_id = ?']; const params = [req.user.id];
    const dayStr = (n) => reports.ymd(new Date(Date.now() + n * 86400000));
    if (req.query.range === 'today') { where.push('b.booking_date = ?'); params.push(dayStr(0)); }
    else if (req.query.range === 'tomorrow') { where.push('b.booking_date = ?'); params.push(dayStr(1)); }
    else if (req.query.range === 'week') { where.push('b.booking_date BETWEEN ? AND ?'); params.push(dayStr(0), dayStr(6)); }
    if (YMD.test(req.query.from || '')) { where.push('b.booking_date >= ?'); params.push(req.query.from); }
    if (YMD.test(req.query.to || '')) { where.push('b.booking_date <= ?'); params.push(req.query.to); }
    if (req.query.status) { where.push('b.status = ?'); params.push(req.query.status); }
    else where.push("b.status <> 'pending'"); // an unpaid, abandoned checkout is not a booking from the owner's point of view
    if (req.query.activity_id) { where.push('b.activity_id = ?'); params.push(Number(req.query.activity_id)); }
    if (req.query.q) {
      const like = `%${String(req.query.q).trim().slice(0, 60)}%`;
      where.push('(b.booking_code LIKE ? OR b.customer_name LIKE ? OR b.customer_phone LIKE ? OR EXISTS (SELECT 1 FROM activity_booking_items bi JOIN activity_ticket_types tt ON tt.id = bi.ticket_type_id WHERE bi.booking_id = b.id AND tt.name LIKE ?))');
      params.push(like, like, like, like);
    }
    const [rows] = await pool.query(
      `SELECT b.*, a.name AS activity_name,
              (SELECT COALESCE(SUM(quantity),0) FROM activity_booking_items WHERE booking_id = b.id) AS ticket_count,
              (SELECT GROUP_CONCAT(CONCAT(tt.name, ' x', bi.quantity) SEPARATOR ', ') FROM activity_booking_items bi JOIN activity_ticket_types tt ON tt.id = bi.ticket_type_id WHERE bi.booking_id = b.id) AS ticket_summary,
              (SELECT CASE WHEN COUNT(*) = 0 THEN NULL WHEN SUM(CASE WHEN t.status = 'COMPLETED' THEN 1 ELSE 0 END) = COUNT(*) THEN 'COMPLETED' ELSE MAX(t.status) END FROM activity_tickets t WHERE t.booking_id = b.id) AS qr_status
       FROM activity_bookings b JOIN activities a ON a.id = b.activity_id WHERE ${where.join(' AND ')} ORDER BY b.booking_date DESC, b.id DESC LIMIT 300`, params
    );
    res.json({ success: true, bookings: rows });
  } catch (e) { console.error('owner bookings:', e.message); bad(res, 500, 'Could not load bookings'); }
});
router.get('/customers', verifyToken, verifyOwner, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT COALESCE(customer_phone, customer_email, customer_name) AS ident, MAX(customer_name) AS name, MAX(customer_phone) AS phone,
              COUNT(*) AS bookings, COALESCE(SUM(total_amount),0) AS spent, MAX(booking_date) AS last_visit
       FROM activity_bookings WHERE owner_id = ? AND status = 'confirmed' GROUP BY ident ORDER BY spent DESC LIMIT 200`, [req.user.id]
    );
    const currencies = await reports.ownerCurrencies(req.user.id);
    res.json({ success: true, currency: currencies[0] || 'INR', customers: rows.map((r) => ({ name: r.name, phone: r.phone, bookings: Number(r.bookings), spent: Number(r.spent), last_visit: r.last_visit })) });
  } catch (e) { console.error('owner customers:', e.message); bad(res, 500, 'Could not load customers'); }
});
// What staff may see: today's entries (and the owner too). Nothing else about the business.
router.get('/entries/today', verifyOwnerOrStaff, async (req, res) => {
  try {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0); const dayStartEpoch = Math.floor(midnight.getTime() / 1000);
    const [rows] = await pool.query(
      `SELECT l.id, l.quantity_redeemed, l.note, UNIX_TIMESTAMP(l.created_at) AS ts, b.booking_code, b.customer_name, a.name AS activity_name, COALESCE(s.name, 'Owner') AS scanned_by
       FROM activity_qr_scan_logs l JOIN activity_tickets t ON t.id = l.ticket_id JOIN activity_bookings b ON b.id = t.booking_id JOIN activities a ON a.id = t.activity_id
       LEFT JOIN activity_staff s ON s.id = l.scanned_by_staff_id
       WHERE t.owner_id = ? AND l.result = 'VALID' AND UNIX_TIMESTAMP(l.created_at) >= ? ORDER BY l.id DESC LIMIT 200`, [req.ownerId, dayStartEpoch]
    );
    res.json({ success: true, entries: rows.map((r) => ({ id: r.id, booking_code: r.booking_code, customer_name: r.customer_name, activity_name: r.activity_name, quantity: r.quantity_redeemed, scanned_by: r.scanned_by, manual: String(r.note || '').startsWith('MANUAL_VERIFICATION'), at: new Date(Number(r.ts) * 1000).toISOString() })) });
  } catch (e) { console.error('entries today:', e.message); bad(res, 500, 'Could not load entries'); }
});
router.get('/staff', verifyToken, verifyOwner, async (req, res) => {
  const [rows] = await pool.query('SELECT id, name, email, phone, role, is_active, created_at FROM activity_staff WHERE owner_id = ? ORDER BY id DESC', [req.user.id]);
  res.json({ success: true, staff: rows });
});

router.get('/:id', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  const [ticketTypes] = await pool.query('SELECT * FROM activity_ticket_types WHERE activity_id = ? ORDER BY sort_order', [req.params.id]);
  const [addons] = await pool.query('SELECT * FROM activity_addons WHERE activity_id = ? ORDER BY sort_order', [req.params.id]);
  const [offers] = await pool.query('SELECT * FROM activity_offers WHERE activity_id = ?', [req.params.id]);
  res.json({ success: true, activity: req.activity, ticket_types: ticketTypes, addons, offers });
});

const EDITABLE_FIELDS = ['name', 'description', 'location', 'address', 'latitude', 'longitude', 'phone', 'email', 'images', 'videos', 'opening_days', 'opening_time', 'closing_time', 'age_restriction_min', 'rules', 'facilities', 'cancellation_policy', 'terms', 'timed_entry_enabled', 'ticket_qr_mode', 'partial_entry_enabled', 'cancellation_hours_before', 'refund_percent', 'tax_percent', 'qr_validity_mode', 'qr_valid_from', 'qr_valid_until'];
const JSON_FIELDS = new Set(['images', 'videos', 'opening_days', 'facilities']);
router.put('/:id', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.refund_percent !== undefined && !(Number(b.refund_percent) >= 0 && Number(b.refund_percent) <= 100)) return bad(res, 400, 'refund_percent must be between 0 and 100');
    if (b.tax_percent !== undefined && !(Number(b.tax_percent) >= 0 && Number(b.tax_percent) <= 50)) return bad(res, 400, 'tax_percent must be between 0 and 50');
    if (b.qr_validity_mode !== undefined && !['day', 'hours', 'custom'].includes(b.qr_validity_mode)) return bad(res, 400, 'qr_validity_mode must be day, hours or custom');
    if (b.ticket_qr_mode !== undefined && !['single', 'per_ticket'].includes(b.ticket_qr_mode)) return bad(res, 400, 'ticket_qr_mode must be single or per_ticket');
    if (b.qr_validity_mode === 'custom' && !(b.qr_valid_from && b.qr_valid_until) && !(req.activity.qr_valid_from && req.activity.qr_valid_until)) return bad(res, 400, 'Custom QR validity needs a start and end time');
    if (b.cancellation_hours_before === '') b.cancellation_hours_before = null;
    let geoUpdate = null;
    if (b.country_code !== undefined || b.timezone !== undefined) {
      const geo = await globalConfig.resolveVenueGeo({ country_code: b.country_code || req.activity.country_code, timezone: b.timezone });
      if (geo.error) return bad(res, 400, geo.error);
      if (geo.currency_code !== req.activity.currency_code) {
        const [[used]] = await pool.query("SELECT COUNT(*) AS c FROM activity_bookings WHERE activity_id = ? AND status = 'confirmed' AND total_amount > 0", [req.params.id]);
        if (used.c > 0) return bad(res, 400, `This activity already has paid bookings in ${req.activity.currency_code}, so its country/currency can no longer be changed.`);
      }
      geoUpdate = geo;
    }
    const sets = []; const params = [];
    for (const f of EDITABLE_FIELDS) {
      if (b[f] === undefined) continue;
      sets.push(`${f} = ?`); params.push(JSON_FIELDS.has(f) ? JSON.stringify(b[f]) : b[f]);
    }
    if (sets.length === 0 && !geoUpdate && b.city === undefined && b.state_province === undefined) return bad(res, 400, 'Nothing to update');
    if (sets.length) await pool.query(`UPDATE activities SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
    if (geoUpdate) await pool.query('UPDATE activities SET country_code = ?, currency_code = ?, timezone = ? WHERE id = ?', [geoUpdate.country_code, geoUpdate.currency_code, geoUpdate.timezone, req.params.id]);
    if (b.city !== undefined) await pool.query('UPDATE activities SET city = ? WHERE id = ?', [b.city ? String(b.city).slice(0, 80) : null, req.params.id]);
    if (b.state_province !== undefined) await pool.query('UPDATE activities SET state_province = ? WHERE id = ?', [b.state_province ? String(b.state_province).slice(0, 80) : null, req.params.id]);
    res.json({ success: true });
  } catch (e) { console.error('update activity:', e.message); bad(res, 500, 'Could not update this activity'); }
});

// ================================================================= ticket types
router.get('/:id/ticket-types', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM activity_ticket_types WHERE activity_id = ? ORDER BY sort_order', [req.params.id]);
  res.json({ success: true, ticket_types: rows });
});
router.post('/:id/ticket-types', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || b.price == null || Number(b.price) < 0) return bad(res, 400, 'A ticket name and a valid price are required');
    if (b.product_type !== undefined && !['ENTRY', 'RIDE', 'ACTIVITY', 'PASS'].includes(b.product_type)) return bad(res, 400, 'product_type must be ENTRY, RIDE, ACTIVITY or PASS');
    if (b.image_url != null && (typeof b.image_url !== 'string' || b.image_url.length > 500)) return bad(res, 400, 'image_url must be a valid image URL');
    const [ins] = await pool.query(
      'INSERT INTO activity_ticket_types (activity_id, name, description, price, weekend_price, min_quantity, max_quantity, age_min, age_max, sort_order, image_url, product_type, requires_entry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.params.id, String(b.name).slice(0, 60), b.description || null, Number(b.price), b.weekend_price != null ? Number(b.weekend_price) : null, b.min_quantity || 1, b.max_quantity || 10, b.age_min || null, b.age_max || null, b.sort_order || 0, b.image_url || null, ['ENTRY', 'RIDE', 'ACTIVITY', 'PASS'].includes(b.product_type) ? b.product_type : 'ENTRY', !!b.requires_entry]
    );
    res.json({ success: true, ticket_type_id: ins.insertId });
  } catch (e) { console.error('create ticket type:', e.message); bad(res, 500, 'Could not create this ticket type'); }
});
router.put('/:id/ticket-types/:ttId', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.price !== undefined && !(Number(b.price) >= 0)) return bad(res, 400, 'price must be a non-negative number');
    if (b.weekend_price != null && !(Number(b.weekend_price) >= 0)) return bad(res, 400, 'weekend_price must be a non-negative number');
    if (b.product_type !== undefined && !['ENTRY', 'RIDE', 'ACTIVITY', 'PASS'].includes(b.product_type)) return bad(res, 400, 'product_type must be ENTRY, RIDE, ACTIVITY or PASS');
    if (b.image_url !== undefined && b.image_url !== null && (typeof b.image_url !== 'string' || b.image_url.length > 500)) return bad(res, 400, 'image_url must be a valid image URL');
    const fields = ['name', 'description', 'price', 'weekend_price', 'min_quantity', 'max_quantity', 'age_min', 'age_max', 'is_active', 'sort_order', 'image_url', 'product_type', 'requires_entry'];
    const sets = []; const params = [];
    for (const f of fields) { if (b[f] !== undefined) { sets.push(`${f} = ?`); params.push(b[f]); } }
    if (sets.length === 0) return bad(res, 400, 'Nothing to update');
    const [r] = await pool.query(`UPDATE activity_ticket_types SET ${sets.join(', ')} WHERE id = ? AND activity_id = ?`, [...params, req.params.ttId, req.params.id]);
    if (r.affectedRows === 0) return bad(res, 404, 'Ticket type not found');
    res.json({ success: true });
  } catch (e) { console.error('update ticket type:', e.message); bad(res, 500, 'Could not update this ticket type'); }
});

// ================================================================= inventory (date-based capacity)
router.get('/:id/inventory', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  const { from, to } = req.query;
  const where = ['i.activity_id = ?']; const params = [req.params.id];
  if (from) { where.push('i.date >= ?'); params.push(from); }
  if (to) { where.push('i.date <= ?'); params.push(to); }
  const [rows] = await pool.query(`SELECT i.*, t.name AS ticket_type_name FROM activity_inventory i JOIN activity_ticket_types t ON t.id = i.ticket_type_id WHERE ${where.join(' AND ')} ORDER BY i.date`, params);
  res.json({ success: true, inventory: rows });
});
// POST .../inventory/bulk { ticket_type_id, start_date, end_date, capacity }  — sets the SAME capacity for every date in the range
router.post('/:id/inventory/bulk', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  try {
    const { ticket_type_id, start_date, end_date, capacity } = req.body || {};
    if (!ticket_type_id || !start_date || !end_date || !(Number(capacity) >= 0)) return bad(res, 400, 'ticket_type_id, start_date, end_date and a non-negative capacity are required');
    const [[tt]] = await pool.query('SELECT id FROM activity_ticket_types WHERE id = ? AND activity_id = ?', [ticket_type_id, req.params.id]);
    if (!tt) return bad(res, 404, 'Ticket type not found');
    if (end_date < start_date) return bad(res, 400, 'end_date must not be before start_date');
    const dates = [];
    for (let d = new Date(`${start_date}T00:00:00Z`); d <= new Date(`${end_date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
    if (dates.length > 366) return bad(res, 400, 'Range too large (max 366 days at a time)');
    // optional per-date overrides (festival / peak pricing, closing). Only touched when sent, so re-setting capacity
    // later never silently wipes a festival price the owner already configured.
    const b = req.body || {};
    if (b.special_price != null && !(Number(b.special_price) >= 0)) return bad(res, 400, 'special_price must be a non-negative number');
    const extraCols = []; const extraVals = [];
    if (b.special_price !== undefined) { extraCols.push('special_price'); extraVals.push(b.special_price); }
    if (b.is_closed !== undefined) { extraCols.push('is_closed'); extraVals.push(!!b.is_closed); }
    const insertCols = ['activity_id', 'ticket_type_id', 'date', 'capacity', ...extraCols];
    const updates = ['capacity = VALUES(capacity)', ...extraCols.map((c) => `${c} = VALUES(${c})`)];
    for (const date of dates) {
      await pool.query(`INSERT INTO activity_inventory (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${updates.join(', ')}`, [req.params.id, ticket_type_id, date, capacity, ...extraVals]);
    }
    res.json({ success: true, dates_set: dates.length });
  } catch (e) { console.error('bulk inventory:', e.message); bad(res, 500, 'Could not set inventory'); }
});
// POST .../inventory/block { start_date, end_date, is_closed? } — close (or reopen) every already-opened ticket type for a date range
router.post('/:id/inventory/block', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  try {
    const { start_date, end_date, is_closed } = req.body || {};
    if (!YMD.test(start_date || '') || !YMD.test(end_date || '') || end_date < start_date) return bad(res, 400, 'start_date and end_date (YYYY-MM-DD, end not before start) are required');
    const [r] = await pool.query('UPDATE activity_inventory SET is_closed = ? WHERE activity_id = ? AND date BETWEEN ? AND ?', [is_closed === false ? false : true, req.params.id, start_date, end_date]);
    res.json({ success: true, rows_changed: r.affectedRows });
  } catch (e) { console.error('block dates:', e.message); bad(res, 500, 'Could not update those dates'); }
});
// POST .../disable | .../enable — the owner pauses/resumes their own LIVE listing. Enabling only restores something an
// admin already approved; it can never publish something that was never approved or that an admin suspended.
router.post('/:id/disable', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  if (req.activity.status !== 'approved') return bad(res, 400, 'Only a live activity can be paused');
  await pool.query("UPDATE activities SET status = 'draft' WHERE id = ?", [req.params.id]);
  res.json({ success: true });
});
router.post('/:id/enable', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  if (req.activity.status !== 'draft' || !req.activity.approved_at) return bad(res, 400, 'Only an activity you paused (that was already approved) can be re-enabled');
  await pool.query("UPDATE activities SET status = 'approved' WHERE id = ?", [req.params.id]);
  res.json({ success: true });
});
router.put('/:id/inventory/:invId', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  try {
    const b = req.body || {};
    const fields = ['capacity', 'is_closed', 'special_price'];
    const sets = []; const params = [];
    for (const f of fields) { if (b[f] !== undefined) { sets.push(`${f} = ?`); params.push(b[f]); } }
    if (sets.length === 0) return bad(res, 400, 'Nothing to update');
    const [r] = await pool.query(`UPDATE activity_inventory SET ${sets.join(', ')} WHERE id = ? AND activity_id = ?`, [...params, req.params.invId, req.params.id]);
    if (r.affectedRows === 0) return bad(res, 404, 'Inventory row not found');
    res.json({ success: true });
  } catch (e) { console.error('update inventory:', e.message); bad(res, 500, 'Could not update inventory'); }
});

// ================================================================= timed entry windows
router.get('/:id/time-windows', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  const where = ['activity_id = ?']; const params = [req.params.id];
  if (req.query.date) { where.push('date = ?'); params.push(req.query.date); }
  const [rows] = await pool.query(`SELECT * FROM activity_time_windows WHERE ${where.join(' AND ')} ORDER BY date, start_time`, params);
  res.json({ success: true, time_windows: rows });
});
router.post('/:id/time-windows', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  try {
    const { date, start_time, end_time, capacity } = req.body || {};
    if (!date || !start_time || !end_time || !(Number(capacity) > 0)) return bad(res, 400, 'date, start_time, end_time and a positive capacity are required');
    const [ins] = await pool.query('INSERT INTO activity_time_windows (activity_id, date, start_time, end_time, capacity) VALUES (?, ?, ?, ?, ?)', [req.params.id, date, start_time, end_time, capacity]);
    res.json({ success: true, time_window_id: ins.insertId });
  } catch (e) { console.error('create time window:', e.message); bad(res, 500, 'Could not create this time window'); }
});
router.delete('/:id/time-windows/:windowId', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  const [[w]] = await pool.query('SELECT sold FROM activity_time_windows WHERE id = ? AND activity_id = ?', [req.params.windowId, req.params.id]);
  if (!w) return bad(res, 404, 'Time window not found');
  if (w.sold > 0) return bad(res, 400, 'Cannot delete a time window that already has bookings');
  await pool.query('DELETE FROM activity_time_windows WHERE id = ?', [req.params.windowId]);
  res.json({ success: true });
});

// ================================================================= add-ons
router.get('/:id/addons', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM activity_addons WHERE activity_id = ? ORDER BY sort_order', [req.params.id]);
  res.json({ success: true, addons: rows });
});
router.post('/:id/addons', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  try {
    const { name, price } = req.body || {};
    if (!name || !(Number(price) >= 0)) return bad(res, 400, 'name and a non-negative price are required');
    const [ins] = await pool.query('INSERT INTO activity_addons (activity_id, name, price) VALUES (?, ?, ?)', [req.params.id, String(name).slice(0, 60), Number(price)]);
    res.json({ success: true, addon_id: ins.insertId });
  } catch (e) { bad(res, 500, 'Could not create this add-on'); }
});
router.put('/:id/addons/:addonId', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  const b = req.body || {}; const sets = []; const params = [];
  for (const f of ['name', 'price', 'is_active', 'sort_order']) { if (b[f] !== undefined) { sets.push(`${f} = ?`); params.push(b[f]); } }
  if (sets.length === 0) return bad(res, 400, 'Nothing to update');
  const [r] = await pool.query(`UPDATE activity_addons SET ${sets.join(', ')} WHERE id = ? AND activity_id = ?`, [...params, req.params.addonId, req.params.id]);
  if (r.affectedRows === 0) return bad(res, 404, 'Add-on not found');
  res.json({ success: true });
});

// ================================================================= offers (mirrors routes/coupons.js's model, scoped to one activity)
router.get('/:id/offers', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM activity_offers WHERE activity_id = ? ORDER BY id DESC', [req.params.id]);
  res.json({ success: true, offers: rows });
});
router.post('/:id/offers', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.code || !['flat', 'percentage'].includes(b.discount_type) || !(Number(b.discount_value) > 0)) return bad(res, 400, 'code, discount_type (flat/percentage) and a positive discount_value are required');
    if (b.discount_type === 'percentage' && Number(b.discount_value) > 100) return bad(res, 400, 'A percentage discount cannot exceed 100');
    const [ins] = await pool.query(
      'INSERT INTO activity_offers (activity_id, code, label, discount_type, discount_value, min_amount, max_discount_cap, valid_from, valid_until, max_uses, per_user_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.params.id, String(b.code).trim().toUpperCase().slice(0, 40), b.label || null, b.discount_type, Number(b.discount_value), b.min_amount || 0, b.max_discount_cap || null, b.valid_from || null, b.valid_until || null, b.max_uses || null, b.per_user_limit || null]
    );
    res.json({ success: true, offer_id: ins.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return bad(res, 400, 'This code already exists for this activity');
    console.error('create offer:', e.message); bad(res, 500, 'Could not create this offer');
  }
});
router.put('/:id/offers/:offerId', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  const b = req.body || {}; const sets = []; const params = [];
  for (const f of ['label', 'discount_value', 'min_amount', 'max_discount_cap', 'valid_from', 'valid_until', 'max_uses', 'per_user_limit', 'is_active']) { if (b[f] !== undefined) { sets.push(`${f} = ?`); params.push(b[f]); } }
  if (sets.length === 0) return bad(res, 400, 'Nothing to update');
  const [r] = await pool.query(`UPDATE activity_offers SET ${sets.join(', ')} WHERE id = ? AND activity_id = ?`, [...params, req.params.offerId, req.params.id]);
  if (r.affectedRows === 0) return bad(res, 404, 'Offer not found');
  res.json({ success: true });
});

// ================================================================= bookings
router.get('/:id/bookings', verifyToken, verifyOwner, loadOwnedActivity, async (req, res) => {
  const where = ['activity_id = ?']; const params = [req.params.id];
  if (req.query.date) { where.push('booking_date = ?'); params.push(req.query.date); }
  if (req.query.status) { where.push('status = ?'); params.push(req.query.status); }
  const [rows] = await pool.query(`SELECT * FROM activity_bookings WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 200`, params);
  res.json({ success: true, bookings: rows });
});
router.get('/bookings/:bookingId', verifyToken, verifyOwner, async (req, res) => {
  const [[b]] = await pool.query('SELECT b.*, a.name AS activity_name FROM activity_bookings b JOIN activities a ON a.id = b.activity_id WHERE b.id = ? AND b.owner_id = ?', [req.params.bookingId, req.user.id]);
  if (!b) return bad(res, 404, 'Booking not found');
  const [items] = await pool.query('SELECT ti.name, bi.quantity, bi.unit_price FROM activity_booking_items bi JOIN activity_ticket_types ti ON ti.id = bi.ticket_type_id WHERE bi.booking_id = ?', [b.id]);
  const [tickets] = await pool.query('SELECT qr_token, quantity_covered, redeemed_quantity, status FROM activity_tickets WHERE booking_id = ?', [b.id]);
  res.json({ success: true, booking: b, items, tickets });
});
router.put('/bookings/:bookingId/cancel', verifyToken, verifyOwner, async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || 'Other';
    const r = await require('../services/cancellation').cancel({ type: 'activity', id: Number(req.params.bookingId), actor: { kind: 'owner', id: req.user.id }, reason });
    if (r.error) return bad(res, r.status || 400, r.error);
    const q = r.view;
    res.json({ success: true, already_cancelled: !!r.alreadyCancelled, currency: q.currency, refund_amount: q.refund_amount || 0, quote: q, message: q.refund_amount > 0 ? 'Cancelled. The customer is being refunded in full.' : 'Cancelled.' });
  } catch (e) { console.error('owner cancel:', e.message); bad(res, 500, 'Could not cancel this booking'); }
});

// ================================================================= QR scanning (owner OR scoped staff)
// POST { qr_token, quantity?, preview? }
router.post('/scan', verifyOwnerOrStaff, scanLimiter, async (req, res) => {
  try {
    const { qr_token, quantity, preview, manual, booking_item_id, bookingItemId, redeem_all, redeemAll } = req.body || {};
    if (!qr_token || typeof qr_token !== 'string') return bad(res, 400, 'qr_token is required');
    const result = await activityBooking.redeemTicket({
      qrToken: qr_token,
      ownerId: req.ownerId,
      staffId: req.staffId,
      quantity,
      markComplete: !preview,
      manual: !!manual,
      bookingItemId: booking_item_id || bookingItemId,
      redeemAll: !!(redeem_all || redeemAll)
    });
    if (result.ok && !preview && result.ticket) fireNotification('activity.ticket_redeemed', { ticketId: result.ticket.id, redeemed: result.quantity_redeemed });
    res.json({ success: result.ok, ...result });
  } catch (e) { console.error('scan:', e.message); bad(res, 500, 'Could not process this scan'); }
});
router.get('/lookup/:bookingCode', verifyOwnerOrStaff, scanLimiter, async (req, res) => {
  const [[b]] = await pool.query('SELECT * FROM activity_bookings WHERE booking_code = ? AND owner_id = ?', [req.params.bookingCode, req.ownerId]);
  if (!b) return bad(res, 404, 'Booking not found');
  const [tickets] = await pool.query('SELECT * FROM activity_tickets WHERE booking_id = ?', [b.id]);
  const [items] = await pool.query('SELECT bi.*, tt.name AS ticket_name, tt.product_type FROM activity_booking_items bi LEFT JOIN activity_ticket_types tt ON tt.id = bi.ticket_type_id WHERE bi.booking_id = ?', [b.id]);
  await pool.query('INSERT INTO activity_qr_scan_logs (ticket_id, qr_token_tried, scanned_by_owner_id, scanned_by_staff_id, result, note) VALUES (?, NULL, ?, ?, ?, ?)', [tickets[0] ? tickets[0].id : null, req.ownerId, req.staffId, 'MANUAL_LOOKUP', `booking ${b.booking_code}`]);
  res.json({ success: true, booking: b, tickets, items });
});

// ================================================================= staff (owner-only to manage; staff never manage staff)
// (GET /staff is declared above, alongside /today, before /:id.)
router.post('/staff', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body || {};
    if (!name || !email || !password || password.length < 6) return bad(res, 400, 'name, email and a password of at least 6 characters are required');
    const hash = await bcrypt.hash(password, 10);
    const [ins] = await pool.query('INSERT INTO activity_staff (owner_id, name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)', [req.user.id, name, String(email).toLowerCase().trim(), phone || null, hash, role === 'MANAGER' ? 'MANAGER' : 'ENTRY_STAFF']);
    res.json({ success: true, staff_id: ins.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return bad(res, 400, 'A staff account with this email already exists for you');
    bad(res, 500, 'Could not create this staff account');
  }
});
router.patch('/staff/:staffId', verifyToken, verifyOwner, async (req, res) => {
  const b = req.body || {}; const sets = []; const params = [];
  if (b.is_active !== undefined) { sets.push('is_active = ?'); params.push(!!b.is_active); }
  if (b.role !== undefined && ['MANAGER', 'ENTRY_STAFF'].includes(b.role)) { sets.push('role = ?'); params.push(b.role); }
  if (sets.length === 0) return bad(res, 400, 'Nothing to update');
  const [r] = await pool.query(`UPDATE activity_staff SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`, [...params, req.params.staffId, req.user.id]);
  if (r.affectedRows === 0) return bad(res, 404, 'Staff account not found');
  res.json({ success: true });
});

module.exports = router;
