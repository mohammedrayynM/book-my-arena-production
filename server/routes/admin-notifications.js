// /api/admin/notifications - notification management for admins: statistics, history, failed deliveries, the type registry, and
// platform announcements / promotions.
//
// Broadcasting is deliberately two-step: /broadcast/preview shows exactly who would receive the message and returns a short-lived
// signed confirmation token; /broadcast only sends when that token matches the SAME message and segment. There is no unrestricted
// "send to everyone" action: an all-users send additionally needs the words SEND TO ALL, and every send is capped and recorded.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { TYPES, CATEGORIES } = require('../utils/notifications/constants');
const { notify } = require('../utils/notifications/service');
const audience = require('../utils/notifications/audience');

router.use(verifyToken, verifyAdmin);

const MAX_BROADCAST = 5000;
const secret = () => process.env.JWT_SECRET || 'notification-broadcast';
const sign = (payload) => crypto.createHmac('sha256', secret()).update(JSON.stringify(payload)).digest('hex');
const KINDS = { announcement: 'SYSTEM_ANNOUNCEMENT', promotion: 'PROMOTION' };

function cleanBroadcast(body) {
  const b = body || {};
  const kind = KINDS[b.kind] ? b.kind : null;
  const title = String(b.title || '').trim();
  const message = String(b.message || '').trim();
  const seg = b.segment || {};
  const segment = {
    roles: (Array.isArray(seg.roles) && seg.roles.length ? seg.roles : ['user']).filter((r) => ['user', 'owner'].includes(r)),
    sport: seg.sport ? String(seg.sport).trim().slice(0, 40) : null,
    city: seg.city ? String(seg.city).trim().slice(0, 60) : null,
    activeSubscription: !!seg.activeSubscription,
  };
  if (!kind) return { error: 'kind must be "announcement" or "promotion"' };
  if (title.length < 3 || title.length > 100) return { error: 'Title must be 3 to 100 characters' };
  if (message.length < 5 || message.length > 400) return { error: 'Message must be 5 to 400 characters' };
  return { kind, title, message, segment };
}

// GET /stats
router.get('/stats', async (req, res) => {
  try {
    const [[totals]] = await pool.query(`SELECT COUNT(*) AS total, SUM(created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS last_24h, SUM(created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)) AS last_7d, SUM(is_read = false) AS unread FROM notifications`);
    const [byCategory] = await pool.query('SELECT category, COUNT(*) AS count FROM notifications GROUP BY category ORDER BY count DESC');
    const [byType] = await pool.query('SELECT notification_type AS type, COUNT(*) AS count FROM notifications GROUP BY notification_type ORDER BY count DESC LIMIT 15');
    const [deliveries] = await pool.query('SELECT status, COUNT(*) AS count FROM notification_deliveries GROUP BY status');
    const [[devices]] = await pool.query('SELECT SUM(is_active = true) AS active, SUM(is_active = false) AS inactive, COUNT(DISTINCT CONCAT(recipient_type, recipient_id)) AS accounts FROM user_push_tokens');
    res.json({ success: true, totals, by_category: byCategory, by_type: byType, deliveries, devices });
  } catch (e) { console.error('admin notif stats:', e.message); res.status(500).json({ success: false, error: 'Could not load statistics' }); }
});

// GET /history?limit=30&cursor=<id>&type=&category=&recipient_type=
router.get('/history', async (req, res) => {
  try {
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const where = ['1=1']; const params = [];
    if (req.query.cursor && /^\d+$/.test(req.query.cursor)) { where.push('n.id < ?'); params.push(Number(req.query.cursor)); }
    if (req.query.type && TYPES[req.query.type]) { where.push('n.notification_type = ?'); params.push(req.query.type); }
    if (req.query.category && CATEGORIES[req.query.category]) { where.push('n.category = ?'); params.push(req.query.category); }
    if (['user', 'owner', 'admin'].includes(req.query.recipient_type)) { where.push('n.recipient_type = ?'); params.push(req.query.recipient_type); }
    const [rows] = await pool.query(
      `SELECT n.id, n.recipient_type, n.recipient_id, n.notification_type, n.category, n.title, n.message, n.is_read, n.created_at,
              (SELECT COUNT(*) FROM notification_deliveries d WHERE d.notification_id = n.id) AS deliveries,
              (SELECT COUNT(*) FROM notification_deliveries d WHERE d.notification_id = n.id AND d.status IN ('SENT','DELIVERED')) AS pushed
       FROM notifications n WHERE ${where.join(' AND ')} ORDER BY n.id DESC LIMIT ${lim + 1}`, params);
    const page = rows.slice(0, lim);
    res.json({ success: true, notifications: page, next_cursor: rows.length > lim ? String(page[page.length - 1].id) : null });
  } catch (e) { res.status(500).json({ success: false, error: 'Could not load history' }); }
});

// GET /failures - deliveries that failed or are waiting to retry
router.get('/failures', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT d.id, d.notification_id, d.status, d.error, d.retry_count, d.next_attempt_at, d.created_at, n.notification_type, n.title, n.recipient_type, n.recipient_id, t.platform, t.is_active
       FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id JOIN user_push_tokens t ON t.id = d.device_id
       WHERE d.status IN ('FAILED','RETRY') ORDER BY d.id DESC LIMIT 100`);
    res.json({ success: true, failures: rows });
  } catch (e) { res.status(500).json({ success: false, error: 'Could not load failed deliveries' }); }
});

// GET /types - the registry, including which types have a real trigger today
router.get('/types', (req, res) => {
  res.json({ success: true, categories: Object.entries(CATEGORIES).map(([key, c]) => ({ key, ...c })), types: Object.entries(TYPES).map(([type, m]) => ({ type, ...m })) });
});

// POST /broadcast/preview  { kind, title, message, segment:{ roles, sport, city, activeSubscription } }
router.post('/broadcast/preview', async (req, res) => {
  try {
    const c = cleanBroadcast(req.body);
    if (c.error) return res.status(400).json({ success: false, error: c.error });
    const seg = await audience.segment(c.segment);
    const wholeUserBase = !c.segment.sport && !c.segment.city && !c.segment.activeSubscription;
    const payload = { admin: req.user.id, kind: c.kind, title: c.title, message: c.message, segment: c.segment, exp: Date.now() + 10 * 60000 };
    res.json({ success: true, recipient_count: seg.count, capped: seg.count > MAX_BROADCAST, max: MAX_BROADCAST, requires_all_confirmation: wholeUserBase, notification_type: KINDS[c.kind], payload_expires_in_seconds: 600, confirm_token: `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sign(payload)}` });
  } catch (e) { console.error('broadcast preview:', e.message); res.status(500).json({ success: false, error: 'Could not preview this broadcast' }); }
});

// POST /broadcast  { ...same fields, confirm_token, confirm_text? }
router.post('/broadcast', async (req, res) => {
  try {
    const c = cleanBroadcast(req.body);
    if (c.error) return res.status(400).json({ success: false, error: c.error });
    const [body, sig] = String((req.body || {}).confirm_token || '').split('.');
    let payload;
    try { payload = JSON.parse(Buffer.from(body || '', 'base64url').toString('utf8')); } catch { payload = null; }
    if (!payload || !sig || sign(payload) !== sig) return res.status(400).json({ success: false, error: 'Preview this broadcast and confirm it before sending' });
    if (payload.exp < Date.now()) return res.status(400).json({ success: false, error: 'The confirmation expired. Preview it again.' });
    if (payload.admin !== req.user.id || payload.kind !== c.kind || payload.title !== c.title || payload.message !== c.message || JSON.stringify(payload.segment) !== JSON.stringify(c.segment)) {
      return res.status(400).json({ success: false, error: 'The message or audience changed after the preview. Preview it again.' });
    }
    const wholeUserBase = !c.segment.sport && !c.segment.city && !c.segment.activeSubscription;
    if (wholeUserBase && String(req.body.confirm_text || '').trim() !== 'SEND TO ALL') {
      return res.status(400).json({ success: false, error: 'Type SEND TO ALL to confirm a message to every user' });
    }

    const seg = await audience.segment(c.segment);
    if (seg.recipients.length === 0) return res.status(400).json({ success: false, error: 'No one matches this audience' });
    const [ins] = await pool.query('INSERT INTO notification_broadcasts (admin_id, kind, title, message, segment, recipient_count) VALUES (?, ?, ?, ?, ?, ?)', [req.user.id, c.kind, c.title, c.message, JSON.stringify(c.segment), seg.recipients.length]);
    const broadcastId = ins.insertId;
    res.json({ success: true, broadcast_id: broadcastId, recipient_count: seg.recipients.length, message: 'Sending' });

    // deliver in the background, a few at a time; one bad recipient never stops the rest
    setImmediate(async () => {
      const type = KINDS[c.kind];
      for (let i = 0; i < seg.recipients.length; i += 20) {
        await Promise.all(seg.recipients.slice(i, i + 20).map((to) => notify({ to, type, eventKey: `broadcast:${broadcastId}`, data: { title: c.title, message: c.message, entityType: 'broadcast', entityId: broadcastId } })));
      }
    });
  } catch (e) { console.error('broadcast:', e.message); if (!res.headersSent) res.status(500).json({ success: false, error: 'Could not send this broadcast' }); }
});

// GET /broadcasts - what was sent, by whom
router.get('/broadcasts', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT b.id, b.admin_id, a.username AS admin_name, b.kind, b.title, b.message, b.segment, b.recipient_count, b.created_at FROM notification_broadcasts b LEFT JOIN admins a ON a.id = b.admin_id ORDER BY b.id DESC LIMIT 50');
    res.json({ success: true, broadcasts: rows });
  } catch (e) { res.status(500).json({ success: false, error: 'Could not load broadcasts' }); }
});

module.exports = router;
