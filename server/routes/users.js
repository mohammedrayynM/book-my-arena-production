const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';

// Middleware to verify user
const verifyToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(403).json({ error: 'No token provided' });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Unauthorized' });
        req.userId = decoded.id;
        next();
    });
};

// Register
router.post('/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

        const [existing] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (existing.length > 0) return res.status(409).json({ error: 'Email already in use' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await pool.query(
            'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
            [name, email, hashedPassword]
        );

        const token = jwt.sign({ id: result.insertId, email }, JWT_SECRET, { expiresIn: '7d' });
        res.status(201).json({ success: true, user: { id: result.insertId, name, email }, token });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, user: { id: user.id, name: user.name, email: user.email }, token });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Google Login. Gated by the admin switch (Authentication Settings), enforced here, not just hidden in the app.
// The ID token is verified against Google (signature, expiry, audience = our client id); an unverified email is refused.
// This route only ever touches the `users` table, so a Google identity can never become an admin or owner session.
router.post('/google-login', async (req, res) => {
    try {
        const { getAuthSettings } = require('../services/authSettings');
        const settings = await getAuthSettings();
        if (!settings.googleEnabled) return res.status(403).json({ error: 'Google sign-in is currently disabled', code: 'GOOGLE_DISABLED' });
        if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google sign-in is not configured', code: 'GOOGLE_NOT_CONFIGURED' });

        const { idToken } = req.body || {};
        if (!idToken || typeof idToken !== 'string' || idToken.length > 4096) return res.status(400).json({ error: 'ID Token required' });

        let payload;
        try {
            const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
            payload = ticket.getPayload();
        } catch (e) {
            return res.status(401).json({ error: 'Google sign-in could not be verified', code: 'GOOGLE_TOKEN_INVALID' });
        }
        if (!payload || !payload.email || payload.email_verified === false) {
            return res.status(401).json({ error: 'Your Google email is not verified', code: 'GOOGLE_EMAIL_UNVERIFIED' });
        }
        const { sub: googleId, name, picture } = payload;
        const email = String(payload.email).trim().toLowerCase();

        let [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        let user;
        if (users.length === 0) {
            const [result] = await pool.query(
                'INSERT INTO users (name, email, google_id, profile_pic) VALUES (?, ?, ?, ?)',
                [name || email.split('@')[0], email, googleId, picture || null]
            );
            user = { id: result.insertId, name: name || email.split('@')[0], email };
        } else {
            user = users[0];
            if (user.google_id && user.google_id !== googleId) {
                return res.status(409).json({ error: 'This email is linked to a different Google account', code: 'GOOGLE_ACCOUNT_CONFLICT' });
            }
            if (!user.google_id) await pool.query('UPDATE users SET google_id = ? WHERE id = ?', [googleId, user.id]);
        }

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({
            success: true,
            user: { id: user.id, name: user.name, email: user.email, profile_pic: picture || user.profile_pic },
            token
        });
    } catch (error) {
        console.error('Google Login error:', error.message);
        res.status(500).json({ error: 'Google authentication failed' });
    }
});

// Profile / Bookings
router.get('/me', verifyToken, async (req, res) => {
    try {
        const [userColumns] = await pool.query('SHOW COLUMNS FROM users');
        const hasPhone = userColumns.some((column) => column.Field === 'phone');
        const profileFields = ['id', 'name', 'email', ...(hasPhone ? ['phone'] : []), 'profile_pic', 'created_at'];
        const [users] = await pool.query(`SELECT ${profileFields.join(', ')} FROM users WHERE id = ?`, [req.userId]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found' });

        let bookings = [];
        let matchReceipts = [];
        // optional pagination (?page=1&limit=20). Without them the response is exactly what older app/web builds expect.
        const paged = req.query.limit !== undefined;
        const pageLimit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageOffset = (pageNum - 1) * pageLimit;
        try {
            const [rows] = await pool.query(`
                SELECT b.*, t.name as turf_name, t.sport_type as sport_type, c.name as court_name
                FROM bookings b 
                JOIN turfs t ON b.turf_id = t.id
                LEFT JOIN courts c ON b.court_id = c.id
                WHERE b.user_id = ? 
                ORDER BY b.created_at DESC, b.id DESC
                ${paged ? 'LIMIT ? OFFSET ?' : ''}
            `, paged ? [req.userId, pageLimit + 1, pageOffset] : [req.userId]);
            bookings = rows;
        } catch (bookingError) {
            const [rows] = await pool.query(`
                SELECT b.*, t.name as turf_name, t.sport_type as sport_type
                FROM bookings b 
                JOIN turfs t ON b.turf_id = t.id 
                WHERE b.user_id = ? 
                ORDER BY b.created_at DESC, b.id DESC
                ${paged ? 'LIMIT ? OFFSET ?' : ''}
            `, paged ? [req.userId, pageLimit + 1, pageOffset] : [req.userId]);
            bookings = rows;
        }

        // mysql2 hands DATE columns back as JS Dates built in the server's timezone; serialised to JSON they become UTC and can land
        // on the previous calendar day. The app needs the calendar date itself, so send it as YYYY-MM-DD.
        const ymd = (v) => { if (!(v instanceof Date) || isNaN(v)) return v; return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`; };
        let hasMore = false;
        if (paged && bookings.length > pageLimit) { hasMore = true; bookings = bookings.slice(0, pageLimit); }
        bookings = bookings.map((b) => ({ ...b, booking_date: ymd(b.booking_date) }));

        // Refund info per booking (best effort: the refunds table only exists once a refund was ever made)
        try {
            const ids = bookings.map((b) => b.id);
            if (ids.length) {
                const [refunds] = await pool.query(
                    `SELECT booking_id, refund_status, refund_amount_minor, refund_code, created_at FROM refunds WHERE booking_type = 'turf' AND booking_id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC`, ids);
                const byBooking = new Map();
                for (const r of refunds) if (!byBooking.has(r.booking_id)) byBooking.set(r.booking_id, r);
                bookings = bookings.map((b) => { const r = byBooking.get(b.id); return r ? { ...b, refund: { status: r.refund_status, amount: Number(r.refund_amount_minor || 0) / 100, reference: r.refund_code, at: r.created_at } } : b; });
            }
        } catch (refundErr) { /* no refunds table yet: bookings simply carry no refund info */ }

        // Match join receipts (Find Players payments)
        try {
            const [rows] = await pool.query(`
                SELECT
                  mp.id as match_player_id,
                  mp.match_id,
                  mp.amount_paid,
                  mp.payment_type,
                  mp.payment_status,
                  mp.joined_at,
                  mp.razorpay_payment_id,
                  pr.share_token,
                  pr.sport_type,
                  pr.match_date,
                  pr.match_time,
                  pr.booking_time_slot,
                  pr.contact_phone as host_contact_phone,
                  t.name as turf_name,
                  t.address as turf_address,
                  c.name as court_name,
                  host.name as host_name
                FROM match_players mp
                JOIN player_requests pr ON mp.match_id = pr.id
                JOIN turfs t ON pr.turf_id = t.id
                LEFT JOIN courts c ON pr.court_id = c.id
                JOIN users host ON pr.host_id = host.id
                WHERE mp.user_id = ?
                  AND mp.payment_status = 'paid'
                ORDER BY mp.joined_at DESC
                LIMIT 50
            `, [req.userId]);
            matchReceipts = rows;
        } catch (matchReceiptErr) {
            // If Find Players tables aren't present yet, don't fail the whole profile.
            matchReceipts = [];
        }

        res.json({ success: true, user: users[0], bookings, matchReceipts, ...(paged ? { pagination: { page: pageNum, limit: pageLimit, has_more: hasMore } } : {}) });
    } catch (error) {
        console.error('Fetch profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete my account. The profile is anonymised and sign-in is removed; booking/payment records are kept (tax, accounting and
// dispute handling) without a usable link to a login. Refused while the customer still has upcoming confirmed bookings, so a
// paid slot is never orphaned: cancel them first (or contact support).
router.delete('/me', verifyToken, async (req, res) => {
    try {
        if (String(req.body?.confirm || '').toUpperCase() !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm account deletion.' });
        const [[u]] = await pool.query('SELECT id FROM users WHERE id = ?', [req.userId]);
        if (!u) return res.status(404).json({ error: 'Account not found' });
        const [[up]] = await pool.query("SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = 'confirmed' AND booking_date >= CURDATE()", [req.userId]);
        if (Number(up.n) > 0) return res.status(409).json({ code: 'UPCOMING_BOOKINGS', error: `You have ${up.n} upcoming booking${up.n > 1 ? 's' : ''}. Cancel ${up.n > 1 ? 'them' : 'it'} (if the cancellation window allows) or contact support before deleting your account.` });
        const anon = `deleted-${req.userId}-${Date.now()}@deleted.invalid`;
        await pool.query("UPDATE users SET name = 'Deleted user', email = ?, password_hash = NULL, google_id = NULL, profile_pic = NULL, push_token = NULL WHERE id = ?", [anon, req.userId]);
        for (const col of ['phone', 'mobile', 'phone_number']) { try { await pool.query(`UPDATE users SET ${col} = NULL WHERE id = ?`, [req.userId]); } catch (e) { /* column not present */ } }
        res.json({ success: true, message: 'Your account has been deleted.' });
    } catch (error) {
        console.error('Delete account error:', error);
        res.status(500).json({ error: 'Could not delete the account. Please contact support.' });
    }
});

// Save / update Expo Push Token
router.post('/push-token', verifyToken, async (req, res) => {
    try {
        const { push_token } = req.body;
        if (!push_token) return res.status(400).json({ error: 'push_token required' });

        await pool.query(
            'UPDATE users SET push_token = ? WHERE id = ?',
            [push_token, req.userId]
        ).catch(err => console.error('push-token save failed:', err.message));
        // devices live in user_push_tokens now (many per person, deliveries tracked); this route stays for older app builds
        await require('../utils/notifications/service').registerDevice({ type: 'user', id: req.userId }, { token: push_token, platform: req.body.platform, deviceId: req.body.device_id, appVersion: req.body.app_version })
            .catch(err => console.error('push-token register failed:', err.message));

        res.json({ success: true });
    } catch (error) {
        console.error('Save push token error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

