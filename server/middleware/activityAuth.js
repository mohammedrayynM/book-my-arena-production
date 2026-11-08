// Auth for the Activities ticket-scanning surface only. A staff JWT (role 'activity_staff') is accepted ONLY by the
// scan / manual-lookup / today's-entries routes — nothing else, so staff can never reach price, payout, activity, or
// owner-profile endpoints no matter what they send; those all require the real `verifyOwner` (owner role) middleware.
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';

// Accepts either a normal owner token, or an activity-staff token — and always resolves to a concrete ownerId,
// never one supplied by the request body.
async function verifyOwnerOrStaff(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Access denied. No token provided.' });
  let decoded;
  try { decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
  catch (e) { return res.status(401).json({ error: 'Invalid or expired token.' }); }

  if (decoded.role === 'owner') {
    req.ownerId = decoded.id;
    req.staffId = null;
    req.staffRole = 'OWNER';
    return next();
  }
  if (decoded.type === 'activity_staff') {
    const [[staff]] = await pool.query('SELECT id, owner_id, role, is_active FROM activity_staff WHERE id = ?', [decoded.staffId]);
    if (!staff || !staff.is_active || staff.owner_id !== decoded.ownerId) return res.status(401).json({ error: 'Invalid or expired token.' });
    req.ownerId = staff.owner_id;
    req.staffId = staff.id;
    req.staffRole = staff.role;
    return next();
  }
  return res.status(403).json({ error: 'Not authorized' });
}

module.exports = { verifyOwnerOrStaff };
