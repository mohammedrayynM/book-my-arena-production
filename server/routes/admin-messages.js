const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const { verifyToken, verifyAdmin } = require('../middleware/auth');
const { addSseClient } = require('../utils/messagesRealtime');

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';

function verifyAdminFromQuery(req, res, next) {
  try {
    const raw = String(req.query?.token || '').trim();
    if (!raw) return res.status(401).json({ error: 'Access denied. No token provided.' });
    const decoded = jwt.verify(raw, JWT_SECRET);
    if (decoded?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }
}

// GET /api/admin/messages/events?token=... — Admin SSE stream (no refresh needed)
router.get('/events', verifyAdminFromQuery, (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  addSseClient(res);
  try { res.flushHeaders && res.flushHeaders(); } catch {}
  try { res.write(':ok\n\n'); } catch {}
});

// GET /api/admin/messages — List inbox messages (newest first)
router.get('/', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, email, message, is_read, created_at
       FROM contact_messages
       ORDER BY created_at DESC`
    );
    res.json({ messages: rows });
  } catch (err) {
    console.error('Admin messages fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// PUT /api/admin/messages/:id/read — Mark read/unread
router.put('/:id/read', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid message id' });
    const isRead = req.body?.is_read ? 1 : 0;

    await pool.query('UPDATE contact_messages SET is_read = ? WHERE id = ?', [isRead, id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin message update failed:', err);
    res.status(500).json({ error: 'Failed to update message status' });
  }
});

module.exports = router;

