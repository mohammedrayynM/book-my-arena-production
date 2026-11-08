// /api/activity-staff — public login for an owner's scoped entry-staff accounts (see migrate_activities.js
// `activity_staff`). The resulting token is only ever accepted by the scan/manual-lookup routes in
// routes/owner-activities.js (middleware/activityAuth.js) — nowhere else.
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { rateLimit } = require('../middleware/rateLimit');
const loginLimiter = rateLimit({ windowMs: 60000, max: 10, keyFn: (req) => `${req.ip}:${String((req.body && req.body.email) || '').toLowerCase()}`, message: 'Too many sign-in attempts. Wait a minute.' });
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password are required' });
    // the same email may exist under two different owners (unique per owner), so match the password, not just the email
    const [candidates] = await pool.query('SELECT * FROM activity_staff WHERE email = ? AND is_active = true', [String(email).toLowerCase().trim()]);
    let staff = null;
    for (const c of candidates) { if (await bcrypt.compare(password, c.password_hash)) { staff = c; break; } }
    if (!staff) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    const token = jwt.sign({ type: 'activity_staff', staffId: staff.id, ownerId: staff.owner_id, role: staff.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, token, staff: { id: staff.id, name: staff.name, role: staff.role } });
  } catch (e) { res.status(500).json({ success: false, error: 'Login failed' }); }
});

module.exports = router;
