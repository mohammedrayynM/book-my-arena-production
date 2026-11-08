// Single source of truth for country -> currency/timezone and for the cancellation policy. Booking code never mentions
// a specific country or currency: it asks this module, so a new country is a row in `countries`, not a code change.
const pool = require('../config/db');
const { isValidTimezone } = require('../utils/timezone');

const parseJson = (v, fb) => { if (Array.isArray(v)) return v; try { return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
const shape = (r) => ({
  country_code: r.country_code, country_name: r.country_name, currency_code: r.currency_code, currency_symbol: r.currency_symbol,
  display_prefix: r.display_prefix, currency_name: r.currency_name, minor_digits: r.minor_digits,
  default_timezone: r.default_timezone, timezones: parseJson(r.timezones, [r.default_timezone]), enabled: !!r.enabled,
});

async function listCountries({ onlyEnabled = true } = {}) {
  const [rows] = await pool.query(`SELECT * FROM countries ${onlyEnabled ? 'WHERE enabled = true' : ''} ORDER BY sort_order, country_name`);
  const [cfg] = await pool.query('SELECT country_code, currency_code, enabled FROM payment_configs WHERE payment_provider = ?', ['razorpay']);
  const paymentsOn = new Map(cfg.map((c) => [`${c.country_code}:${c.currency_code}`, !!c.enabled]));
  return rows.map((r) => ({ ...shape(r), payments_enabled: !!paymentsOn.get(`${r.country_code}:${r.currency_code}`) }));
}

async function getCountry(code) {
  const [[r]] = await pool.query('SELECT * FROM countries WHERE country_code = ?', [String(code || '').toUpperCase()]);
  return r ? shape(r) : null;
}

/**
 * Turns what an owner chose (country + optional timezone) into what the venue stores. Currency ALWAYS comes from the
 * country row — never from the client. A timezone is only accepted if the country lists it (a country can have several).
 */
async function resolveVenueGeo({ country_code, timezone } = {}) {
  const code = String(country_code || 'IN').toUpperCase();
  const c = await getCountry(code);
  if (!c) return { error: 'Unknown country' };
  if (!c.enabled) return { error: `${c.country_name} is not enabled yet` };
  let tz = c.default_timezone;
  if (timezone) {
    if (!isValidTimezone(timezone) || !c.timezones.includes(timezone)) return { error: `Timezone ${timezone} is not valid for ${c.country_name}` };
    tz = timezone;
  }
  return { country_code: c.country_code, currency_code: c.currency_code, timezone: tz, country: c };
}

/** Online payment is only allowed for a country/currency the admin has switched on (merchant account confirmed). */
async function paymentsEnabledFor(countryCode, currencyCode) {
  const [[r]] = await pool.query('SELECT enabled FROM payment_configs WHERE country_code = ? AND currency_code = ? AND payment_provider = ?', [String(countryCode).toUpperCase(), String(currencyCode).toUpperCase(), 'razorpay']);
  return !!(r && r.enabled);
}

const shapePolicy = (p) => ({
  version: p.id, cancellationEnabled: !!p.cancellation_enabled, windowHours: Number(p.window_hours), feePercent: Number(p.fee_percent),
  customerRefundEnabled: !!p.customer_refund_enabled, ownerRefundPercent: Number(p.owner_refund_percent),
});
async function getActivePolicy() {
  const [[p]] = await pool.query('SELECT * FROM cancellation_policies WHERE is_active = true ORDER BY id DESC LIMIT 1');
  return shapePolicy(p || { id: 0, cancellation_enabled: 1, window_hours: 5, fee_percent: 20, customer_refund_enabled: 1, owner_refund_percent: 100 });
}
async function getPolicyVersion(version) {
  const [[p]] = await pool.query('SELECT * FROM cancellation_policies WHERE id = ?', [version]);
  return p ? shapePolicy(p) : null;
}
/** Admin edit = a NEW version; the old rows stay so existing bookings keep their own terms. */
async function publishPolicy(input, adminId) {
  const v = {
    cancellation_enabled: input.cancellationEnabled !== false, window_hours: Number(input.windowHours ?? 5), fee_percent: Number(input.feePercent ?? 20),
    customer_refund_enabled: input.customerRefundEnabled !== false, owner_refund_percent: Number(input.ownerRefundPercent ?? 100),
  };
  if (!(v.window_hours >= 0 && v.window_hours <= 720)) return { error: 'windowHours must be between 0 and 720' };
  if (!(v.fee_percent >= 0 && v.fee_percent <= 100)) return { error: 'feePercent must be between 0 and 100' };
  if (!(v.owner_refund_percent >= 0 && v.owner_refund_percent <= 100)) return { error: 'ownerRefundPercent must be between 0 and 100' };
  await pool.query('UPDATE cancellation_policies SET is_active = false WHERE is_active = true');
  const [ins] = await pool.query(
    'INSERT INTO cancellation_policies (cancellation_enabled, window_hours, fee_percent, customer_refund_enabled, owner_refund_percent, is_active, created_by, note) VALUES (?, ?, ?, ?, ?, true, ?, ?)',
    [v.cancellation_enabled, v.window_hours, v.fee_percent, v.customer_refund_enabled, v.owner_refund_percent, adminId || null, input.note ? String(input.note).slice(0, 255) : null]
  );
  return { policy: await getPolicyVersion(ins.insertId) };
}

/**
 * The policy a booking is bound to: its stored snapshot if it has one; otherwise the version that was active when the
 * booking was created (resolved inside the DB so no timezone conversion is involved), which is then stored on the booking.
 */
async function policyForBooking(table, bookingRow) {
  // window + fee are frozen per booking; the on/off switches and the owner-cancel refund % are platform-wide and read live
  const live = await getActivePolicy();
  if (bookingRow.policy_version && bookingRow.policy_window_hours != null && bookingRow.policy_fee_percent != null) {
    return { ...live, version: bookingRow.policy_version, windowHours: Number(bookingRow.policy_window_hours), feePercent: Number(bookingRow.policy_fee_percent) };
  }
  const [[p]] = await pool.query(
    `SELECT p.* FROM cancellation_policies p JOIN ${table} b ON b.id = ? WHERE p.created_at <= b.created_at ORDER BY p.id DESC LIMIT 1`, [bookingRow.id]
  );
  const bound = p ? shapePolicy(p) : live;
  await pool.query(`UPDATE ${table} SET policy_version = ?, policy_window_hours = ?, policy_fee_percent = ? WHERE id = ? AND policy_version IS NULL`, [bound.version || null, bound.windowHours, bound.feePercent, bookingRow.id]);
  return { ...live, version: bound.version, windowHours: bound.windowHours, feePercent: bound.feePercent };
}

module.exports = { listCountries, getCountry, resolveVenueGeo, paymentsEnabledFor, getActivePolicy, getPolicyVersion, publishPolicy, policyForBooking };
