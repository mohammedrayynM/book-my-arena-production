// Admin-controlled authentication switches, stored in `settings` (key/value) so a change applies instantly, no rebuild.
const pool = require('../config/db');
const KEY = 'auth_google_login_enabled';
let cache = { at: 0, v: null };
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

async function getAuthSettings({ fresh = false } = {}) {
  if (!fresh && cache.v && Date.now() - cache.at < 5000) return cache.v;
  let enabled = false; // off until an admin turns it on
  try {
    const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [KEY]);
    if (rows.length) enabled = truthy(rows[0].setting_value);
  } catch { /* no settings table yet: stays off */ }
  cache = { at: Date.now(), v: { googleEnabled: enabled, googleConfigured: !!process.env.GOOGLE_CLIENT_ID } };
  return cache.v;
}
async function setGoogleEnabled(on) {
  await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [KEY, on ? 'true' : 'false']);
  cache = { at: 0, v: null };
}
module.exports = { getAuthSettings, setGoogleEnabled, KEY };
