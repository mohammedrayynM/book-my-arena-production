// /api/admin/activities — admin moderation for the ticket-booking engine: approve/reject/suspend activities, manage
// categories, and cross-owner visibility into bookings/tickets/scans. Mirrors the existing owner approve/reject/block
// convention in routes/admin.js (owners.is_approved/is_blocked) as closely as this domain allows.
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { fire: fireNotification } = require('../utils/notifications/events');
const activityBooking = require('../services/activityBooking');

const { makeDateOnlyResponses } = require('../utils/tournamentValidation');
// DATE columns come back as local-midnight Dates that JSON-serialise a day EARLY on an IST server; emit plain YYYY-MM-DD instead.
const activityDates = makeDateOnlyResponses(['booking_date', 'date', 'last_visit']);
router.use(verifyToken, verifyAdmin);
router.use(activityDates);
const bad = (res, status, error) => res.status(status).json({ success: false, error });

// GET /?status=pending
router.get('/', async (req, res) => {
  try {
    const where = ['1=1']; const params = [];
    if (req.query.status) { where.push('a.status = ?'); params.push(req.query.status); }
    const [rows] = await pool.query(
      `SELECT a.id, a.name, a.slug, a.status, a.is_featured, a.commission_percent, a.created_at, c.label AS category_label, o.name AS owner_name, o.id AS owner_id
       FROM activities a JOIN activity_categories c ON c.id = a.category_id JOIN owners o ON o.id = a.owner_id
       WHERE ${where.join(' AND ')} ORDER BY a.id DESC`, params
    );
    res.json({ success: true, activities: rows });
  } catch (e) { console.error('admin activities:', e.message); bad(res, 500, 'Could not load activities'); }
});

// Declared before /:id — otherwise Express would treat "stats" as an activity id.
router.get('/stats', async (req, res) => {
  const [[totals]] = await pool.query(
    "SELECT COUNT(*) AS activities, SUM(status='pending') AS pending, SUM(status='approved') AS approved, SUM(status='suspended') AS suspended FROM activities"
  );
  const [byCur] = await pool.query("SELECT currency_code, COUNT(*) AS bookings, COALESCE(SUM(total_amount),0) AS revenue FROM activity_bookings WHERE status = 'confirmed' GROUP BY currency_code");
  // amounts in different currencies are never added together: `revenue` is the INR total, the rest are listed per currency
  const inr = byCur.find((r) => r.currency_code === 'INR');
  res.json({ success: true, activities: totals, bookings: byCur.reduce((a, r) => a + Number(r.bookings), 0), revenue: inr ? Number(inr.revenue) : 0, revenue_by_currency: byCur.map((r) => ({ currency: r.currency_code, bookings: Number(r.bookings), revenue: Number(r.revenue) })) });
});

// Also declared before /:id (single-segment literal GET routes).
// Refunds now live in the unified ledger: see /api/admin/global/refunds.
router.get('/revenue', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, a.name, a.currency_code, o.name AS owner_name, a.commission_percent, COUNT(b.id) AS bookings, COALESCE(SUM(b.total_amount),0) AS gross
     FROM activities a JOIN owners o ON o.id = a.owner_id LEFT JOIN activity_bookings b ON b.activity_id = a.id AND b.status = 'confirmed'
     GROUP BY a.id, a.name, a.currency_code, o.name, a.commission_percent HAVING bookings > 0 ORDER BY gross DESC LIMIT 200`
  );
  res.json({ success: true, revenue: rows.map((r) => ({ id: r.id, name: r.name, currency: r.currency_code, owner_name: r.owner_name, bookings: Number(r.bookings), gross: Number(r.gross), commission_percent: r.commission_percent == null ? null : Number(r.commission_percent), commission_amount: r.commission_percent == null ? null : Math.round(Number(r.gross) * Number(r.commission_percent)) / 100 })) });
});

router.get('/:id', async (req, res) => {
  const [[a]] = await pool.query(
    `SELECT a.*, c.label AS category_label, o.name AS owner_name, o.email AS owner_email FROM activities a
     JOIN activity_categories c ON c.id = a.category_id JOIN owners o ON o.id = a.owner_id WHERE a.id = ?`, [req.params.id]
  );
  if (!a) return bad(res, 404, 'Activity not found');
  const [ticketTypes] = await pool.query('SELECT * FROM activity_ticket_types WHERE activity_id = ?', [req.params.id]);
  const [[stats]] = await pool.query("SELECT COUNT(*) AS bookings, COALESCE(SUM(total_amount),0) AS revenue FROM activity_bookings WHERE activity_id = ? AND status = 'confirmed'", [req.params.id]);
  res.json({ success: true, activity: a, ticket_types: ticketTypes, stats: { bookings: stats.bookings, revenue: Number(stats.revenue) } });
});

async function setStatus(req, res, status, requireReasonless) {
  const [[a]] = await pool.query('SELECT id, status FROM activities WHERE id = ?', [req.params.id]);
  if (!a) return bad(res, 404, 'Activity not found');
  if (status === 'approved') {
    await pool.query("UPDATE activities SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ?", [req.user.id, req.params.id]);
  } else {
    await pool.query('UPDATE activities SET status = ? WHERE id = ?', [status, req.params.id]);
  }
  fireNotification('owner.activity_decided', { activityId: req.params.id, decision: status });
  res.json({ success: true });
}
router.put('/:id/approve', (req, res) => setStatus(req, res, 'approved'));
router.put('/:id/reject', (req, res) => setStatus(req, res, 'rejected'));
router.put('/:id/suspend', (req, res) => setStatus(req, res, 'suspended'));

router.put('/:id/featured', async (req, res) => {
  const { is_featured } = req.body || {};
  const [r] = await pool.query('UPDATE activities SET is_featured = ? WHERE id = ?', [!!is_featured, req.params.id]);
  if (r.affectedRows === 0) return bad(res, 404, 'Activity not found');
  res.json({ success: true });
});

// Informational only in this pass — nothing reads this to move money yet (see services/activityBooking.js header).
router.put('/:id/commission', async (req, res) => {
  const pct = Number((req.body || {}).commission_percent);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return bad(res, 400, 'commission_percent must be between 0 and 100');
  const [r] = await pool.query('UPDATE activities SET commission_percent = ? WHERE id = ?', [pct, req.params.id]);
  if (r.affectedRows === 0) return bad(res, 404, 'Activity not found');
  res.json({ success: true });
});

// ---- categories ----
router.get('/categories/all', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM activity_categories ORDER BY sort_order');
  res.json({ success: true, categories: rows });
});
router.post('/categories', async (req, res) => {
  const { key_name, label, icon } = req.body || {};
  if (!key_name || !label) return bad(res, 400, 'key_name and label are required');
  try {
    const [ins] = await pool.query('INSERT INTO activity_categories (key_name, label, icon, sort_order) VALUES (?, ?, ?, 999)', [String(key_name).toUpperCase().trim(), label, icon || null]);
    res.json({ success: true, category_id: ins.insertId });
  } catch (e) { bad(res, 400, 'That category key already exists'); }
});
router.put('/categories/:catId', async (req, res) => {
  const b = req.body || {}; const sets = []; const params = [];
  for (const f of ['label', 'icon', 'is_active', 'sort_order']) { if (b[f] !== undefined) { sets.push(`${f} = ?`); params.push(b[f]); } }
  if (sets.length === 0) return bad(res, 400, 'Nothing to update');
  await pool.query(`UPDATE activity_categories SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.catId]);
  res.json({ success: true });
});

// ---- cross-owner visibility ----
router.get('/bookings/all', async (req, res) => {
  const where = ['1=1']; const params = [];
  if (req.query.status) { where.push('b.status = ?'); params.push(req.query.status); }
  const [rows] = await pool.query(`SELECT b.*, a.name AS activity_name FROM activity_bookings b JOIN activities a ON a.id = b.activity_id WHERE ${where.join(' AND ')} ORDER BY b.id DESC LIMIT 200`, params);
  res.json({ success: true, bookings: rows });
});
router.get('/scans/all', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT l.*, o.name AS owner_name FROM activity_qr_scan_logs l LEFT JOIN owners o ON o.id = l.scanned_by_owner_id ORDER BY l.id DESC LIMIT 200`
  );
  res.json({ success: true, scans: rows });
});
router.get('/tickets/all', async (req, res) => {
  const where = ['1=1']; const params = [];
  if (req.query.status) { where.push('t.status = ?'); params.push(req.query.status); }
  const [rows] = await pool.query(
    `SELECT t.id, t.status, t.quantity_covered, t.redeemed_quantity, t.valid_from, t.valid_until, t.first_scanned_at, b.booking_code, b.booking_date, a.name AS activity_name, o.name AS owner_name
     FROM activity_tickets t JOIN activity_bookings b ON b.id = t.booking_id JOIN activities a ON a.id = t.activity_id JOIN owners o ON o.id = t.owner_id
     WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT 200`, params
  );
  res.json({ success: true, tickets: rows });
});
// Fraud control: a BLOCKED ticket can never be admitted (the scan check already rejects it). Unblocking restores it only
// if it is still usable (someone not yet fully let in).
router.put('/tickets/:ticketId/block', async (req, res) => {
  const [[t]] = await pool.query('SELECT id, status, quantity_covered, redeemed_quantity FROM activity_tickets WHERE id = ?', [req.params.ticketId]);
  if (!t) return bad(res, 404, 'Ticket not found');
  if (req.body && req.body.blocked === false) {
    if (t.status !== 'BLOCKED') return bad(res, 400, 'This ticket is not blocked');
    await pool.query("UPDATE activity_tickets SET status = ? WHERE id = ?", [t.redeemed_quantity >= t.quantity_covered ? 'COMPLETED' : (t.redeemed_quantity > 0 ? 'SCANNED' : 'VALID'), t.id]);
  } else {
    if (!['VALID', 'UNUSED', 'SCANNED'].includes(t.status)) return bad(res, 400, `A ${t.status.toLowerCase()} ticket cannot be blocked`);
    await pool.query("UPDATE activity_tickets SET status = 'BLOCKED' WHERE id = ?", [t.id]);
  }
  res.json({ success: true });
});
router.get('/offers/all', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT o.*, a.name AS activity_name FROM activity_offers o JOIN activities a ON a.id = o.activity_id ORDER BY o.id DESC LIMIT 200`
  );
  res.json({ success: true, offers: rows });
});
module.exports = router;
