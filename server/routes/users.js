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

// Google Login
router.post('/google-login', async (req, res) => {
    try {
        const { idToken } = req.body;
        console.log('--- Google Login Request ---');
        console.log('Token received:', idToken ? 'Yes (length: ' + idToken.length + ')' : 'No');
        console.log('Client ID used:', process.env.GOOGLE_CLIENT_ID);

        if (!idToken) return res.status(400).json({ error: 'ID Token required' });

        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        console.log('Google Payload:', payload.email);
        const { sub: googleId, email, name, picture } = payload;

        // Check if user exists
        let [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        let user;

        if (users.length === 0) {
            // Create user
            const [result] = await pool.query(
                'INSERT INTO users (name, email, google_id, profile_pic) VALUES (?, ?, ?, ?)',
                [name, email, googleId, picture]
            );
            user = { id: result.insertId, name, email };
        } else {
            user = users[0];
            // Update google_id if not present
            if (!user.google_id) {
                await pool.query('UPDATE users SET google_id = ? WHERE id = ?', [googleId, user.id]);
            }
        }

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ 
            success: true, 
            user: { id: user.id, name: user.name, email: user.email, profile_pic: picture || user.profile_pic }, 
            token 
        });
    } catch (error) {
        console.error('Google Login error:', error);
        res.status(500).json({ error: 'Google authentication failed' });
    }
});

// Profile / Bookings
router.get('/me', verifyToken, async (req, res) => {
    try {
        const [users] = await pool.query('SELECT id, name, email, created_at FROM users WHERE id = ?', [req.userId]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found' });
        
        const [bookings] = await pool.query(`
            SELECT b.*, t.name as turf_name 
            FROM bookings b 
            JOIN turfs t ON b.turf_id = t.id 
            WHERE b.user_id = ? 
            ORDER BY b.created_at DESC
        `, [req.userId]);

        res.json({ success: true, user: users[0], bookings });
    } catch (error) {
        console.error('Fetch profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
