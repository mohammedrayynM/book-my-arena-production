// /api/notifications - the signed-in person's own notifications, devices and preferences (users, owners and admins alike).
//
// Every route acts on the identity in the JWT, never on an id sent in the body/query: nobody can read, mark, or register a device
// for someone else, and there is no route that creates a notification at all (notifications only come from real backend events).
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const svc = require('../utils/notifications/service');
const { openChannelStream } = require('../utils/realtime');

router.use((req, res, next) => (req.path.startsWith('/internal/') ? next() : verifyToken(req, res, next)));
router.use((req, res, next) => { if (req.user) req.actor = svc.actorOf(req.user); next(); });

const bad = (res, status, error) => res.status(status).json({ success: false, error });

// GET /api/notifications?limit=20&cursor=<id>&unread=1&category=BOOKINGS
router.get('/', async (req, res) => {
  try {
    const page = await svc.list(req.actor, { limit: req.query.limit, cursor: req.query.cursor, unreadOnly: req.query.unread === '1' || req.query.unread === 'true', category: req.query.category || null });
    res.json({ success: true, ...page, unread_count: await svc.unreadCount(req.actor) });
  } catch (e) { console.error('notifications list:', e.message); bad(res, 500, 'Could not load notifications'); }
});

router.get('/unread-count', async (req, res) => {
  try { res.json({ success: true, unread_count: await svc.unreadCount(req.actor) }); }
  catch (e) { bad(res, 500, 'Could not load the unread count'); }
});

router.patch('/read-all', async (req, res) => {
  try {
    const updated = await svc.markAllRead(req.actor, (req.body && req.body.category) || null);
    res.json({ success: true, updated, unread_count: await svc.unreadCount(req.actor) });
  } catch (e) { bad(res, 500, 'Could not mark notifications as read'); }
});

// ---- preferences ----
router.get('/preferences', async (req, res) => {
  try { res.json({ success: true, preferences: await svc.preferencesView(req.actor) }); }
  catch (e) { bad(res, 500, 'Could not load preferences'); }
});

// PATCH { category, enabled }  or  { preferences: { TOURNAMENTS: false, ... } }
router.patch('/preferences', async (req, res) => {
  try {
    const body = req.body || {};
    const entries = body.preferences && typeof body.preferences === 'object' ? Object.entries(body.preferences) : (body.category !== undefined ? [[body.category, body.enabled]] : []);
    if (entries.length === 0) return bad(res, 400, 'Nothing to update');
    for (const [category, enabled] of entries) {
      if (typeof enabled !== 'boolean') return bad(res, 400, 'enabled must be true or false');
      const r = await svc.setPreference(req.actor, category, enabled);
      if (r.error) return bad(res, r.status, r.error);
    }
    res.json({ success: true, preferences: await svc.preferencesView(req.actor) });
  } catch (e) { bad(res, 500, 'Could not save preferences'); }
});

// ---- devices ----
// POST { push_token, platform, device_id, app_version, device_name }  - registers/refreshes THIS device for the signed-in account
router.post('/push-tokens', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await svc.registerDevice(req.actor, { token: b.push_token, platform: b.platform, deviceId: b.device_id, appVersion: b.app_version, deviceName: b.device_name });
    if (r.error) return bad(res, r.status || 400, r.error);
    res.json({ success: true, id: r.id });
  } catch (e) { console.error('push token register:', e.message); bad(res, 500, 'Could not register this device'); }
});

router.get('/push-tokens', async (req, res) => {
  try { res.json({ success: true, devices: await svc.listDevices(req.actor) }); }
  catch (e) { bad(res, 500, 'Could not load devices'); }
});

// DELETE { push_token } or ?id=  - stop notifications on this device (sign-out). Only your own devices can be affected.
router.delete('/push-tokens', async (req, res) => {
  try {
    const token = (req.body && req.body.push_token) || req.query.push_token || null;
    const id = req.query.id && /^\d+$/.test(String(req.query.id)) ? Number(req.query.id) : null;
    if (!token && !id) return bad(res, 400, 'push_token or id is required');
    const done = await svc.deactivateDevice(req.actor, { token, id });
    res.json({ success: true, deactivated: done });
  } catch (e) { bad(res, 500, 'Could not remove this device'); }
});

// GET /api/notifications/stream - realtime "you have a new notification" signal for THIS account (Server-Sent Events)
router.get('/stream', (req, res) => { openChannelStream(svc.channelOf(req.actor), req, res); });

// PATCH /api/notifications/:id/read
router.patch('/:id/read', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return bad(res, 404, 'Notification not found');
    const ok = await svc.markRead(req.actor, Number(req.params.id));
    if (!ok) return bad(res, 404, 'Notification not found'); // someone else's id looks exactly like a missing one
    res.json({ success: true, unread_count: await svc.unreadCount(req.actor) });
  } catch (e) { bad(res, 500, 'Could not mark as read'); }
});

// POST /api/notifications/internal/run - lets an external cron (or a platform scheduler) trigger a scheduler pass, e.g. on hosts
// that put idle servers to sleep. Protected by NOTIFICATIONS_CRON_SECRET; disabled when the variable is not set.
router.post('/internal/run', async (req, res) => {
  const secret = process.env.NOTIFICATIONS_CRON_SECRET;
  const given = String(req.headers['x-cron-secret'] || '');
  const ok = secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return res.status(404).json({ success: false, error: 'Not found' });
  try { res.json({ success: true, report: await require('../utils/notifications/scheduler').runOnce({ dryRun: req.query.dry === '1' }) }); }
  catch (e) { bad(res, 500, 'Scheduler run failed'); }
});

module.exports = router;
