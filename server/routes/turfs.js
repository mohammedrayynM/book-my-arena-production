const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET /api/turfs — List all active turfs
router.get('/', async (req, res) => {
  try {
    const { sport, location, search, lat, lng, radius = 50 } = req.query; // radius in km
    let query = 'SELECT *';
    const params = [];

    if (lat && lng) {
      query += `, (6371 * acos(cos(radians(?)) * cos(radians(latitude)) * cos(radians(longitude) - radians(?)) + sin(radians(?)) * sin(radians(latitude)))) AS distance`;
      params.push(lat, lng, lat);
    }

    query += ' FROM turfs WHERE is_active = true';

    if (sport) {
      query += ' AND sport_type = ?';
      params.push(sport);
    }
    if (location) {
      query += ' AND location LIKE ?';
      params.push(`%${location}%`);
    }
    if (search) {
      query += ' AND (name LIKE ? OR location LIKE ? OR sport_type LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (lat && lng) {
      query += ' HAVING distance < ?';
      params.push(radius);
      query += ' ORDER BY distance ASC';
    } else {
      query += ' ORDER BY created_at DESC';
    }

    const [rows] = await pool.query(query, params);

    // Parse JSON fields
    const turfs = rows.map(turf => ({
      ...turf,
      images: typeof turf.images === 'string' ? JSON.parse(turf.images) : turf.images || [],
      amenities: typeof turf.amenities === 'string' ? JSON.parse(turf.amenities) : turf.amenities || []
    }));

    res.json({ turfs });
  } catch (err) {
    console.error('Error fetching turfs:', err);
    res.status(500).json({ error: 'Failed to fetch turfs' });
  }
});

// GET /api/turfs/:idOrSlug — Get single turf details
router.get('/:idOrSlug', async (req, res) => {
  try {
    const idOrSlug = req.params.idOrSlug;
    let [rows] = [];

    if (!isNaN(idOrSlug)) {
      [rows] = await pool.query('SELECT * FROM turfs WHERE id = ?', [idOrSlug]);
    } 
    
    if (!rows || rows.length === 0) {
      [rows] = await pool.query('SELECT * FROM turfs WHERE slug = ?', [idOrSlug]);
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Turf not found' });
    }

    const turf = rows[0];
    turf.images = typeof turf.images === 'string' ? JSON.parse(turf.images) : turf.images || [];
    turf.amenities = typeof turf.amenities === 'string' ? JSON.parse(turf.amenities) : turf.amenities || [];

    res.json({ turf });
  } catch (err) {
    console.error('Error fetching turf:', err);
    res.status(500).json({ error: 'Failed to fetch turf' });
  }
});

// GET /api/turfs/slug/:slug — Get single turf details by slug or ID
router.get('/get/slug/:slugOrId', async (req, res) => {
  try {
    const slugOrId = req.params.slugOrId;
    
    // Try to find by slug
    let [rows] = await pool.query('SELECT * FROM turfs WHERE slug = ?', [slugOrId]);
    
    // If not found and slugOrId is a number, try to find by ID
    if (rows.length === 0 && !isNaN(slugOrId)) {
      [rows] = await pool.query('SELECT * FROM turfs WHERE id = ?', [slugOrId]);
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Turf not found' });
    }

    const turf = rows[0];
    turf.images = typeof turf.images === 'string' ? JSON.parse(turf.images) : turf.images || [];
    turf.amenities = typeof turf.amenities === 'string' ? JSON.parse(turf.amenities) : turf.amenities || [];

    res.json({ turf });
  } catch (err) {
    console.error('Error fetching turf by slug/id:', err);
    res.status(500).json({ error: 'Failed to fetch turf' });
  }
});

// GET /api/turfs/:id/slots — Get available slots for a date
router.get('/:idOrSlug/slots', async (req, res) => {
  try {
    const idOrSlug = req.params.idOrSlug;
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }

    let [turfRows] = [];
    if (!isNaN(idOrSlug)) {
      [turfRows] = await pool.query('SELECT id, price_per_hour, open_time, close_time, markup_type, markup_value FROM turfs WHERE id = ?', [idOrSlug]);
    }

    if (!turfRows || turfRows.length === 0) {
      [turfRows] = await pool.query('SELECT id, price_per_hour, open_time, close_time, markup_type, markup_value FROM turfs WHERE slug = ?', [idOrSlug]);
    }

    if (turfRows.length === 0) {
      return res.status(404).json({ error: 'Turf not found' });
    }

    const turf = turfRows[0];
    const turfId = turf.id;
    const basePrice = parseFloat(turf.price_per_hour);
    const markupType = turf.markup_type || 'fixed';
    const markupValue = parseFloat(turf.markup_value || 0);
    
    // Parse open/close times
    const openTime = turf.open_time || '06:00';
    const closeTime = turf.close_time || '23:00';
    const startHour = parseInt(openTime.split(':')[0]);
    const endHour = parseInt(closeTime.split(':')[0]);

    const format12Hour = (hour) => {
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const h = hour % 12 || 12;
      return `${h}:00 ${ampm}`;
    };

    // All possible time slots in 12-hour format based on turf hours
    const allSlots = [];
    for (let h = startHour; h < endHour; h++) {
      const start = format12Hour(h);
      const end = format12Hour(h + 1);
      allSlots.push(`${start} - ${end}`);
    }

    // Get booked slots - only count confirmed/successful payments
    const [booked] = await pool.query(
      'SELECT time_slot FROM bookings WHERE turf_id = ? AND booking_date = ? AND status != ? AND payment_status = ?',
      [turfId, date, 'cancelled', 'success']
    );

    // Get blocked slots
    const [blocked] = await pool.query(
      'SELECT time_slot FROM blocked_slots WHERE turf_id = ? AND block_date = ?',
      [turfId, date]
    );

    // Get special pricing for this date
    const dateObj = new Date(date + 'T00:00:00');
    const dayOfWeek = dateObj.getDay(); 

    const [specialPricing] = await pool.query(
      `SELECT time_slot, special_price, offer_percentage, offer_label FROM special_pricing 
       WHERE turf_id = ? AND is_active = TRUE 
       AND ((specific_date = ?) OR (specific_date IS NULL AND day_of_week = ?))
       ORDER BY specific_date DESC`,
      [turfId, date, dayOfWeek]
    );

    const priceMap = {};
    for (const sp of specialPricing) {
      if (!priceMap[sp.time_slot]) {
        priceMap[sp.time_slot] = {
          price: parseFloat(sp.special_price),
          percentage: sp.offer_percentage,
          label: sp.offer_label
        };
      }
    }

    const bookedSlots = booked.map(b => b.time_slot);
    const blockedSlots = blocked.map(b => b.time_slot);

    const slots = allSlots.map(slot => {
      const status = bookedSlots.includes(slot)
        ? 'booked'
        : blockedSlots.includes(slot)
          ? 'blocked'
          : 'available';
      
      const offerData = priceMap[slot] || {};
      const currentBasePrice = offerData.price || basePrice;
      
      // Calculate display markup for this slot
      let currentMarkup = 0;
      if (markupType === 'percentage') {
        currentMarkup = (currentBasePrice * markupValue) / 100;
      } else {
        currentMarkup = markupValue;
      }
      
      return {
        time: slot,
        status,
        price: parseFloat(currentBasePrice),
        displayPrice: parseFloat(currentBasePrice) + 200, // Fixed marketing strike price (Base + 200)
        markupAmount: 200,
        basePrice: basePrice,
        hasSpecialPrice: !!offerData.price && offerData.price !== basePrice,
        offerPercentage: offerData.percentage,
        offerLabel: offerData.label
      };
    });

    // Get platform settings for service fee
    const [settingsRows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('service_fee', 'service_fee_type')");
    const settings = {};
    settingsRows.forEach(r => settings[r.setting_key] = r.setting_value);
    
    const serviceFeeValue = parseFloat(settings['service_fee'] || '20');
    const serviceFeeType = settings['service_fee_type'] || 'fixed';

    res.json({ slots, basePrice, serviceFeeValue, serviceFeeType, markupType, markupValue });
  } catch (err) {
    console.error('Error fetching slots:', err)
    res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

module.exports = router;
