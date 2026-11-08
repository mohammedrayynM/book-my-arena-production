// Server-authoritative pricing for tournament creation.
//
// Everything a host is charged is decided here from the admin's settings and the coupon records — never from
// anything the app or website sends. The client may say which coupon code it wants; it can never say what the
// discount or the payable amount is.
const pool = require('../config/db');

function parseList(value) {
  if (!value) return null;
  try {
    const list = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(list)) throw new Error('Expected a JSON array');
    return list.length ? list : null;
  } catch {
    throw new Error('Tournament format/sport settings are invalid');
  }
};

// Today in the server's own calendar, as YYYY-MM-DD. Coupon validity is a calendar-day question, so comparing
// Date objects against DATE columns (which mysql2 hands back as midnight-local Dates) is what breaks it.
function todayYmd(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function ymd(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return isNaN(d) ? null : todayYmd(d);
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/** The admin's tournament configuration. A missing or invalid fee must never become a free tournament. */
async function getConfig() {
  const [rows] = await pool.query('SELECT * FROM tournament_settings LIMIT 1');
  const r = rows[0];
  if (!r) throw new Error('Tournament settings are not configured');

  const fee = Number(r.fee_amount);
  const currency = String(r.currency_code || 'INR').toUpperCase();
  if (!Number.isFinite(fee) || fee < 0) throw new Error('Tournament creation fee is invalid');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Tournament creation currency is invalid');

  return {
    fee_amount: fee,
    is_active: r.is_active === undefined ? true : !!r.is_active,
    creation_enabled: r.creation_enabled === undefined ? true : !!r.creation_enabled,
    currency_code: currency,
    min_duration_days: Number(r.min_duration_days) || 1,
    max_duration_days: Number(r.max_duration_days) || 30,
    allowed_formats: parseList(r.allowed_formats),
    allowed_sports: parseList(r.allowed_sports),
    disabled_message: r.disabled_message || null,
    notify_radius_km: r.notify_radius_km === undefined || r.notify_radius_km === null ? 25 : Number(r.notify_radius_km),
  }
}

/** The fee a given host actually faces, before any coupon. Admins host for the platform, so they are never charged. */
function baseFeeFor(config, hostType) {
  if (hostType === 'admin') return 0;
  if (!config.is_active) return 0;
  return round2(config.fee_amount);
}

/** Active, in-date, not-exhausted offers, in the shape the apps display. */
async function listOffers() {
  const today = todayYmd();
  const [rows] = await pool.query(
    `SELECT * FROM tournament_offers
      WHERE is_active = 1
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_until IS NULL OR valid_until >= ?)
        AND (max_uses IS NULL OR used_count < max_uses)
      ORDER BY created_at DESC`, [today, today]);
  return rows.map(publicOffer);
}

function publicOffer(o) {
  const pct = o.discount_type === 'percentage';
  return {
    code: o.code,
    title: o.title,
    description: o.description || null,
    discount_type: o.discount_type,
    discount_value: Number(o.discount_value),
    max_discount: o.max_discount === null || o.max_discount === undefined ? null : Number(o.max_discount),
    min_amount: Number(o.min_amount) || 0,
    valid_from: ymd(o.valid_from),
    valid_until: ymd(o.valid_until),
    display_text: pct ? `${Number(o.discount_value)}% OFF` : `${Number(o.discount_value)} OFF`,
  };
}

function discountFor(offer, base) {
  const value = Number(offer.discount_value) || 0;
  let discount = offer.discount_type === 'percentage' ? (base * value) / 100 : value;
  if (offer.max_discount !== null && offer.max_discount !== undefined) {
    discount = Math.min(discount, Number(offer.max_discount));
  }
  return round2(Math.max(0, Math.min(discount, base)));
}

/**
 * What this host would pay right now. Returns { ok, base, discount, payable, currency, offer, error }.
 * `error` is a message meant for the user; it never leaks why an offer exists or who else used it.
 */
async function quote({ hostType = 'user', hostId = null, couponCode = null } = {}) {
  const config = await getConfig();
  const base = baseFeeFor(config, hostType);
  const out = { ok: true, config, base, discount: 0, payable: base, currency: config.currency_code, offer: null, error: null };

  const code = String(couponCode || '').trim();
  if (!code) return out;
  if (base <= 0) return { ...out, error: 'There is no creation fee to apply a coupon to.' };

  let offer;
  try {
    const [rows] = await pool.query('SELECT * FROM tournament_offers WHERE code = ? LIMIT 1', [code.toUpperCase()]);
    offer = rows[0];
  } catch {
    return { ...out, error: 'Coupons are not available right now.' };
  }
  if (!offer) return { ...out, error: 'That coupon code does not exist.' };
  if (!offer.is_active) return { ...out, error: 'This coupon is no longer active.' };

  const today = todayYmd();
  if (offer.valid_from && ymd(offer.valid_from) > today) return { ...out, error: 'This coupon is not valid yet.' };
  if (offer.valid_until && ymd(offer.valid_until) < today) return { ...out, error: 'This coupon has expired.' };
  if (offer.max_uses !== null && Number(offer.used_count) >= Number(offer.max_uses)) {
    return { ...out, error: 'This coupon has been fully used.' };
  }
  if (base < Number(offer.min_amount || 0)) {
    return { ...out, error: `This coupon needs a creation fee of at least ${Number(offer.min_amount)}.` };
  }
  if (hostId) {
    try {
      const [[mine]] = await pool.query(
        'SELECT COUNT(*) AS n FROM tournament_offer_redemptions WHERE offer_id = ? AND user_id = ? AND user_role = ?',
        [offer.id, hostId, hostType]);
      if (mine && Number(mine.n) >= Number(offer.per_user_limit || 1)) {
        return { ...out, error: 'You have already used this coupon.' };
      }
    } catch {
      return { ...out, error: 'Coupon validation is temporarily unavailable.' };
    }
  }

  const discount = discountFor(offer, base);
  return { ...out, discount, payable: round2(base - discount), offer: { id: offer.id, ...publicOffer(offer) } };
}

/**
 * Consume one use of an offer, atomically, at the moment the payment is verified.
 * Returns true when this call is the one that claimed it. A repeated verify for the same tournament is a no-op
 * (the UNIQUE (offer_id, tournament_id) key), so a coupon can never be spent twice by a retry or a webhook race.
 */
async function claimOffer(conn, { offerId, tournamentId, userId, userRole = 'user', discountAmount = 0 }) {
  if (!offerId || !tournamentId) return false;
  try {
    const [ins] = await conn.query(
      `INSERT IGNORE INTO tournament_offer_redemptions (offer_id, tournament_id, user_id, user_role, discount_amount)
       VALUES (?, ?, ?, ?, ?)`,
      [offerId, tournamentId, userId, userRole, discountAmount]);
    if (!ins.affectedRows) return false; // already redeemed for this tournament
    // Only increments while the cap still allows it, in one statement — two concurrent verifies cannot both win.
    const [upd] = await conn.query(
      'UPDATE tournament_offers SET used_count = used_count + 1 WHERE id = ? AND (max_uses IS NULL OR used_count < max_uses)',
      [offerId]);
    if (!upd.affectedRows) {
      await conn.query('DELETE FROM tournament_offer_redemptions WHERE offer_id = ? AND tournament_id = ?', [offerId, tournamentId]);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Record every admin change to pricing/offers so history is never silently rewritten. */
async function audit(db, { adminId, entity, entityId = null, action, before = null, after = null }) {
  try {
    await (db || pool).query(
      'INSERT INTO tournament_settings_audit (admin_id, entity, entity_id, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)',
      [adminId || null, entity, entityId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
  } catch { /* auditing must never block the change itself */ }
}

module.exports = { getConfig, baseFeeFor, listOffers, publicOffer, quote, claimOffer, audit, todayYmd, ymd, round2 };
