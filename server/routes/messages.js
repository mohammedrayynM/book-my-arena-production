const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { broadcastSse } = require('../utils/messagesRealtime');

// POST /api/messages — Public "Contact Us" submission
router.post('/', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim();
    const message = String(req.body?.message || '').trim();

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required' });
    }

    // Basic email sanity check (keep it permissive)
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }

    const [result] = await pool.query(
      `INSERT INTO contact_messages (name, email, message, is_read)
       VALUES (?, ?, ?, 0)`,
      [name, email, message]
    );

    const [[row]] = await pool.query(
      'SELECT id, name, email, message, is_read, created_at FROM contact_messages WHERE id = ?',
      [result.insertId]
    );

    // Realtime notify admin inbox listeners
    broadcastSse('contact_message_created', { message: row });

    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error('Contact message insert failed:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;

