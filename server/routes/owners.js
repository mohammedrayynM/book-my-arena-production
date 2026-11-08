const express = require('express');
const venueSports = require('../services/venueSports');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pool = require('../config/db');
const { generateToken, verifyToken, verifyOwner } = require('../middleware/auth');
const { broadcastSse } = require('../utils/realtime');
const { fire: fireNotification } = require('../utils/notifications/events');
const businessTypes = require('../services/businessTypes');
const subscriptionReservations = require('../services/subscriptionReservations');
const availabilityService = require('../services/availabilityService');
const globalConfig = require('../services/globalConfig');

const { acquireSlotLock, releaseSlotLock } = require('../services/slotLock');
const slotSchedule = require('../services/slotSchedule');
// 24-hour / schedule settings. Only validated when the client sends the new `is_24_hours` field, so older clients keep working untouched.
function scheduleGuard(body = {}) {
  if (body.is_24_hours === undefined) return null;
  return slotSchedule.validateSchedule({ open_time: body.open_time, close_time: body.close_time, is_24_hours: body.is_24_hours, slot_duration: body.slot_duration });
}
async function persistSchedule(table, id, body = {}) {
  if (body.is_24_hours === undefined) return;
  try { await pool.query(`UPDATE ${table} SET is_24_hours = ? WHERE id = ?`, [slotSchedule.truthy(body.is_24_hours) ? 1 : 0, id]); }
  catch (e) { console.warn(`[schedule] ${table}.is_24_hours not saved: ${e.message}`); }
}

const UPLOAD_DIR = path.join(__dirname, '../uploads/turfs');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const {
  ALLOWED_IMAGE_EXTS,
  isAllowedImageUploadMeta,
  ensureUploadedImageExt
} = require('../utils/imageUpload');

const turfImageStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ALLOWED_IMAGE_EXTS.has(ext) ? ext : '.jpg';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  }
});

const turfImageUpload = multer({
  storage: turfImageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (isAllowedImageUploadMeta(file.originalname, file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('Only JPEG, PNG and WEBP images are allowed'));
  }
});

function parseJsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function normalizePhotoUrl(entry) {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    return trimmed || null;
  }
  if (entry && typeof entry === 'object') {
    const url = entry.url || entry.src || entry.path;
    if (typeof url === 'string' && url.trim()) return url.trim();
  }
  return null;
}

function normalizePhotoList(list) {
  return parseJsonArray(list).map(normalizePhotoUrl).filter(Boolean);
}

function mapOwnerTurfRow(turf) {
  const images = normalizePhotoList(turf.images);
  const photos = normalizePhotoList(turf.photos);
  const resolvedPhotos = photos.length > 0 ? photos : images;
  const categories = parseJsonArray(turf.categories, turf.category ? [turf.category] : ['SPORTS']);
  const capabilities = parseJsonArray(turf.enabled_capabilities, ['courts', 'slots', 'subscriptions']);
  return {
    ...turf,
    images: resolvedPhotos,
    photos: resolvedPhotos,
    coverImage: turf.coverImage || resolvedPhotos[0] || '',
    photosCount: Number(turf.photosCount) || resolvedPhotos.length,
    amenities: parseJsonArray(turf.amenities),
    category: turf.category || (categories[0] || 'SPORTS'),
    categories,
    booking_model: turf.booking_model || 'SLOT',
    enabled_capabilities: capabilities,
    approval_status: turf.approval_status || (turf.is_active ? 'APPROVED' : 'PENDING_APPROVAL'),
    admin_feedback: turf.admin_feedback || null,
    draft_data: typeof turf.draft_data === 'string' ? JSON.parse(turf.draft_data) : (turf.draft_data || null)
  };
}

function finalizeUploadedImage(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided. Use field name "image".' });
  }

  const validation = ensureUploadedImageExt(req.file);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  const url = `/api/uploads/${req.file.filename}`;
  return res.json({
    success: true,
    url,
    filename: req.file.filename,
    image: { url, filename: req.file.filename }
  });
}

function handleMulterUpload(req, res, next) {
  turfImageUpload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image must be 10MB or smaller' });
      }
      return res.status(400).json({ error: err.message });
    }
    return res.status(400).json({ error: err.message || 'Upload failed' });
  });
}

const periodPricingFields = [
  'default_price',
  'early_morning_price',
  'morning_price',
  'afternoon_price',
  'evening_price'
];

function parsePeriodPricingFields(body) {
  const values = {};
  for (const field of periodPricingFields) {
    if (body[field] === undefined || body[field] === null || String(body[field]).trim() === '') {
      values[field] = null;
      continue;
    }
    const parsed = parseFloat(body[field]);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: `${field} must be a non-negative number` };
    }
    values[field] = parsed;
  }
  return { values };
}

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

    fireNotification('owner.registered', { ownerId: result.insertId });
    res.json({ success: true, message: 'Registration successful! You can now log in.', owner_id: result.insertId });
  } catch (err) {
    console.error('Error registering owner:', err);
    res.status(500).json({ error: 'Registration failed', details: err.message });
  }
});

// POST /api/owners/login — Owner login
router.post('/login', async (req, res) => {
  try {
    const { email, username, password, phone } = req.body || {};
    const identifier = String(email || username || phone || req.body?.identifier || '').trim();
    if (!identifier) {
      return res.status(400).json({ error: 'Email, phone or identifier is required' });
    }
    const [ownerRows] = await pool.query('SELECT * FROM owners WHERE email = ? OR phone = ?', [identifier, identifier]);

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    if (ownerRows.length === 0) {
      return res.status(401).json({ error: 'Owner account not found' });
    }
    const owner = ownerRows[0];

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
    const [rows] = await pool.query('SELECT id, name, email, phone, created_at, business_types FROM owners WHERE id = ?', [req.user.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Owner not found' });
    }
    const owner = rows[0];
    owner.business_types = businessTypes.normalize(owner.business_types);
    res.json({ owner });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PATCH /api/owners/business-types — which modules this owner's panel shows (SPORTS / ACTIVITY / EVENT). Admin and
// customers can never set this for an owner; only the owner themselves, and it never affects any other owner's turfs
// or activities.
router.patch('/business-types', verifyToken, verifyOwner, async (req, res) => {
  try {
    const result = await businessTypes.setOwnerBusinessTypes(req.user.id, (req.body || {}).business_types);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true, business_types: result.business_types });
  } catch (err) {
    res.status(500).json({ error: 'Could not update business types' });
  }
});

// GET /api/owners/venues/summary — Aggregated status of all venues owned by current owner
router.get('/venues/summary', verifyToken, verifyOwner, async (req, res) => {
  try {
    const [turfRows] = await pool.query(
      'SELECT * FROM turfs WHERE owner_id = ? AND (is_deleted IS NULL OR is_deleted = 0) ORDER BY created_at DESC',
      [req.user.id]
    );
    const turfs = turfRows.map(mapOwnerTurfRow);

    // Also fetch activities if table exists
    let activities = [];
    try {
      const [actRows] = await pool.query(
        `SELECT a.*, c.key_name AS category_key, c.label AS category_label
         FROM activities a LEFT JOIN activity_categories c ON c.id = a.category_id
         WHERE a.owner_id = ? ORDER BY a.id DESC`,
        [req.user.id]
      );
      activities = actRows.map(a => ({
        id: a.id,
        is_activity: true,
        type: 'ACTIVITY',
        name: a.name,
        slug: a.slug,
        location: a.location,
        city: a.city,
        state_province: a.state_province,
        country_code: a.country_code || 'IN',
        currency_code: a.currency_code || 'INR',
        timezone: a.timezone || 'Asia/Kolkata',
        category: a.category_key || 'AMUSEMENT_PARK',
        categories: [a.category_key || 'AMUSEMENT_PARK'],
        booking_model: a.timed_entry_enabled ? 'SESSION' : 'TICKET',
        enabled_capabilities: ['tickets', 'capacity', 'qr_checkin'],
        approval_status: a.status === 'approved' ? 'APPROVED' : (a.status === 'rejected' ? 'REJECTED' : (a.status === 'suspended' ? 'REJECTED' : 'PENDING_APPROVAL')),
        status: a.status,
        is_active: a.status === 'approved',
        created_at: a.created_at
      }));
    } catch (e) {
      // activities table may be optional
    }

    const allVenues = [
      ...turfs.map(t => ({ ...t, is_activity: false, type: 'TURF' })),
      ...activities
    ];

    const approvedVenues = allVenues.filter(v => (v.approval_status || '').toUpperCase() === 'APPROVED');
    const pendingVenues = allVenues.filter(v => (v.approval_status || '').toUpperCase() === 'PENDING_APPROVAL');
    const actionRequiredVenues = allVenues.filter(v => (v.approval_status || '').toUpperCase() === 'ACTION_REQUIRED');
    const rejectedVenues = allVenues.filter(v => (v.approval_status || '').toUpperCase() === 'REJECTED');
    const draftVenues = allVenues.filter(v => (v.approval_status || '').toUpperCase() === 'DRAFT');

    const hasApprovedVenue = approvedVenues.length > 0;
    const hasAnyVenue = allVenues.length > 0;

    res.json({
      success: true,
      hasApprovedVenue,
      hasAnyVenue,
      totalVenues: allVenues.length,
      approvedVenues,
      pendingVenues,
      actionRequiredVenues,
      rejectedVenues,
      draftVenues,
      venues: allVenues,
      primaryVenue: approvedVenues[0] || allVenues[0] || null
    });
  } catch (err) {
    console.error('Error fetching venues summary:', err);
    res.status(500).json({ error: 'Failed to fetch venues summary' });
  }
});

// POST /api/owners/venues/draft — Save or update incomplete venue registration
router.post('/venues/draft', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { draftId, step, draftData, name, country_code, currency_code, timezone, category, categories, booking_model } = req.body;
    
    // Check if updating existing draft
    if (draftId) {
      const [existing] = await pool.query('SELECT id, owner_id FROM turfs WHERE id = ?', [draftId]);
      if (existing.length > 0 && existing[0].owner_id === req.user.id) {
        await pool.query(
          `UPDATE turfs SET name = ?, registration_step = ?, draft_data = ?, country_code = ?, currency_code = ?, timezone = ?, category = ?, categories = ?, booking_model = ? WHERE id = ?`,
          [
            name || 'Untitled Venue Draft',
            step || 1,
            JSON.stringify(draftData || {}),
            country_code || 'IN',
            currency_code || 'INR',
            timezone || 'Asia/Kolkata',
            category || 'SPORTS',
            JSON.stringify(categories || [category || 'SPORTS']),
            booking_model || 'SLOT',
            draftId
          ]
        );
        return res.json({ success: true, draft_id: draftId, message: 'Draft updated successfully' });
      }
    }

    // Insert new draft
    const baseSlug = (name || 'draft-venue').toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 50);
    const slug = `${baseSlug}-${Math.random().toString(36).substring(2, 7)}`;
    const [result] = await pool.query(
      `INSERT INTO turfs (name, location, sport_type, price_per_hour, owner_id, slug, approval_status, status, is_active, registration_step, draft_data, country_code, currency_code, timezone, category, categories, booking_model)
       VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', 'DRAFT', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name || 'Untitled Venue Draft',
        (draftData && (draftData.location || draftData.city)) || 'Incomplete',
        (draftData && draftData.sport_type) || 'general',
        (draftData && parseFloat(draftData.price_per_hour)) || 0,
        req.user.id,
        slug,
        step || 1,
        JSON.stringify(draftData || {}),
        country_code || 'IN',
        currency_code || 'INR',
        timezone || 'Asia/Kolkata',
        category || 'SPORTS',
        JSON.stringify(categories || [category || 'SPORTS']),
        booking_model || 'SLOT'
      ]
    );

    res.json({ success: true, draft_id: result.insertId, message: 'Draft saved successfully' });
  } catch (err) {
    console.error('Error saving draft:', err);
    res.status(500).json({ error: 'Failed to save venue draft', details: err.message });
  }
});

// GET /api/owners/turfs — Get owner's turfs
router.get('/turfs', verifyToken, verifyOwner, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM turfs WHERE owner_id = ? ORDER BY created_at DESC', [req.user.id]);
    const turfs = rows.map(mapOwnerTurfRow);
    // selected sports (canonical ids) so the venue form can pre-fill its multi-select; best effort
    try {
      if (turfs.length) {
        const [links] = await pool.query(`SELECT turf_id, category_id FROM turf_sports WHERE turf_id IN (${turfs.map(() => '?').join(',')})`, turfs.map((t) => t.id));
        const by = new Map();
        for (const l of links) { if (!by.has(l.turf_id)) by.set(l.turf_id, []); by.get(l.turf_id).push(l.category_id); }
        for (const t of turfs) t.sport_ids = by.get(t.id) || [];
      }
    } catch (e) { /* turf_sports not created yet */ }
    res.json({ turfs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch turfs' });
  }
});

// GET /api/owners/search-location — Search location / venue for owner panel
const { searchVenues } = require('../services/mapsService');
router.get('/search-location', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query || String(query).trim().length < 2) {
      return res.json({ results: [] });
    }
    const results = await searchVenues(query);
    res.json({ results });
  } catch (err) {
    console.error('Error searching location:', err);
    res.status(500).json({ error: 'Failed to search location', results: [] });
  }
});

// POST /api/owners/turfs — Add a new turf
router.post('/turfs', verifyToken, verifyOwner, async (req, res) => {
  try {
    { const _e = scheduleGuard(req.body); if (_e) return res.status(400).json({ error: _e }); }
    const {
      name, location, address, sport_type: sport_type_in, price_per_hour, description,
      images, photos, coverImage, photosCount, amenities, open_time, close_time,
      markup_type, markup_value, slot_duration, time_format, advance_percent,
      latitude, longitude, default_price, early_morning_price, morning_price,
      afternoon_price, evening_price, owner_email, place_id, postal_code, city,
      category, categories, booking_model, enabled_capabilities, draft_id, is_draft
    } = req.body;

    const sportSel = await venueSports.resolveSelection(req.body);
    if (sportSel.error) return res.status(400).json({ error: sportSel.error });
    const sport_type = sportSel.text !== null ? sportSel.text : sport_type_in;
    const parsedPeriodPricing = parsePeriodPricingFields(req.body);
    if (parsedPeriodPricing.error) return res.status(400).json({ error: parsedPeriodPricing.error });
    const normalizedSlotDuration = Number(slot_duration) === 30 ? 30 : 60;
    const normalizedTimeFormat = String(time_format || '').trim().toLowerCase() === '24h' ? '24h' : '12h';
    const normalizedAdvancePercent = [20, 30, 50, 100].includes(Number(advance_percent)) ? Number(advance_percent) : 100;
    const normalizedPhotos = Array.isArray(photos) && photos.length > 0 ? photos : (Array.isArray(images) ? images : []);
    const normalizedCover = coverImage || normalizedPhotos[0] || null;
    const normalizedPhotosCount = Number(photosCount) || normalizedPhotos.length;

    let numLat = parseFloat(latitude);
    let numLng = parseFloat(longitude);
    const isValidCoords = !isNaN(numLat) && !isNaN(numLng) && numLat !== 0 && numLng !== 0 && numLat >= -90 && numLat <= 90 && numLng >= -180 && numLng <= 180;
    if (!isValidCoords) {
      numLat = null; // unknown location stays unknown (no invented coordinates)
      numLng = null;
    }

    if (!name || !location || !price_per_hour) {
      return res.status(400).json({ error: 'Name, location, and base price are required' });
    }

    // country -> currency + timezone are decided HERE from the countries table, never taken from the client
    const geo = await globalConfig.resolveVenueGeo({ country_code: req.body.country_code, timezone: req.body.timezone });
    if (geo.error) return res.status(400).json({ error: geo.error });

    // Generate unique slug
    const baseSlug = name.toLowerCase()
      .trim()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    
    const locationSlug = location.toLowerCase().trim().replace(/[^a-z0-9]/g, '-');
    const randomSalt = Math.random().toString(36).substring(2, 6);
    let slug = `${baseSlug}-${locationSlug}-${randomSalt}`;
    
    const resolvedOwnerEmail = (owner_email && String(owner_email).trim()) || null;
    const initialApprovalStatus = is_draft ? 'DRAFT' : 'PENDING_APPROVAL';
    const initialActive = false; // Only active once approved by admin
    const initialStatus = is_draft ? 'DRAFT' : 'PENDING_APPROVAL';

    const finalCategory = category || 'SPORTS';
    const finalCategories = JSON.stringify(Array.isArray(categories) && categories.length > 0 ? categories : [finalCategory]);
    const finalBookingModel = booking_model || 'SLOT';
    const finalCapabilities = JSON.stringify(Array.isArray(enabled_capabilities) && enabled_capabilities.length > 0 ? enabled_capabilities : ['courts', 'slots', 'subscriptions']);

    let turfId = null;

    // If converting from an existing draft
    if (draft_id) {
      const [draftCheck] = await pool.query('SELECT id, owner_id FROM turfs WHERE id = ?', [draft_id]);
      if (draftCheck.length > 0 && draftCheck[0].owner_id === req.user.id) {
        turfId = draft_id;
        await pool.query(
          `UPDATE turfs SET
             name = ?, location = ?, address = ?, sport_type = ?, price_per_hour = ?, description = ?,
             images = ?, photos = ?, coverImage = ?, photosCount = ?, amenities = ?, open_time = ?, close_time = ?,
             markup_type = ?, markup_value = ?, slot_duration = ?, time_format = ?, advance_percent = ?,
             latitude = ?, longitude = ?, default_price = ?, early_morning_price = ?, morning_price = ?,
             afternoon_price = ?, evening_price = ?, owner_email = ?, place_id = ?, postal_code = ?, city = ?,
             approval_status = ?, status = ?, is_active = ?, registration_step = ?, category = ?, categories = ?,
             booking_model = ?, enabled_capabilities = ?, country_code = ?, currency_code = ?, timezone = ?, state_province = ?
           WHERE id = ?`,
          [
            name, location, address || '', sport_type || 'general', price_per_hour, description || '',
            JSON.stringify(normalizedPhotos), JSON.stringify(normalizedPhotos), normalizedCover, normalizedPhotosCount, JSON.stringify(amenities || []),
            open_time || '06:00', close_time || '23:00', markup_type || 'fixed', markup_value || 0, normalizedSlotDuration, normalizedTimeFormat,
            normalizedAdvancePercent, numLat, numLng, parsedPeriodPricing.values.default_price, parsedPeriodPricing.values.early_morning_price,
            parsedPeriodPricing.values.morning_price, parsedPeriodPricing.values.afternoon_price, parsedPeriodPricing.values.evening_price,
            resolvedOwnerEmail, place_id || null, postal_code || null, city || null,
            initialApprovalStatus, initialStatus, initialActive, 3, finalCategory, finalCategories, finalBookingModel, finalCapabilities,
            geo.country_code, geo.currency_code, geo.timezone, req.body.state_province ? String(req.body.state_province).slice(0, 80) : null,
            turfId
          ]
        );
      }
    }

    if (!turfId) {
      const [result] = await pool.query(
        `INSERT INTO turfs (name, location, address, sport_type, price_per_hour, description, images, photos, coverImage, photosCount, amenities, owner_id, open_time, close_time, markup_type, markup_value, slot_duration, time_format, advance_percent, slug, latitude, longitude, default_price, early_morning_price, morning_price, afternoon_price, evening_price, owner_email, place_id, postal_code, city, approval_status, status, is_active, registration_step, category, categories, booking_model, enabled_capabilities, country_code, currency_code, timezone, state_province)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name, location, address || '', sport_type || 'general', price_per_hour, description || '', JSON.stringify(normalizedPhotos), JSON.stringify(normalizedPhotos), normalizedCover, normalizedPhotosCount, JSON.stringify(amenities || []), req.user.id, open_time || '06:00', close_time || '23:00', markup_type || 'fixed', markup_value || 0, normalizedSlotDuration, normalizedTimeFormat, normalizedAdvancePercent, slug, numLat, numLng, parsedPeriodPricing.values.default_price, parsedPeriodPricing.values.early_morning_price, parsedPeriodPricing.values.morning_price, parsedPeriodPricing.values.afternoon_price, parsedPeriodPricing.values.evening_price, resolvedOwnerEmail, place_id || null, postal_code || null, city || null,
          initialApprovalStatus, initialStatus, initialActive, 3, finalCategory, finalCategories, finalBookingModel, finalCapabilities, geo.country_code, geo.currency_code, geo.timezone, req.body.state_province ? String(req.body.state_province).slice(0, 80) : null
        ]
      );
      turfId = result.insertId;
    }

    await venueSports.sync(turfId, sportSel.ids);
    fireNotification('owner.venue_submitted', { turfId, ownerId: req.user.id, status: initialApprovalStatus });
    await persistSchedule('turfs', turfId, req.body);
    res.json({
      success: true,
      turf_id: turfId,
      slug,
      approval_status: initialApprovalStatus,
      message: is_draft ? 'Venue draft saved' : 'Venue submitted for approval! An admin will review it shortly.',
      country_code: geo.country_code,
      currency_code: geo.currency_code,
      timezone: geo.timezone
    });
  } catch (err) {
    console.error('Error adding turf:', err);
    res.status(500).json({ error: 'Failed to add turf', details: err.message });
  }
});

// PUT /api/owners/turfs/:id — Edit a turf
router.put('/turfs/:id', verifyToken, verifyOwner, async (req, res) => {
  try {
    { const _e = scheduleGuard(req.body); if (_e) return res.status(400).json({ error: _e }); }
    // Verify owner owns the turf
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    const { name, location, address, sport_type: sport_type_in, price_per_hour, description, images, photos, coverImage, photosCount, amenities, is_active, open_time, close_time, markup_type, markup_value, slot_duration, time_format, advance_percent, latitude, longitude, default_price, early_morning_price, morning_price, afternoon_price, evening_price, owner_email, place_id, postal_code, city } = req.body;
    const sportSel = await venueSports.resolveSelection(req.body);
    if (sportSel.error) return res.status(400).json({ error: sportSel.error });
    const sport_type = sportSel.text !== null ? sportSel.text : sport_type_in;
    const parsedPeriodPricing = parsePeriodPricingFields(req.body);
    if (parsedPeriodPricing.error) return res.status(400).json({ error: parsedPeriodPricing.error });
    const normalizedSlotDuration = Number(slot_duration) === 30 ? 30 : 60;
    const normalizedTimeFormat = String(time_format || '').trim().toLowerCase() === '24h' ? '24h' : '12h';
    const normalizedAdvancePercent = [20, 30, 50, 100].includes(Number(advance_percent)) ? Number(advance_percent) : 100;
    const normalizedPhotos = Array.isArray(photos) && photos.length > 0 ? photos : (Array.isArray(images) ? images : []);
    const normalizedCover = coverImage || normalizedPhotos[0] || null;
    const normalizedPhotosCount = Number(photosCount) || normalizedPhotos.length;

    let numLat = parseFloat(latitude);
    let numLng = parseFloat(longitude);
    const isValidCoords = !isNaN(numLat) && !isNaN(numLng) && numLat !== 0 && numLng !== 0 && numLat >= -90 && numLat <= 90 && numLng >= -180 && numLng <= 180;
    if (!isValidCoords) {
      numLat = null; // unknown location stays unknown (no invented coordinates)
      numLng = null;
    }

    let geoUpdate = null;
    if (req.body.country_code !== undefined || req.body.timezone !== undefined) {
      const [[cur]] = await pool.query('SELECT country_code, currency_code FROM turfs WHERE id = ?', [req.params.id]);
      const geo = await globalConfig.resolveVenueGeo({ country_code: req.body.country_code || cur.country_code, timezone: req.body.timezone });
      if (geo.error) return res.status(400).json({ error: geo.error });
      if (geo.currency_code !== cur.currency_code) {
        const [[used]] = await pool.query("SELECT COUNT(*) AS c FROM bookings WHERE turf_id = ? AND status <> 'cancelled' AND payment_status = 'success'", [req.params.id]);
        if (used.c > 0) return res.status(400).json({ error: `This venue already has paid bookings in ${cur.currency_code}, so its country/currency can no longer be changed.` });
      }
      geoUpdate = geo;
    }

    // Optional: Update slug if name changes
    const baseSlug = name.toLowerCase().trim().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    const locationSlug = location.toLowerCase().trim().replace(/[^a-z0-9]/g, '-');
    const randomSalt = Math.random().toString(36).substring(2, 6);
    const slug = `${baseSlug}-${locationSlug}-${randomSalt}`;

    // Determine the notification email — prefer the submitted value, fall back to login email
    const resolvedOwnerEmail = (owner_email && String(owner_email).trim()) || null;
    console.log(`[Turf Update] id=${req.params.id} owner_email submitted="${owner_email}" resolved="${resolvedOwnerEmail}"`);

    await pool.query(
      `UPDATE turfs SET name = ?, location = ?, address = ?, sport_type = ?, price_per_hour = ?, description = ?, images = ?, photos = ?, coverImage = ?, photosCount = ?, amenities = ?, is_active = ?, open_time = ?, close_time = ?, markup_type = ?, markup_value = ?, slot_duration = ?, time_format = ?, advance_percent = ?, slug = ?, latitude = ?, longitude = ?, default_price = ?, early_morning_price = ?, morning_price = ?, afternoon_price = ?, evening_price = ?, owner_email = ?, place_id = COALESCE(?, place_id), postal_code = COALESCE(?, postal_code), city = COALESCE(?, city)
       WHERE id = ? AND owner_id = ?`,
      [name, location, address, sport_type, price_per_hour, description, JSON.stringify(normalizedPhotos), JSON.stringify(normalizedPhotos), normalizedCover, normalizedPhotosCount, JSON.stringify(amenities || []), is_active !== false, open_time || '06:00', close_time || '23:00', markup_type || 'fixed', markup_value || 0, normalizedSlotDuration, normalizedTimeFormat, normalizedAdvancePercent, slug, numLat, numLng, parsedPeriodPricing.values.default_price, parsedPeriodPricing.values.early_morning_price, parsedPeriodPricing.values.morning_price, parsedPeriodPricing.values.afternoon_price, parsedPeriodPricing.values.evening_price, resolvedOwnerEmail, place_id || null, postal_code || null, city || null, req.params.id, req.user.id]
    );

    await venueSports.sync(req.params.id, sportSel.ids);
    if (geoUpdate) await pool.query('UPDATE turfs SET country_code = ?, currency_code = ?, timezone = ? WHERE id = ?', [geoUpdate.country_code, geoUpdate.currency_code, geoUpdate.timezone, req.params.id]);
    if (req.body.state_province !== undefined) await pool.query('UPDATE turfs SET state_province = ? WHERE id = ?', [req.body.state_province ? String(req.body.state_province).slice(0, 80) : null, req.params.id]);
    await persistSchedule('turfs', req.params.id, req.body);
    res.json({ success: true, message: 'Turf updated successfully', slug });
  } catch (err) {
    console.error('Error updating turf:', err);
    res.status(500).json({ error: 'Failed to update turf' });
  }
});

// POST /api/owners/upload-image — Upload turf photo (before or after turf is saved)
router.post('/upload-image', verifyToken, verifyOwner, handleMulterUpload, (req, res) => {
  try {
    finalizeUploadedImage(req, res);
  } catch (err) {
    console.error('Error uploading turf image:', err);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// POST /api/owners/turfs/:id/upload-image — Upload photo for an existing turf
router.post('/turfs/:id/upload-image', verifyToken, verifyOwner, handleMulterUpload, async (req, res) => {
  try {
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    finalizeUploadedImage(req, res);
  } catch (err) {
    console.error('Error uploading turf image:', err);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// DELETE /api/owners/turfs/:id/remove-image — Remove uploaded file from disk
router.delete('/turfs/:id/remove-image', verifyToken, verifyOwner, async (req, res) => {
  try {
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    const filename = String(req.body?.filename || '').trim();
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const filePath = path.join(UPLOAD_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ success: true, message: 'Image removed successfully' });
  } catch (err) {
    console.error('Error removing turf image:', err);
    res.status(500).json({ error: 'Failed to remove image' });
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

// GET /api/owners/turfs/:id/courts — Get owner's courts for a turf (including pending and approved)
router.get('/turfs/:id/courts', verifyToken, verifyOwner, async (req, res) => {
  try {
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    const [rows] = await pool.query(
      'SELECT * FROM courts WHERE turf_id = ? ORDER BY created_at DESC, name ASC',
      [req.params.id]
    );

    const courts = rows.map(court => ({
      ...court,
      approval_status: court.approval_status || (court.is_active ? 'APPROVED' : 'PENDING_APPROVAL'),
      admin_feedback: court.admin_feedback || null,
      images: typeof court.images === 'string' ? JSON.parse(court.images) : court.images || [],
      amenities: typeof court.amenities === 'string' ? JSON.parse(court.amenities) : court.amenities || []
    }));

    res.json({ courts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch courts' });
  }
});

// POST /api/owners/turfs/:id/courts — Add a court (requires admin approval)
router.post('/turfs/:id/courts', verifyToken, verifyOwner, async (req, res) => {
  try {
    { const _e = scheduleGuard(req.body); if (_e) return res.status(400).json({ error: _e }); }
    const [turfCheck] = await pool.query('SELECT owner_id, approval_status FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    const { name, sport_type, price_per_hour, description, images, amenities, open_time, close_time, markup_type, markup_value, slot_duration, time_format, advance_percent, default_price, early_morning_price, morning_price, afternoon_price, evening_price } = req.body;
    const parsedPeriodPricing = parsePeriodPricingFields(req.body);
    if (parsedPeriodPricing.error) return res.status(400).json({ error: parsedPeriodPricing.error });

    if (!name || !sport_type || !price_per_hour) {
      return res.status(400).json({ error: 'Court name, sport type, and price are required' });
    }

    // Newly added court defaults to PENDING_APPROVAL and is_active = false
    const [result] = await pool.query(
      `INSERT INTO courts (turf_id, name, sport_type, price_per_hour, description, images, amenities, open_time, close_time, markup_type, markup_value, slot_duration, time_format, advance_percent, default_price, early_morning_price, morning_price, afternoon_price, evening_price, approval_status, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', false)`,
      [
        req.params.id, name, sport_type, price_per_hour, description || '',
        JSON.stringify(images || []), JSON.stringify(amenities || []),
        open_time || '06:00', close_time || '23:00', markup_type || 'fixed', markup_value || 0,
        slot_duration || 60, time_format || '12h', advance_percent || 100,
        parsedPeriodPricing.values.default_price, parsedPeriodPricing.values.early_morning_price,
        parsedPeriodPricing.values.morning_price, parsedPeriodPricing.values.afternoon_price, parsedPeriodPricing.values.evening_price
      ]
    );

    await persistSchedule('courts', result.insertId, req.body);
    res.json({
      success: true,
      court_id: result.insertId,
      approval_status: 'PENDING_APPROVAL',
      message: 'Court added and submitted for admin review. It will become bookable once approved.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add court', details: err.message });
  }
});

// PUT /api/owners/turfs/:id/courts/:courtId — Edit a court
router.put('/turfs/:id/courts/:courtId', verifyToken, verifyOwner, async (req, res) => {
  try {
    { const _e = scheduleGuard(req.body); if (_e) return res.status(400).json({ error: _e }); }
    const [courtCheck] = await pool.query(
      'SELECT c.*, t.owner_id FROM courts c JOIN turfs t ON c.turf_id = t.id WHERE c.id = ? AND t.owner_id = ?',
      [req.params.courtId, req.user.id]
    );
    if (courtCheck.length === 0) {
      return res.status(403).json({ error: 'You do not own this court' });
    }
    const curCourt = courtCheck[0];

    const { name, sport_type, price_per_hour, description, images, amenities, open_time, close_time, markup_type, markup_value, slot_duration, time_format, advance_percent, default_price, early_morning_price, morning_price, afternoon_price, evening_price } = req.body;
    const parsedPeriodPricing = parsePeriodPricingFields(req.body);
    if (parsedPeriodPricing.error) return res.status(400).json({ error: parsedPeriodPricing.error });

    if (!name || !sport_type || !price_per_hour) {
      return res.status(400).json({ error: 'Court name, sport type, and price are required' });
    }

    // Reapproval rule: If core pricing or slot duration changes on an approved court, require re-approval
    let targetApprovalStatus = curCourt.approval_status || 'APPROVED';
    let targetIsActive = curCourt.is_active;

    if (curCourt.approval_status === 'APPROVED') {
      const priceChanged = parseFloat(curCourt.price_per_hour) !== parseFloat(price_per_hour);
      const sportChanged = String(curCourt.sport_type).trim().toLowerCase() !== String(sport_type).trim().toLowerCase();
      const slotDurationChanged = Number(curCourt.slot_duration) !== Number(slot_duration);

      if (priceChanged || sportChanged || slotDurationChanged) {
        targetApprovalStatus = 'PENDING_APPROVAL';
        targetIsActive = false;
      }
    }

    await pool.query(
      `UPDATE courts SET name = ?, sport_type = ?, price_per_hour = ?, description = ?, images = ?, amenities = ?, open_time = ?, close_time = ?, markup_type = ?, markup_value = ?, slot_duration = ?, time_format = ?, advance_percent = ?, default_price = ?, early_morning_price = ?, morning_price = ?, afternoon_price = ?, evening_price = ?, approval_status = ?, is_active = ?
       WHERE id = ? AND turf_id = ?`,
      [
        name, sport_type, price_per_hour, description || '',
        JSON.stringify(images || []), JSON.stringify(amenities || []),
        open_time || '06:00', close_time || '23:00', markup_type || 'fixed', markup_value || 0,
        slot_duration || 60, time_format || '12h', advance_percent || 100,
        parsedPeriodPricing.values.default_price, parsedPeriodPricing.values.early_morning_price,
        parsedPeriodPricing.values.morning_price, parsedPeriodPricing.values.afternoon_price, parsedPeriodPricing.values.evening_price,
        targetApprovalStatus, targetIsActive,
        req.params.courtId, req.params.id
      ]
    );

    await persistSchedule('courts', req.params.courtId, req.body);
    const reapprovalTriggered = targetApprovalStatus === 'PENDING_APPROVAL' && curCourt.approval_status === 'APPROVED';
    res.json({
      success: true,
      message: reapprovalTriggered
        ? 'Court updated. Significant changes to pricing/duration require admin re-approval before becoming bookable.'
        : 'Court updated successfully',
      approval_status: targetApprovalStatus,
      reapproval_required: reapprovalTriggered
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update court', details: err.message });
  }
});

// DELETE /api/owners/turfs/:id/courts/:courtId — Delete a court
router.delete('/turfs/:id/courts/:courtId', verifyToken, verifyOwner, async (req, res) => {
  try {
    const [courtCheck] = await pool.query(
      'SELECT owner_id FROM courts c JOIN turfs t ON c.turf_id = t.id WHERE c.id = ? AND t.owner_id = ?',
      [req.params.courtId, req.user.id]
    );
    if (courtCheck.length === 0) {
      return res.status(403).json({ error: 'You do not own this court' });
    }

    await pool.query('DELETE FROM courts WHERE id = ? AND turf_id = ?', [req.params.courtId, req.params.id]);
    res.json({ success: true, message: 'Court deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete court' });
  }
});

// GET /api/owners/turfs/:id/base-pricing — Get period-based base pricing
router.get('/turfs/:id/base-pricing', verifyToken, verifyOwner, async (req, res) => {
  try {
    const courtId = req.query.court_id ? parseInt(req.query.court_id, 10) : null;
    let row;
    let targetType = 'turf';

    if (courtId) {
      const [courtRows] = await pool.query(
        `SELECT c.*, t.owner_id
         FROM courts c JOIN turfs t ON c.turf_id = t.id
         WHERE c.id = ? AND c.turf_id = ? AND t.owner_id = ?`,
        [courtId, req.params.id, req.user.id]
      );
      if (courtRows.length === 0) return res.status(404).json({ error: 'Court not found' });
      row = courtRows[0];
      targetType = 'court';
    } else {
      const [turfRows] = await pool.query(
        'SELECT * FROM turfs WHERE id = ? AND owner_id = ?',
        [req.params.id, req.user.id]
      );
      if (turfRows.length === 0) return res.status(404).json({ error: 'Turf not found' });
      row = turfRows[0];
    }

    res.json({
      basePricing: {
        target_type: targetType,
        default_price: row.default_price ?? '',
        early_morning_price: row.early_morning_price ?? '',
        morning_price: row.morning_price ?? '',
        afternoon_price: row.afternoon_price ?? '',
        evening_price: row.evening_price ?? ''
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch base pricing', details: err.message });
  }
});

// PUT /api/owners/turfs/:id/base-pricing — Save period-based base pricing
router.put('/turfs/:id/base-pricing', verifyToken, verifyOwner, async (req, res) => {
  try {
    const courtId = req.body.court_id ? parseInt(req.body.court_id, 10) : null;
    const parsedPeriodPricing = parsePeriodPricingFields(req.body);
    if (parsedPeriodPricing.error) return res.status(400).json({ error: parsedPeriodPricing.error });

    if (courtId) {
      const [courtCheck] = await pool.query(
        'SELECT owner_id FROM courts c JOIN turfs t ON c.turf_id = t.id WHERE c.id = ? AND c.turf_id = ? AND t.owner_id = ?',
        [courtId, req.params.id, req.user.id]
      );
      if (courtCheck.length === 0) return res.status(403).json({ error: 'You do not own this court' });

      await pool.query(
        `UPDATE courts SET default_price = ?, early_morning_price = ?, morning_price = ?, afternoon_price = ?, evening_price = ?
         WHERE id = ? AND turf_id = ?`,
        [
          parsedPeriodPricing.values.default_price, parsedPeriodPricing.values.early_morning_price,
          parsedPeriodPricing.values.morning_price, parsedPeriodPricing.values.afternoon_price,
          parsedPeriodPricing.values.evening_price, courtId, req.params.id
        ]
      );
    } else {
      const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
      if (turfCheck.length === 0) return res.status(403).json({ error: 'You do not own this turf' });

      await pool.query(
        `UPDATE turfs SET default_price = ?, early_morning_price = ?, morning_price = ?, afternoon_price = ?, evening_price = ?
         WHERE id = ? AND owner_id = ?`,
        [
          parsedPeriodPricing.values.default_price, parsedPeriodPricing.values.early_morning_price,
          parsedPeriodPricing.values.morning_price, parsedPeriodPricing.values.afternoon_price,
          parsedPeriodPricing.values.evening_price, req.params.id, req.user.id
        ]
      );
    }

    res.json({ success: true, message: 'Base pricing saved successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save base pricing', details: err.message });
  }
});

// GET /api/owners/turfs/:id/day-wise-pricing — Get day-wise pricing
router.get('/turfs/:id/day-wise-pricing', verifyToken, verifyOwner, async (req, res) => {
  try {
    const courtId = req.query.court_id ? parseInt(req.query.court_id, 10) : null;
    
    // Verify owner owns the turf
    const [turfRows] = await pool.query(
      'SELECT * FROM turfs WHERE id = ? AND owner_id = ?',
      [req.params.id, req.user.id]
    );
    if (turfRows.length === 0) return res.status(404).json({ error: 'Turf not found' });

    if (courtId) {
      const [courtRows] = await pool.query(
        'SELECT id FROM courts WHERE id = ? AND turf_id = ?',
        [courtId, req.params.id]
      );
      if (courtRows.length === 0) return res.status(404).json({ error: 'Court not found' });
    }

    let query = 'SELECT * FROM day_wise_pricing WHERE turf_id = ?';
    const params = [req.params.id];
    if (courtId) {
      query += ' AND court_id = ?';
      params.push(courtId);
    } else {
      query += ' AND court_id IS NULL';
    }

    const [rows] = await pool.query(query, params);
    res.json({ dayWisePricing: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch day-wise pricing', details: err.message });
  }
});

// PUT /api/owners/turfs/:id/day-wise-pricing — Save day-wise pricing
router.put('/turfs/:id/day-wise-pricing', verifyToken, verifyOwner, async (req, res) => {
  try {
    const courtId = req.body.court_id ? parseInt(req.body.court_id, 10) : null;
    const { day_of_week, early_morning_price, morning_price, afternoon_price, evening_price } = req.body;

    if (!day_of_week) {
      return res.status(400).json({ error: 'day_of_week is required' });
    }

    // Verify ownership
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
    if (turfCheck.length === 0) return res.status(403).json({ error: 'You do not own this turf' });

    if (courtId) {
      const [courtCheck] = await pool.query(
        'SELECT id FROM courts WHERE id = ? AND turf_id = ?',
        [courtId, req.params.id]
      );
      if (courtCheck.length === 0) return res.status(403).json({ error: 'Court not found' });
    }

    // Parse and validate pricing fields
    const prices = {
      early_morning_price: early_morning_price === '' || early_morning_price === null || early_morning_price === undefined ? null : parseFloat(early_morning_price),
      morning_price: morning_price === '' || morning_price === null || morning_price === undefined ? null : parseFloat(morning_price),
      afternoon_price: afternoon_price === '' || afternoon_price === null || afternoon_price === undefined ? null : parseFloat(afternoon_price),
      evening_price: evening_price === '' || evening_price === null || evening_price === undefined ? null : parseFloat(evening_price)
    };

    // Check if entry already exists
    let existingQuery = 'SELECT id FROM day_wise_pricing WHERE turf_id = ? AND day_of_week = ?';
    const existingParams = [req.params.id, day_of_week];
    if (courtId) {
      existingQuery += ' AND court_id = ?';
      existingParams.push(courtId);
    } else {
      existingQuery += ' AND court_id IS NULL';
    }

    const [existing] = await pool.query(existingQuery, existingParams);

    if (existing.length > 0) {
      // UPDATE
      let updateQuery = `
        UPDATE day_wise_pricing 
        SET early_morning_price = ?, morning_price = ?, afternoon_price = ?, evening_price = ?
        WHERE id = ?
      `;
      await pool.query(updateQuery, [
        prices.early_morning_price,
        prices.morning_price,
        prices.afternoon_price,
        prices.evening_price,
        existing[0].id
      ]);
    } else {
      // INSERT
      let insertQuery = `
        INSERT INTO day_wise_pricing (turf_id, court_id, day_of_week, early_morning_price, morning_price, afternoon_price, evening_price)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      await pool.query(insertQuery, [
        req.params.id,
        courtId,
        day_of_week,
        prices.early_morning_price,
        prices.morning_price,
        prices.afternoon_price,
        prices.evening_price
      ]);
    }

    res.json({ success: true, message: 'Day-wise pricing saved successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save day-wise pricing', details: err.message });
  }
});

// POST /api/owners/turfs/:id/block-slot — Block a slot
router.post('/turfs/:id/block-slot', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { block_date, time_slot, reason, court_id } = req.body;

    if (!block_date || !time_slot) {
      return res.status(400).json({ error: 'block_date and time_slot are required' });
    }

    // Verify owner owns the turf
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You are not authorized to block this court' });
    }

    if (court_id) {
      const [courtCheck] = await pool.query(
        'SELECT id FROM courts WHERE id = ? AND turf_id = ?',
        [court_id, req.params.id]
      );
      if (courtCheck.length === 0) {
        return res.status(400).json({ error: 'Invalid court selected for this turf' });
      }
    }

    let lockAcquired = false;
    lockAcquired = await acquireSlotLock(req.params.id, court_id || null, block_date);
    if (!lockAcquired) {
      return res.status(503).json({ error: 'Could not acquire slot lock. Please try again.' });
    }

    const vlock = await subscriptionReservations.lockVenue(req.params.id);
    try {
      const availCheck = await availabilityService.checkSingleSlotAvailability({
        turfId: req.params.id,
        courtId: court_id || null,
        date: block_date,
        timeSlot: time_slot
      });

      if (!availCheck.available) {
        return res.status(409).json({ error: availCheck.message, reason: availCheck.reason });
      }

      const [blockedInsert] = await pool.query(
        'INSERT INTO blocked_slots (turf_id, court_id, block_date, time_slot, reason) VALUES (?, ?, ?, ?, ?)',
        [req.params.id, court_id || null, block_date, time_slot, reason || '']
      );

      broadcastSse('slot_blocked', {
        turfId: req.params.id,
        courtId: court_id || null,
        date: block_date,
        time_slot: time_slot,
        blockedId: blockedInsert.insertId
      });

      res.json({ success: true, message: 'Slot blocked successfully' });
    } finally {
      await vlock.release();
      if (lockAcquired) {
        await releaseSlotLock(req.params.id, court_id || null, block_date).catch((unlockErr) => {
          console.warn('⚠️ Failed to release owner slot lock:', unlockErr.message || unlockErr);
        });
      }
    }
  } catch (err) {
    console.error('Error blocking slot:', err);
    res.status(500).json({ error: err.message || 'Failed to block slot' });
  }
});

// DELETE /api/owners/turfs/:id/unblock-slot — Unblock a slot
router.delete('/turfs/:id/unblock-slot', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { block_date, time_slot, court_id } = req.body;

    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You are not authorized to manage this court' });
    }

    const params = [req.params.id, block_date, time_slot];
    let query = 'DELETE FROM blocked_slots WHERE turf_id = ? AND block_date = ? AND time_slot = ?';

    if (court_id) {
      query += ' AND court_id = ?';
      params.push(court_id);
    } else {
      query += ' AND court_id IS NULL';
    }

    let lockAcquired = false;
    lockAcquired = await acquireSlotLock(req.params.id, court_id || null, block_date);
    if (!lockAcquired) {
      return res.status(503).json({ error: 'Could not acquire slot lock. Please retry.' });
    }

    try {
      await pool.query(query, params);

      broadcastSse('slot_unblocked', {
        turfId: req.params.id,
        courtId: court_id || null,
        date: block_date,
        time_slot: time_slot
      });

      res.json({ success: true, message: 'Slot unblocked successfully' });
    } finally {
      if (lockAcquired) {
        await releaseSlotLock(req.params.id, court_id || null, block_date).catch((unlockErr) => {
          console.warn('⚠️ Failed to release owner slot lock:', unlockErr.message || unlockErr);
        });
      }
    }
  } catch (err) {
    console.error('Unblock slot error:', err);
    res.status(500).json({ error: err.message || 'Failed to unblock slot' });
  }
});

// POST /api/owners/turfs/:id/block-slots/bulk — Block multiple slots at once
router.post('/turfs/:id/block-slots/bulk', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { block_date, time_slots, reason, court_id } = req.body;

    if (!block_date || !Array.isArray(time_slots) || time_slots.length === 0) {
      return res.status(400).json({ error: 'block_date and non-empty time_slots array are required' });
    }

    // Verify owner owns the turf
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You are not authorized to block this court' });
    }

    if (court_id) {
      const [courtCheck] = await pool.query(
        'SELECT id FROM courts WHERE id = ? AND turf_id = ?',
        [court_id, req.params.id]
      );
      if (courtCheck.length === 0) {
        return res.status(400).json({ error: 'Invalid court selected for this turf' });
      }
    }

    let lockAcquired = false;
    lockAcquired = await acquireSlotLock(req.params.id, court_id || null, block_date);
    if (!lockAcquired) {
      return res.status(503).json({ error: 'Could not acquire slot lock. Please retry.' });
    }

    // Start transaction
    const connection = await pool.getConnection();
    const vlock = await subscriptionReservations.lockVenue(req.params.id);
    try {
      await connection.beginTransaction();

      for (const slot of time_slots) {
        const availCheck = await availabilityService.checkSingleSlotAvailability({
          turfId: req.params.id,
          courtId: court_id || null,
          date: block_date,
          timeSlot: slot,
          dbConn: connection
        });

        if (!availCheck.available) {
          const err = new Error(availCheck.message);
          err.status = 409;
          err.reason = availCheck.reason;
          throw err;
        }

        await connection.query(
          'INSERT INTO blocked_slots (turf_id, court_id, block_date, time_slot, reason) VALUES (?, ?, ?, ?, ?)',
          [req.params.id, court_id || null, block_date, slot, reason || '']
        );
      }

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
      await vlock.release();
      if (lockAcquired) {
        await releaseSlotLock(req.params.id, court_id || null, block_date).catch((unlockErr) => {
          console.warn('⚠️ Failed to release owner bulk slot lock:', unlockErr.message || unlockErr);
        });
      }
    }

    // Broadcast SSE notifications
    for (const slot of time_slots) {
      broadcastSse('slot_blocked', {
        turfId: req.params.id,
        courtId: court_id || null,
        date: block_date,
        time_slot: slot
      });
    }

    res.json({ success: true, message: `${time_slots.length} slot(s) blocked successfully` });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to block slots', reason: err.reason });
  }
});

// POST /api/owners/turfs/:id/unblock-slots/bulk — Unblock multiple slots at once
router.post('/turfs/:id/unblock-slots/bulk', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { block_date, time_slots, court_id } = req.body;

    if (!block_date || !Array.isArray(time_slots) || time_slots.length === 0) {
      return res.status(400).json({ error: 'block_date and non-empty time_slots array are required' });
    }

    // Verify owner owns the turf
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You are not authorized to manage this court' });
    }

    let lockAcquired = false;
    lockAcquired = await acquireSlotLock(req.params.id, court_id || null, block_date);
    if (!lockAcquired) {
      return res.status(503).json({ error: 'Could not acquire slot lock. Please retry.' });
    }

    // Start transaction
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      for (const slot of time_slots) {
        let query = 'DELETE FROM blocked_slots WHERE turf_id = ? AND block_date = ? AND time_slot = ?';
        const params = [req.params.id, block_date, slot];
        if (court_id) {
          query += ' AND court_id = ?';
          params.push(court_id);
        } else {
          query += ' AND court_id IS NULL';
        }
        await connection.query(query, params);
      }

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
      if (lockAcquired) {
        await releaseSlotLock(req.params.id, court_id || null, block_date).catch((unlockErr) => {
          console.warn('⚠️ Failed to release owner bulk unblock slot lock:', unlockErr.message || unlockErr);
        });
      }
    }

    // Broadcast SSE notifications
    for (const slot of time_slots) {
      broadcastSse('slot_unblocked', {
        turfId: req.params.id,
        courtId: court_id || null,
        date: block_date,
        time_slot: slot
      });
    }

    res.json({ success: true, message: `${time_slots.length} slot(s) unblocked successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to unblock slots' });
  }
});

// GET /api/owners/bookings — Get all bookings for owner's turfs
router.get('/bookings', verifyToken, verifyOwner, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.id, b.payment_id, b.customer_name, b.customer_phone, b.customer_email,
              b.booking_date, b.time_slot, b.amount, b.original_price,
              b.payment_status, b.status, b.created_at, b.currency_code,
              b.discount_amount, b.advance_amount, b.pending_balance, b.payment_type,
              b.need_players, b.match_request_id,
              t.name as turf_name, c.name as court_name,
              (SELECT COALESCE(SUM(mp.amount_paid), 0) 
               FROM match_players mp 
               WHERE mp.match_id = b.match_request_id 
                 AND mp.payment_status IN ('paid', 'success')
              ) as players_collected
       FROM bookings b
       JOIN turfs t ON b.turf_id = t.id
       LEFT JOIN courts c ON b.court_id = c.id
       WHERE t.owner_id = ? AND b.payment_status = 'success' AND b.status = 'confirmed'
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );

    // netAmount = exact original_price - discount_amount (no commission deductions)
    const bookings = rows.map(booking => {
      const discount = parseFloat(booking.discount_amount || 0);
      const netAmount = parseFloat(booking.original_price || booking.amount || 0) - discount;
      return {
        ...booking,
        netAmount: Math.round(netAmount * 100) / 100
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

    const courtId = req.query.court_id ? parseInt(req.query.court_id, 10) : null;
    let query = 'SELECT * FROM special_pricing WHERE turf_id = ?';
    const params = [req.params.id];
    if (courtId) {
      query += ' AND court_id = ?';
      params.push(courtId);
    } else {
      query += ' AND court_id IS NULL';
    }
    query += ' ORDER BY day_of_week, specific_date, time_slot';

    const [rows] = await pool.query(query, params);

    res.json({ specialPricing: rows });
  } catch (err) {
    console.error('Error fetching special pricing:', err);
    res.status(500).json({ error: 'Failed to fetch special pricing' });
  }
});

// POST /api/owners/turfs/:id/special-pricing — Set special pricing for a slot
router.post('/turfs/:id/special-pricing', verifyToken, verifyOwner, async (req, res) => {
  try {
    const { day_of_week, specific_date, time_slot, special_price, offer_percentage, offer_label, court_id } = req.body;
    const courtId = court_id ? parseInt(court_id, 10) : null;

    // Verify owner owns the turf
    const [turfCheck] = await pool.query('SELECT owner_id FROM turfs WHERE id = ?', [req.params.id]);
    if (turfCheck.length === 0 || turfCheck[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }
    if (courtId) {
      const [courtCheck] = await pool.query('SELECT owner_id FROM courts c JOIN turfs t ON c.turf_id = t.id WHERE c.id = ? AND c.turf_id = ? AND t.owner_id = ?', [courtId, req.params.id, req.user.id]);
      if (courtCheck.length === 0) return res.status(403).json({ error: 'You do not own this court' });
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
      `INSERT INTO special_pricing (turf_id, court_id, day_of_week, specific_date, time_slot, special_price, offer_percentage, offer_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE special_price = VALUES(special_price), offer_percentage = VALUES(offer_percentage), offer_label = VALUES(offer_label)`,
      [req.params.id, courtId, day, specific_date || null, time_slot, special_price, offer_percentage || null, offer_label || null]
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
      const { day_of_week, specific_date, time_slot, special_price, offer_percentage, offer_label, court_id } = entry;
      if (!time_slot || special_price === undefined || special_price === null) continue;

      const day = day_of_week !== undefined && day_of_week !== null ? parseInt(day_of_week) : null;
      const courtId = court_id ? parseInt(court_id, 10) : null;

      await pool.query(
        `INSERT INTO special_pricing (turf_id, court_id, day_of_week, specific_date, time_slot, special_price, offer_percentage, offer_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE special_price = VALUES(special_price), offer_percentage = VALUES(offer_percentage), offer_label = VALUES(offer_label)`,
        [req.params.id, courtId, day, specific_date || null, time_slot, special_price, offer_percentage || null, offer_label || null]
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

function parseMinutes(timeStr = '06:00') {
  const cleanStr = String(timeStr).trim();
  const match = cleanStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (match) {
    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const ampm = match[3];
    if (ampm) {
      if (ampm.toUpperCase() === 'PM' && hours !== 12) hours += 12;
      if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
    }
    if (hours === 24 && minutes === 0) {
      return 24 * 60;
    }
    return (hours % 24) * 60 + minutes;
  }
  const [hours = '0', minutes = '0'] = cleanStr.split(':');
  return (parseInt(hours, 10) || 0) * 60 + (parseInt(minutes, 10) || 0);
}

function getSlotStartMinutes(slotRange) {
  const [start] = String(slotRange || '').split('-').map(s => s.trim());
  return parseMinutes(start);
}

function getSlotPeriod(slotStartMinutes) {
  const mins = slotStartMinutes % 1440;
  if (mins >= 0 && mins < 360) return 'earlyMorning';
  if (mins >= 360 && mins < 720) return 'morning';
  if (mins >= 720 && mins < 1080) return 'afternoon';
  return 'evening';
}

function normalizeDate(val) {
  // Normalize DB date values (Date objects or 'YYYY-MM-DD' strings) to 'YYYY-MM-DD' string
  if (!val) return null;
  if (val instanceof Date) {
    return `${val.getFullYear()}-${String(val.getMonth() + 1).padStart(2, '0')}-${String(val.getDate()).padStart(2, '0')}`;
  }
  // Already a string — strip time portion if present
  return String(val).slice(0, 10);
}

function resolveSlotPriceLocal(slot, turfMap, courtMap, specialPricingList, dayWisePricingList = []) {
  const { turf_id, court_id, block_date, time_slot } = slot;

  // 1. Get the bookable entity (court or turf)
  const entity = court_id ? courtMap[court_id] : turfMap[turf_id];
  if (!entity) return 0;

  // 2. Normalize block_date to 'YYYY-MM-DD' string (DB may return Date object)
  const blockDateStr = normalizeDate(block_date);
  const dateObj = new Date(blockDateStr + 'T00:00:00');
  const dayOfWeek = dateObj.getDay();

  // 3. Find matching special pricing
  let matchedSp = null;

  for (const sp of specialPricingList) {
    if (Number(sp.turf_id) !== Number(turf_id) || sp.time_slot !== time_slot) continue;

    const matchesCourt = court_id
      ? (Number(sp.court_id) === Number(court_id))
      : (sp.court_id === null || sp.court_id === undefined);

    const spDateStr = normalizeDate(sp.specific_date);
    const matchesDate = spDateStr !== null && spDateStr === blockDateStr;
    const matchesDay = spDateStr === null && sp.day_of_week === dayOfWeek;

    if (matchesCourt && (matchesDate || matchesDay)) {
      if (!matchedSp) {
        matchedSp = sp;
      } else {
        const currentScore = (matchedSp.court_id ? 2 : 0) + (normalizeDate(matchedSp.specific_date) ? 1 : 0);
        const newScore = (sp.court_id ? 2 : 0) + (spDateStr ? 1 : 0);
        if (newScore > currentScore) {
          matchedSp = sp;
        }
      }
    }
  }

  if (matchedSp) {
    return parseFloat(matchedSp.special_price);
  }

  const startMins = getSlotStartMinutes(time_slot);
  const period = getSlotPeriod(startMins);

  // 3.5 Find matching day wise pricing (Priority 2)
  if (dayWisePricingList && dayWisePricingList.length > 0) {
    const DAYS_OF_WEEK_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = DAYS_OF_WEEK_NAMES[dayOfWeek];
    const dw = dayWisePricingList.find(item => 
      Number(item.turf_id) === Number(turf_id) && 
      item.day_of_week === dayName && 
      (court_id ? Number(item.court_id) === Number(court_id) : (item.court_id === null || item.court_id === undefined))
    );
    if (dw) {
      let dayWisePrice = null;
      if (period === 'earlyMorning' && dw.early_morning_price !== null) {
        dayWisePrice = parseFloat(dw.early_morning_price);
      } else if (period === 'morning' && dw.morning_price !== null) {
        dayWisePrice = parseFloat(dw.morning_price);
      } else if (period === 'afternoon' && dw.afternoon_price !== null) {
        dayWisePrice = parseFloat(dw.afternoon_price);
      } else if (period === 'evening' && dw.evening_price !== null) {
        dayWisePrice = parseFloat(dw.evening_price);
      }
      if (dayWisePrice !== null && dayWisePrice > 0) {
        return dayWisePrice;
      }
    }
  }

  // 4. Fallback to period pricing (Priority 3)
  let price = 0;
  if (period === 'earlyMorning') {
    price = parseFloat(entity.early_morning_price);
  } else if (period === 'morning') {
    price = parseFloat(entity.morning_price);
  } else if (period === 'afternoon') {
    price = parseFloat(entity.afternoon_price);
  } else if (period === 'evening') {
    price = parseFloat(entity.evening_price);
  }

  if (!price || price <= 0) {
    price = parseFloat(entity.default_price || entity.price_per_hour || 0);
  }
  return price;
}

function parseLocalDateOnly(value) {
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

function formatLocalDateOnly(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function diffDaysInclusive(startDate, endDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((endDate.getTime() - startDate.getTime()) / msPerDay) + 1;
}

function resolveEarningsDateRange(query) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const ninetyDaysAgo = new Date(today);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 89);

  const hasCustomRange = !!(query.start_date || query.end_date);
  const rawRangeDays = query.range_days ? parseInt(query.range_days, 10) : null;

  if (hasCustomRange) {
    if (!query.start_date || !query.end_date) {
      return { error: 'Both start_date and end_date are required for custom range' };
    }

    const startDate = parseLocalDateOnly(query.start_date);
    const endDate = parseLocalDateOnly(query.end_date);

    if (!startDate || !endDate) {
      return { error: 'Invalid date format. Use YYYY-MM-DD' };
    }
    if (startDate > endDate) {
      return { error: 'start_date cannot be after end_date' };
    }
    if (startDate < ninetyDaysAgo) {
      return { error: 'Custom range can only include the last 90 days' };
    }
    if (diffDaysInclusive(startDate, endDate) > 90) {
      return { error: 'Custom range cannot exceed 90 days' };
    }

    return {
      filter_type: 'custom',
      startDate,
      endDate,
      start_date: formatLocalDateOnly(startDate),
      end_date: formatLocalDateOnly(endDate),
      days: diffDaysInclusive(startDate, endDate)
    };
  }

  if (rawRangeDays) {
    if (Number.isNaN(rawRangeDays) || rawRangeDays < 1 || rawRangeDays > 90) {
      return { error: 'range_days must be between 1 and 90' };
    }

    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (rawRangeDays - 1));

    return {
      filter_type: 'preset',
      startDate,
      endDate: today,
      start_date: formatLocalDateOnly(startDate),
      end_date: formatLocalDateOnly(today),
      days: rawRangeDays
    };
  }

  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const currentMonthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  return {
    filter_type: 'current_month',
    startDate: currentMonthStart,
    endDate: currentMonthEnd,
    start_date: formatLocalDateOnly(currentMonthStart),
    end_date: formatLocalDateOnly(currentMonthEnd),
    days: diffDaysInclusive(currentMonthStart, currentMonthEnd)
  };
}

// GET /api/owners/earnings — Get earnings data for a specific turf (required)
router.get('/earnings', verifyToken, verifyOwner, async (req, res) => {
  try {
    const turfId = req.query.turf_id ? parseInt(req.query.turf_id, 10) : null;

    // Require turf_id — do not allow cross-turf combined view
    if (!turfId || isNaN(turfId)) {
      return res.status(400).json({ error: 'turf_id is required' });
    }

    // Verify ownership
    const [turfCheck] = await pool.query('SELECT id FROM turfs WHERE id = ? AND owner_id = ?', [turfId, req.user.id]);
    if (turfCheck.length === 0) {
      return res.status(403).json({ error: 'You do not own this turf' });
    }

    const range = resolveEarningsDateRange(req.query);
    if (range.error) {
      return res.status(400).json({ error: range.error });
    }

    // 1. Fetch reference data for the specific turf
    const [turfs] = await pool.query('SELECT *, monthly_subscription_amount, razorpay_linked_account_id FROM turfs WHERE id = ? AND owner_id = ?', [turfId, req.user.id]);
    const turfMap = {};
    turfs.forEach(t => turfMap[t.id] = t);

    if (turfs.length === 0) {
      return res.json({ total: 0, today: 0, monthly: 0, daily: [] });
    }

    const [courts] = await pool.query('SELECT * FROM courts WHERE turf_id = ?', [turfId]);
    const courtMap = {};
    courts.forEach(c => courtMap[c.id] = c);

    const [specialPricingList] = await pool.query('SELECT * FROM special_pricing WHERE turf_id = ?', [turfId]);
    const [dayWisePricingList] = await pool.query('SELECT * FROM day_wise_pricing WHERE turf_id = ?', [turfId]);

    // 2. Fetch ALL confirmed/success bookings for this turf with full payment detail
    const [bookings] = await pool.query(
      `SELECT b.original_price, b.discount_amount, b.booking_date, b.created_at,
              COALESCE(b.advance_amount, b.amount, 0) as razorpay_paid,
              b.payment_type
       FROM bookings b
       WHERE b.turf_id = ? AND b.status = 'confirmed' AND b.payment_status = 'success'`,
      [turfId]
    );

    // 3. Fetch blocked slots for this turf
    const [blockedSlots] = await pool.query(
      `SELECT bs.block_date, bs.time_slot, bs.turf_id, bs.court_id, bs.created_at
       FROM blocked_slots bs
       WHERE bs.turf_id = ?`,
      [turfId]
    );

    // 4. Fetch daily payouts for the selected range (for the daily breakdown)
    const [payoutRows] = await pool.query(
      `SELECT dp.payout_date, dp.status, dp.paid_at
       FROM daily_payouts dp
       WHERE dp.turf_id = ?
         AND dp.payout_date BETWEEN ? AND ?`,
      [turfId, range.start_date, range.end_date]
    );
    const payoutMap = {};
    payoutRows.forEach(row => {
      const dateStr = new Date(row.payout_date).toISOString().slice(0, 10);
      payoutMap[dateStr] = { status: row.status, paid_at: row.paid_at };
    });

    // 5. Aggregate calculations in JS
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const currentYear = now.getFullYear();
    const currentMonthVal = now.getMonth() + 1; // 1-12

    let totalEarnings = 0;
    let todayEarnings = 0;
    let monthlyEarnings = 0;
    let rangeSlotValue = 0;
    let rangeRazorpayCollected = 0;
    let rangeVenueCash = 0;
    let rangeBlockedValue = 0;
    let rangeCustomerBookingValue = 0;

    // dailyMap stores per-day data
    // Structure: { earnings: fullSlotValue, razorpay_paid, venue_cash, blocked_value, slots: [...] }
    const dailyMap = {};

    // Process Bookings — use full original_price as slot value
    for (const b of bookings) {
      const fullSlotValue = parseFloat(b.original_price || 0) - parseFloat(b.discount_amount || 0);
      const razorpayPaid = parseFloat(b.razorpay_paid || 0);

      totalEarnings += fullSlotValue;

      const createdAtDate = new Date(b.created_at);
      const createdAtStr = `${createdAtDate.getFullYear()}-${String(createdAtDate.getMonth() + 1).padStart(2, '0')}-${String(createdAtDate.getDate()).padStart(2, '0')}`;

      if (createdAtStr === todayStr) {
        todayEarnings += fullSlotValue;
      }

      const bDate = new Date(b.booking_date);
      const bDateStr = `${bDate.getFullYear()}-${String(bDate.getMonth() + 1).padStart(2, '0')}-${String(bDate.getDate()).padStart(2, '0')}`;

      if (bDate.getFullYear() === currentYear && (bDate.getMonth() + 1) === currentMonthVal) {
        monthlyEarnings += fullSlotValue;
      }

      const venueCash = Math.max(0, fullSlotValue - razorpayPaid);
      if (bDateStr >= range.start_date && bDateStr <= range.end_date) {
        rangeSlotValue += fullSlotValue;
        rangeRazorpayCollected += razorpayPaid;
        rangeVenueCash += venueCash;
        rangeCustomerBookingValue += fullSlotValue;

        if (!dailyMap[bDateStr]) dailyMap[bDateStr] = { earnings: 0, razorpay_paid: 0, venue_cash: 0, blocked_value: 0, slots: [] };
        dailyMap[bDateStr].earnings += fullSlotValue;
        dailyMap[bDateStr].razorpay_paid += razorpayPaid;
        dailyMap[bDateStr].venue_cash += venueCash;
        dailyMap[bDateStr].slots.push({ type: 'booking', amount: fullSlotValue, razorpay_paid: razorpayPaid, venue_cash: venueCash, payment_type: b.payment_type });
      }
    }

    // Process Blocked Slots — included in full slot value calculations
    for (const bs of blockedSlots) {
      const price = resolveSlotPriceLocal(bs, turfMap, courtMap, specialPricingList, dayWisePricingList);
      totalEarnings += price;

      const createdAtDate = new Date(bs.created_at);
      const createdAtStr = `${createdAtDate.getFullYear()}-${String(createdAtDate.getMonth() + 1).padStart(2, '0')}-${String(createdAtDate.getDate()).padStart(2, '0')}`;

      if (createdAtStr === todayStr) {
        todayEarnings += price;
      }

      const bDate = new Date(bs.block_date);
      const bDateStr = `${bDate.getFullYear()}-${String(bDate.getMonth() + 1).padStart(2, '0')}-${String(bDate.getDate()).padStart(2, '0')}`;

      if (bDate.getFullYear() === currentYear && (bDate.getMonth() + 1) === currentMonthVal) {
        monthlyEarnings += price;
      }

      if (bDateStr >= range.start_date && bDateStr <= range.end_date) {
        rangeSlotValue += price;
        rangeBlockedValue += price;
        if (!dailyMap[bDateStr]) dailyMap[bDateStr] = { earnings: 0, razorpay_paid: 0, venue_cash: 0, blocked_value: 0, slots: [] };
        dailyMap[bDateStr].earnings += price;
        dailyMap[bDateStr].blocked_value += price;
        dailyMap[bDateStr].slots.push({ type: 'owner_blocked', amount: price, razorpay_paid: 0, venue_cash: 0 });
      }
    }

    // Convert dailyMap to sorted array
    const daily = Object.keys(dailyMap).sort().map(dateStr => {
      const d = dailyMap[dateStr];
      const payout = payoutMap[dateStr] || { status: 'not_paid', paid_at: null };

      // Determine if this day has any customer bookings
      const hasCustomerBookings = d.slots.some(s => s.type === 'booking');
      const hasOwnerBlocked = d.slots.some(s => s.type === 'owner_blocked');
      const razorpayPaid = Math.round(d.razorpay_paid * 100) / 100;
      const venueCash = Math.round((d.venue_cash || 0) * 100) / 100;
      const blockedValue = Math.round(d.blocked_value * 100) / 100;

      return {
        date: dateStr,
        earnings: Math.round(d.earnings * 100) / 100,
        razorpay_paid: razorpayPaid,
        venue_cash: venueCash,
        blocked_value: blockedValue,
        has_customer_bookings: hasCustomerBookings,
        has_owner_blocked: hasOwnerBlocked,
        status: payout.status,
        paid_at: payout.paid_at
      };
    });

    const [settlementRows] = await pool.query(
      `SELECT currency, billing_model, status,
              SUM(COALESCE(captured_minor, 0)) AS captured_minor,
              SUM(COALESCE(platform_fee_minor, 0)) AS platform_fee_minor,
              SUM(COALESCE(tax_minor, 0)) AS tax_minor,
              SUM(COALESCE(subscription_deduction_minor, 0)) AS subscription_deduction_minor,
              SUM(COALESCE(owner_transfer_minor, 0)) AS owner_transfer_minor,
              COUNT(*) AS transfer_count
       FROM route_split_transfers
       WHERE turf_id = ? AND status <> 'SUPERSEDED'
         AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY currency, billing_model, status`,
      [turfId, range.start_date, range.end_date]
    );
    const settlementByCurrency = {};
    for (const row of settlementRows) {
      const current = settlementByCurrency[row.currency] || {
        currency: row.currency, captured_minor: 0, platform_fee_minor: 0, tax_minor: 0,
        subscription_deduction_minor: 0, owner_transfer_minor: 0, settled_owner_transfer_minor: 0,
        pending_owner_transfer_minor: 0, transfer_count: 0, by_model: {},
      };
      const count = Number(row.transfer_count || 0);
      const fee = Number(row.platform_fee_minor || 0);
      const ownerShare = Number(row.owner_transfer_minor || 0);
      current.captured_minor += Number(row.captured_minor || 0);
      current.platform_fee_minor += fee;
      current.tax_minor += Number(row.tax_minor || 0);
      current.subscription_deduction_minor += Number(row.subscription_deduction_minor || 0);
      current.owner_transfer_minor += ownerShare;
      current.transfer_count += count;
      if (['SUCCESS', 'NOT_REQUIRED'].includes(row.status)) current.settled_owner_transfer_minor += ownerShare;
      if (['PENDING', 'PROCESSING', 'RETRY_REQUIRED'].includes(row.status)) current.pending_owner_transfer_minor += ownerShare;
      const model = current.by_model[row.billing_model || 'UNKNOWN'] || { captured_minor: 0, platform_fee_minor: 0, owner_transfer_minor: 0, transfers: 0 };
      model.captured_minor += Number(row.captured_minor || 0);
      model.platform_fee_minor += fee;
      model.owner_transfer_minor += ownerShare;
      model.transfers += count;
      current.by_model[row.billing_model || 'UNKNOWN'] = model;
      settlementByCurrency[row.currency] = current;
    }

    res.json({
      total: Math.round(totalEarnings * 100) / 100,
      today: Math.round(todayEarnings * 100) / 100,
      monthly: Math.round(monthlyEarnings * 100) / 100,
      daily: daily,
      summary: {
        filter_type: range.filter_type,
        start_date: range.start_date,
        end_date: range.end_date,
        days: range.days,
        slot_value: Math.round(rangeSlotValue * 100) / 100,
        razorpay_collected: Math.round(rangeRazorpayCollected * 100) / 100,
        venue_cash: Math.round(rangeVenueCash * 100) / 100,
        blocked_value: Math.round(rangeBlockedValue * 100) / 100,
        customer_booking_value: Math.round(rangeCustomerBookingValue * 100) / 100,
        settlement_by_currency: settlementByCurrency,
        settlement_definition: 'Captured amounts, platform fee, tax, subscription deductions and owner transfer are from the immutable per-payment settlement snapshots. Gross booking value is not platform revenue; only SUCCESS/NOT_REQUIRED transfers count as settled to the owner.',
      },
    });
  } catch (err) {
    console.error('Error fetching owner earnings:', err);
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

// POST /api/owners/forgot-password — Request password reset OTP
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const [rows] = await pool.query('SELECT * FROM owners WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Owner account with this email does not exist' });
    }

    const owner = rows[0];
    if (!owner.is_approved) {
      return res.status(403).json({ error: 'Your account is pending admin approval.' });
    }

    // Generate 6 digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    await pool.query(
      'UPDATE owners SET reset_otp = ?, reset_otp_expires = ? WHERE id = ?',
      [otp, expires, owner.id]
    );

    // Send email with OTP
    const { sendEmail } = require('../utils/email');
    const mailMsg = `Hello ${owner.name},

You have requested to reset your password. Use the following 6-digit One-Time Password (OTP) to complete the reset process:

OTP: ${otp}

This OTP is valid for 15 minutes. If you did not request this, please ignore this email.

Best regards,
BookArena Team`;

    const emailRes = await sendEmail(owner.email, 'Password Reset OTP - BookArena', mailMsg);
    if (!emailRes.success) {
      // Fallback message for console/dev
      console.log(`[DEV ONLY] Password Reset OTP for ${owner.email} is: ${otp}`);
    }

    res.json({ success: true, message: 'OTP sent to registered email address' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to request password reset' });
  }
});

// POST /api/owners/reset-password — Reset password using OTP
router.post('/reset-password', async (req, res) => {
  try {
    const { email, otp, password } = req.body;
    if (!email || !otp || !password) {
      return res.status(400).json({ error: 'Email, OTP, and new password are required' });
    }

    const [rows] = await pool.query('SELECT * FROM owners WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Owner not found' });
    }

    const owner = rows[0];
    if (!owner.reset_otp || owner.reset_otp !== String(otp).trim()) {
      return res.status(400).json({ error: 'Invalid OTP code' });
    }

    if (new Date() > new Date(owner.reset_otp_expires)) {
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    // Update password
    const password_hash = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE owners SET password_hash = ?, reset_otp = NULL, reset_otp_expires = NULL WHERE id = ?',
      [password_hash, owner.id]
    );

    // a password change is a security event: tell the owner (in-app) in case it was not them
    fireNotification('security.alert', { to: { type: 'owner', id: owner.id }, eventKey: `password-reset:${owner.id}:${Date.now()}`, title: 'Password changed', message: 'Your Book Arena password was just changed. If this was not you, contact support immediately.' });
    res.json({ success: true, message: 'Password reset successfully! You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// GET /api/owners/tournaments — List tournaments created by this owner
router.get('/tournaments', verifyToken, verifyOwner, async (req, res) => {
  try {
    const ownerId = req.user.id;
    const [tournaments] = await pool.query(`
      SELECT id, name, sport, banner, logo, start_date, end_date, venue, location, visibility, status, slug
      FROM tournaments 
      WHERE owner_id = ? AND owner_type = 'owner'
      ORDER BY created_at DESC
    `, [ownerId]);
    res.json({ success: true, tournaments });
  } catch (error) {
    console.error('Error fetching owner tournaments:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tournaments' });
  }
});

module.exports = router;
