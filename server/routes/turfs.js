const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { addSseClient } = require('../utils/realtime');
const { computeOwnerMarkup } = require('../utils/pricing');
const slotSchedule = require('../services/slotSchedule');
const billingRestrictions = require('../services/venueBillingRestrictions');
const { todayIn, isValidTimezone } = require('../utils/timezone');

const PUBLIC_TURF_FIELDS = new Set([
  'id', 'name', 'slug', 'location', 'city', 'state_province', 'address', 'postal_code',
  'country_code', 'sport_type', 'description', 'images', 'photos', 'coverImage', 'amenities',
  'latitude', 'longitude', 'price_per_hour', 'default_price', 'early_morning_price',
  'morning_price', 'afternoon_price', 'evening_price', 'slot_duration', 'time_format',
  'open_time', 'close_time', 'advance_percent', 'timezone', 'currency_code', 'rating',
  'review_count', 'distance_km', 'created_at'
]);
const PUBLIC_COURT_FIELDS = new Set([
  'id', 'name', 'sport_type', 'images', 'amenities', 'slot_duration', 'time_format', 'price_per_hour'
]);
function toPublicRecord(record, allowedFields = PUBLIC_TURF_FIELDS) {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => allowedFields.has(key))
  );
}

const columnCache = {};
async function hasColumn(table, column) {
  const cacheKey = `${table}.${column}`;
  if (columnCache[cacheKey] !== undefined) return columnCache[cacheKey];
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [process.env.DB_NAME, table, column]
  );
  const exists = rows.length > 0;
  columnCache[cacheKey] = exists;
  return exists;
}

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

function getSlotOrderInSection(slotTime, section) {
  const startMins = getSlotStartMinutes(slotTime);
  const sStart = parseMinutes(section.start_time);
  const sEnd = parseMinutes(section.end_time);

  if (sStart > sEnd) {
    if (startMins >= sStart) return startMins;
    return startMins + 24 * 60;
  }
  return startMins;
}

function sortSlotsInSection(slots, section) {
  return [...slots].sort(
    (a, b) => getSlotOrderInSection(a, section) - getSlotOrderInSection(b, section)
  );
}

function getSlotPeriod(slotStartMinutes) {
  const mins = slotStartMinutes % 1440;
  if (mins >= 0 && mins < 360) return 'earlyMorning';
  if (mins >= 360 && mins < 720) return 'morning';
  if (mins >= 720 && mins < 1080) return 'afternoon';
  return 'evening';
}

function resolveSlotPrice(slotStartMinutes, entity) {
  const period = getSlotPeriod(slotStartMinutes);
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

function formatSlotClock(totalMinutes, timeFormat = '12h') {
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  if (timeFormat === '24h') {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${ampm}`;
}

function generateSlots(openTime, closeTime, slotDuration, timeFormat = '12h') {
  const startMinutes = parseMinutes(openTime);
  let endMinutes = parseMinutes(closeTime);
  if (startMinutes === 0 && (endMinutes === 1440 || endMinutes === 1439 || endMinutes === 0)) {
    endMinutes = 24 * 60;
  } else if (endMinutes <= startMinutes) {
    endMinutes += 24 * 60;
  }

  const slots = [];
  for (let total = startMinutes; total < endMinutes; total += slotDuration) {
    const start = formatSlotClock(total, timeFormat);
    const end = formatSlotClock(total + slotDuration, timeFormat);
    slots.push(`${start} - ${end}`);
  }
  return slots;
}

// Public SSE stream for live slot/pricing availability updates.
router.get('/events', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  addSseClient(res);

  try { res.flushHeaders && res.flushHeaders(); } catch { }
  try { res.write(':ok\n\n'); } catch { }
});

// GET /api/turfs/search-location — Search places / venues for maps
const { searchVenues } = require('../services/mapsService');
router.get('/search-location', async (req, res) => {
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

// GET /api/turfs — List all active turfs
router.get('/', async (req, res) => {
  try {
    const { sport, location, search, lat, lng, radius = 50 } = req.query; // radius in km
    let normalizedSearch = String(search || '').trim();
    // Auto-correction alias mapping
    const searchLower = normalizedSearch.toLowerCase();
    const aliasMap = {
      'cricjet': 'cricket',
      'criket': 'cricket',
      'crickt': 'cricket',
      'fotball': 'football',
      'fottball': 'football',
      'badmiton': 'badminton',
      'badmnton': 'badminton'
    };
    if (aliasMap[searchLower]) {
      normalizedSearch = aliasMap[searchLower];
    }
    const hasSearch = normalizedSearch.length > 0;
    const useDistanceFilter = !!(lat && lng && !hasSearch);
    let query = 'SELECT *';
    const params = [];

    if (useDistanceFilter) {
      query += `, (6371 * acos(cos(radians(?)) * cos(radians(latitude)) * cos(radians(longitude) - radians(?)) + sin(radians(?)) * sin(radians(latitude)))) AS distance`;
      params.push(lat, lng, lat);
    }

    query += " FROM turfs WHERE is_active = true AND (is_deleted IS NULL OR is_deleted = 0) AND (status IS NULL OR status != 'BLOCKED') AND (approval_status = 'APPROVED' OR approval_status IS NULL)";

    if (sport && sport !== 'All') {
      query += ' AND (sport_type LIKE ? OR sport_type = ?)';
      params.push(`%${sport}%`, sport);
    }
    if (location && !hasSearch) {
      query += ' AND location LIKE ?';
      params.push(`%${location}%`);
    }
    if (hasSearch) {
      query += ' AND (name LIKE ? OR location LIKE ? OR sport_type LIKE ? OR address LIKE ? OR city LIKE ?)';
      params.push(`%${normalizedSearch}%`, `%${normalizedSearch}%`, `%${normalizedSearch}%`, `%${normalizedSearch}%`, `%${normalizedSearch}%`);
    }

    if (useDistanceFilter) {
      query += ' HAVING distance < ?';
      params.push(radius);
      query += ' ORDER BY distance ASC';
    } else {
      query += ' ORDER BY created_at DESC';
    }

    const [rows] = await pool.query(query, params);

    // Parse JSON fields
    const turfs = rows.map(turf => ({
      ...toPublicRecord(turf),
      images: typeof turf.images === 'string' ? JSON.parse(turf.images) : turf.images || [],
      photos: typeof turf.photos === 'string' ? JSON.parse(turf.photos) : turf.photos || [],
      amenities: typeof turf.amenities === 'string' ? JSON.parse(turf.amenities) : turf.amenities || []
    }));

    // Include best active owner-coupon offer per turf (for offer badge on browse cards).
    // "Best" = highest discount_value among currently active & non-expired coupons.
    try {
      const turfIds = turfs.map(t => Number(t.id)).filter(Boolean);
      if (turfIds.length > 0) {
        const hasValidFrom = await hasColumn('coupons', 'valid_from');
        const hasValidUntil = await hasColumn('coupons', 'valid_until');
        const hasExpiryDate = await hasColumn('coupons', 'expiry_date');
        const hasMaxUses = await hasColumn('coupons', 'max_uses');
        const hasUsedCount = await hasColumn('coupons', 'used_count');

        const where = [
          `turf_id IN (${turfIds.map(() => '?').join(',')})`,
          'is_active = TRUE'
        ];
        const couponParams = [...turfIds];

        if (hasValidFrom) where.push('(valid_from IS NULL OR valid_from <= CURDATE())');

        if (hasValidUntil && hasExpiryDate) {
          where.push(
            `(
              (valid_until IS NULL AND (expiry_date IS NULL OR expiry_date >= CURDATE()))
              OR (valid_until IS NOT NULL AND valid_until >= CURDATE())
            )`
          );
        } else if (hasValidUntil) {
          where.push('(valid_until IS NULL OR valid_until >= CURDATE())');
        } else if (hasExpiryDate) {
          where.push('(expiry_date IS NULL OR expiry_date >= CURDATE())');
        }

        if (hasMaxUses && hasUsedCount) {
          where.push('(max_uses IS NULL OR used_count < max_uses)');
        }

        const [couponRows] = await pool.query(
          `SELECT turf_id, discount_type, discount_value
           FROM coupons
           WHERE ${where.join(' AND ')}`,
          couponParams
        );

        const bestByTurf = new Map();
        for (const c of couponRows || []) {
          const turfId = Number(c.turf_id);
          const dv = parseFloat(c.discount_value);
          if (!turfId || !dv || dv <= 0) continue;

          const current = bestByTurf.get(turfId);
          if (!current || dv > current.discountValue) {
            bestByTurf.set(turfId, {
              discountType: c.discount_type,
              discountValue: dv
            });
          }
        }

        turfs.forEach(t => {
          const best = bestByTurf.get(Number(t.id));
          if (best) {
            t.bestCoupon = best;
          }
        });
      }
    } catch (couponErr) {
      // Never fail the browse page if coupons table/columns are missing on older DBs.
      console.warn('Best-coupon enrichment skipped:', couponErr.message);
    }

    res.json({ turfs });
  } catch (err) {
    console.error('Error fetching turfs:', err);
    res.status(500).json({ error: 'Failed to fetch turfs' });
  }
});

// GET /api/turfs/:id/sessions — Public: get enabled sessions for a turf
// (Used by TurfDetail checkout UI to group slots into Morning/Evening/Night.)
router.get('/:id/sessions', async (req, res) => {
  try {
    const turfId = parseInt(req.params.id, 10);
    if (!turfId) return res.status(400).json({ error: 'Invalid turf id' });

    const [rows] = await pool.query(
      `SELECT id, turf_id, court_id, name, start_time, end_time, is_enabled
       FROM turf_sessions
       WHERE turf_id = ? AND is_enabled = 1
       ORDER BY start_time ASC`,
      [turfId]
    );

    res.json({ sessions: rows || [] });
  } catch (err) {
    console.error('Error fetching turf sessions:', err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// GET /api/turfs/:idOrSlug — Get single turf details
router.get('/:idOrSlug', async (req, res) => {
  try {
    const idOrSlug = req.params.idOrSlug;
    let [rows] = [];

    if (!isNaN(idOrSlug)) {
      [rows] = await pool.query(
        "SELECT * FROM turfs WHERE id = ? AND is_active = true AND (is_deleted IS NULL OR is_deleted = 0) AND (status IS NULL OR status != 'BLOCKED') AND (approval_status = 'APPROVED' OR approval_status IS NULL)",
        [idOrSlug]
      );
    }

    if (!rows || rows.length === 0) {
      [rows] = await pool.query(
        "SELECT * FROM turfs WHERE slug = ? AND is_active = true AND (is_deleted IS NULL OR is_deleted = 0) AND (status IS NULL OR status != 'BLOCKED') AND (approval_status = 'APPROVED' OR approval_status IS NULL)",
        [idOrSlug]
      );
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Turf not found' });
    }

    const turf = toPublicRecord(rows[0]);
    turf.images = typeof turf.images === 'string' ? JSON.parse(turf.images) : turf.images || [];
    turf.photos = typeof turf.photos === 'string' ? JSON.parse(turf.photos) : turf.photos || [];
    turf.amenities = typeof turf.amenities === 'string' ? JSON.parse(turf.amenities) : turf.amenities || [];

    // Fetch active and approved courts for this turf
    const [courtRows] = await pool.query(
      "SELECT * FROM courts WHERE turf_id = ? AND is_active = true AND (approval_status = 'APPROVED' OR approval_status IS NULL)",
      [turf.id]
    );
    turf.courts = courtRows.map(court => ({
      ...toPublicRecord(court, PUBLIC_COURT_FIELDS),
      images: typeof court.images === 'string' ? JSON.parse(court.images) : court.images || [],
      amenities: typeof court.amenities === 'string' ? JSON.parse(court.amenities) : court.amenities || []
    }));

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
    let [rows] = await pool.query(
      "SELECT * FROM turfs WHERE slug = ? AND is_active = true AND (is_deleted IS NULL OR is_deleted = 0) AND (status IS NULL OR status != 'BLOCKED') AND (approval_status = 'APPROVED' OR approval_status IS NULL)",
      [slugOrId]
    );

    // If not found and slugOrId is a number, try to find by ID
    if (rows.length === 0 && !isNaN(slugOrId)) {
      [rows] = await pool.query(
        "SELECT * FROM turfs WHERE id = ? AND is_active = true AND (is_deleted IS NULL OR is_deleted = 0) AND (status IS NULL OR status != 'BLOCKED') AND (approval_status = 'APPROVED' OR approval_status IS NULL)",
        [slugOrId]
      );
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Turf not found' });
    }

    const turf = toPublicRecord(rows[0]);
    turf.images = typeof turf.images === 'string' ? JSON.parse(turf.images) : turf.images || [];
    turf.photos = typeof turf.photos === 'string' ? JSON.parse(turf.photos) : turf.photos || [];
    turf.amenities = typeof turf.amenities === 'string' ? JSON.parse(turf.amenities) : turf.amenities || [];

    // Fetch active and approved courts for this turf
    const [courtRows] = await pool.query(
      "SELECT * FROM courts WHERE turf_id = ? AND is_active = true AND (approval_status = 'APPROVED' OR approval_status IS NULL)",
      [turf.id]
    );
    turf.courts = courtRows.map(court => ({
      ...toPublicRecord(court, PUBLIC_COURT_FIELDS),
      images: typeof court.images === 'string' ? JSON.parse(court.images) : court.images || [],
      amenities: typeof court.amenities === 'string' ? JSON.parse(court.amenities) : court.amenities || []
    }));

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
    const { date, court_id } = req.query;
    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }

    let [turfRows] = [];
    if (!isNaN(idOrSlug)) {
      [turfRows] = await pool.query(
        `SELECT id, status, is_active, is_deleted, price_per_hour, open_time, close_time, markup_type, markup_value, slot_duration, time_format, advance_percent,
                early_morning_price, morning_price, afternoon_price, evening_price, default_price
         FROM turfs WHERE id = ?`,
        [idOrSlug]
      );
    }

    if (!turfRows || turfRows.length === 0) {
      [turfRows] = await pool.query(
        `SELECT id, status, is_active, is_deleted, price_per_hour, open_time, close_time, markup_type, markup_value, slot_duration, time_format, advance_percent,
                early_morning_price, morning_price, afternoon_price, evening_price, default_price
         FROM turfs WHERE slug = ?`,
        [idOrSlug]
      );
    }

    if (turfRows.length === 0) {
      return res.status(404).json({ error: 'Turf not found' });
    }

    const turf = turfRows[0];
    if (turf.is_deleted || turf.status === 'BLOCKED' || turf.is_active === 0 || turf.is_active === false) {
      return res.json({ slots: [], is_blocked: true, error: 'This venue has been blocked by Admin.' });
    }
    const turfId = turf.id;
    if (await billingRestrictions.getActive(turfId)) {
      return res.json({
        slots: [],
        is_blocked: true,
        restriction_code: 'VENUE_BILLING_RESTRICTED',
        error: 'This venue is temporarily not accepting new bookings.',
      });
    }
    let basePrice = parseFloat(turf.price_per_hour);
    let markupType = turf.markup_type || 'fixed';
    let markupValue = parseFloat(turf.markup_value || 0);

    // Parse open/close times
    let openTime = turf.open_time || '06:00';
    let closeTime = turf.close_time || '23:00';

    let currentBookable = turf;
    if (court_id) {
      const [courtRows] = await pool.query(
        `SELECT price_per_hour, open_time, close_time, markup_type, markup_value, slot_duration, time_format, advance_percent,
                early_morning_price, morning_price, afternoon_price, evening_price, default_price
         FROM courts WHERE id = ? AND turf_id = ?`,
        [court_id, turfId]
      );
      if (courtRows.length > 0) {
        const court = courtRows[0];
        basePrice = parseFloat(court.price_per_hour);
        markupType = court.markup_type || 'fixed';
        markupValue = parseFloat(court.markup_value || 0);
        openTime = court.open_time || '06:00';
        closeTime = court.close_time || '23:00';
        currentBookable = court;
      }
    }

    // 24-hour operation + venue timezone. Read defensively (older DBs without the column keep working unchanged).
    let is24Hours = false; let venueTz = 'Asia/Kolkata';
    try {
      const [[tx]] = await pool.query('SELECT is_24_hours, timezone FROM turfs WHERE id = ?', [turfId]);
      if (tx) { is24Hours = slotSchedule.truthy(tx.is_24_hours); if (isValidTimezone(tx.timezone)) venueTz = tx.timezone; }
      if (court_id && currentBookable !== turf) {
        const [[cx]] = await pool.query('SELECT is_24_hours FROM courts WHERE id = ?', [court_id]);
        if (cx) is24Hours = slotSchedule.truthy(cx.is_24_hours);   // a court has its own schedule
      }
    } catch (e) { /* column not migrated yet: legacy behaviour */ }
    if (is24Hours) { openTime = '00:00'; closeTime = '00:00'; }   // legacy all-day rule => 00:00..24:00
    const scheduleWindow = slotSchedule.resolveWindow({ open_time: openTime, close_time: closeTime, is_24_hours: is24Hours });

    const slotDuration = Number(currentBookable.slot_duration || turf.slot_duration) === 30 ? 30 : 60;
    const timeFormat = String(currentBookable.time_format || turf.time_format || '').trim().toLowerCase() === '24h' ? '24h' : '12h';
    const advancePercent = parseInt(currentBookable.advance_percent || turf.advance_percent || 100, 10);
    const startMinutes = parseMinutes(openTime);
    let endMinutes = parseMinutes(closeTime);
    if (startMinutes === 0 && (endMinutes === 1440 || endMinutes === 1439 || endMinutes === 0)) {
      endMinutes = 24 * 60;
    } else if (endMinutes <= startMinutes) {
      endMinutes += 24 * 60;
    }

    console.log('🕒 Slot settings resolved:', {
      turfId,
      courtId: court_id || null,
      openTime,
      closeTime,
      slotDuration,
      timeFormat,
      rawTimeFormat: currentBookable.time_format || turf.time_format
    });

    const allSlots = generateSlots(openTime, closeTime, slotDuration, timeFormat);

    // Get booked slots (confirmed or temporarily held during checkout for 15 minutes)
    let bookedQuery = `
      SELECT time_slot, payment_status, status FROM bookings 
      WHERE turf_id = ? AND booking_date = ? 
      AND (
        (payment_status = 'success' AND status != 'cancelled')
        OR
        (payment_status = 'pending' AND status = 'pending' AND created_at > NOW() - INTERVAL 15 MINUTE)
      )
    `;
    const bookedParams = [turfId, date];
    if (court_id) {
      bookedQuery += ' AND (court_id IS NULL OR court_id = ?)';
      bookedParams.push(court_id);
    }
    const [booked] = await pool.query(bookedQuery, bookedParams);

    const blockedHasCourtId = await hasColumn('blocked_slots', 'court_id');
    const specialPricingHasCourtId = await hasColumn('special_pricing', 'court_id');

    // Get blocked slots
    let blockedQuery = 'SELECT time_slot FROM blocked_slots WHERE turf_id = ? AND block_date = ?';
    const blockedParams = [turfId, date];
    if (court_id && blockedHasCourtId) {
      blockedQuery += ' AND (court_id IS NULL OR court_id = ?)';
      blockedParams.push(court_id);
    }
    const [blocked] = await pool.query(blockedQuery, blockedParams);

    // Get day-wise pricing
    const [dayWiseRows] = await pool.query(
      'SELECT * FROM day_wise_pricing WHERE turf_id = ?',
      [turfId]
    );

    // Get special pricing for this date
    const dateObj = new Date(date + 'T00:00:00');
    const dayOfWeek = dateObj.getDay();
    const DAYS_OF_WEEK_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = DAYS_OF_WEEK_NAMES[dayOfWeek];

    let specialPricingQuery = `
      SELECT time_slot, special_price, offer_percentage, offer_label, court_id FROM special_pricing 
      WHERE turf_id = ? AND is_active = TRUE 
      AND ((specific_date = ?) OR (specific_date IS NULL AND day_of_week = ?))
    `;
    const specialPricingParams = [turfId, date, dayOfWeek];
    if (court_id && specialPricingHasCourtId) {
      specialPricingQuery += ' AND (court_id IS NULL OR court_id = ?)';
      specialPricingParams.push(court_id);
    } else if (!court_id && specialPricingHasCourtId) {
      specialPricingQuery += ' AND court_id IS NULL';
    }
    specialPricingQuery += ' ORDER BY (court_id IS NOT NULL) DESC, specific_date DESC';

    const [specialPricing] = await pool.query(specialPricingQuery, specialPricingParams);

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

    const bookedSuccessSlots = booked.filter(b => b.payment_status === 'success').map(b => String(b.time_slot).trim());
    const bookedPendingSlots = booked.filter(b => b.payment_status === 'pending').map(b => String(b.time_slot).trim());
    const blockedSlots = blocked.map(b => String(b.time_slot).trim());

    // slots held by an ACTIVE subscription (member-reserved) are shown as their own status
    const subRes = require('../services/subscriptionReservations');
    const subTime = require('../utils/notifications/time');
    const reservedRanges = await subRes.reservedRangesForDate(turfId, court_id || null, date);
    const isSubscriptionReserved = (slotLabel) => {
      const ps = subTime.parseSlot(slotLabel);
      if (!ps || reservedRanges.length === 0) return false;
      const s = subRes.toMinutes(ps.start); const e = ps.end ? subRes.toMinutes(ps.end) : s + 60;
      return reservedRanges.some((r) => subRes.overlaps(s, e, r.start, r.end));
    };

    const slots = allSlots.map(slot => {
      const normalizedSlot = String(slot).trim();
      const status = bookedSuccessSlots.includes(normalizedSlot)
        ? 'booked'
        : bookedPendingSlots.includes(normalizedSlot)
          ? 'held'
          : blockedSlots.includes(normalizedSlot)
            ? 'blocked'
            : isSubscriptionReserved(normalizedSlot)
              ? 'subscription_reserved'
              : 'available';

      const offerData = priceMap[normalizedSlot] || {};
      const startMins = getSlotStartMinutes(normalizedSlot);
      const period = getSlotPeriod(startMins);

      // Resolve Day-Wise Pricing (Priority 2)
      let dayWisePrice = null;
      if (dayWiseRows && dayWiseRows.length > 0) {
        const dw = dayWiseRows.find(item =>
          item.day_of_week === dayName &&
          (court_id ? Number(item.court_id) === Number(court_id) : (item.court_id === null || item.court_id === undefined))
        );
        if (dw) {
          if (period === 'earlyMorning' && dw.early_morning_price !== null) {
            dayWisePrice = parseFloat(dw.early_morning_price);
          } else if (period === 'morning' && dw.morning_price !== null) {
            dayWisePrice = parseFloat(dw.morning_price);
          } else if (period === 'afternoon' && dw.afternoon_price !== null) {
            dayWisePrice = parseFloat(dw.afternoon_price);
          } else if (period === 'evening' && dw.evening_price !== null) {
            dayWisePrice = parseFloat(dw.evening_price);
          }
        }
      }

      // Resolve Regular Period Pricing (Priority 3) or default base price (Priority 4)
      const periodPrice = resolveSlotPrice(startMins, currentBookable);

      // Apply slot pricing priority
      const basePriceForThisSlot = (dayWisePrice !== null && dayWisePrice > 0) ? dayWisePrice : periodPrice;
      const exactPrice = offerData.price != null ? parseFloat(offerData.price) : basePriceForThisSlot;
      const hasSpecialPrice = offerData.price != null && exactPrice !== basePriceForThisSlot;

      const { markupAmount, displayPrice } = computeOwnerMarkup(exactPrice, markupType, markupValue, 1);

      const sMin = slotSchedule.intervalOf(normalizedSlot, scheduleWindow);
      return {
        time: normalizedSlot,
        startMin: sMin ? sMin.start : null,
        endMin: sMin ? sMin.end : null,
        status,
        price: exactPrice,
        basePrice: basePriceForThisSlot,
        displayPrice,
        markupAmount,
        hasSpecialPrice,
        offerPercentage: offerData.percentage,
        offerLabel: offerData.label
      };
    });

    // Get platform settings for service fee
    const [settingsRows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('service_fee', 'service_fee_type')");
    const settings = {};
    settingsRows.forEach(r => settings[r.setting_key] = r.setting_value);

    // Hide slots that already started — in the VENUE's timezone (Asia/Kolkata unless the venue has its own), and aware of
    // after-midnight slots of an overnight session (they belong to the previous day's operating window).
    const venueToday = todayIn(venueTz);
    const yesterday = new Date(`${venueToday}T00:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const venueYesterday = yesterday.toISOString().slice(0, 10);
    let finalSlots = slots;
    if (date === venueToday || (scheduleWindow.overnight && date === venueYesterday)) {
      finalSlots = slots.filter(s => s.startMin == null || slotSchedule.isFutureSlot(date, { startMin: s.startMin }, venueTz));
    }

    const serviceFeeValue = parseFloat(settings['service_fee'] || '20');
    const serviceFeeType = settings['service_fee_type'] || 'fixed';
    res.json({ slots: finalSlots, basePrice, serviceFeeValue, serviceFeeType, markupType, markupValue, slotDuration, advancePercent, timeFormat, is24Hours, timezone: venueTz });
  } catch (err) {
    console.error('Error fetching slots:', err);
    res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

module.exports = router;
module.exports._test = {
  parseMinutes,
  formatSlotClock,
  generateSlots,
  getSlotStartMinutes,
  getSlotOrderInSection,
  sortSlotsInSection,
  getSlotPeriod,
  resolveSlotPrice
};
