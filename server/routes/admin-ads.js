const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pool = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');

// Supported placements
const VALID_PLACEMENTS = [
  'HOME_BANNER',
  'ENTRY_AD',
  'TOURNAMENT_AD',
  'HOME',
  'TOURNAMENT_PAGE',
  'SPORTS_FEED',
  'RESULT_PAGE'
];

// Configure Multer storage for Ad Images
const uploadDir = path.join(__dirname, '../uploads/ads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `ad-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'];
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];

  if (allowedExts.includes(ext) || allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid image file format. Supported: JPG, PNG, WEBP, GIF, SVG'));
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB limit
  fileFilter
});

// POST /api/admin-ads/upload - Upload ad image file
router.post('/upload', verifyToken, verifyAdmin, upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file uploaded' });
    }
    const relativeUrl = `/api/uploads/ads/${req.file.filename}`;
    res.json({ success: true, url: relativeUrl, filename: req.file.filename });
  } catch (error) {
    console.error('Ad image upload error:', error);
    res.status(500).json({ success: false, error: 'Failed to upload image' });
  }
});

// GET /api/admin-ads - List all ads
router.get('/', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [ads] = await pool.query('SELECT * FROM advertisements ORDER BY priority DESC, created_at DESC');
    res.json({ success: true, ads });
  } catch (error) {
    console.error('Error fetching admin ads:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch ads' });
  }
});

// POST /api/admin-ads - Create an ad
router.post('/', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const {
      title,
      description,
      image_url,
      video_url,
      sponsor_name,
      link_url,
      placement = 'HOME_BANNER',
      priority = 1,
      start_date,
      end_date,
      is_active = true
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }

    const normPlacement = String(placement).toUpperCase().trim();
    if (!VALID_PLACEMENTS.includes(normPlacement)) {
      return res.status(400).json({ success: false, error: `Placement must be one of: ${VALID_PLACEMENTS.join(', ')}` });
    }

    const [result] = await pool.query(`
      INSERT INTO advertisements (title, description, image_url, video_url, sponsor_name, link_url, placement, priority, start_date, end_date, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      title.trim(),
      description || null,
      image_url || null,
      video_url || null,
      sponsor_name || null,
      link_url || null,
      normPlacement,
      parseInt(priority, 10) || 1,
      start_date || null,
      end_date || null,
      is_active !== false
    ]);

    res.json({ success: true, message: 'Ad created successfully', ad_id: result.insertId });
  } catch (error) {
    console.error('Error creating ad:', error);
    res.status(500).json({ success: false, error: 'Failed to create ad: ' + error.message });
  }
});

// PUT /api/admin-ads/:id - Edit / pause / resume an ad
router.put('/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { title, description, image_url, video_url, sponsor_name, link_url, placement, priority, start_date, end_date, is_active } = req.body;

    const updates = [];
    const params = [];
    const fields = { title, description, image_url, video_url, sponsor_name, link_url, placement, priority, start_date, end_date, is_active };

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        if (key === 'placement') {
          const normPlacement = String(value).toUpperCase().trim();
          if (!VALID_PLACEMENTS.includes(normPlacement)) {
            return res.status(400).json({ success: false, error: `Placement must be one of: ${VALID_PLACEMENTS.join(', ')}` });
          }
          updates.push(`${key} = ?`);
          params.push(normPlacement);
        } else {
          updates.push(`${key} = ?`);
          params.push(value);
        }
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }
    params.push(req.params.id);

    const [result] = await pool.query(`UPDATE advertisements SET ${updates.join(', ')} WHERE id = ?`, params);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Ad not found' });
    }
    res.json({ success: true, message: 'Ad updated' });
  } catch (error) {
    console.error('Error updating ad:', error);
    res.status(500).json({ success: false, error: 'Failed to update ad' });
  }
});

// DELETE /api/admin-ads/:id - Remove an ad
router.delete('/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM advertisements WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Ad removed' });
  } catch (error) {
    console.error('Error deleting ad:', error);
    res.status(500).json({ success: false, error: 'Failed to delete ad' });
  }
});

module.exports = router;
