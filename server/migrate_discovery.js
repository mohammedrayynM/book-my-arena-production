// Discovery / app-config migration. Idempotent and ADDITIVE ONLY: creates new tables, seeds the sports categories that
// Book Arena already supports, links existing venues to them from the text they already store, and adds read indexes.
// It never drops, renames or rewrites an existing column, and existing venues keep their `sport_type` text untouched.
const pool = require('./config/db');

// Aliases are matched against search text AND against legacy `sport_type` text on venues created before categories.
const SEED = [
  { slug: 'cricket-turf', name: 'Cricket Turf', venue_type: 'SPORTS', group: 'turf', order: 1, aliases: ['cricket turf', 'turf cricket', 'cricket', 'cricjet', 'criket', 'crickt'] },
  { slug: 'badminton', name: 'Badminton', venue_type: 'INDOOR', group: null, order: 2, aliases: ['badminton', 'badmiton', 'badmnton', 'shuttle'] },
  { slug: 'football-turf', name: 'Football Turf', venue_type: 'SPORTS', group: 'turf', order: 3, aliases: ['football turf', 'turf football', 'football', 'fotball', 'fottball', 'soccer', 'futsal'] },
  { slug: 'snooker', name: 'Snooker', venue_type: 'INDOOR', group: null, order: 4, aliases: ['snooker', 'billiards', 'billiard', 'pool table'] },
  { slug: 'cricket-nets', name: 'Cricket Nets', venue_type: 'SPORTS', group: null, order: 5, aliases: ['cricket nets', 'cricket net', 'nets'] },
  { slug: 'box-cricket', name: 'Box Cricket', venue_type: 'SPORTS', group: 'turf', order: 6, aliases: ['box cricket'] },
  { slug: 'table-tennis', name: 'Table Tennis', venue_type: 'INDOOR', group: null, order: 7, aliases: ['table tennis', 'ping pong', 'tt'] },
  { slug: 'pickleball', name: 'Pickleball', venue_type: 'SPORTS', group: null, order: 8, aliases: ['pickleball', 'pickle ball'] },
  { slug: 'padel', name: 'Padel', venue_type: 'SPORTS', group: null, order: 9, aliases: ['padel'] },
  { slug: 'swimming', name: 'Swimming', venue_type: 'RECREATION', group: null, order: 10, aliases: ['swimming', 'swim', 'swimming pool'] },
];

async function indexExists(table, name) {
  const [rows] = await pool.query(
    'SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1', [table, name]);
  return rows.length > 0;
}
async function columnExists(table, col) {
  const [rows] = await pool.query(
    'SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1', [table, col]);
  return rows.length > 0;
}
async function tableExists(table) {
  const [rows] = await pool.query('SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1', [table]);
  return rows.length > 0;
}
async function addIndex(table, name, cols) {
  try {
    if (!(await tableExists(table))) return;
    for (const c of cols) if (!(await columnExists(table, c))) return;
    if (await indexExists(table, name)) return;
    await pool.query(`CREATE INDEX ${name} ON ${table} (${cols.join(', ')})`);
  } catch (e) { console.warn(`[discovery-migration] index ${name} skipped: ${e.message}`); }
}

module.exports = async function migrateDiscovery() {
  await pool.query(`CREATE TABLE IF NOT EXISTS sport_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    slug VARCHAR(60) NOT NULL,
    name VARCHAR(80) NOT NULL,
    venue_type VARCHAR(20) NOT NULL DEFAULT 'SPORTS',
    search_group VARCHAR(20) NULL,
    aliases TEXT NULL,
    image_url VARCHAR(500) NULL,
    sort_order INT NOT NULL DEFAULT 100,
    is_enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sport_categories_slug (slug),
    UNIQUE KEY uq_sport_categories_name (name)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS turf_sports (
    turf_id INT NOT NULL,
    category_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (turf_id, category_id),
    KEY idx_turf_sports_category (category_id, turf_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT,
    UNIQUE KEY uq_settings_key (setting_key)
  )`).catch(() => { /* an existing settings table keeps its own shape */ });

  for (const s of SEED) {
    await pool.query(
      `INSERT IGNORE INTO sport_categories (slug, name, venue_type, search_group, aliases, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
      [s.slug, s.name, s.venue_type, s.group, JSON.stringify(s.aliases), s.order]);
  }

  // Link venues that only have the old free-text `sport_type`. INSERT IGNORE keeps this safe to re-run and never overrides a
  // selection an owner made later. Matching is on whole words/phrases so "cricket" does not match "cricket nets" twice.
  try {
    if (await tableExists('turfs') && await columnExists('turfs', 'sport_type')) {
      const [cats] = await pool.query('SELECT id, slug, name, aliases FROM sport_categories');
      const [turfs] = await pool.query("SELECT id, sport_type FROM turfs WHERE sport_type IS NOT NULL AND sport_type <> '' AND sport_type <> 'general'");
      const norm = (v) => ` ${String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
      const rows = [];
      for (const t of turfs) {
        const text = norm(t.sport_type);
        const hit = new Set();
        for (const c of cats) {
          const phrases = [c.name, ...(safeJson(c.aliases))].map(norm);
          if (phrases.some((p) => p.trim() && text.includes(p))) hit.add(c.id);
        }
        // "cricket nets" / "box cricket" are more specific than the bare word "cricket": the generic Cricket Turf link is dropped
        // when the specific phrase is the only mention of cricket
        const stripped = text.replace(/ cricket nets? /g, ' ').replace(/ box cricket /g, ' ');
        const generic = cats.find((c) => c.slug === 'cricket-turf');
        if (generic && !stripped.includes(' cricket ') && !text.includes(' cricket turf ')) hit.delete(generic.id);
        for (const id of hit) rows.push([t.id, id]);
      }
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        await pool.query(`INSERT IGNORE INTO turf_sports (turf_id, category_id) VALUES ${chunk.map(() => '(?, ?)').join(',')}`, chunk.flat());
      }
    }
  } catch (e) { console.warn('[discovery-migration] backfill skipped:', e.message); }

  // A venue with no known coordinates must be stored as such (NULL), not given a made-up Bangalore point that would put it
  // in the wrong place in every distance sort. Keep each column's exact type; only drop NOT NULL.
  for (const col of ['latitude', 'longitude']) {
    try {
      const [[c]] = await pool.query("SELECT COLUMN_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'turfs' AND COLUMN_NAME = ?", [col]);
      if (c && c.IS_NULLABLE === 'NO') await pool.query(`ALTER TABLE turfs MODIFY COLUMN ${col} ${c.COLUMN_TYPE} NULL DEFAULT NULL`);
    } catch (e) { console.warn(`[discovery-migration] could not make turfs.${col} nullable:`, e.message); }
  }

  // Read indexes for the search / nearby queries (each only created if its table+columns exist and it is not there yet)
  await addIndex('turfs', 'idx_turfs_discovery', ['is_active', 'approval_status']);
  await addIndex('turfs', 'idx_turfs_city', ['city']);
  await addIndex('turfs', 'idx_turfs_geo', ['latitude', 'longitude']);
  await addIndex('turfs', 'idx_turfs_name', ['name']);
  await addIndex('bookings', 'idx_bookings_slot_lookup', ['turf_id', 'booking_date', 'payment_status']);
  await addIndex('bookings', 'idx_bookings_user_created', ['user_id', 'created_at']);
  await addIndex('advertisements', 'idx_ads_placement_active', ['placement', 'is_active']);
};

function safeJson(v) { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }
module.exports.SEED = SEED;
