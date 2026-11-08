const jwt = require('jsonwebtoken');
require('dotenv').config();

// IMPORTANT:
// Some routes (e.g. /routes/users.js) sign tokens using a fallback secret when
// JWT_SECRET is not set. Keep the middleware consistent so user auth doesn't
// randomly fail in dev / misconfigured environments.
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  // The fallback above is public (it is in the repository): anyone could mint an admin token with it.
  console.error('🚨 SECURITY: JWT_SECRET is not set in production. Tokens are signed with a publicly known default. Set JWT_SECRET to a long random value NOW.');
}

// Verify JWT token middleware
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    // 401 = "not authenticated" (bad/expired token). 403 is reserved for "authenticated but not allowed",
    // which clients must be able to tell apart so they only end the session on a real auth failure.
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
};

const verifyCustomer = (req, res, next) => {
  verifyToken(req, res, () => {
    if (req.user.role) {
      return res.status(403).json({ error: 'Customer account required.' });
    }
    next();
  });
};

// Like verifyToken, but never rejects the request: a missing/invalid token just leaves req.user unset. For routes that
// serve both guests and signed-in accounts (e.g. a guest checkout receipt) and decide access themselves.
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    } catch (err) { /* not authenticated; the route falls back to its unauthenticated rules */ }
  }
  next();
};

// Verify Admin role
const verifyAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

// Verify Owner role
const verifyOwner = (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required.' });
  }
  next();
};

// Generate JWT token
const generateToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
};

module.exports = { verifyToken, verifyCustomer, optionalAuth, verifyAdmin, verifyOwner, generateToken };
