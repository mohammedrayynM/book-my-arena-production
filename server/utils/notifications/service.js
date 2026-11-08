// The one place a notification is created. Feature code never inserts notifications, sends pushes or writes copy:
//
//   feature event -> events.js -> notify() -> template -> preferences -> notifications row (dedupe) -> push deliveries -> Expo
//
// Notifications are only a DELIVERY layer. notify() never throws into its caller and nothing here can change a booking,
// payment, subscription or tournament: callers do not await it, and every failure is logged and swallowed.
const pool = require('../../config/db');
const { TYPES, CATEGORIES, OPTIONAL_CATEGORIES, isMandatory } = require('./constants');
const { render } = require('./templates');
const { broadcastChannel } = require('../realtime');

const key = (to) => `${to.type}:${to.id}`;
const isRecipient = (to) => to && ['user', 'owner', 'admin'].includes(to.type) && Number.isInteger(Number(to.id)) && Number(to.id) > 0;
const channelOf = (to) => `notif:${to.type}:${to.id}`;

// The signed-in caller as a recipient. User JWTs carry no role claim; owner / admin JWTs do.
function actorOf(jwtUser) {
  const role = jwtUser && (jwtUser.role === 'owner' || jwtUser.role === 'admin') ? jwtUser.role : 'user';
  return { type: role, id: Number(jwtUser.id) };
}

// ---- preferences ----------------------------------------------------------------------------------------
async function preferenceMap(to) {
  const [rows] = await pool.query('SELECT category, enabled FROM notification_preferences WHERE recipient_type = ? AND recipient_id = ?', [to.type, to.id]);
  const map = {};
  for (const r of rows) map[r.category] = !!r.enabled;
  return map;
}

async function isAllowed(to, type) {
  if (isMandatory(type)) return true;
  const meta = TYPES[type];
  const [rows] = await pool.query('SELECT enabled FROM notification_preferences WHERE recipient_type = ? AND recipient_id = ? AND category = ?', [to.type, to.id, meta.category]);
  return rows.length === 0 ? true : !!rows[0].enabled;
}

async function preferencesView(to) {
  const map = await preferenceMap(to);
  return Object.entries(CATEGORIES).map(([category, c]) => ({
    category, label: c.label, description: c.description,
    locked: c.locked, enabled: c.locked ? true : map[category] !== false,
  }));
}

async function setPreference(to, category, enabled) {
  if (!CATEGORIES[category]) return { error: 'Unknown category', status: 400 };
  if (CATEGORIES[category].locked) return { error: `${CATEGORIES[category].label} notifications are important and cannot be turned off`, status: 400 };
  await pool.query(
    'INSERT INTO notification_preferences (recipient_type, recipient_id, category, enabled) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)',
    [to.type, to.id, category, enabled ? 1 : 0]
  );
  return { ok: true };
}

// ---- creating notifications ---------------------------------------------------------------------------
/**
 * notify({ to: {type,id}, type, data, eventKey, push?, expiresAt? })
 *  - `data`     the facts the template needs (loaded from the database by the event handler)
 *  - `eventKey` identifies the real-world event ("booking 12 confirmed"); the same event twice creates ONE notification
 * Resolves { id } | { deduped } | { skipped } | { error } - never rejects.
 */
async function notify({ to, type, data = {}, eventKey, push = true, expiresAt = null }) {
  try {
    if (!isRecipient(to)) return { skipped: 'no-recipient' };
    const meta = TYPES[type];
    if (!meta) return { error: `unknown notification type ${type}` };
    if (eventKey === undefined || eventKey === null || eventKey === '') return { error: 'eventKey is required' };
    to = { type: to.type, id: Number(to.id) };

    if (!(await isAllowed(to, type))) return { skipped: 'preference' };

    const content = render(type, { ...data, recipientType: to.type });
    const fullKey = `${type}:${eventKey}:${to.type}:${to.id}`.slice(0, 190);
    const [ins] = await pool.query(
      `INSERT IGNORE INTO notifications
        (recipient_type, recipient_id, notification_type, category, title, message, entity_type, entity_id, deep_link, image_url, metadata, event_key, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
      [to.type, to.id, type, meta.category, content.title.slice(0, 160), content.message.slice(0, 500),
        content.entityType || null, content.entityId == null ? null : String(content.entityId), content.deepLink || null, content.imageUrl || null,
        JSON.stringify(content.metadata || {}), fullKey, expiresAt ? Math.round((expiresAt - Date.now()) / 1000) : null]
    );
    if (ins.affectedRows === 0) return { deduped: true };
    const id = ins.insertId;

    // realtime badge / toast for anyone with the app open (best effort)
    try {
      broadcastChannel(channelOf(to), 'notification', { id, type, category: meta.category, title: content.title, message: content.message, deep_link: content.deepLink || null });
    } catch (e) { /* realtime is optional */ }

    // push: one delivery row per active device, sent asynchronously so the caller is never delayed by (or blocked on) Expo
    if (push && meta.push) {
      try {
        const [devices] = await pool.query('SELECT id FROM user_push_tokens WHERE recipient_type = ? AND recipient_id = ? AND is_active = true', [to.type, to.id]);
        if (devices.length > 0) {
          const values = devices.map(() => '(?, ?)').join(',');
          await pool.query(`INSERT IGNORE INTO notification_deliveries (notification_id, device_id) VALUES ${values}`, devices.flatMap((d) => [id, d.id]));
          setImmediate(() => { require('./push').deliver(id).catch((e) => console.error('[notifications] push error:', e.message)); });
        }
      } catch (e) { console.error('[notifications] could not queue push:', e.message); }
    }
    return { id };
  } catch (error) {
    console.error(`[notifications] notify ${type} failed:`, error.message);
    return { error: error.message };
  }
}

// Same notification for many recipients (each gets its own row + dedupe key). Sequential and bounded on purpose.
async function notifyMany(recipients, opts) {
  const out = { created: 0, deduped: 0, skipped: 0, errors: 0 };
  const seen = new Set();
  for (const to of recipients || []) {
    if (!isRecipient(to) || seen.has(key(to))) continue;
    seen.add(key(to));
    const r = await notify({ ...opts, to });
    if (r.id) out.created++; else if (r.deduped) out.deduped++; else if (r.skipped) out.skipped++; else out.errors++;
  }
  return out;
}

// ---- reading -----------------------------------------------------------------------------------------------
const rowToApi = (r) => ({
  id: r.id, type: r.notification_type, category: r.category, title: r.title, message: r.message,
  entity_type: r.entity_type, entity_id: r.entity_id, deep_link: r.deep_link, image_url: r.image_url,
  metadata: typeof r.metadata === 'string' ? (() => { try { return JSON.parse(r.metadata); } catch { return {}; } })() : (r.metadata || {}),
  is_read: !!r.is_read, read_at: r.read_at, created_at: r.created_at,
});

// Cursor pagination on the primary key (newest first): stable while new notifications keep arriving.
async function list(to, { limit = 20, cursor = null, unreadOnly = false, category = null } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const where = ['recipient_type = ?', 'recipient_id = ?', '(expires_at IS NULL OR expires_at > NOW())'];
  const params = [to.type, to.id];
  if (cursor && /^\d+$/.test(String(cursor))) { where.push('id < ?'); params.push(Number(cursor)); }
  if (unreadOnly) where.push('is_read = false');
  if (category && CATEGORIES[category]) { where.push('category = ?'); params.push(category); }
  const [rows] = await pool.query(`SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${lim + 1}`, params);
  const page = rows.slice(0, lim);
  return { notifications: page.map(rowToApi), next_cursor: rows.length > lim ? String(page[page.length - 1].id) : null };
}

async function unreadCount(to) {
  const [[r]] = await pool.query('SELECT COUNT(*) AS c FROM notifications WHERE recipient_type = ? AND recipient_id = ? AND is_read = false AND (expires_at IS NULL OR expires_at > NOW())', [to.type, to.id]);
  return Number(r.c);
}

// Only ever touches the caller's own rows: someone else's notification id simply matches nothing.
async function markRead(to, id) {
  const [r] = await pool.query('UPDATE notifications SET is_read = true, read_at = COALESCE(read_at, NOW()) WHERE id = ? AND recipient_type = ? AND recipient_id = ?', [id, to.type, to.id]);
  return r.affectedRows > 0;
}

async function markAllRead(to, category = null) {
  const params = [to.type, to.id];
  let sql = 'UPDATE notifications SET is_read = true, read_at = NOW() WHERE recipient_type = ? AND recipient_id = ? AND is_read = false';
  if (category && CATEGORIES[category]) { sql += ' AND category = ?'; params.push(category); }
  const [r] = await pool.query(sql, params);
  return r.affectedRows;
}

// ---- devices ----------------------------------------------------------------------------------------------
const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_\-]{10,}\]$/;

// Registers (or refreshes) a device for the signed-in account.
//  - one row per token: a token that appears under another account is MOVED to this one (the phone changed hands / user switched)
//  - a device that rotated its token replaces its old row, so the same phone never receives a notification twice
async function registerDevice(to, { token, platform, deviceId, appVersion, deviceName }) {
  if (!TOKEN_RE.test(String(token || ''))) return { error: 'That is not a valid Expo push token', status: 400 };
  const clean = (v, n) => (v == null ? null : String(v).slice(0, n));
  const dev = clean(deviceId, 120);
  if (dev) {
    await pool.query("UPDATE user_push_tokens SET is_active = false, deactivated_reason = 'token_rotated' WHERE recipient_type = ? AND recipient_id = ? AND device_id = ? AND push_token <> ? AND is_active = true", [to.type, to.id, dev, token]);
  }
  await pool.query(
    `INSERT INTO user_push_tokens (recipient_type, recipient_id, push_token, platform, device_id, device_name, app_version, is_active, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, true, NOW())
     ON DUPLICATE KEY UPDATE recipient_type = VALUES(recipient_type), recipient_id = VALUES(recipient_id), platform = VALUES(platform),
       device_id = VALUES(device_id), device_name = VALUES(device_name), app_version = VALUES(app_version), is_active = true, deactivated_reason = NULL, last_seen_at = NOW()`,
    [to.type, to.id, token, clean(platform, 20), dev, clean(deviceName, 120), clean(appVersion, 30)]
  );
  const [[row]] = await pool.query('SELECT id FROM user_push_tokens WHERE push_token = ?', [token]);
  return { ok: true, id: row.id };
}

// Sign-out on one device: stop pushing to it (the row is kept for the delivery history).
async function deactivateDevice(to, { token, id }) {
  const where = token ? 'push_token = ?' : 'id = ?';
  const [r] = await pool.query(`UPDATE user_push_tokens SET is_active = false, deactivated_reason = 'signed_out' WHERE recipient_type = ? AND recipient_id = ? AND ${where}`, [to.type, to.id, token || id]);
  return r.affectedRows > 0;
}

async function listDevices(to) {
  const [rows] = await pool.query('SELECT id, platform, device_name, app_version, is_active, last_seen_at, created_at FROM user_push_tokens WHERE recipient_type = ? AND recipient_id = ? ORDER BY last_seen_at DESC', [to.type, to.id]);
  return rows;
}

module.exports = {
  actorOf, notify, notifyMany, list, unreadCount, markRead, markAllRead,
  preferencesView, setPreference, isAllowed, registerDevice, deactivateDevice, listDevices,
  TOKEN_RE, channelOf, OPTIONAL_CATEGORIES,
};
