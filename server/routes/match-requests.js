const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { sendEmail } = require('../utils/email');
const { verifyToken, optionalAuth } = require('../middleware/auth');
const matchJoin = require('../services/matchJoin');
const { inviteUrl } = require('../services/publicUrl');
const routeProvider = require('../services/routeProvider');
const { toMinor } = require('../utils/money');
const { addSseClient, broadcastSse } = require('../utils/realtime');
const { fire: fireNotification } = require('../utils/notifications/events');
const Razorpay = require('razorpay');
const crypto = require('crypto');
require('dotenv').config();

// Avoid crashing the whole server if Razorpay env is not configured.
// Routes that need payments will return a clean error instead.
let razorpay = null;
try {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
  }
} catch (e) {
  console.error('⚠️ Razorpay init failed:', e?.message || e);
  razorpay = null;
}

// a spot is held for a few minutes while the player is paying; it just stops counting when it expires
const RESERVE_SQL = `DATE_ADD(NOW(), INTERVAL ${matchJoin.RESERVATION_MINUTES} MINUTE)`;

// Helper for location distance (Haversine)
function getDistanceSql(lat, lng, tableAlias = 'r') {
  const latNum = Number(lat) || 0;
  const lngNum = Number(lng) || 0;
  // IMPORTANT: qualify columns so joins (turfs/users) don't break with ambiguous latitude/longitude.
  return `(6371 * acos(cos(radians(${latNum})) * cos(radians(${tableAlias}.latitude)) * cos(radians(${tableAlias}.longitude) - radians(${lngNum})) + sin(radians(${latNum})) * sin(radians(${tableAlias}.latitude))))`;
}

function parseTimeToSql(timeStr) {
  // Accepts: "6:00 AM", "18:00", "6 AM", "06:00"
  const s = String(timeStr || '').trim();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return null;

  let h = parseInt(m[1], 10);
  const mm = parseInt(m[2] || '0', 10);
  const mod = (m[3] || '').toUpperCase();

  if (mod === 'PM' && h !== 12) h += 12;
  if (mod === 'AM' && h === 12) h = 0;

  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
}

function extractStartTimeFromSlot(slot) {
  // Example slot: "6:00 AM - 7:00 AM" or "18:00 - 19:00"
  const [start] = String(slot || '').split('-').map(s => s.trim());
  return parseTimeToSql(start);
}

async function getContributionTotal(matchId) {
  try {
    const [[row]] = await pool.query(
      `SELECT COALESCE(SUM(amount_paid), 0) AS total
       FROM match_players
       WHERE match_id = ? AND payment_status = 'paid'`,
      [matchId]
    );
    return parseFloat(row?.total || 0);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// REALTIME (SSE)
// ---------------------------------------------------------------------------
router.get('/events', (req, res) => {
  // SSE headers
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Nginx/Cloudflare buffering off (harmless if not present)
  res.setHeader('X-Accel-Buffering', 'no');

  addSseClient(res);

  // Ensure headers/body are flushed immediately (some proxies/balancers buffer otherwise).
  try { res.flushHeaders && res.flushHeaders(); } catch { }
  try { res.write(':ok\n\n'); } catch { }
});

async function fetchMatchWithJoins(matchId) {
  const [rows] = await pool.query(
    `
    SELECT r.*, t.name as turf_name, t.location as turf_location, t.address as turf_address, t.images as turf_images,
    u.name as host_name, u.karma_points as host_karma
    FROM player_requests r
    JOIN turfs t ON r.turf_id = t.id
    JOIN users u ON r.host_id = u.id
    WHERE r.id = ?
    `,
    [matchId]
  );
  return rows?.[0] || null;
}

async function broadcastMatchCreated(matchId) {
  try {
    const match = await fetchMatchWithJoins(matchId);
    if (!match) return;
    broadcastSse('match_request_created', { match });
  } catch { }
}

async function broadcastMatchUpdated(matchId) {
  try {
    const [[match]] = await pool.query(
      'SELECT id, filled_slots, total_slots, status, contribution_amount, booking_total_amount, share_token, turf_id, match_date, match_time FROM player_requests WHERE id = ?',
      [matchId]
    );
    if (!match) return;
    const contribution_total = await getContributionTotal(matchId);
    broadcastSse('match_request_updated', { match, contribution_total });
  } catch { }
}

async function sendNearbyMatchEmails({ host_id, turf_id, sport_type, share_token, booking_time_slot, match_date, match_time, players_needed, contribution_amount }) {
  // Selection is "best-effort" based on currently available DB fields.
  // Criteria used:
  // - users who booked before (bookings.user_id)
  // - users who played same sport before (bookings + turfs.sport_type)
  // - users who booked in same location previously (turfs.location string match)
  // - users active recently (booking created recently OR recently registered)
  try {
    const [[turf]] = await pool.query('SELECT name, location, address FROM turfs WHERE id = ?', [turf_id]);
    const turfLocation = String(turf?.location || '').trim();

    const [recipients] = await pool.query(
      `
      SELECT DISTINCT u.id, u.email, u.name
      FROM users u
      LEFT JOIN bookings b
        ON b.user_id = u.id AND b.payment_status = 'success'
      LEFT JOIN turfs bt
        ON bt.id = b.turf_id
      WHERE u.id != ?
        AND u.email IS NOT NULL
        AND (
          b.id IS NOT NULL
          OR (bt.id IS NOT NULL AND LOWER(bt.sport_type) = ?)
          OR (bt.id IS NOT NULL AND ? <> '' AND LOWER(bt.location) LIKE CONCAT('%', LOWER(?), '%'))
          OR (b.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY))
          OR (u.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY))
        )
      LIMIT 200
      `,
      [host_id, String(sport_type || '').toLowerCase(), turfLocation, turfLocation]
    );

    if (!recipients || recipients.length === 0) return;

    const joinUrl = inviteUrl(share_token);

    const subject = `🔥 Someone nearby needs players — ${String(sport_type || '').toUpperCase()} at ${turf?.name || 'a venue'}`;
    const whenLine = booking_time_slot ? `Time: ${booking_time_slot}` : `Time: ${String(match_time || '').slice(0, 5)}`;
    const playersLine = players_needed ? `Players needed: ${players_needed}` : '';
    const priceLine = contribution_amount ? `Price per player: ₹${contribution_amount}` : '';

    for (const user of recipients) {
      const text =
        `Hi ${user.name || ''},\n\n` +
        `Someone nearby needs players for a match.\n\n` +
        `Sport: ${sport_type}\n` +
        `Venue: ${turf?.name || ''}\n` +
        `Date: ${match_date}\n` +
        `${whenLine}\n` +
        `${playersLine}\n` +
        `${priceLine}\n\n` +
        `Join here: ${joinUrl}\n\n` +
        `— BookArena`;

      // sendEmail(toEmail, subject, text, html?)
      await sendEmail(user.email, subject, text, undefined, { suppressAdminRecipients: true });
    }
  } catch (e) {
    console.error('sendNearbyMatchEmails error:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// BOOKING → MATCH REQUEST (Need Players for This Slot)
// ---------------------------------------------------------------------------

// Create match request linked to a booking slot (host must be logged in)
router.post('/create-from-booking', verifyToken, async (req, res) => {
  try {
    const {
      turf_id,
      court_id,
      sport_type,
      match_type,
      match_date,
      booking_time_slot,
      players_needed,
      roles_needed,
      skill_level,
      contact_phone,
      contribution_amount,
      booking_total_amount,
      note,
      latitude,
      longitude,
      visibility_radius
    } = req.body || {};

    const host_id = req.user?.id;
    if (!host_id) return res.status(401).json({ error: 'Login required' });

    if (!turf_id || !sport_type || !match_date || !booking_time_slot) {
      return res.status(400).json({ error: 'turf_id, sport_type, match_date, booking_time_slot are required' });
    }

    const needed = Math.max(1, parseInt(players_needed, 10) || 1);
    const total_slots = needed + 1; // include host
    const filled_slots = 1;

    const match_time = extractStartTimeFromSlot(booking_time_slot);
    if (!match_time) {
      return res.status(400).json({ error: 'Invalid booking_time_slot format' });
    }

    const share_token = crypto.randomBytes(16).toString('hex');

    // Ensure we always store coordinates for nearby search.
    // If the client didn't send them, fall back to the turf coordinates.
    let latVal = latitude ?? null;
    let lngVal = longitude ?? null;
    if ((latVal === null || lngVal === null) && turf_id) {
      try {
        const [[turf]] = await pool.query('SELECT latitude, longitude FROM turfs WHERE id = ?', [turf_id]);
        if (turf) {
          if (latVal === null) latVal = turf.latitude ?? null;
          if (lngVal === null) lngVal = turf.longitude ?? null;
        }
      } catch { }
    }

    const [result] = await pool.query(
      `INSERT INTO player_requests (
        host_id, turf_id, court_id, sport_type, match_type, match_date, match_time,
        total_slots, filled_slots, roles_needed, skill_level,
        advance_amount, split_amount, visibility_radius, latitude, longitude,
        share_token, booking_time_slot, contact_phone, contribution_amount, booking_total_amount, note, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      [
        host_id,
        turf_id,
        court_id || null,
        String(sport_type).toLowerCase(),
        String(match_type || 'friendly').toLowerCase(),
        match_date,
        match_time,
        total_slots,
        filled_slots,
        JSON.stringify(Array.isArray(roles_needed) ? roles_needed : []),
        String(skill_level || 'all').toLowerCase(),
        0,
        0,
        parseInt(visibility_radius || 25, 10),
        latVal,
        lngVal,
        share_token,
        String(booking_time_slot),
        contact_phone || null,
        parseFloat(contribution_amount || 0),
        parseFloat(booking_total_amount || 0),
        note || null
      ]
    );

    // Realtime popup + live list updates
    broadcastMatchCreated(result.insertId).catch(() => { });
    fireNotification('find_players.match_created', { matchRequestId: result.insertId });

    // Email nearby users (best-effort filtering)
    sendNearbyMatchEmails({
      host_id,
      turf_id,
      sport_type,
      share_token,
      booking_time_slot,
      match_date,
      match_time,
      players_needed: needed,
      contribution_amount: parseFloat(contribution_amount || 0)
    }).catch(() => { });

    res.json({ success: true, id: result.insertId, share_token, invite_url: inviteUrl(share_token) });
  } catch (err) {
    console.error('create-from-booking error:', err);
    res.status(500).json({ error: 'Failed to create match request', details: process.env.NODE_ENV !== 'production' ? err.message : undefined });
  }
});

// Public match request (share link). Anyone holding the link sees the match, never private data (no phone numbers / emails / coordinates).
// `invite` is the backend-authoritative view the join screen shows: state, share, remaining spots, amounts, the canonical invite URL.
router.get('/public/:token', optionalAuth, async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return res.status(404).json({ error: 'Match not found' });
    const data = await matchJoin.publicInvite(token, req.user && req.user.id);
    if (!data) return res.status(404).json({ error: 'Match not found' });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch match details' });
  }
});

// Host's "Share with friends" panel: participants + payment status, spots, collected / outstanding, and the one invite URL (for the QR code).
router.get('/:id/host-summary', verifyToken, async (req, res) => {
  try {
    const out = await matchJoin.hostSummary(parseInt(req.params.id, 10), req.user.id);
    res.status(out.status).json(out.status === 200 ? out : { error: out.error });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load participants' }); }
});

// A participant's own receipt (paid) or pending/failed acknowledgement, clearly labelled.
router.get('/receipt/:matchPlayerId', verifyToken, async (req, res) => {
  try {
    const out = await matchJoin.receiptFor(parseInt(req.params.matchPlayerId, 10), req.user.id);
    res.status(out.status).json(out.status === 200 ? out : { error: out.error });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load receipt' }); }
});

// Summary for polling widgets (booking summary / small UIs)
router.get('/:id/summary', async (req, res) => {
  try {
    const matchId = req.params.id;
    const [[match]] = await pool.query(
      'SELECT id, total_slots, filled_slots, status, contribution_amount, booking_total_amount FROM player_requests WHERE id = ?',
      [matchId]
    );
    if (!match) return res.status(404).json({ error: 'Match not found' });
    const contribution_total = await getContributionTotal(matchId);
    res.json({ match, contribution_total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch match summary' });
  }
});

// Join + pay (Razorpay) — requires login
router.post('/:id/join/create-order', verifyToken, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const matchId = parseInt(req.params.id, 10);
    const user_id = req.user?.id;
    const { role, payment_option } = req.body || {}; // payment_option: 'full' | 'half'
    if (!user_id) return res.status(401).json({ error: 'Login required' });

    await conn.beginTransaction();

    const [[match]] = await conn.query(
      `SELECT r.*, t.advance_percent, t.timezone AS tz
       FROM player_requests r
       JOIN turfs t ON r.turf_id = t.id
       WHERE r.id = ? 
       FOR UPDATE`,
      [matchId]
    );
    if (!match) {
      await conn.rollback();
      await conn.release();
      return res.status(404).json({ error: 'Match not found' });
    }
    // the backend decides whether this invitation can still take a player (open / full / cancelled / already started / ended)
    const state = matchJoin.sessionState(match, match.tz || 'Asia/Kolkata');
    if (state !== 'open' || match.filled_slots >= match.total_slots) {
      await conn.rollback();
      await conn.release();
      return res.status(state === 'full' || state === 'open' ? 409 : 400).json({ error: matchJoin.STATE_MESSAGE[state === 'open' ? 'full' : state] || 'Sorry, this match is already full or closed.', code: state === 'open' ? 'full' : state });
    }

    if (parseInt(match.host_id, 10) === parseInt(user_id, 10)) {
      await conn.rollback();
      await conn.release();
      return res.status(400).json({ error: 'You are the host of this match.' });
    }

    // someone else is paying for the last spot right now: hold this person back instead of letting two people pay for one spot
    const heldByOthers = await matchJoin.activeReservations(conn, matchId, user_id);
    if (parseInt(match.filled_slots || 0, 10) + heldByOthers >= parseInt(match.total_slots || 0, 10)) {
      await conn.rollback();
      await conn.release();
      return res.status(409).json({ error: `The last spot is being held for another player who is paying right now. Please try again in ${matchJoin.RESERVATION_MINUTES} minutes.`, code: 'spot_held' });
    }

    const baseAmount = Math.max(0, parseFloat(match.contribution_amount || 0));
    // a player always pays their whole share: a partial "advance" would leave the match under-funded while still taking a spot
    const opt = 'full';
    const advancePercent = Number(match.advance_percent ?? 50);
    const amount = opt === 'half'
      ? Math.round((baseAmount * (advancePercent / 100)) * 100) / 100
      : baseAmount;

    if ((!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || !razorpay) && amount > 0) {
      await conn.rollback();
      await conn.release();
      return res.status(500).json({ error: 'Payment gateway not configured' });
    }

    // If user started checkout earlier but didn't pay, allow retry by reusing the row.
    const [[existing]] = await conn.query(
      'SELECT id, payment_status FROM match_players WHERE match_id = ? AND user_id = ? FOR UPDATE',
      [matchId, user_id]
    );

    let matchPlayerId = null;
    if (existing) {
      if (existing.payment_status === 'paid') {
        await conn.rollback();
        await conn.release();
        return res.status(409).json({ error: 'You have already joined this match' });
      }
      matchPlayerId = existing.id;
      await conn.query(
        `UPDATE match_players
         SET role = ?,
             payment_type = ?,
             payment_status = ?,
             status = ?,
             joined_at = NOW(),
             amount_paid = ?,
             reserved_until = ${RESERVE_SQL}
         WHERE id = ?`,
        [role || null, opt === 'half' ? 'advance' : 'split', amount <= 0 ? 'paid' : 'pending', amount <= 0 ? 'approved' : 'pending', amount, matchPlayerId]
      );
    } else {
      const [insert] = await conn.query(
        `INSERT INTO match_players (match_id, user_id, role, payment_type, payment_status, status, joined_at, amount_paid, reserved_until)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ${RESERVE_SQL})`,
        [matchId, user_id, role || null, opt === 'half' ? 'advance' : 'split', amount <= 0 ? 'paid' : 'pending', amount <= 0 ? 'approved' : 'pending', amount]
      );
      matchPlayerId = insert.insertId;
    }

    if (amount <= 0) {
      // Auto-join if no payment is required.
      const nextFilled = parseInt(match.filled_slots || 0, 10) + 1;
      const nextStatus = nextFilled >= parseInt(match.total_slots || 0, 10) ? 'full' : 'open';
      await conn.query(
        'UPDATE player_requests SET filled_slots = ?, status = ? WHERE id = ?',
        [nextFilled, nextStatus, match.id]
      );

      await conn.commit();
      fireNotification('find_players.join_requested', { matchPlayerId });
      await conn.release();
      return res.json({
        success: true,
        match_player_id: matchPlayerId,
        order_id: null,
        skipPayment: true,
        amount
      });
    }

    // a player's contribution is paid in the VENUE's currency, and only where payments are switched on for it
    const [[venueRow]] = await conn.query('SELECT country_code, currency_code FROM turfs WHERE id = ?', [match.turf_id]);
    const matchCurrency = (venueRow && venueRow.currency_code) || 'INR';
    if (!(await require('../services/globalConfig').paymentsEnabledFor((venueRow && venueRow.country_code) || 'IN', matchCurrency))) {
      try { await conn.rollback(); } catch { }
      try { await conn.release(); } catch { }
      return res.status(400).json({ error: `Online payments in ${matchCurrency} are not available for this venue yet.` });
    }
    const order = await razorpay.orders.create({
      amount: require('../utils/money').toMinor(amount, matchCurrency),
      currency: matchCurrency,
      receipt: `match_${matchId}_${Date.now()}`
    });

    await conn.query(
      'UPDATE match_players SET razorpay_order_id = ? WHERE id = ?',
      [order.id, matchPlayerId]
    );

    await conn.commit();
    await conn.release();

    res.json({
      success: true,
      match_player_id: matchPlayerId,
      order_id: order.id,
      amount,
      currency: matchCurrency,
      key_id: process.env.RAZORPAY_KEY_ID,
      reserved_minutes: matchJoin.RESERVATION_MINUTES
    });
  } catch (err) {
    try { await conn.rollback(); } catch { }
    try { await conn.release(); } catch { }
    console.error('join/create-order error:', err);
    res.status(500).json({ error: 'Failed to initiate payment', details: process.env.NODE_ENV !== 'production' ? err.message : undefined });
  }
});

// Shared by the in-app verify (signed-in player) and the hosted-checkout verify (Expo Go / web payment page).
// The signature proves the checkout completed THIS order; the gateway is then asked what it really captured; only then does
// matchJoin.confirmPayment (atomic + idempotent) turn it into a confirmed participant. Returns { http, json, confirmed? }.
async function verifyJoinPayment({ matchPlayerId, orderId, paymentId, signature, userId }) {
  if (!matchPlayerId || !orderId || !paymentId || !signature) return { http: 400, json: { error: 'Missing payment verification fields' } };
  if (!process.env.RAZORPAY_KEY_SECRET) return { http: 500, json: { error: 'Payment gateway not configured' } };
  const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  if (expectedSignature !== signature) return { http: 400, json: { error: 'Invalid payment signature' } };

  // ask the gateway what it actually captured — a client's word is never enough. If Razorpay cannot be reached we continue on the
  // verified signature (the same rule bookings use); a payment the gateway reports as not captured is NOT credited.
  let capturedMinor; let currency;
  try {
    const rp = await routeProvider.fetchPayment(paymentId);
    if (rp.order_id && rp.order_id !== orderId) return { http: 400, json: { error: 'Payment does not belong to this order' } };
    if (rp.status !== 'captured') return { http: 409, json: { pending: true, error: 'Your payment has not been captured yet. You will be added automatically as soon as it is.' } };
    capturedMinor = Number(rp.amount); currency = rp.currency;
  } catch (e) {
    console.warn(`[match-join] could not fetch payment ${paymentId} (${e.message}); continuing on the verified signature`);
  }

  const out = await matchJoin.confirmPayment({ matchPlayerId: parseInt(matchPlayerId, 10), orderId, paymentId, signature, userId: userId || null, capturedMinor, currency, verified: true });
  if (out.error) return { http: out.status || 400, json: { error: out.error } };
  if (out.refunded) {
    return { http: 409, json: { error: `This match is no longer available (${out.state === 'open' ? 'full' : out.state}). Your payment is being refunded to your original payment method.`, refunded: true, code: out.state } };
  }
  const id = Number(matchPlayerId);
  if (out.alreadyPaid) return { http: 200, json: { success: true, alreadyPaid: true, match_player_id: id } };
  return { http: 200, json: { success: true, match_player_id: id, receipt_url: `/match-requests/receipt/${id}` }, confirmed: out, user_id: out.row && out.row.user_id };
}

// Everything that follows a newly confirmed join: realtime update, confirmation e-mails to the player and the host, notification.
async function afterJoinConfirmed({ matchBefore, nextFilled, becameFull, user_id, match_player_id }) {
    // Realtime updates for all online users (match card + host checkout recalculation)
    broadcastMatchUpdated(matchBefore.id).catch(() => { });

    // Email confirmations (player + host)
    try {
      const [[player]] = await pool.query('SELECT email, name FROM users WHERE id = ?', [user_id]);

      let joinedPlayersRows = [];
      try {
        const [rows] = await pool.query(
          `SELECT u.name, mp.role 
           FROM match_players mp
           JOIN users u ON mp.user_id = u.id
           WHERE mp.match_id = ? AND mp.payment_status = 'paid'`,
          [matchBefore.id]
        );
        joinedPlayersRows = rows;
      } catch (err) {
        console.warn('Failed to query joined players list:', err.message);
      }

      let details = null;
      try {
        const [[row]] = await pool.query(
          `
          SELECT
            pr.id as match_id,
            pr.share_token,
            pr.sport_type,
            pr.match_date,
            pr.match_time,
            pr.booking_time_slot,
            pr.contact_phone as host_contact_phone,
            t.name as turf_name,
            t.address as turf_address,
            c.name as court_name,
            host.id as host_id,
            host.name as host_name,
            host.email as host_email,
            mp.amount_paid,
            mp.razorpay_payment_id
          FROM match_players mp
          JOIN player_requests pr ON mp.match_id = pr.id
          JOIN turfs t ON pr.turf_id = t.id
          LEFT JOIN courts c ON pr.court_id = c.id
          JOIN users host ON pr.host_id = host.id
          WHERE mp.id = ?
          LIMIT 1
          `,
          [match_player_id]
        );
        details = row || null;
      } catch {
        const [[row]] = await pool.query(
          `
          SELECT
            pr.id as match_id,
            pr.share_token,
            pr.sport_type,
            pr.match_date,
            pr.match_time,
            pr.booking_time_slot,
            pr.contact_phone as host_contact_phone,
            t.name as turf_name,
            t.address as turf_address,
            host.id as host_id,
            host.name as host_name,
            host.email as host_email,
            mp.amount_paid,
            mp.razorpay_payment_id
          FROM match_players mp
          JOIN player_requests pr ON mp.match_id = pr.id
          JOIN turfs t ON pr.turf_id = t.id
          JOIN users host ON pr.host_id = host.id
          WHERE mp.id = ?
          LIMIT 1
          `,
          [match_player_id]
        );
        details = row || null;
      }

      const joinUrl = details?.share_token
        ? inviteUrl(details.share_token)
        : `${require('../services/publicUrl').publicWebBase()}/find-players`;

      const whenLine = details?.booking_time_slot
        ? String(details.booking_time_slot)
        : String(details?.match_time || '').slice(0, 5);

      const joinedList = joinedPlayersRows.map((p, idx) => `  - ${p.name} (${p.role || 'Any Role'})`).join('\n') || '  No other players joined yet';

      // Player confirmation (must include host/contact/court/turf/date/time/amount)
      if (player?.email && details) {
        const receiptText =
          `✅ Match Join Confirmed (Payment Successful)\n\n` +
          `Hi ${player?.name || ''},\n\n` +
          `Your slot is confirmed. Here are your match details:\n\n` +
          `--- MATCH DETAILS ---\n` +
          `Match: ${String(details.sport_type || '').toUpperCase()}\n` +
          `Turf: ${details.turf_name || ''}\n` +
          (details.turf_address ? `Address: ${details.turf_address}\n` : '') +
          (details.court_name ? `Court: ${details.court_name}\n` : '') +
          `Date: ${String(details.match_date).slice(0, 10)}\n` +
          `Time: ${whenLine}\n\n` +
          `--- HOST DETAILS ---\n` +
          `Host Name: ${details.host_name || ''}\n` +
          `Host Contact: ${details.host_contact_phone || 'N/A'}\n\n` +
          `--- PLAYERS STATUS ---\n` +
          `Players Added: ${nextFilled} (Host + ${nextFilled - 1} joined)\n` +
          `Players Wanted (Needed): ${matchBefore.total_slots - 1} (Total slots: ${matchBefore.total_slots})\n` +
          `Players Left to Join: ${matchBefore.total_slots - nextFilled}\n\n` +
          `--- JOINED PLAYERS LIST ---\n` +
          `1. ${details.host_name || ''} (Host)\n` +
          `${joinedList}\n\n` +
          `--- PAYMENT INFO ---\n` +
          `Amount Paid: ₹${Number(details.amount_paid || 0)}\n` +
          (details.razorpay_payment_id ? `Payment ID: ${details.razorpay_payment_id}\n` : '') +
          `\nView match: ${joinUrl}\n\n` +
          `— BookArena`;

        await sendEmail(player.email, '✅ Match join confirmed — BookArena', receiptText, undefined, { suppressAdminRecipients: true });
      }

      // Host notification (keep existing behavior; details included)
      if (details?.host_email && details) {
        const hostText =
          `✅ A player joined your match and paid\n\n` +
          `Hi ${details.host_name || ''},\n\n` +
          `A new player, ${player?.name || 'Someone'}, has joined your match!\n\n` +
          `--- MATCH DETAILS ---\n` +
          `Match: ${String(details.sport_type || '').toUpperCase()}\n` +
          `Turf: ${details.turf_name || ''}\n` +
          `Date: ${String(details.match_date).slice(0, 10)}\n` +
          `Time: ${whenLine}\n\n` +
          `--- PLAYERS STATUS ---\n` +
          `Players Added: ${nextFilled} (Host + ${nextFilled - 1} joined)\n` +
          `Players Wanted (Needed): ${matchBefore.total_slots - 1} (Total slots: ${matchBefore.total_slots})\n` +
          `Players Left to Join: ${matchBefore.total_slots - nextFilled}\n\n` +
          `--- JOINED PLAYERS LIST ---\n` +
          `1. ${details.host_name || ''} (Host)\n` +
          `${joinedList}\n\n` +
          `--- PAYMENT INFO ---\n` +
          `Contribution collected (this payment): ₹${Number(details.amount_paid || 0)}\n` +
          `Link: ${joinUrl}\n\n` +
          `— BookArena`;

        await sendEmail(details.host_email, '✅ A player joined your match — BookArena', hostText, undefined, { suppressAdminRecipients: true });
      }

      // Notify host if full
      if (becameFull && details?.host_email) {
        await sendEmail(
          details.host_email,
          '✅ Match request filled',
          `Hi ${details.host_name || ''}, your match request is now full. You can proceed with the booking payment with the collected contributions.`,
          undefined,
          { suppressAdminRecipients: true }
        );
      }
    } catch { }

    // the payment was verified above: tell the host, and confirm to the player
    fireNotification('find_players.join_requested', { matchPlayerId: match_player_id });

}

router.post('/join/verify', verifyToken, async (req, res) => {
  try {
    const user_id = req.user?.id;
    if (!user_id) return res.status(401).json({ error: 'Login required' });
    const { match_player_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    const r = await verifyJoinPayment({ matchPlayerId: match_player_id, orderId: razorpay_order_id, paymentId: razorpay_payment_id, signature: razorpay_signature, userId: user_id });
    if (r.confirmed) await afterJoinConfirmed({ matchBefore: r.confirmed.matchBefore, nextFilled: r.confirmed.nextFilled, becameFull: r.confirmed.becameFull, user_id, match_player_id });
    res.status(r.http).json(r.json);
  } catch (err) {
    console.error('join/verify error:', err);
    res.status(500).json({ error: 'Payment verification failed', details: process.env.NODE_ENV !== 'production' ? err.message : undefined });
  }
});

// Hosted payment page (Expo Go / browser): it cannot send the app's login, but the order id inside the signed payment is bound to
// one join record, so the same signature + gateway checks apply and the money can only ever land on that record.
router.post('/join/hosted/verify', async (req, res) => {
  try {
    const { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    const r = await verifyJoinPayment({ matchPlayerId: booking_id, orderId: razorpay_order_id, paymentId: razorpay_payment_id, signature: razorpay_signature, userId: null });
    if (r.confirmed) await afterJoinConfirmed({ matchBefore: r.confirmed.matchBefore, nextFilled: r.confirmed.nextFilled, becameFull: r.confirmed.becameFull, user_id: r.user_id, match_player_id: booking_id });
    res.status(r.http).json(r.json);
  } catch (err) {
    console.error('join/hosted/verify error:', err);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// The player closed the payment window: release the held spot straight away (it would also simply expire). Never touches a paid row.
router.post('/join/hosted/cancel', async (req, res) => {
  try {
    const id = parseInt((req.body || {}).booking_id, 10);
    if (id) await pool.query("UPDATE match_players SET reserved_until = NULL WHERE id = ? AND payment_status = 'pending'", [id]);
    res.json({ success: true });
  } catch (err) { res.json({ success: true }); }
});

// Get user's matches (hosted + joined)
router.get('/mine', verifyToken, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Login required' });

    // Hosted requests
    const [hosted] = await pool.query(
      `SELECT r.*, t.name as turf_name, t.images as turf_images, 'host' as my_role
       FROM player_requests r
       JOIN turfs t ON r.turf_id = t.id
       WHERE r.host_id = ?
       ORDER BY r.created_at DESC`,
      [userId]
    );

    // Joined requests
    const [joined] = await pool.query(
      `SELECT r.*, t.name as turf_name, t.images as turf_images, mp.role as my_role, mp.payment_status as my_payment_status, mp.amount_paid as my_amount_paid, mp.razorpay_payment_id
       FROM match_players mp
       JOIN player_requests r ON mp.match_id = r.id
       JOIN turfs t ON r.turf_id = t.id
       WHERE mp.user_id = ? AND mp.payment_status = 'paid'
       ORDER BY mp.joined_at DESC`,
      [userId]
    );

    res.json({ success: true, hosted, joined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your matches' });
  }
});

// 1. Create a player request
router.post('/create', async (req, res) => {
  try {
    const {
      host_id, turf_id, court_id, sport_type, match_type, match_date, match_time,
      total_slots, filled_slots, roles_needed, skill_level, advance_amount,
      split_amount, visibility_radius, latitude, longitude
    } = req.body;

    const [result] = await pool.query(
      `INSERT INTO player_requests (
        host_id, turf_id, court_id, sport_type, match_type, match_date, match_time, 
        total_slots, filled_slots, roles_needed, skill_level, advance_amount, 
        split_amount, visibility_radius, latitude, longitude
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        host_id, turf_id, court_id, sport_type, match_type, match_date, match_time,
        total_slots, filled_slots, JSON.stringify(roles_needed), skill_level, advance_amount,
        split_amount, visibility_radius, latitude, longitude
      ]
    );

    const requestId = result.insertId;

    // Notify nearby users (simplified: send email to all users for now, or filter by location in a real app)
    // For demo, we'll fetch nearby users and email them
    const [nearbyUsers] = await pool.query(
      `SELECT id, email, name FROM users 
       WHERE id != ? AND email IS NOT NULL`, [host_id]
    );

    // Get turf info for email
    const [[turf]] = await pool.query('SELECT name FROM turfs WHERE id = ?', [turf_id]);

    for (const user of nearbyUsers) {
      await sendEmail(
        user.email,
        `🔥 New Match Request: ${sport_type} at ${turf.name}`,
        `Hi ${user.name}, someone needs players for a ${sport_type} match! Join here: ${(process.env.CLIENT_URL || 'https://bookarena.in').replace(/\/$/, '')}/match/${requestId}`
      ).catch(e => console.error('Email failed:', e));
    }

    broadcastMatchCreated(requestId).catch(() => { });
    res.json({ success: true, id: requestId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create match request' });
  }
});

// 2. Get nearby requests
router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng, sport, radius = 50, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    const distanceSql = getDistanceSql(lat || 0, lng || 0, 'r');

    // Build query twice:
    // 1) Prefer results within radius
    // 2) If none found for page=1, fallback to "all active matches" so the page isn't empty
    const build = ({ applyRadius }) => {
      let query = `
        SELECT r.*, t.name as turf_name, t.images as turf_images, t.advance_percent as turf_advance_percent, u.name as host_name, u.karma_points as host_karma,
        ${distanceSql} AS distance
        FROM player_requests r
        JOIN turfs t ON r.turf_id = t.id
        JOIN users u ON r.host_id = u.id
        WHERE r.status IN ('open', 'full')
        AND (
          r.match_date > CURDATE()
          OR (r.match_date = CURDATE() AND (r.match_time IS NULL OR r.match_time >= CURTIME()))
        )
      `;
      const params = [];

      if (lat && lng && applyRadius) {
        // If a request is missing coordinates, still show it (distance will be null).
        query += ` AND (r.latitude IS NULL OR r.longitude IS NULL OR ${distanceSql} <= ?)`;
        params.push(radius);
      }

      if (sport && sport !== 'All') {
        query += ` AND LOWER(r.sport_type) = ?`;
        params.push(String(sport).toLowerCase());
      }

      // Sort by urgent (within 2h), then distance, then newest
      query += ` ORDER BY 
        (r.status = 'open') DESC,
        (TIMESTAMP(r.match_date, r.match_time) <= DATE_ADD(NOW(), INTERVAL 2 HOUR)) DESC,
        (CASE WHEN distance IS NULL THEN 999999 ELSE distance END) ASC, 
        r.created_at DESC
        LIMIT ? OFFSET ?`;
      params.push(parseInt(limit), parseInt(offset));

      return { query, params };
    };

    const { query: q1, params: p1 } = build({ applyRadius: true });
    const [requests1] = await pool.query(q1, p1);

    // Fallback behavior requested:
    // If there are active matches but none within user's radius, show all matches.
    if ((parseInt(page, 10) || 1) === 1 && (lat && lng) && (!requests1 || requests1.length === 0)) {
      const { query: q2, params: p2 } = build({ applyRadius: false });
      const [requests2] = await pool.query(q2, p2);
      return res.json({ requests: requests2 || [], fallback: true });
    }

    res.json({ requests: requests1 || [], fallback: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch nearby matches' });
  }
});

// 3. Join a match
router.post('/join', verifyToken, async (req, res) => {
  if (req.user.role) return res.status(403).json({ error: 'This action is for customer accounts' });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { match_id, role, payment_type } = req.body;
    const user_id = req.user.id;

    const [[match]] = await connection.query(
      `SELECT * FROM player_requests WHERE id = ? FOR UPDATE`,
      [match_id]
    );

    if (!match) {
      await connection.rollback();
      return res.status(404).json({ error: 'Match not found' });
    }

    if (match.status !== 'open' || match.filled_slots >= match.total_slots) {
      await connection.rollback();
      return res.status(400).json({ error: 'Sorry, this match is already full.' });
    }

    if (parseInt(match.host_id, 10) === parseInt(user_id, 10)) {
      await connection.rollback();
      return res.status(400).json({ error: 'Host is already in the match' });
    }

    const [[existing]] = await connection.query(
      `SELECT id FROM match_players WHERE match_id = ? AND user_id = ? FOR UPDATE`,
      [match_id, user_id]
    );

    if (existing) {
      await connection.rollback();
      return res.status(409).json({ error: 'You are already participating in this match' });
    }

    // 1. Add player to match
    const [joinInsert] = await connection.query(
      `INSERT INTO match_players (match_id, user_id, role, payment_type, payment_status, status) VALUES (?, ?, ?, ?, 'paid', 'approved')`,
      [match_id, user_id, role || null, payment_type || 'split']
    );

    // 2. Update filled slots
    const nextFilled = parseInt(match.filled_slots || 0, 10) + 1;
    const nextStatus = nextFilled >= parseInt(match.total_slots || 0, 10) ? 'full' : 'open';
    await connection.query(
      `UPDATE player_requests SET filled_slots = ?, status = ? WHERE id = ?`,
      [nextFilled, nextStatus, match_id]
    );

    // 3. Award Karma
    await connection.query(`UPDATE users SET karma_points = karma_points + 50 WHERE id = ?`, [user_id]);

    await connection.commit();
    fireNotification('find_players.join_requested', { matchPlayerId: joinInsert.insertId });
    res.json({ success: true, filled_slots: nextFilled, status: nextStatus });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: 'Failed to join match' });
  } finally {
    connection.release();
  }
});

// SPECIFIC ROUTES (BEFORE GENERIC /:id)

// Get admin stats
router.get('/admin/stats', async (req, res) => {
  try {
    const [[stats]] = await pool.query(`
      SELECT
        COUNT(*) as total_requests,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_requests,
        SUM(CASE WHEN status = 'full' THEN 1 ELSE 0 END) as full_requests,
        SUM(CASE WHEN TIMESTAMP(match_date, match_time) <= DATE_ADD(NOW(), INTERVAL 2 HOUR) AND status = 'open' THEN 1 ELSE 0 END) as urgent_requests,
        SUM(filled_slots) as total_players_joined_today
      FROM player_requests
      WHERE match_date = CURDATE()
    `);

    res.json({ stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get match requests by host
router.get('/host/:host_id', async (req, res) => {
  try {
    const [requests] = await pool.query(`
      SELECT r.*, t.name as turf_name, t.address as turf_address, t.images as turf_images,
      (SELECT COUNT(*) FROM match_players WHERE match_id = r.id) as player_count
      FROM player_requests r
      JOIN turfs t ON r.turf_id = t.id
      WHERE r.host_id = ?
      ORDER BY r.created_at DESC
    `, [req.params.host_id]);

    res.json({ requests });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch host requests' });
  }
});

// GENERIC /:id ROUTES

// 4. Get Match Detail
router.get('/:id', async (req, res) => {
  try {
    const [matches] = await pool.query(`
      SELECT r.*, t.name as turf_name, t.address as turf_address, t.images as turf_images,
      u.name as host_name, u.karma_points as host_karma
      FROM player_requests r
      JOIN turfs t ON r.turf_id = t.id
      JOIN users u ON r.host_id = u.id
      WHERE r.id = ?
    `, [req.params.id]);

    if (matches.length === 0) return res.status(404).json({ error: 'Match not found' });

    const [players] = await pool.query(`
      SELECT p.*, u.name as user_name, u.karma_points as user_karma
      FROM match_players p
      JOIN users u ON p.user_id = u.id
      WHERE p.match_id = ?
    `, [req.params.id]);

    res.json({ match: matches[0], players });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch match details' });
  }
});

// 6. Edit a match request
router.put('/:id', async (req, res) => {
  try {
    const { total_slots, roles_needed, advance_amount, split_amount, visibility_radius, host_id } = req.body;
    const matchId = req.params.id;

    // Verify ownership
    const [[match]] = await pool.query('SELECT host_id FROM player_requests WHERE id = ?', [matchId]);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.host_id !== parseInt(host_id)) {
      return res.status(403).json({ error: 'Not authorized to edit this match' });
    }

    await pool.query(`
      UPDATE player_requests 
      SET total_slots = ?, roles_needed = ?, advance_amount = ?, split_amount = ?, visibility_radius = ?
      WHERE id = ?
    `, [
      total_slots,
      JSON.stringify(roles_needed),
      advance_amount,
      split_amount,
      visibility_radius,
      matchId
    ]);

    res.json({ success: true, message: 'Match request updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update match request' });
  }
});

// 7. Cancel a match request
router.delete('/:id', verifyToken, async (req, res) => {
  if (req.user.role) return res.status(403).json({ error: 'This action is for customer accounts' });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const matchId = req.params.id;
    const host_id = req.user.id;

    // Verify ownership
    const [[match]] = await connection.query('SELECT host_id FROM player_requests WHERE id = ?', [matchId]);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.host_id !== parseInt(host_id)) {
      return res.status(403).json({ error: 'Not authorized to cancel this match' });
    }

    // Update status to cancelled
    await connection.query('UPDATE player_requests SET status = ? WHERE id = ?', ['cancelled', matchId]);

    // Notify all joined players
    const [players] = await connection.query(
      'SELECT u.id, u.email, u.name FROM match_players p JOIN users u ON p.user_id = u.id WHERE p.match_id = ?',
      [matchId]
    );

    for (const player of players) {
      await sendEmail(
        player.email,
        '❌ Match Cancelled',
        `Hi ${player.name}, the match you joined has been cancelled. Your payment will be refunded (if applicable).`,
        undefined,
        { suppressAdminRecipients: true }
      ).catch(e => console.error('Email failed:', e));
    }

    await connection.commit();
    fireNotification('find_players.match_cancelled', { matchRequestId: matchId });
    res.json({ success: true, message: 'Match request cancelled and players notified' });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel match request' });
  } finally {
    connection.release();
  }
});

// 8. Approve a player
router.put('/:id/approve-player', verifyToken, async (req, res) => {
  try {
    if (req.user.role) return res.status(403).json({ error: 'This action is for customer accounts' });
    const { player_id } = req.body;
    const host_id = req.user.id;
    const matchId = req.params.id;

    // Verify host ownership (the host is the signed-in user, not whoever the body says)
    const [[match]] = await pool.query('SELECT host_id FROM player_requests WHERE id = ?', [matchId]);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.host_id !== host_id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await pool.query(
      'UPDATE match_players SET status = ? WHERE id = ? AND match_id = ?',
      ['approved', player_id, matchId]
    );

    // Notify player
    const [[player]] = await pool.query('SELECT u.email, u.name FROM match_players p JOIN users u ON p.user_id = u.id WHERE p.id = ?', [player_id]);
    if (player) {
      await sendEmail(
        player.email,
        '✅ You\'ve Been Approved for the Match',
        `Hi ${player.name}, your spot in the match has been approved!`,
        undefined,
        { suppressAdminRecipients: true }
      ).catch(e => console.error('Email failed:', e));
    }

    fireNotification('find_players.join_decided', { matchPlayerId: player_id, decision: 'approved' });
    res.json({ success: true, message: 'Player approved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve player' });
  }
});

// 9. Reject a player
router.put('/:id/reject-player', verifyToken, async (req, res) => {
  if (req.user.role) return res.status(403).json({ error: 'This action is for customer accounts' });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { player_id } = req.body;
    const host_id = req.user.id;
    const matchId = req.params.id;

    // Verify host ownership (the host is the signed-in user, not whoever the body says)
    const [[match]] = await connection.query('SELECT host_id FROM player_requests WHERE id = ?', [matchId]);
    if (!match || match.host_id !== host_id) {
      await connection.rollback();
      return res.status(match ? 403 : 404).json({ error: match ? 'Not authorized' : 'Match not found' });
    }

    // Get player info for notification
    const [[playerInfo]] = await connection.query(
      'SELECT u.email, u.name, u.id FROM match_players p JOIN users u ON p.user_id = u.id WHERE p.id = ?',
      [player_id]
    );

    // Delete player from match
    await connection.query('DELETE FROM match_players WHERE id = ? AND match_id = ?', [player_id, matchId]);

    // Decrease filled slots
    await connection.query('UPDATE player_requests SET filled_slots = filled_slots - 1 WHERE id = ?', [matchId]);

    // Notify player
    if (playerInfo) {
      await sendEmail(
        playerInfo.email,
        '❌ Application Rejected',
        `Hi ${playerInfo.name}, unfortunately your application for this match was not accepted.`,
        undefined,
        { suppressAdminRecipients: true }
      ).catch(e => console.error('Email failed:', e));
    }

    await connection.commit();
    if (playerInfo) fireNotification('find_players.join_decided', { matchPlayerId: player_id, decision: 'rejected', userId: playerInfo.id, matchRequestId: matchId });
    res.json({ success: true, message: 'Player rejected' });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: 'Failed to reject player' });
  } finally {
    connection.release();
  }
});

// 11. Feature a match (admin only)
router.put('/:id/feature', async (req, res) => {
  try {
    const { featured } = req.body;

    // In production, verify admin role here
    await pool.query('UPDATE player_requests SET is_featured = ? WHERE id = ?', [featured, req.params.id]);

    res.json({ success: true, message: `Match ${featured ? 'featured' : 'unfeatured'}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update featured status' });
  }
});

// 12. Broadcast notification about a match (admin only)
router.post('/:id/broadcast', async (req, res) => {
  try {
    const matchId = req.params.id;

    // Get match details
    const [[match]] = await pool.query(
      `SELECT r.*, t.name as turf_name FROM player_requests r
       JOIN turfs t ON r.turf_id = t.id WHERE r.id = ?`,
      [matchId]
    );

    if (!match) return res.status(404).json({ error: 'Match not found' });

    // Get all users who play this sport (in production, also filter by location)
    const [users] = await pool.query(
      'SELECT id, email, name FROM users WHERE email IS NOT NULL LIMIT 100'
    );

    for (const user of users) {
      await sendEmail(
        user.email,
        `🔥 Featured Match Alert: ${match.sport_type} at ${match.turf_name}`,
        `Hi ${user.name}, a featured ${match.sport_type} match is looking for players! ${match.total_slots - match.filled_slots} spots available. Join here: ${(process.env.CLIENT_URL || 'https://bookarena.in').replace(/\/$/, '')}/match/${matchId}`,
        undefined,
        { suppressAdminRecipients: true }
      ).catch(e => console.error('Email failed:', e));
    }

    res.json({ success: true, message: 'Broadcast sent', recipientCount: users.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

module.exports = router;
