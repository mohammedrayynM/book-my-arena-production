const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');

// Helper for location distance (Haversine)
function getDistanceSql(lat, lng) {
  return `(6371 * acos(cos(radians(${lat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${lng})) + sin(radians(${lat})) * sin(radians(latitude))))`;
}

// 1. Create/Update player availability
router.post('/create', verifyToken, async (req, res) => {
  try {
    const {
      sport_type,
      turf_id,
      preferred_location,
      availability_start,
      availability_end,
      availability_date,
      role,
      skill_level,
    } = req.body;

    const user_id = req.user?.id;
    if (!user_id) {
      return res.status(401).json({ error: 'Login required' });
    }
    if (!sport_type || !availability_start || !availability_end || !availability_date) {
      return res.status(400).json({ error: 'sport_type, availability_date, availability_start, availability_end are required' });
    }

    // First, cancel any existing active availability for this user on this date
    await pool.query(
      `UPDATE player_availability SET status = 'cancelled' 
       WHERE user_id = ? AND availability_date = ? AND status = 'active'`,
      [user_id, availability_date]
    );

    // Create new availability entry
    const [result] = await pool.query(
      `INSERT INTO player_availability (
        user_id, sport_type, turf_id, preferred_location, availability_start, 
        availability_end, availability_date, role, skill_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user_id,
        String(sport_type).toLowerCase(),
        turf_id || null,
        preferred_location || null,
        availability_start,
        availability_end,
        availability_date,
        role || null,
        skill_level || 'all'
      ]
    );

    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark availability' });
  }
});

// 2. Get nearby available players
router.get('/nearby', async (req, res) => {
  try {
    // Keep statuses accurate even if cron/cleanup isn't running.
    await pool.query(`
      UPDATE player_availability 
      SET status = 'expired'
      WHERE status = 'active' 
      AND (
        availability_date < CURDATE() 
        OR (availability_date = CURDATE() AND availability_end < CURTIME())
      )
    `);

    const {
      lat,
      lng,
      sport,
      radius = 50,
      date,
      page = 1,
      limit = 10
    } = req.query;
    const offset = (page - 1) * limit;
    const distanceSql = getDistanceSql(lat || 0, lng || 0);

    let query = `
      SELECT pa.*, u.name as user_name, u.karma_points, u.profile_pic,
      t.name as turf_name, t.latitude, t.longitude,
      ${distanceSql} AS distance
      FROM player_availability pa
      JOIN users u ON pa.user_id = u.id
      LEFT JOIN turfs t ON pa.turf_id = t.id
      WHERE pa.status = 'active'
      AND DATE(pa.availability_date) = DATE(?)
      AND (
        pa.availability_date > CURDATE()
        OR (pa.availability_date = CURDATE() AND pa.availability_end > CURTIME())
      )
    `;
    const params = [date || new Date().toISOString().split('T')[0]];

    if (lat && lng) {
      query += ` AND (t.latitude IS NULL OR t.longitude IS NULL OR ${distanceSql} <= ?)`;
      params.push(radius);
    }

    if (sport && sport !== 'All') {
      query += ` AND LOWER(pa.sport_type) = ?`;
      params.push(String(sport).toLowerCase());
    }

    query += ` ORDER BY distance ASC, pa.availability_start ASC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const [players] = await pool.query(query, params);
    res.json({ players });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch available players' });
  }
});

// 3. Get user's availability history
router.get('/user/:user_id', verifyToken, async (req, res) => {
  try {
    const requestedUserId = parseInt(req.params.user_id);
    const authedUserId = parseInt(req.user?.id);
    if (!authedUserId) return res.status(401).json({ error: 'Login required' });
    if (requestedUserId !== authedUserId) return res.status(403).json({ error: 'Not authorized' });

    const [availability] = await pool.query(`
      SELECT pa.*, t.name as turf_name
      FROM player_availability pa
      LEFT JOIN turfs t ON pa.turf_id = t.id
      WHERE pa.user_id = ?
      ORDER BY pa.availability_date DESC, pa.availability_start DESC
      LIMIT 20
    `, [req.params.user_id]);

    res.json({ availability });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch availability history' });
  }
});

// 4. Cancel availability
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const user_id = req.user?.id;
    if (!user_id) return res.status(401).json({ error: 'Login required' });

    // Verify ownership
    const [[avail]] = await pool.query('SELECT user_id FROM player_availability WHERE id = ?', [req.params.id]);
    if (!avail) return res.status(404).json({ error: 'Availability not found' });
    if (avail.user_id !== parseInt(user_id)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await pool.query('UPDATE player_availability SET status = ? WHERE id = ?', ['cancelled', req.params.id]);
    res.json({ success: true, message: 'Availability cancelled' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel availability' });
  }
});

// 5. Auto-expire expired availability
router.post('/cleanup', async (req, res) => {
  try {
    const [result] = await pool.query(`
      UPDATE player_availability 
      SET status = 'expired'
      WHERE status = 'active' 
      AND (
        availability_date < CURDATE() 
        OR (availability_date = CURDATE() AND availability_end < CURTIME())
      )
    `);

    res.json({ success: true, expired: result.affectedRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

// 6. Invite available player to a match
router.post('/invite', async (req, res) => {
  try {
    const { match_id, availability_id, host_id } = req.body;

    // Verify host ownership of match
    const [[match]] = await pool.query('SELECT host_id FROM player_requests WHERE id = ?', [match_id]);
    if (!match || match.host_id !== host_id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Create invite
    const [result] = await pool.query(
      `INSERT INTO player_invites (match_id, availability_id, status) VALUES (?, ?, 'pending')`,
      [match_id, availability_id]
    );

    // Fetch details for real-time SSE notification
    try {
      const [[details]] = await pool.query(
        `SELECT pr.id as match_id, pr.share_token, pr.sport_type, pr.match_date, pr.match_time, pr.booking_time_slot,
                t.name as turf_name,
                host.name as host_name,
                pa.user_id as player_user_id
         FROM player_requests pr
         JOIN users host ON pr.host_id = host.id
         JOIN player_availability pa ON pa.id = ?
         LEFT JOIN turfs t ON pr.turf_id = t.id
         WHERE pr.id = ?`,
        [availability_id, match_id]
      );

      if (details) {
        const { broadcastSse } = require('../utils/realtime');
        broadcastSse('player_invited', {
          player_user_id: details.player_user_id,
          host_name: details.host_name,
          sport_type: details.sport_type,
          turf_name: details.turf_name,
          match_date: details.match_date,
          match_time: details.match_time,
          booking_time_slot: details.booking_time_slot,
          share_token: details.share_token,
          match_id: details.match_id
        });
      }
    } catch (sseErr) {
      console.error('Failed to broadcast invite SSE:', sseErr.message);
    }

    res.json({ success: true, invite_id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// 7. Get invites for a player (by user_id via join to availability)
router.get('/invites/user/:user_id', async (req, res) => {
  try {
    const [invites] = await pool.query(`
      SELECT pi.*, pr.sport_type, pr.match_date, pr.match_time, pr.turf_id, pr.host_id, pa.user_id as player_user_id, pa.role as player_role, u.name as host_name, t.name as turf_name
      FROM player_invites pi
      JOIN player_availability pa ON pi.availability_id = pa.id
      JOIN player_requests pr ON pi.match_id = pr.id
      JOIN users u ON pr.host_id = u.id
      LEFT JOIN turfs t ON pr.turf_id = t.id
      WHERE pa.user_id = ?
      ORDER BY pi.created_at DESC
    `, [req.params.user_id]);

    res.json({ invites });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invites' });
  }
});

// 8. Player responds to invite (accept/decline)
router.put('/invites/:id/respond', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { status, user_id } = req.body; // status: 'accepted'|'declined'
    await conn.beginTransaction();

    const [[invite]] = await conn.query('SELECT * FROM player_invites WHERE id = ?', [req.params.id]);
    if (!invite) {
      await conn.release();
      return res.status(404).json({ error: 'Invite not found' });
    }

    // Verify ownership of availability
    const [[availability]] = await conn.query('SELECT * FROM player_availability WHERE id = ?', [invite.availability_id]);
    if (!availability || availability.user_id !== parseInt(user_id)) {
      await conn.release();
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (status === 'accepted') {
      // Insert into match_players and update filled_slots on match
      const [insert] = await conn.query(
        `INSERT INTO match_players (match_id, user_id, role, payment_type, payment_status, status, joined_at) VALUES (?, ?, ?, 'advance', 'pending', 'pending', NOW())`,
        [invite.match_id, availability.user_id, availability.role || null]
      );

      await conn.query('UPDATE player_requests SET filled_slots = filled_slots + 1 WHERE id = ?', [invite.match_id]);
      await conn.query('UPDATE player_invites SET status = ? WHERE id = ?', ['accepted', req.params.id]);

      await conn.commit();
      await conn.release();
      return res.json({ success: true, player_join_id: insert.insertId });
    } else {
      await conn.query('UPDATE player_invites SET status = ? WHERE id = ?', ['declined', req.params.id]);
      await conn.commit();
      await conn.release();
      return res.json({ success: true });
    }
  } catch (err) {
    await conn.rollback();
    await conn.release();
    console.error(err);
    res.status(500).json({ error: 'Failed to respond to invite' });
  }
});

module.exports = router;
