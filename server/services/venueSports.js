// Owner-selected sports for a venue: canonical category ids in `turf_sports`, with the legacy `turfs.sport_type` text kept
// in step (comma-joined names) so every older screen/report that still reads that column keeps working.
const pool = require('../config/db');
const discovery = require('./discoverySearch');

/**
 * Reads the owner's selection from a request body.
 *  - `sport_ids` (array of category ids) is the new contract: validated against ENABLED categories, de-duplicated.
 *  - otherwise the old free-text `sport_type` is left alone (ids = null → nothing is re-synced).
 * Returns { ids, text } or { error }.
 */
async function resolveSelection(body) {
  const raw = body && body.sport_ids;
  if (raw === undefined || raw === null) return { ids: null, text: null };
  if (!Array.isArray(raw)) return { error: 'sport_ids must be a list' };
  if (raw.length > 12) return { error: 'Choose at most 12 sports' };
  const wanted = [...new Set(raw.map((x) => Number(x)))];
  if (wanted.some((n) => !Number.isInteger(n) || n <= 0)) return { error: 'sport_ids contains an invalid sport' };
  if (!wanted.length) return { error: 'Select at least one sport' };
  const cats = (await discovery.loadCategories({ force: true })).filter((c) => c.is_enabled);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const unknown = wanted.filter((id) => !byId.has(id));
  if (unknown.length) return { error: 'One or more selected sports are not available' };
  return { ids: wanted, text: wanted.map((id) => byId.get(id).name).join(', ') };
}

async function sync(turfId, ids) {
  if (!Array.isArray(ids)) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM turf_sports WHERE turf_id = ?', [turfId]);
    if (ids.length) await conn.query(`INSERT IGNORE INTO turf_sports (turf_id, category_id) VALUES ${ids.map(() => '(?, ?)').join(',')}`, ids.flatMap((id) => [turfId, id]));
    await conn.commit();
  } catch (e) { await conn.rollback().catch(() => {}); throw e; } finally { conn.release(); }
}

async function forVenue(turfId) {
  const [rows] = await pool.query('SELECT c.id, c.name, c.slug FROM turf_sports ts JOIN sport_categories c ON c.id = ts.category_id WHERE ts.turf_id = ? ORDER BY c.sort_order, c.name', [turfId]);
  return rows;
}
module.exports = { resolveSelection, sync, forVenue };
