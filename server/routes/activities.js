// /api/activities — PUBLIC discovery/detail for the ticket-booking engine, plus the CUSTOMER booking flow
// (price preview -> order -> verify -> QR ticket) and "my tickets". Owner management lives in routes/owner-activities.js;
// admin moderation in routes/admin-activities.js. This file never trusts a client-sent price — see services/activityBooking.js.
const express = require('express');
const router = express.Router();
router.use((req, res, next) => activityDates(req, res, next));
const crypto = require('crypto');
const pool = require('../config/db');
const { verifyToken, verifyCustomer, optionalAuth } = require('../middleware/auth');
const activityBooking = require('../services/activityBooking');
const { fire: fireNotification } = require('../utils/notifications/events');
const { rateLimit } = require('../middleware/rateLimit');
// Keyed by who is acting, not by IP: behind a proxy every customer shares one IP, so an IP key would throttle everybody together.
const whoKey = (req) => (req.user && req.user.id ? `u${req.user.role || 'user'}${req.user.id}` : `ip${req.ip}`);
const checkoutLimiter = rateLimit({ windowMs: 60000, max: 120, keyFn: whoKey, message: 'Too many booking attempts. Please wait a minute.' });
// payment verification is keyed by the booking being verified (the thing an attacker would be guessing signatures for)
const verifyLimiter = rateLimit({ windowMs: 60000, max: 30, keyFn: (req) => `b${(req.body && req.body.booking_id) || req.ip}`, message: 'Too many verification attempts for this booking.' });
const lookupLimiter = rateLimit({ windowMs: 60000, max: 60, keyFn: whoKey });

const { makeDateOnlyResponses } = require('../utils/tournamentValidation');
// DATE columns come back as local-midnight Dates that JSON-serialise a day EARLY on an IST server; emit plain YYYY-MM-DD instead.
const activityDates = makeDateOnlyResponses(['booking_date', 'date', 'last_visit']);
const bad = (res, status, error) => res.status(status).json({ success: false, error });

// GET /categories
router.get('/categories', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, key_name, label, icon FROM activity_categories WHERE is_active = true ORDER BY sort_order');
    res.json({ success: true, categories: rows });
  } catch (e) { bad(res, 500, 'Could not load categories'); }
});

// GET /?category=&location=&search=&section=trending|popular|weekend|family|friends|deals&lat=&lng=&sort=nearest — approved activities only
const FAMILY_CATS = ['AMUSEMENT_PARK', 'WATER_PARK', 'KIDS_PLAY', 'TRAMPOLINE'];
const FRIENDS_CATS = ['GO_KARTING', 'BOWLING', 'GAMING_ZONE', 'ESCAPE_ROOM', 'ADVENTURE', 'TRAMPOLINE'];
const pad2 = (n) => String(n).padStart(2, '0');
const localYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
router.get('/', async (req, res) => {
  try {
    const where = ["a.status = 'approved'"]; const params = [];
    if (req.query.category) { where.push('c.key_name = ?'); params.push(req.query.category); }
    if (req.query.location) { where.push('a.location LIKE ?'); params.push(`%${req.query.location}%`); }
    if (req.query.search) { where.push('(a.name LIKE ? OR a.location LIKE ?)'); params.push(`%${req.query.search}%`, `%${req.query.search}%`); }
    const section = String(req.query.section || '');
    const todayStr = localYmd(new Date());
    if (section === 'weekend') { where.push('EXISTS (SELECT 1 FROM activity_inventory i WHERE i.activity_id = a.id AND i.date >= ? AND DAYOFWEEK(i.date) IN (1, 7) AND i.is_closed = false AND i.capacity > i.sold)'); params.push(todayStr); }
    if (section === 'family') { where.push(`(c.key_name IN (${FAMILY_CATS.map(() => '?').join(',')}) OR EXISTS (SELECT 1 FROM activity_ticket_types t WHERE t.activity_id = a.id AND t.is_active = true AND t.name LIKE '%Family%'))`); params.push(...FAMILY_CATS); }
    if (section === 'friends') { where.push(`c.key_name IN (${FRIENDS_CATS.map(() => '?').join(',')})`); params.push(...FRIENDS_CATS); }
    if (section === 'deals') { where.push('EXISTS (SELECT 1 FROM activity_offers o WHERE o.activity_id = a.id AND o.is_active = true AND (o.valid_until IS NULL OR o.valid_until >= ?) AND (o.max_uses IS NULL OR o.used_count < o.max_uses))'); params.push(todayStr); }
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    const hasGeo = req.query.lat !== undefined && req.query.lng !== undefined && req.query.lat !== '' && req.query.lng !== '' && Number.isFinite(lat) && Number.isFinite(lng);
    const distSql = hasGeo ? `, CASE WHEN a.latitude IS NULL OR a.longitude IS NULL THEN NULL ELSE ROUND(6371 * 2 * ASIN(SQRT(POW(SIN(RADIANS(a.latitude - ?) / 2), 2) + COS(RADIANS(?)) * COS(RADIANS(a.latitude)) * POW(SIN(RADIANS(a.longitude - ?) / 2), 2))), 1) END AS distance_km` : '';
    const distParams = hasGeo ? [lat, lat, lng] : [];
    let order = 'a.is_featured DESC, a.id DESC';
    if (section === 'trending') order = 'bookings_30d DESC, a.is_featured DESC, a.id DESC';
    if (section === 'popular') order = 'a.rating DESC, bookings_total DESC, a.id DESC';
    if (req.query.sort === 'nearest' && hasGeo) order = 'distance_km IS NULL, distance_km ASC, a.id DESC';
    const [rows] = await pool.query(
      `SELECT a.id, a.name, a.slug, a.location, a.city, a.country_code, a.currency_code, a.images, a.rating, a.is_featured, c.key_name AS category, c.label AS category_label,
              (SELECT MIN(price) FROM activity_ticket_types WHERE activity_id = a.id AND is_active = true) AS starting_price,
              (SELECT COUNT(*) FROM activity_bookings WHERE activity_id = a.id AND status = 'confirmed' AND booking_date >= DATE_SUB(?, INTERVAL 30 DAY)) AS bookings_30d,
              (SELECT COUNT(*) FROM activity_bookings WHERE activity_id = a.id AND status = 'confirmed') AS bookings_total,
              EXISTS (SELECT 1 FROM activity_offers o WHERE o.activity_id = a.id AND o.is_active = true AND (o.valid_until IS NULL OR o.valid_until >= ?)) AS has_offer${distSql}
       FROM activities a JOIN activity_categories c ON c.id = a.category_id
       WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 100`, [todayStr, todayStr, ...distParams, ...params]
    );
    res.json({ success: true, activities: rows.map((r) => ({ ...r, has_offer: !!r.has_offer })) });
  } catch (e) { console.error('activities list:', e.message); bad(res, 500, 'Could not load activities'); }
});

// GET /:slug — full detail (ticket types, add-ons, offers are not leaked unless active)
router.get('/:slug', async (req, res) => {
  try {
    const slugOrId = req.params.slug;
    const isNum = /^\d+$/.test(String(slugOrId));
    const [[a]] = await pool.query(
      `SELECT a.*, c.key_name AS category, c.label AS category_label, o.name AS owner_name
       FROM activities a JOIN activity_categories c ON c.id = a.category_id JOIN owners o ON o.id = a.owner_id
       WHERE (a.slug = ? OR a.id = ?) AND a.status = 'approved'`,
      [slugOrId, isNum ? Number(slugOrId) : 0]
    );
    if (!a) return bad(res, 404, 'Activity not found');

    const [ticketTypes] = await pool.query(
      `SELECT id, name, description, price, weekend_price, min_quantity, max_quantity,
              age_min, age_max, product_type, image_url, daily_capacity, requires_entry, terms
       FROM activity_ticket_types
       WHERE activity_id = ? AND is_active = true AND approval_status = 'APPROVED'
       ORDER BY sort_order, id`,
      [a.id]
    );
    const [addons] = await pool.query('SELECT id, name, price FROM activity_addons WHERE activity_id = ? AND is_active = true ORDER BY sort_order', [a.id]);
    const [offers] = await pool.query('SELECT code, discount_type, discount_value, min_amount, valid_until FROM activity_offers WHERE activity_id = ? AND is_active = true AND (valid_until IS NULL OR valid_until >= ?) AND (max_uses IS NULL OR used_count < max_uses)', [a.id, localYmd(new Date())]);
    res.json({ success: true, activity: a, ticket_types: ticketTypes, addons, offers, policy: await require('../services/globalConfig').getActivePolicy() });
  } catch (e) { console.error('activity detail:', e.message); bad(res, 500, 'Could not load this activity'); }
});

// GET /:slug/availability?date=YYYY-MM-DD — remaining capacity per ticket type + time windows for that date
router.get('/:slug/availability', async (req, res) => {
  try {
    const date = req.query.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return bad(res, 400, 'date must be YYYY-MM-DD');
    const slugOrId = req.params.slug;
    const isNum = /^\d+$/.test(String(slugOrId));
    const [[a]] = await pool.query(
      "SELECT id, timed_entry_enabled, opening_days, opening_time, closing_time FROM activities WHERE (slug = ? OR id = ?) AND status = 'approved'",
      [slugOrId, isNum ? Number(slugOrId) : 0]
    );
    if (!a) return bad(res, 404, 'Activity not found');

    // Get all active approved ticket types for this activity
    const [ticketTypes] = await pool.query(
      `SELECT id, name, description, product_type, price, weekend_price, daily_capacity, requires_entry, image_url, min_quantity, max_quantity, age_min, age_max
       FROM activity_ticket_types
       WHERE activity_id = ? AND is_active = true AND approval_status = 'APPROVED'
       ORDER BY sort_order, id`,
      [a.id]
    );

    // Get inventory overrides if present
    const [invRows] = await pool.query(
      'SELECT ticket_type_id, capacity, sold, is_closed, special_price FROM activity_inventory WHERE activity_id = ? AND date = ?',
      [a.id, date]
    );
    const invMap = new Map(invRows.map((r) => [r.ticket_type_id, r]));

    // Query confirmed sold count from bookings for this date to ensure atomic accuracy
    const [soldRows] = await pool.query(
      `SELECT bi.ticket_type_id, SUM(bi.quantity) as booked_qty
       FROM activity_booking_items bi
       JOIN activity_bookings b ON b.id = bi.booking_id
       WHERE b.activity_id = ? AND b.booking_date = ? AND b.status = 'confirmed'
       GROUP BY bi.ticket_type_id`,
      [a.id, date]
    );
    const soldMap = new Map(soldRows.map((r) => [r.ticket_type_id, Number(r.booked_qty || 0)]));

    const resultTypes = ticketTypes.map((t) => {
      const inv = invMap.get(t.id);
      const isClosed = inv ? !!inv.is_closed : false;
      const capacity = inv ? inv.capacity : (t.daily_capacity || 200);
      const sold = inv ? Math.max(inv.sold, soldMap.get(t.id) || 0) : (soldMap.get(t.id) || 0);
      const remaining = isClosed ? 0 : Math.max(0, capacity - sold);
      return {
        ticket_type_id: t.id,
        name: t.name,
        description: t.description,
        product_type: t.product_type || 'ENTRY',
        requires_entry: !!t.requires_entry,
        image_url: t.image_url,
        price: t.price,
        weekend_price: t.weekend_price,
        min_quantity: t.min_quantity || 1,
        max_quantity: t.max_quantity || 10,
        age_min: t.age_min,
        age_max: t.age_max,
        remaining,
        capacity,
        sold,
        is_closed: isClosed,
        special_price: inv?.special_price || null
      };
    });

    const [windows] = await pool.query('SELECT id, start_time, end_time, capacity, sold FROM activity_time_windows WHERE activity_id = ? AND date = ? ORDER BY start_time', [a.id, date]);
    res.json({
      success: true,
      weekend: activityBooking.isWeekend(date),
      ticket_types: resultTypes,
      time_windows: a.timed_entry_enabled ? windows.map((w) => ({ id: w.id, start_time: w.start_time, end_time: w.end_time, remaining: Math.max(0, w.capacity - w.sold) })) : [],
    });
  } catch (e) { console.error('activity availability:', e.message); bad(res, 500, 'Could not load availability'); }
});

// GET /:slug/open-dates?days=30 — only the dates the owner has actually opened (with seats left), so the booking screen
// can offer exactly those and nothing else. A date today is only offered while the venue is still open.
router.get('/:slug/open-dates', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const slugOrId = req.params.slug;
    const isNum = /^\d+$/.test(String(slugOrId));
    const [[a]] = await pool.query(
      "SELECT id, opening_days, closing_time FROM activities WHERE (slug = ? OR id = ?) AND status = 'approved'",
      [slugOrId, isNum ? Number(slugOrId) : 0]
    );
    if (!a) return bad(res, 404, 'Activity not found');
    const now = new Date();
    const end = new Date(now); end.setDate(end.getDate() + days);
    const [rows] = await pool.query(
      `SELECT i.date, SUM(i.capacity - i.sold) AS remaining FROM activity_inventory i
       WHERE i.activity_id = ? AND i.date BETWEEN ? AND ? AND i.is_closed = false AND i.capacity > i.sold GROUP BY i.date ORDER BY i.date`, [a.id, localYmd(now), localYmd(end)]
    );
    const nowHms = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    const todayStr = localYmd(now);
    let dates = rows.map((r) => ({ date: typeof r.date === 'string' ? r.date.slice(0, 10) : localYmd(r.date), remaining: Number(r.remaining) }))
      .filter((d) => !(d.date === todayStr && a.closing_time && String(a.closing_time) < nowHms));

    // Fallback: If no explicit inventory rows exist or if fewer than 7 days, generate standard open dates based on opening_days!
    if (dates.length === 0) {
      let allowedDays = null;
      try {
        allowedDays = Array.isArray(a.opening_days) ? a.opening_days : JSON.parse(a.opening_days || '[]');
      } catch (e) { allowedDays = []; }
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

      for (let i = 0; i < days; i++) {
        const curDate = new Date(now.getTime() + i * 86400000);
        const ymd = localYmd(curDate);
        const dayName = dayNames[curDate.getDay()];
        if (ymd === todayStr && a.closing_time && String(a.closing_time) < nowHms) continue;
        if (!allowedDays || allowedDays.length === 0 || allowedDays.includes(dayName) || allowedDays.includes(curDate.getDay())) {
          dates.push({ date: ymd, remaining: 500 });
        }
      }
    }

    res.json({ success: true, dates });
  } catch (e) { console.error('open dates:', e.message); bad(res, 500, 'Could not load dates'); }
});

// POST /price-preview — { activity_id, booking_date, items:[{ticket_type_id,quantity}], addons?, offer_code? }
router.post('/price-preview', optionalAuth, checkoutLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const customer = { userId: req.user && !req.user.role ? req.user.id : null, email: b.email, phone: b.phone };
    const priced = await activityBooking.calculatePrice({ activityId: b.activity_id, bookingDate: b.booking_date, items: b.items, addons: b.addons, offerCode: b.offer_code, customer });
    if (priced.error) return bad(res, 400, priced.error);
    res.json({ success: true, currency: priced.activity.currency_code || 'INR', subtotal: priced.subtotal, addon_amount: priced.addonAmount, discount_amount: priced.discountAmount, tax_amount: priced.taxAmount, tax_percent: Number(priced.activity.tax_percent || 0), total: priced.total, line_items: priced.lineItems, addon_items: priced.addonItems, weekend: priced.weekend });
  } catch (e) { console.error('price-preview:', e.message); bad(res, 500, 'Could not calculate price'); }
});

// POST /book — creates a pending booking + Razorpay order (or skips payment when the total is 0)
router.post('/book', verifyCustomer, checkoutLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.customer_name || !b.customer_phone) return bad(res, 400, 'Name and phone are required');
    const customer = { userId: req.user.id, name: b.customer_name, phone: b.customer_phone, email: b.customer_email };
    const result = await activityBooking.createPendingBooking({ activityId: b.activity_id, bookingDate: b.booking_date, timeWindowId: b.time_window_id, items: b.items, addons: b.addons, offerCode: b.offer_code, customer });
    if (result.error) return bad(res, 400, result.error);

    if (result.skipPayment) {
      const confirmed = await activityBooking.confirmBooking({ bookingId: result.bookingId, paymentId: `free_${crypto.randomBytes(6).toString('hex')}` });
      if (confirmed.error) return bad(res, 409, confirmed.error === 'sold_out' ? 'This date sold out while you were booking' : confirmed.error);
      fireNotification('activity.booking_confirmed', { bookingId: result.bookingId });
      return res.json({ success: true, booking_id: result.bookingId, skip_payment: true });
    }
    res.json({ success: true, booking_id: result.bookingId, order_id: result.orderId, amount: result.amountMinor, currency: result.currency, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (e) { console.error('activity book:', e.message); bad(res, 500, 'Could not create this booking'); }
});

// POST /verify — { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature }
router.post('/verify', verifyCustomer, verifyLimiter, async (req, res) => {
  try {
    const { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    const [[booking]] = await pool.query(
      'SELECT id, user_id FROM activity_bookings WHERE id = ? AND razorpay_order_id = ?',
      [booking_id, razorpay_order_id]
    );
    if (!booking) return bad(res, 404, 'Booking not found');
    if (Number(booking.user_id) !== Number(req.user.id)) return bad(res, 403, 'Not authorized to verify this booking');
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature) {
      await pool.query("UPDATE activity_bookings SET status = 'cancelled', payment_status = 'failed' WHERE id = ? AND razorpay_order_id = ? AND user_id = ?", [booking_id, razorpay_order_id, req.user.id]);
      fireNotification('activity.payment_failed', { bookingId: booking_id });
      return bad(res, 400, 'Payment verification failed');
    }
    const result = await activityBooking.confirmBooking({ bookingId: booking_id, paymentId: razorpay_payment_id });
    if (result.error === 'sold_out') { fireNotification('activity.booking_cancelled', { bookingId: booking_id, reason: 'sold_out' }); return res.status(409).json({ success: false, error: 'This date sold out while you were paying. You will be refunded.' }); }
    if (result.error) return bad(res, 400, result.error);
    if (!result.already) fireNotification('activity.booking_confirmed', { bookingId: booking_id });
    res.json({ success: true, status: 'confirmed', message: 'Payment verified' });
  } catch (e) { console.error('activity verify:', e.message); bad(res, 500, 'Verification failed'); }
});

// POST /cancel-pending — the customer backed out of payment; release the hold if it was never paid (mirrors
// routes/bookings.js's cancel-pending). Never touches an already-confirmed booking.
router.post('/cancel-pending', verifyCustomer, verifyLimiter, async (req, res) => {
  try {
    const { booking_id } = req.body || {};
    if (!booking_id) return bad(res, 400, 'booking_id is required');
    const [result] = await pool.query("UPDATE activity_bookings SET status = 'cancelled', payment_status = 'failed' WHERE id = ? AND user_id = ? AND status = 'pending'", [booking_id, req.user.id]);
    if (!result.affectedRows) return bad(res, 404, 'Pending booking not found');
    res.json({ success: true });
  } catch (e) { bad(res, 500, 'Could not cancel this booking'); }
});

// What the customer sees on a booking: upcoming | used | expired | cancelled (derived from the booking + its tickets)
function displayStatus(b, tickets) {
  if (b.status === 'cancelled') return 'cancelled';
  const now = Date.now();
  const anyRedeemed = tickets.some((t) => Number(t.redeemed_quantity) > 0);
  if (tickets.length && tickets.every((t) => t.status === 'COMPLETED')) return 'used';
  const lapsed = tickets.length > 0 && tickets.every((t) => t.status === 'EXPIRED' || new Date(t.valid_until).getTime() < now);
  if (lapsed) return anyRedeemed ? 'used' : 'expired';
  return 'upcoming';
}

// GET /my/tickets?tab=upcoming|used|expired|cancelled — the signed-in customer's own activity bookings + tickets (never another user's)
router.get('/my/tickets', verifyToken, async (req, res) => {
  try {
    if (req.user.role) return bad(res, 403, 'Only customers have activity tickets');
    const [bookings] = await pool.query(
      `SELECT b.id, b.booking_code, b.booking_date, b.status, b.payment_status, b.total_amount, b.currency_code, b.refund_amount, b.refund_status, a.name AS activity_name, a.slug, a.images
       FROM activity_bookings b JOIN activities a ON a.id = b.activity_id
       WHERE b.user_id = ? AND b.status IN ('confirmed', 'cancelled') ORDER BY b.booking_date DESC, b.id DESC LIMIT 100`, [req.user.id]
    );
    // two queries for the whole list (not two per booking): the DB is a network hop away, so N+1 gets slow fast
    const ids = bookings.map((b) => b.id);
    const itemsBy = new Map(); const ticketsBy = new Map();
    if (ids.length) {
      const [items] = await pool.query(`SELECT bi.booking_id, ti.name, bi.quantity FROM activity_booking_items bi JOIN activity_ticket_types ti ON ti.id = bi.ticket_type_id WHERE bi.booking_id IN (${ids.map(() => '?').join(',')})`, ids);
      const [tickets] = await pool.query(`SELECT booking_id, qr_token, quantity_covered, redeemed_quantity, status, valid_until FROM activity_tickets WHERE booking_id IN (${ids.map(() => '?').join(',')})`, ids);
      for (const i of items) { if (!itemsBy.has(i.booking_id)) itemsBy.set(i.booking_id, []); itemsBy.get(i.booking_id).push({ name: i.name, quantity: i.quantity }); }
      for (const t of tickets) { if (!ticketsBy.has(t.booking_id)) ticketsBy.set(t.booking_id, []); ticketsBy.get(t.booking_id).push({ qr_token: t.qr_token, quantity_covered: t.quantity_covered, redeemed_quantity: t.redeemed_quantity, status: t.status, valid_until: t.valid_until }); }
    }
    for (const b of bookings) {
      b.items = itemsBy.get(b.id) || []; b.tickets = ticketsBy.get(b.id) || [];
      b.display_status = displayStatus(b, b.tickets);
    }
    const tab = String(req.query.tab || '');
    res.json({ success: true, bookings: ['upcoming', 'used', 'expired', 'cancelled'].includes(tab) ? bookings.filter((b) => b.display_status === tab) : bookings });
  } catch (e) { console.error('my tickets:', e.message); bad(res, 500, 'Could not load your tickets'); }
});

// POST /my/tickets/:bookingId/cancel { acceptNoRefund? } — the one cancellation engine (services/cancellation.js): the
// backend decides eligibility, fee, refund and currency; the client only says "cancel this booking".
router.post('/my/tickets/:bookingId/cancel', verifyToken, lookupLimiter, async (req, res) => {
  try {
    if (req.user.role) return bad(res, 403, 'Only customers can cancel their own tickets');
    const r = await require('../services/cancellation').cancel({ type: 'activity', id: Number(req.params.bookingId), actor: { kind: 'customer', id: req.user.id }, reason: req.body && req.body.reason, acceptNoRefund: !!(req.body && req.body.acceptNoRefund === true) });
    if (r.error) return res.status(r.status || 400).json({ success: false, error: r.error, code: r.code, quote: r.view });
    const q = r.view;
    res.json({ success: true, already_cancelled: !!r.alreadyCancelled, currency: q.currency, refund_amount: q.refund_amount || 0, quote: q, message: q.refund_amount > 0 ? 'Cancelled. Your refund has been initiated and may take 4–5 business days to reach your original payment method.' : 'Cancelled.' });
  } catch (e) { console.error('customer cancel:', e.message); bad(res, 500, 'Could not cancel this booking'); }
});

// GET /my/tickets/:bookingId — one booking's full detail (ownership enforced)
router.get('/my/tickets/:bookingId', verifyToken, async (req, res) => {
  try {
    if (req.user.role) return bad(res, 403, 'Only customers have activity tickets');
    const [[b]] = await pool.query(
      `SELECT b.*, a.name AS activity_name, a.slug, a.location, a.images FROM activity_bookings b JOIN activities a ON a.id = b.activity_id WHERE b.id = ? AND b.user_id = ?`,
      [req.params.bookingId, req.user.id]
    );
    const [items] = await pool.query('SELECT bi.id, ti.name, ti.name AS ticket_type_name, ti.product_type, ti.image_url, bi.quantity, COALESCE(bi.redeemed_quantity, 0) AS redeemed_quantity, COALESCE(bi.status, "VALID") AS status, bi.unit_price FROM activity_booking_items bi JOIN activity_ticket_types ti ON ti.id = bi.ticket_type_id WHERE bi.booking_id = ?', [b.id]);
    const [tickets] = await pool.query('SELECT qr_token, quantity_covered, redeemed_quantity, status, valid_from, valid_until FROM activity_tickets WHERE booking_id = ?', [b.id]);
    const cp = await activityBooking.getActivity(b.activity_id);
    const platformPolicy = await require('../services/globalConfig').policyForBooking('activity_bookings', b);
    res.json({ success: true, booking: { ...b, display_status: displayStatus(b, tickets) }, items, tickets, policy: { windowHours: platformPolicy.windowHours, feePercent: platformPolicy.feePercent, cancellationEnabled: platformPolicy.cancellationEnabled, cancellation_hours_before: cp.cancellation_hours_before, refund_percent: Number(cp.refund_percent), cancellation_policy: cp.cancellation_policy } });
  } catch (e) { console.error('ticket detail:', e.message); bad(res, 500, 'Could not load this booking'); }
});

module.exports = router;
