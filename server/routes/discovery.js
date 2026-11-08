// Public discovery API: /api/discovery/*  and  /api/app-config
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const svc = require('../services/discoverySearch');
const { getAuthSettings } = require('../services/authSettings');

const rate = new Map();
function limiter(req, res, next) { // light per-IP guard so typing can't hammer the DB
  const k = req.ip; const now = Date.now(); const w = rate.get(k) || [];
  const recent = w.filter((t) => now - t < 10000);
  if (recent.length >= 40) return res.status(429).json({ success: false, error: 'Too many searches, slow down' });
  recent.push(now); rate.set(k, recent);
  if (rate.size > 5000) rate.clear();
  next();
}

router.get('/sitemap.xml', async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id FROM turfs WHERE is_active = true AND (is_deleted IS NULL OR is_deleted = 0) AND (status IS NULL OR status != 'BLOCKED') AND (approval_status = 'APPROVED' OR approval_status IS NULL) ORDER BY id LIMIT 50000"
    );
    const staticPaths = [
      '/', '/turfs', '/find-players', '/blog', '/about', '/about/founder', '/contact',
      '/privacy', '/terms', '/refund', '/activities', '/tournaments'
    ];
    const urls = [
      ...staticPaths.map((path) => `https://bookarena.in${path}`),
      ...rows.map((row) => `https://bookarena.in/turfs/${encodeURIComponent(row.id)}`)
    ];
    const escapeXml = (value) => String(value).replace(/[<>&"']/g, (character) => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
    })[character]);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`).join('\n')}\n</urlset>`;
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(xml);
  } catch (e) {
    console.error('[discovery/sitemap]', e.message);
    res.status(500).type('text/plain').send('Could not generate sitemap');
  }
});

router.get('/search', limiter, async (req, res) => {
  try {
    const data = await svc.discover({ ...req.query, mode: 'search' });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...data });
  } catch (e) { console.error('[discovery/search]', e.message); res.status(500).json({ success: false, error: 'Search failed' }); }
});

router.get('/nearby', limiter, async (req, res) => {
  try {
    const data = await svc.discover({ ...req.query, q: req.query.q || '', mode: 'nearby', includeActivities: false, type: 'venue' });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...data });
  } catch (e) { console.error('[discovery/nearby]', e.message); res.status(500).json({ success: false, error: 'Could not load nearby venues' }); }
});

router.get('/locations', limiter, async (req, res) => {
  try { res.json({ success: true, locations: await svc.listLocations(String(req.query.q || '').slice(0, 60)) }); }
  catch (e) { res.status(500).json({ success: false, error: 'Could not load locations' }); }
});

// Enabled sports for the home grid / filters / owner picker. Order is admin-controlled (sort_order).
router.get('/sports', async (req, res) => {
  try {
    const rows = await svc.loadCategories();
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ success: true, sports: rows.filter((c) => c.is_enabled).map((c) => ({ id: c.id, slug: c.slug, name: c.name, venue_type: c.venue_type, image_url: c.image_url || null, sort_order: c.sort_order })) });
  } catch (e) { res.status(500).json({ success: false, error: 'Could not load sports' }); }
});

// Only real, currently-valid offers: admin-wide coupons + live ads. Nothing is invented when there are none.
router.get('/offers', async (req, res) => {
  const offers = [];
  try {
    const [coupons] = await pool.query(
      `SELECT id, code, label, discount_type, discount_value, min_booking_amount, max_discount_cap, valid_until
       FROM admin_coupons WHERE is_active = TRUE
         AND (valid_from IS NULL OR valid_from <= CURDATE()) AND (valid_until IS NULL OR valid_until >= CURDATE())
         AND (max_uses IS NULL OR used_count < max_uses)
       ORDER BY created_at DESC LIMIT 10`);
    for (const c of coupons) offers.push({ kind: 'coupon', id: `c${c.id}`, code: c.code, title: c.label || `${c.discount_type === 'percentage' ? `${Number(c.discount_value)}%` : `₹${Number(c.discount_value)}`} off`, discount_type: c.discount_type, discount_value: Number(c.discount_value), min_booking_amount: c.min_booking_amount == null ? null : Number(c.min_booking_amount), max_discount_cap: c.max_discount_cap == null ? null : Number(c.max_discount_cap), valid_until: c.valid_until });
  } catch (e) { /* table may not exist on a fresh install */ }
  try {
    const [ads] = await pool.query(
      `SELECT id, title, description, image_url, link_url, sponsor_name FROM advertisements
       WHERE placement IN ('HOME_BANNER','HOME') AND is_active = true
         AND (start_date IS NULL OR start_date <= CURDATE()) AND (end_date IS NULL OR end_date >= CURDATE())
       ORDER BY priority DESC, created_at DESC LIMIT 10`);
    for (const a of ads) offers.push({ kind: 'ad', id: `a${a.id}`, ad_id: a.id, title: a.title, description: a.description, image_url: a.image_url, link_url: a.link_url, sponsor_name: a.sponsor_name });
  } catch (e) { /* same */ }
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ success: true, offers });
});

// Public runtime config the app reads at start (and on focus). Only non-secret flags.
const configRouter = express.Router();
configRouter.get('/', async (req, res) => {
  try {
    const auth = await getAuthSettings();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, auth: { google_login_enabled: auth.googleEnabled } });
  } catch (e) { res.json({ success: true, auth: { google_login_enabled: false } }); }
});

module.exports = router;
module.exports.configRouter = configRouter;
