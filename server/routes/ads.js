const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET /api/ads?placement=HOME_BANNER - Public, returns currently-active ads for a placement.
router.get('/', async (req, res) => {
  try {
    const rawPlacement = String(req.query.placement || '').trim();
    if (!rawPlacement) {
      return res.status(400).json({ success: false, error: 'placement is required' });
    }

    // Alias mapping for placements
    let placementList = [rawPlacement];
    const upper = rawPlacement.toUpperCase();
    if (upper === 'HOME_BANNER' || upper === 'HOME') {
      placementList = ['HOME_BANNER', 'HOME'];
    } else if (upper === 'ENTRY_AD' || upper === 'ENTRY') {
      placementList = ['ENTRY_AD', 'ENTRY'];
    } else if (upper === 'TOURNAMENT_AD' || upper === 'TOURNAMENT_PAGE' || upper === 'TOURNAMENT') {
      placementList = ['TOURNAMENT_AD', 'TOURNAMENT_PAGE', 'TOURNAMENT'];
    }

    const placeholders = placementList.map(() => '?').join(',');
    const [ads] = await pool.query(`
      SELECT id, title, description, image_url, video_url, sponsor_name, link_url, placement, priority, start_date, end_date
      FROM advertisements
      WHERE placement IN (${placeholders}) AND is_active = true
        AND (start_date IS NULL OR start_date <= CURDATE())
        AND (end_date IS NULL OR end_date >= CURDATE())
      ORDER BY priority DESC, created_at DESC
      LIMIT 10
    `, placementList);

    if (ads.length > 0) {
      const ids = ads.map(a => a.id);
      pool.query(`UPDATE advertisements SET impression_count = impression_count + 1 WHERE id IN (${ids.map(() => '?').join(',')})`, ids).catch(() => {});
    }

    res.json({ success: true, ads });
  } catch (error) {
    console.error('Error fetching ads:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch ads' });
  }
});

// POST /api/ads/:id/click - Public, records a click
router.post('/:id/click', async (req, res) => {
  try {
    await pool.query('UPDATE advertisements SET click_count = click_count + 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

module.exports = router;
