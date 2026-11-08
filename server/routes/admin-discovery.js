// /api/admin/discovery — admin-only: Google sign-in switch + sport category management.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const auth = require('../services/authSettings');
const svc = require('../services/discoverySearch');
const { ALLOWED_IMAGE_EXTS, isAllowedImageUploadMeta, ensureUploadedImageExt } = require('../utils/imageUpload');
const SPORT_IMAGE_DIR = path.join(__dirname, '../uploads/turfs/sport-categories');
fs.mkdirSync(SPORT_IMAGE_DIR, { recursive: true });
const sportUpload = multer({ storage: multer.diskStorage({ destination: SPORT_IMAGE_DIR, filename: (_req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ALLOWED_IMAGE_EXTS.has(ext) ? ext : '.jpg'}`);
} }), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(isAllowedImageUploadMeta(file.originalname, file.mimetype) ? null : new Error('Only JPEG, PNG and WEBP images are allowed'), isAllowedImageUploadMeta(file.originalname, file.mimetype)) });

async function requireAdminRecord(req, res, next) {
  try {
    const [[a]] = await pool.query('SELECT id FROM admins WHERE id = ?', [req.user.id]);
    if (!a) return res.status(403).json({ success: false, error: 'Admin account not found' });
    next();
  } catch (e) { res.status(500).json({ success: false, error: 'Could not verify the admin account' }); }
}
router.use(verifyToken, verifyAdmin, requireAdminRecord);

router.get('/auth-settings', async (req, res) => {
  const s = await auth.getAuthSettings({ fresh: true });
  res.json({ success: true, google_login_enabled: s.googleEnabled, google_configured: s.googleConfigured });
});
router.put('/auth-settings', async (req, res) => {
  try {
    const v = req.body?.google_login_enabled;
    if (typeof v !== 'boolean') return res.status(400).json({ success: false, error: 'google_login_enabled must be true or false' });
    if (v && !process.env.GOOGLE_CLIENT_ID) return res.status(400).json({ success: false, error: 'GOOGLE_CLIENT_ID is not configured on the server, so Google sign-in cannot be enabled yet.' });
    await auth.setGoogleEnabled(v);
    res.json({ success: true, google_login_enabled: v });
  } catch (e) { console.error('[admin auth-settings]', e.message); res.status(500).json({ success: false, error: 'Could not save the setting' }); }
});

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const VENUE_TYPES = new Set(['sports', 'activity']);

router.get('/sports', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, (SELECT COUNT(*) FROM turf_sports ts WHERE ts.category_id = c.id) AS venue_count FROM sport_categories c ORDER BY c.sort_order, c.name`);
    res.json({ success: true, sports: rows.map((r) => ({ ...r, is_enabled: !!r.is_enabled, venue_count: Number(r.venue_count) })) });
  } catch (e) { res.status(500).json({ success: false, error: 'Could not load sports' }); }
});

router.post('/sports', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (name.length < 2 || name.length > 80) return res.status(400).json({ success: false, error: 'Name must be 2–80 characters' });
    const slug = slugify(name);
    if (!slug) return res.status(400).json({ success: false, error: 'Name must contain letters or digits' });
    const aliases = Array.isArray(req.body?.aliases) ? [...new Set(req.body.aliases.map((a) => String(a).trim().toLowerCase()).filter(Boolean))].slice(0, 20) : [];
    const [[dup]] = await pool.query('SELECT id FROM sport_categories WHERE slug = ? OR LOWER(name) = LOWER(?)', [slug, name]);
    if (dup) return res.status(409).json({ success: false, error: 'A sport with this name already exists' });
    const [[mx]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM sport_categories');
    const [r] = await pool.query('INSERT INTO sport_categories (slug, name, venue_type, search_group, aliases, sort_order, is_enabled) VALUES (?, ?, ?, NULL, ?, ?, 1)',
      [slug, name, VENUE_TYPES.has(req.body?.venue_type) ? req.body.venue_type : 'sports', JSON.stringify(aliases), Number(mx.m) + 10]);
    svc.clearCategoryCache();
    res.status(201).json({ success: true, id: r.insertId });
  } catch (e) { console.error('[admin sports create]', e.message); res.status(500).json({ success: false, error: 'Could not create the sport' }); }
});

router.put('/sports/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[cur]] = await pool.query('SELECT * FROM sport_categories WHERE id = ?', [id]);
    if (!cur) return res.status(404).json({ success: false, error: 'Sport not found' });
    const sets = []; const vals = [];
    if (req.body.name !== undefined) {
      const n = String(req.body.name).trim();
      if (n.length < 2 || n.length > 80) return res.status(400).json({ success: false, error: 'Name must be 2–80 characters' });
      const [[dup]] = await pool.query('SELECT id FROM sport_categories WHERE LOWER(name) = LOWER(?) AND id <> ?', [n, id]);
      if (dup) return res.status(409).json({ success: false, error: 'A sport with this name already exists' });
      sets.push('name = ?'); vals.push(n);
    }
    if (req.body.is_enabled !== undefined) { sets.push('is_enabled = ?'); vals.push(req.body.is_enabled ? 1 : 0); }
    if (req.body.sort_order !== undefined) { const o = parseInt(req.body.sort_order, 10); if (!Number.isFinite(o)) return res.status(400).json({ success: false, error: 'sort_order must be a number' }); sets.push('sort_order = ?'); vals.push(o); }
    if (req.body.image_url !== undefined) { sets.push('image_url = ?'); vals.push(req.body.image_url ? String(req.body.image_url).slice(0, 500) : null); }
    if (Array.isArray(req.body.aliases)) { sets.push('aliases = ?'); vals.push(JSON.stringify([...new Set(req.body.aliases.map((a) => String(a).trim().toLowerCase()).filter(Boolean))].slice(0, 20))); }
    if (!sets.length) return res.status(400).json({ success: false, error: 'Nothing to update' });
    await pool.query(`UPDATE sport_categories SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
    svc.clearCategoryCache();
    res.json({ success: true });
  } catch (e) { console.error('[admin sports update]', e.message); res.status(500).json({ success: false, error: 'Could not update the sport' }); }
});

// Upload first, then persist the category reference, and only then remove the previous local file.
router.post('/sports/:id/image', (req, res, next) => sportUpload.single('image')(req, res, (e) => {
  if (!e) return next();
  if (e instanceof multer.MulterError && e.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, error: 'Image must be 5MB or smaller' });
  return res.status(400).json({ success: false, error: e.message || 'Image upload failed' });
}), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[current]] = await pool.query('SELECT id, image_url FROM sport_categories WHERE id = ?', [id]);
    if (!current) { if (req.file) fs.unlinkSync(req.file.path); return res.status(404).json({ success: false, error: 'Sport not found' }); }
    if (!req.file) return res.status(400).json({ success: false, error: 'Choose an image to upload' });
    const checked = ensureUploadedImageExt(req.file);
    if (!checked.ok) return res.status(400).json({ success: false, error: checked.error });
    const url = `/api/uploads/sport-categories/${req.file.filename}`;
    try { await pool.query('UPDATE sport_categories SET image_url = ? WHERE id = ?', [url, id]); }
    catch (e) { fs.unlinkSync(req.file.path); throw e; }
    const previous = String(current.image_url || '');
    const match = previous.match(/^\/api\/uploads\/sport-categories\/([\w.-]+)$/);
    if (match) { const oldFile = path.join(SPORT_IMAGE_DIR, path.basename(match[1])); if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile); }
    svc.clearCategoryCache();
    return res.json({ success: true, image_url: url });
  } catch (e) { console.error('[admin sport image]', e.message); return res.status(500).json({ success: false, error: 'Could not save category image' }); }
});

router.delete('/sports/:id/image', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[current]] = await pool.query('SELECT id, image_url FROM sport_categories WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ success: false, error: 'Sport not found' });
    await pool.query('UPDATE sport_categories SET image_url = NULL WHERE id = ?', [id]);
    const match = String(current.image_url || '').match(/^\/api\/uploads\/sport-categories\/([\w.-]+)$/);
    if (match) { const oldFile = path.join(SPORT_IMAGE_DIR, path.basename(match[1])); if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile); }
    svc.clearCategoryCache();
    return res.json({ success: true });
  } catch (e) { console.error('[admin sport image remove]', e.message); return res.status(500).json({ success: false, error: 'Could not remove category image' }); }
});

module.exports = router;
