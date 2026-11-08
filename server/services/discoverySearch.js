// Unified venue search + nearby. One engine for the Search tab, the home "Nearby Venues" section and the "View all" lists.
//
// What it understands in free text: sports (matched to canonical categories, not strings), a generic "turf", activity words
// ("amusement park"), "near me", and place/venue words. "badminton in Chennai", "turf in Pernambut", "cricket turf Pernambut",
// "snooker near me" or a venue name each become: category filter + location/name tokens (+ distance when coordinates are known).
//
// What it refuses to do: return every venue for a query that matches nothing, scan on every keystroke without a LIMIT, or
// invent a distance (venues with no stored coordinates simply have distance_km = null).
const pool = require('../config/db');

const STOP = new Set(['in', 'at', 'near', 'me', 'nearby', 'around', 'the', 'for', 'of', 'and', 'a', 'an', 'to', 'best', 'top', 'good', 'my', 'close', 'play']);
const GENERIC_VENUE = new Set(['turf', 'turfs', 'ground', 'grounds', 'court', 'courts', 'venue', 'venues', 'arena', 'arenas']);
const ACTIVITY_WORDS = new Set(['amusement', 'park', 'parks', 'theme', 'waterpark', 'karting', 'trampoline', 'bowling', 'activities', 'activity', 'adventure']);
const ACTIVITY_CATEGORY_PHRASES = [
  { category: 'AMUSEMENT_PARK', phrases: ['amusement park', 'amusement parks', 'theme park', 'theme parks'] },
  { category: 'WATER_PARK', phrases: ['water park', 'water parks', 'waterpark', 'waterparks'] },
  { category: 'GO_KARTING', phrases: ['go kart', 'go karts', 'go karting', 'karting'] },
  { category: 'TRAMPOLINE', phrases: ['trampoline park', 'trampoline parks', 'trampoline'] },
  { category: 'ADVENTURE', phrases: ['adventure park', 'adventure parks', 'adventure'] },
  { category: 'KIDS_PLAY', phrases: ['kids play area', 'kids play', 'kids zone'] },
  { category: 'BOWLING', phrases: ['bowling'] },
  { category: 'GAMING_ZONE', phrases: ['gaming zone', 'game zone', 'gaming'] },
  { category: 'ESCAPE_ROOM', phrases: ['escape room', 'escape rooms'] },
];
const MAX_LIMIT = 30;
const MAX_PAGE = 20;

const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const validCoord = (lat, lng) => lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
function aliasesOf(c) { try { const a = JSON.parse(c.aliases); return Array.isArray(a) ? a : []; } catch { return []; } }

// ---- category cache (the table is small; a 30s cache keeps typing from hitting it on every request) --------------------
let catCache = { at: 0, rows: [] };
async function loadCategories({ force = false } = {}) {
  if (!force && Date.now() - catCache.at < 30000) return catCache.rows;
  const [rows] = await pool.query('SELECT id, slug, name, venue_type, search_group, aliases, image_url, sort_order, is_enabled FROM sport_categories ORDER BY sort_order, name');
  catCache = { at: Date.now(), rows };
  return rows;
}
function clearCategoryCache() { catCache = { at: 0, rows: [] }; }

/**
 * Pure: turns the typed text into { sportIds, turfGroup, wantsActivities, nearMe, textTokens, matchedSports }.
 * `categories` are the ENABLED categories (a disabled sport is not a search concept any more; its words fall back to text).
 */
function parseQuery(q, categories) {
  const tokens = norm(q).split(' ').filter(Boolean);
  const out = { sportIds: new Set(), activityCategories: new Set(), turfGroup: false, wantsActivities: false, nearMe: false, textTokens: [], matchedSports: [] };
  if (!tokens.length) return out;

  for (let i = 0; i < tokens.length - 1; i++) if (tokens[i] === 'near' && tokens[i + 1] === 'me') out.nearMe = true;
  if (tokens.includes('nearby')) out.nearMe = true;

  // phrase list: every category name/alias as a token sequence; longest phrase wins at a given position
  const phrases = [];
  for (const c of categories) {
    for (const p of new Set([c.name, c.slug.replace(/-/g, ' '), ...aliasesOf(c)])) {
      const t = norm(p).split(' ').filter(Boolean);
      if (t.length) phrases.push({ t, cat: c });
    }
  }
  phrases.sort((a, b) => b.t.length - a.t.length);

  const used = new Array(tokens.length).fill(false);
  const activityPhrases = ACTIVITY_CATEGORY_PHRASES
    .flatMap(({ category, phrases: entries }) => entries.map((phrase) => ({ category, tokens: norm(phrase).split(' ') })))
    .sort((a, b) => b.tokens.length - a.tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    if (used[i]) continue;
    for (const phrase of activityPhrases) {
      if (i + phrase.tokens.length > tokens.length) continue;
      if (phrase.tokens.every((word, k) => tokens[i + k] === word && !used[i + k])) {
        out.activityCategories.add(phrase.category);
        out.wantsActivities = true;
        for (let k = 0; k < phrase.tokens.length; k++) used[i + k] = true;
        break;
      }
    }
  }
  if (!out.activityCategories.size && tokens.some((token) => token === 'park' || token === 'parks')) {
    ['AMUSEMENT_PARK', 'WATER_PARK', 'ADVENTURE'].forEach((category) => out.activityCategories.add(category));
    out.wantsActivities = true;
  }
  for (let i = 0; i < tokens.length; i++) {
    if (used[i]) continue;
    for (const ph of phrases) {
      if (i + ph.t.length > tokens.length) continue;
      if (ph.t.every((w, k) => tokens[i + k] === w && !used[i + k])) {
        out.sportIds.add(ph.cat.id);
        // a bare sport word ("cricket", "football") means the whole family: Cricket Turf + Cricket Nets + Box Cricket
        if (ph.t.length === 1) for (const c of categories) if (norm(c.name).split(' ').includes(ph.t[0])) out.sportIds.add(c.id);
        for (let k = 0; k < ph.t.length; k++) used[i + k] = true;
        break;
      }
    }
  }
  const rest = [];
  tokens.forEach((tk, i) => {
    if (used[i]) return;
    if (STOP.has(tk)) return;
    if (GENERIC_VENUE.has(tk)) { if (tk.startsWith('turf')) out.turfGroup = true; return; }
    if (ACTIVITY_WORDS.has(tk)) { out.wantsActivities = true; return; }
    rest.push(tk);
  });
  out.textTokens = rest;
  out.matchedSports = categories.filter((c) => out.sportIds.has(c.id)).map((c) => c.name);
  return out;
}

const HAVERSINE = 'ACOS(LEAST(1, GREATEST(-1, COS(RADIANS(?)) * COS(RADIANS(%LAT%)) * COS(RADIANS(%LNG%) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(%LAT%)))))';
const distExpr = (alias) => `(6371 * ${HAVERSINE.replace(/%LAT%/g, `${alias}.latitude`).replace(/%LNG%/g, `${alias}.longitude`)})`;
const bbox = (lat, lng, km) => {
  const dLat = km / 111.0; const dLng = km / (111.0 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return [lat - dLat, lat + dLat, lng - dLng, lng + dLng];
};

function parseJson(v, d = []) { if (Array.isArray(v)) return v; try { const a = JSON.parse(v); return Array.isArray(a) ? a : d; } catch { return d; } }
const round1 = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10);

async function searchVenues({ parsed, explicitCategoryIds, city, lat, lng, radius, limitPlus, offset, categories }) {
  const where = ["t.is_active = true", "(t.is_deleted IS NULL OR t.is_deleted = 0)", "(t.status IS NULL OR t.status != 'BLOCKED')", "(t.approval_status = 'APPROVED' OR t.approval_status IS NULL)"];
  const params = [];
  const located = validCoord(lat, lng);

  const catFilter = (ids) => {
    const list = [...ids];
    // venues that have category rows are matched on those; venues that predate categories fall back to their old text
    const legacy = categories.filter((c) => list.includes(c.id)).flatMap((c) => [c.name, ...aliasesOf(c)]).map(norm).filter(Boolean);
    const legacyClause = legacy.length ? `(NOT EXISTS (SELECT 1 FROM turf_sports x WHERE x.turf_id = t.id) AND (${legacy.map(() => 'LOWER(t.sport_type) LIKE ?').join(' OR ')}))` : '0';
    where.push(`(EXISTS (SELECT 1 FROM turf_sports ts WHERE ts.turf_id = t.id AND ts.category_id IN (${list.map(() => '?').join(',')})) OR ${legacyClause})`);
    params.push(...list, ...legacy.map((p) => `%${p}%`));
  };
  if (parsed.sportIds.size) catFilter(parsed.sportIds);
  if (explicitCategoryIds.size) catFilter(explicitCategoryIds);
  if (parsed.turfGroup && !parsed.sportIds.size && !explicitCategoryIds.size) {
    const ids = categories.filter((c) => c.search_group === 'turf').map((c) => c.id);
    const clauses = ["LOWER(t.sport_type) LIKE '%turf%'"];
    if (ids.length) { clauses.push(`EXISTS (SELECT 1 FROM turf_sports ts WHERE ts.turf_id = t.id AND ts.category_id IN (${ids.map(() => '?').join(',')}))`); params.push(...ids); }
    where.push(`(${clauses.join(' OR ')})`);
  }
  for (const tk of parsed.textTokens) {
    where.push("LOWER(CONCAT_WS(' ', t.name, t.location, t.city, t.address, t.state_province)) LIKE ?");
    params.push(`%${tk}%`);
  }
  if (city) { where.push("LOWER(CONCAT_WS(' ', t.city, t.location, t.address)) LIKE ?"); params.push(`%${norm(city)}%`); }

  let select = 't.*'; const selectParams = [];
  let order = 't.created_at DESC, t.id DESC';
  const orderParams = [];
  if (located) {
    select += `, ${distExpr('t')} AS distance_km`;
    selectParams.push(lat, lng, lat);
    if (radius) {
      const [a, b, c, d] = bbox(lat, lng, radius);
      where.push('t.latitude BETWEEN ? AND ? AND t.longitude BETWEEN ? AND ?');
      params.push(a, b, c, d);
    }
    order = 'distance_km IS NULL, distance_km ASC, t.id DESC';
  }
  const text = parsed.textTokens.join(' ');
  let relevance = '0';
  if (text) {
    const tokens = text.split(' ').filter((token) => !GENERIC_VENUE.has(token));
    const namePhrases = [];
    for (let length = tokens.length; length > 0; length--) {
      for (let start = 0; start + length <= tokens.length; start++) {
        namePhrases.push(tokens.slice(start, start + length).join(' '));
      }
    }
    const phraseCases = namePhrases.map((_, index) => `WHEN LOWER(t.name) LIKE ? THEN ${Math.max(2, 4 - index)}`).join(' ');
    relevance = `(CASE WHEN LOWER(t.name) = ? THEN 6 WHEN LOWER(t.name) LIKE ? THEN 5 ${phraseCases} WHEN LOWER(t.name) LIKE ? THEN 1 ELSE 0 END)`;
    orderParams.push(text, `${text}%`, ...namePhrases.map((phrase) => `${phrase}%`), `%${text}%`);
  }

  // radius filter on the computed distance, applied as an outer query so it works on every MySQL-compatible engine
  let sql = `SELECT ${select}, ${relevance} AS relevance FROM turfs t WHERE ${where.join(' AND ')}`;
  const all = [...selectParams, ...orderParams, ...params];
  let wrapped = `SELECT * FROM (${sql}) q`;
  if (located && radius) wrapped += ' WHERE (q.distance_km IS NOT NULL AND q.distance_km <= ?)';
  wrapped += ` ORDER BY q.relevance DESC, ${located ? 'q.distance_km IS NULL, q.distance_km ASC, q.id DESC' : 'q.created_at DESC, q.id DESC'} LIMIT ? OFFSET ?`;
  if (located && radius) all.push(radius);
  all.push(limitPlus, offset);
  void order;
  const [rows] = await pool.query(wrapped, all);
  return rows;
}

async function searchActivities({ parsed, city, lat, lng, radius, limitPlus, offset }) {
  const where = ["a.status = 'approved'"]; const params = [];
  if (parsed.activityCategories.size) {
    const categories = [...parsed.activityCategories];
    where.push(`c.key_name IN (${categories.map(() => '?').join(',')})`);
    params.push(...categories);
  }
  for (const token of parsed.textTokens) {
    where.push("LOWER(CONCAT_WS(' ', a.name, a.location, a.city, a.address, c.label, c.key_name)) LIKE ?");
    params.push(`%${token}%`);
  }
  if (city) {
    where.push("LOWER(CONCAT_WS(' ', a.city, a.location, a.address)) LIKE ?");
    params.push(`%${norm(city)}%`);
  }
  const located = validCoord(lat, lng);
  let select = `a.*, c.key_name AS category_key, c.label AS category_label,
    (SELECT MIN(tt.price) FROM activity_ticket_types tt WHERE tt.activity_id = a.id AND tt.is_active = true) AS price_from`;
  const sel = [];
  if (located) { select += `, ${distExpr('a')} AS distance_km`; sel.push(lat, lng, lat); }
  let sql = `SELECT ${select} FROM activities a JOIN activity_categories c ON c.id = a.category_id WHERE ${where.join(' AND ')}`;
  let wrapped = `SELECT * FROM (${sql}) q`; const all = [...sel, ...params];
  if (located && radius) { wrapped += ' WHERE (q.distance_km IS NOT NULL AND q.distance_km <= ?)'; all.push(radius); }
  wrapped += located ? ' ORDER BY q.distance_km IS NULL, q.distance_km ASC, q.id DESC' : ' ORDER BY q.is_featured DESC, q.id DESC';
  wrapped += ' LIMIT ? OFFSET ?'; all.push(limitPlus, offset);
  return (await pool.query(wrapped, all))[0];
}

function shapeVenue(t, sportsByTurf) {
  const images = parseJson(t.images); const photos = parseJson(t.photos);
  const price = num(t.price_per_hour);
  const periodPrices = [t.default_price, t.early_morning_price, t.morning_price, t.afternoon_price, t.evening_price].map(num).filter((n) => n && n > 0);
  const from = periodPrices.length ? Math.min(...periodPrices) : (price && price > 0 ? price : null);
  const sports = sportsByTurf.get(Number(t.id));
  return {
    type: 'venue', id: t.id, slug: t.slug || null, name: t.name,
    location: t.location || null, city: t.city || null, address: t.address || null,
    sport_type: t.sport_type || null,
    sports: sports && sports.length ? sports : (t.sport_type && t.sport_type !== 'general' ? [String(t.sport_type)] : []),
    price_per_hour: price && price > 0 ? price : null, price_from: from, currency_code: t.currency_code || 'INR',
    images: images.length ? images : photos, coverImage: t.coverImage || null,
    rating: num(t.rating), review_count: t.review_count == null ? null : Number(t.review_count),
    latitude: num(t.latitude), longitude: num(t.longitude),
    distance_km: round1(t.distance_km),
  };
}
function shapeActivity(a) {
  const images = parseJson(a.images);
  return {
    type: 'activity', id: a.id, slug: a.slug || null, name: a.title || a.name,
    location: a.location || a.venue_name || null, city: a.city || null, address: a.address || null,
    category: a.category_key || null, category_label: a.category_label || null,
    sports: [], sport_type: a.category_label || a.category_key || 'Activity', price_per_hour: null, price_from: num(a.price_from ?? a.base_price ?? a.price), currency_code: a.currency_code || 'INR',
    images, coverImage: a.cover_image || a.image_url || images[0] || null, rating: num(a.rating), review_count: null,
    latitude: num(a.latitude), longitude: num(a.longitude), distance_km: round1(a.distance_km),
  };
}

/**
 * @param {{ q?:string, sport?:string|number, city?:string, lat?:any, lng?:any, radius?:any, page?:any, limit?:any, mode?:'search'|'nearby', includeActivities?:boolean, type?:string }} opts
 */
async function discover(opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 12, 1), MAX_LIMIT);
  const page = Math.min(Math.max(parseInt(opts.page, 10) || 1, 1), MAX_PAGE);
  const offset = (page - 1) * limit;
  const categories = (await loadCategories()).filter((c) => c.is_enabled);
  const parsed = parseQuery(String(opts.q || '').slice(0, 120), categories);

  const explicit = new Set();
  if (opts.sport !== undefined && opts.sport !== null && String(opts.sport).trim() && String(opts.sport) !== 'All') {
    const s = norm(opts.sport); const asId = Number(opts.sport);
    const hit = categories.find((c) => c.id === asId || c.slug === String(opts.sport).toLowerCase() || norm(c.name) === s || aliasesOf(c).map(norm).includes(s));
    if (hit) explicit.add(hit.id);
    else if (s) parsed.textTokens.push(...s.split(' ')); // not a known category: treat it as plain text rather than returning everything
  }

  let lat = num(opts.lat); let lng = num(opts.lng);
  const located = validCoord(lat, lng);
  if (!located) { lat = null; lng = null; }
  let radius = num(opts.radius);
  if (radius !== null) radius = Math.min(Math.max(radius, 1), 500);
  if (radius === null && located && (opts.mode === 'nearby' || parsed.nearMe)) radius = 50;
  const wantNearMeButNoCoords = parsed.nearMe && !located;

  const typeFilter = String(opts.type || '').toLowerCase();
  const venuesWanted = typeFilter !== 'activity';
  const activitiesWanted = typeFilter === 'activity' || (typeFilter !== 'venue' && (parsed.wantsActivities || (opts.includeActivities !== false && !parsed.sportIds.size && !explicit.size && !parsed.turfGroup)));
  // "amusement park" style queries are about activities only; don't pad them with unrelated sport venues
  const venuesOnlyIfNoActivityIntent = !(parsed.wantsActivities && !parsed.sportIds.size && !explicit.size && !parsed.turfGroup);

  const limitPlus = offset + limit + 1;
  const [venueRows, actRows] = await Promise.all([
    venuesWanted && venuesOnlyIfNoActivityIntent
      ? searchVenues({ parsed, explicitCategoryIds: explicit, city: opts.city, lat, lng, radius, limitPlus, offset: 0, categories })
      : [],
    activitiesWanted ? searchActivities({ parsed, city: opts.city, lat, lng, radius, limitPlus, offset: 0 }) : [],
  ]);

  const ids = venueRows.map((r) => Number(r.id));
  const sportsByTurf = new Map();
  if (ids.length) {
    const [links] = await pool.query(
      `SELECT ts.turf_id, c.name FROM turf_sports ts JOIN sport_categories c ON c.id = ts.category_id WHERE ts.turf_id IN (${ids.map(() => '?').join(',')}) AND c.is_enabled = 1 ORDER BY c.sort_order, c.name`, ids);
    for (const l of links) { const k = Number(l.turf_id); if (!sportsByTurf.has(k)) sportsByTurf.set(k, []); sportsByTurf.get(k).push(l.name); }
  }

  let merged = [...venueRows.map((r) => ({ item: shapeVenue(r, sportsByTurf), rel: Number(r.relevance || 0), created: r.created_at })), ...actRows.map((r) => ({ item: shapeActivity(r), rel: 0, created: r.created_at }))];
  merged.sort((a, b) => {
    if (b.rel !== a.rel) return b.rel - a.rel;
    if (located) {
      const da = a.item.distance_km, db = b.item.distance_km;
      if (da === null && db !== null) return 1; if (db === null && da !== null) return -1;
      if (da !== null && db !== null && da !== db) return da - db;
    } else if (a.created && b.created) { const d = new Date(b.created) - new Date(a.created); if (d) return d; }
    return 0;
  });
  const slice = merged.slice(offset, offset + limit + 1);
  const hasMore = slice.length > limit;
  const results = slice.slice(0, limit).map((m) => m.item);
  const queryNameTokens = parsed.textTokens.filter((token) => !GENERIC_VENUE.has(token));
  const exactMatches = !hasMore && queryNameTokens.length
    ? results.filter((item) => {
      if (item.type !== 'venue') return false;
      const nameTokens = norm(item.name).split(' ').filter((token) => !GENERIC_VENUE.has(token));
      return nameTokens.length > 0 && nameTokens.every((nameToken) =>
        queryNameTokens.some((queryToken) => nameToken.includes(queryToken) || queryToken.includes(nameToken))
      );
    })
    : [];
  const exactMatch = exactMatches.length === 1 ? exactMatches[0] : null;

  let suggestions = [];
  if (!results.length && page === 1) suggestions = await buildSuggestions(String(opts.q || ''), categories);

  return {
    results, page, limit, hasMore, located, exactMatch,
    parsed: { sports: parsed.matchedSports, turf: parsed.turfGroup, activities: parsed.wantsActivities, activity_categories: [...parsed.activityCategories], near_me: parsed.nearMe, text: parsed.textTokens.join(' ') },
    notice: wantNearMeButNoCoords ? 'Turn on location (or pick a place) to search near you.' : null,
    suggestions,
  };
}

async function buildSuggestions(q, categories) {
  const out = [];
  const s = norm(q).split(' ').filter(Boolean).pop() || '';
  try {
    if (s.length >= 2) {
      const [cities] = await pool.query(
        "SELECT city, COUNT(*) AS n FROM turfs WHERE is_active = true AND (approval_status = 'APPROVED' OR approval_status IS NULL) AND city LIKE ? GROUP BY city ORDER BY n DESC LIMIT 5", [`${s.slice(0, 4)}%`]);
      for (const c of cities) if (c.city) out.push({ kind: 'place', label: c.city, query: c.city });
    }
  } catch { /* suggestions are best-effort */ }
  for (const c of categories.slice(0, 6)) out.push({ kind: 'sport', label: c.name, query: c.name });
  return out.slice(0, 8);
}

async function listLocations(q, limit = 8) {
  const term = norm(q);
  const params = []; let like = '';
  if (term) { like = ' AND (city LIKE ? OR location LIKE ?)'; params.push(`${term}%`, `%${term}%`); }
  const [cities] = await pool.query(
    `SELECT city AS label, COUNT(*) AS venues, AVG(latitude) AS latitude, AVG(longitude) AS longitude FROM turfs
     WHERE is_active = true AND (approval_status = 'APPROVED' OR approval_status IS NULL) AND city IS NOT NULL AND city <> ''${like}
     GROUP BY city ORDER BY venues DESC LIMIT ?`, [...params, Math.min(limit, 20)]);
  return cities.map((c) => ({ kind: 'city', label: c.label, venues: Number(c.venues), latitude: num(c.latitude), longitude: num(c.longitude) }));
}

module.exports = { discover, parseQuery, loadCategories, clearCategoryCache, listLocations, norm, validCoord };
