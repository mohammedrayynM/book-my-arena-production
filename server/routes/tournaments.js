const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { verifyHost, findManageableTournament, HOST_NAME_SQL } = require('../utils/tournamentAccess');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { fire: fireNotification } = require('../utils/notifications/events');
const { validateTournamentDates, dateOnlyResponses } = require('../utils/tournamentValidation');
const { isAssignedScorer, liveMatchCards } = require('../utils/liveMatch');
const { youtubePayload } = require('../utils/youtube');
const tournamentPricing = require('../services/tournamentPricing');
const { toMinor } = require('../utils/money');
const { tournamentInviteUrl } = require('../services/publicUrl');
const { isCricketSport, roleForSport } = require('../utils/tournamentRoles');

const SUPPORTED_FORMATS = ['Knockout', 'Round Robin', 'Group Stage + Knockout'];

// SQL DATE columns leave this router as plain 'YYYY-MM-DD' (not a timezone-shifted ISO timestamp).
router.use(dateOnlyResponses);

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'dummy_key',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_secret',
});

// GET /api/tournaments - Public listing (search, sport, status filter)
router.get('/', async (req, res) => {
  try {
    const { sport, status, search } = req.query;

    let query = `
      SELECT t.id, t.name, t.sport, t.banner, t.logo, t.start_date, t.end_date, t.venue, t.location, 
             t.visibility, t.status, t.slug, t.prize_pool_amount, t.max_teams, t.format_type,
             (SELECT COUNT(*) FROM tournament_teams WHERE tournament_id = t.id) AS teams_count,
             ${HOST_NAME_SQL} as host_name
      FROM tournaments t
      WHERE t.visibility = 'PUBLIC' AND t.status != 'DRAFT' AND t.status != 'CANCELLED'
    `;
    const params = [];

    if (sport) {
      query += ` AND t.sport = ?`;
      params.push(sport);
    }
    if (status) {
      query += ` AND t.status = ?`;
      params.push(status);
    }
    if (search) {
      query += ` AND (t.name LIKE ? OR t.venue LIKE ? OR t.location LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY t.created_at DESC';

    const [tournaments] = await pool.query(query, params);

    // Live tournaments carry the match being played right now, so the list can show the score without another screen.
    const live = tournaments.filter(t => t.status === 'LIVE').slice(0, 30);
    if (live.length > 0) {
      const [fixtures] = await pool.query(`
        SELECT f.*, ta.name AS team_a_name, ta.logo AS team_a_logo, ta.color AS team_a_color,
               tb.name AS team_b_name, tb.logo AS team_b_logo, tb.color AS team_b_color
        FROM tournament_fixtures f
        LEFT JOIN tournament_teams ta ON f.team_a_id = ta.id
        LEFT JOIN tournament_teams tb ON f.team_b_id = tb.id
        WHERE f.tournament_id IN (${live.map(() => '?').join(',')}) AND f.status IN ('LIVE', 'PAUSED')
        ORDER BY (f.status = 'LIVE') DESC, f.id ASC
      `, live.map(t => t.id));
      for (const t of live) {
        const first = fixtures.find(fx => fx.tournament_id === t.id);
        t.live_match = first ? (await liveMatchCards(pool, t, [first]))[0] : null;
        t.live_matches_count = fixtures.filter(fx => fx.tournament_id === t.id).length;
      }
    }
    // The next scheduled match of every tournament that is not already live, so a card can say "Tomorrow ·
    // Chennai · Titans v Kings" without the user opening the tournament. Dates and venues are the fixture's own.
    const upcomingIds = tournaments.filter((t) => !t.live_match).map((t) => t.id);
    if (upcomingIds.length) {
      const [next] = await pool.query(`
        SELECT f.tournament_id, f.id, f.match_date, f.match_time, f.venue, f.stage, f.status,
               ta.name AS team_a_name, tb.name AS team_b_name
          FROM tournament_fixtures f
          LEFT JOIN tournament_teams ta ON ta.id = f.team_a_id
          LEFT JOIN tournament_teams tb ON tb.id = f.team_b_id
         WHERE f.tournament_id IN (${upcomingIds.map(() => '?').join(',')})
           AND f.status = 'SCHEDULED' AND f.match_date IS NOT NULL
         ORDER BY f.match_date ASC, f.match_time ASC, f.id ASC`, upcomingIds);
      const seen = new Set();
      for (const fx of next) {
        if (seen.has(fx.tournament_id)) continue;
        seen.add(fx.tournament_id);
        const t = tournaments.find((x) => x.id === fx.tournament_id);
        if (!t) continue;
        t.next_match = {
          id: fx.id,
          date: fx.match_date,
          time: fx.match_time ? String(fx.match_time).slice(0, 5) : null,
          venue: fx.venue || t.venue || null,
          location: t.location || null,
          stage: fx.stage,
          team_a_name: fx.team_a_name,
          team_b_name: fx.team_b_name,
        };
      }
    }

    res.json({ success: true, tournaments });
  } catch (error) {
    console.error('Error fetching tournaments:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tournaments' });
  }
});

// GET /api/tournaments/host/mine - Host gets their own tournaments
router.get('/host/mine', verifyToken, verifyHost, async (req, res) => {
  try {
    const [tournaments] = await pool.query(`
      SELECT t.*,
             (SELECT COUNT(*) FROM tournament_teams WHERE tournament_id = t.id) as teams_count,
             (SELECT COUNT(*) FROM tournament_participants WHERE tournament_id = t.id AND status = 'APPROVED') as approved_participants_count,
             (SELECT COUNT(*) FROM tournament_participants WHERE tournament_id = t.id AND status = 'PENDING') as pending_requests_count
      FROM tournaments t
      WHERE t.owner_id = ? AND t.owner_type = ?
      ORDER BY t.created_at DESC
    `, [req.tHost.id, req.tHost.type]);

    res.json({ success: true, tournaments });
  } catch (error) {
    console.error('Error fetching host tournaments:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch host tournaments' });
  }
});

// GET /api/tournaments/host/:id - One tournament the caller may manage (its host, or an admin)
router.get('/host/:id', verifyToken, verifyHost, async (req, res) => {
  try {
    const t = await findManageableTournament(pool, req.params.id, req.tHost);
    if (!t) {
      // 404 (not 403): the mobile client treats any 403 as an expired session and logs the user out.
      return res.status(404).json({ success: false, error: 'Tournament not found or not yours to manage' });
    }
    const [[counts]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM tournament_teams WHERE tournament_id = ?) as teams_count,
        (SELECT COUNT(*) FROM tournament_participants WHERE tournament_id = ? AND status = 'APPROVED') as approved_participants_count,
        (SELECT COUNT(*) FROM tournament_participants WHERE tournament_id = ? AND status = 'PENDING') as pending_requests_count
    `, [t.id, t.id, t.id]);
    // The host also gets the canonical invitation URL — the exact string the Share panel copies, shares and
    // turns into a QR code, built from the production domain rather than whatever host the app happened to call.
    const [[pending]] = await pool.query(
      "SELECT COUNT(*) AS n FROM tournament_registrations WHERE tournament_id = ? AND status = 'PENDING'", [t.id]);
    res.json({
      success: true,
      tournament: {
        ...t,
        ...counts,
        pending_registrations_count: pending ? Number(pending.n) : 0,
        invite_url: t.join_token ? tournamentInviteUrl(t.join_token) : null,
      },
    });
  } catch (error) {
    console.error('Error fetching managed tournament:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tournament' });
  }
});

// GET /api/tournaments/:id/can-manage - Does the signed-in caller host this tournament (or is an admin)?
// Always answers 200 so the app can show/hide a "Manage" shortcut without triggering error handling.
router.get('/:id/can-manage', verifyToken, verifyHost, async (req, res) => {
  try {
    const t = await findManageableTournament(pool, req.params.id, req.tHost, { columns: 'id' });
    // Assigned scorers can run the live score without being able to manage the tournament
    const canScore = !!t || await isAssignedScorer(pool, req.params.id, req.tHost);
    res.json({ success: true, can_manage: !!t, can_score: canScore });
  } catch (error) {
    res.json({ success: true, can_manage: false, can_score: false });
  }
});

// GET /api/tournaments/join/:token - Public invitation. Deliberately a whitelist: the tournament row carries the
// host's payment ids, the join token itself and the admin fee state, none of which belong on a public page.
router.get('/join/:token', optionalAuthForInvite, async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) {
      return res.status(404).json({ success: false, error: 'Tournament joining link invalid or expired' });
    }

    const [rows] = await pool.query(`
      SELECT t.*, ${HOST_NAME_SQL} as host_name,
             tf.name AS venue_turf_name, tf.address AS venue_turf_address, tf.images AS venue_turf_images
      FROM tournaments t
      LEFT JOIN turfs tf ON tf.id = t.venue_turf_id
      WHERE t.join_token = ?
    `, [token]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Tournament joining link invalid or expired' });
    }
    const t = rows[0];

    const [[teams]] = await pool.query('SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ?', [t.id]);
    const [[players]] = await pool.query("SELECT COUNT(*) as count FROM tournament_participants WHERE tournament_id = ? AND status = 'APPROVED'", [t.id]);

    // Why joining is or is not possible right now. The invite always renders; the button is what changes.
    const today = tournamentPricing.todayYmd();
    const deadline = tournamentPricing.ymd(t.reg_close_date);
    let state = 'open';
    let message = null;
    if (!t.join_link_active) { state = 'disabled'; message = 'The host has turned this invitation link off.'; }
    else if (t.status === 'CANCELLED') { state = 'cancelled'; message = 'This tournament was cancelled.'; }
    else if (t.status === 'COMPLETED') { state = 'completed'; message = 'This tournament has finished.'; }
    else if (t.status === 'DRAFT') { state = 'draft'; message = 'This tournament has not been published yet.'; }
    else if (t.status !== 'REGISTRATION_OPEN') { state = 'closed'; message = 'Registration is closed for this tournament.'; }
    else if (deadline && deadline < today) { state = 'closed'; message = 'The registration deadline has passed.'; }
    else if (t.max_teams && teams.count >= t.max_teams) { state = 'full'; message = 'All team places are taken.'; }

    // Only ever the viewer's OWN registration, never anyone else's team or contact details.
    let my_registration = null;
    if (req.inviteUserId) {
      const [[mine]] = await pool.query(
        "SELECT id, team_name, status FROM tournament_registrations WHERE tournament_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1",
        [t.id, req.inviteUserId]);
      if (mine) my_registration = mine;
      else {
        const [[req2]] = await pool.query(
          "SELECT id, status, requested_team_name FROM tournament_join_requests WHERE tournament_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1",
          [t.id, req.inviteUserId]);
        if (req2) my_registration = { id: req2.id, team_name: req2.requested_team_name, status: req2.status };
      }
    }

    res.json({
      success: true,
      state,
      message,
      can_register: state === 'open' && !my_registration,
      my_registration,
      invite_url: tournamentInviteUrl(token),
      tournament: {
        id: t.id, name: t.name, slug: t.slug, sport: t.sport, banner: t.banner, logo: t.logo,
        description: t.description, format_type: t.format_type, participation_type: t.participation_type,
        venue: t.venue, location: t.location,
        venue_turf: t.venue_turf_id ? { id: t.venue_turf_id, name: t.venue_turf_name, address: t.venue_turf_address, images: t.venue_turf_images } : null,
        start_date: t.start_date, end_date: t.end_date, reg_open_date: t.reg_open_date, reg_close_date: t.reg_close_date,
        entry_fee: Number(t.entry_fee) || 0, max_teams: t.max_teams, players_per_team: t.players_per_team,
        substitute_limit: t.substitute_limit, status: t.status, host_name: t.host_name,
        host_approval_required: !!t.host_approval_required,
        open_registration: !!t.open_registration,
        allow_team_registration: !!t.allow_team_registration,
        allow_individual_registration: !!t.allow_individual_registration,
        teams_count: teams.count, players_count: players.count,
        spots_left: t.max_teams ? Math.max(0, t.max_teams - teams.count) : null,
      },
    });
  } catch (error) {
    console.error('Error fetching join link details:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch join link details' });
  }
});

// The invite is public, but a signed-in viewer also gets to see their OWN registration status on it.
function optionalAuthForInvite(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.inviteUserId = require('jsonwebtoken').verify(token, process.env.JWT_SECRET || 'your_jwt_secret_key').id; } catch { }
  }
  next();
}

// GET /api/tournaments/plans - Public pricing tiers (Free/Pro/Premium). Informational only for now;
// not yet enforced against any feature. Declared before /:slug so it isn't shadowed by it.
router.get('/plans', async (req, res) => {
  try {
    const [plans] = await pool.query('SELECT * FROM tournament_plans WHERE is_active = true ORDER BY sort_order ASC');
    res.json({ success: true, plans });
  } catch (error) {
    console.error('Error fetching tournament plans:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tournament plans' });
  }
});

// GET /api/tournaments/creation-fee - Platform fee (if any) shown on the Create Tournament screen.
// Readable by everyone: the Create screen used to read the admin-only settings route, which returned
// 403 for every user/owner. Declared before /:slug so it isn't shadowed by it.
router.get('/creation-fee', async (req, res) => {
  try {
    const config = await tournamentPricing.getConfig();
    const fee = tournamentPricing.baseFeeFor(config, 'user');
    res.json({ success: true, fee_amount: fee, currency: config.currency_code, is_active: fee > 0 });
  } catch (error) {
    console.error('Error fetching tournament creation fee:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch creation fee' });
  }
});

// GET /api/tournaments/creation-config - Everything the Create Tournament screen needs, decided by the admin:
// the fee for THIS host, the currency, whether creation is open at all, the allowed duration/formats, and the
// live offer list. Declared before /:slug so it isn't shadowed by it.
router.get('/creation-config', verifyToken, verifyHost, async (req, res) => {
  try {
    const config = await tournamentPricing.getConfig();
    const base = tournamentPricing.baseFeeFor(config, req.tHost.type);
    const offers = base > 0 ? await tournamentPricing.listOffers() : [];
    res.json({
      success: true,
      creation_enabled: config.creation_enabled,
      disabled_message: config.disabled_message,
      fee_amount: base,
      fee_required: base > 0,
      currency: config.currency_code,
      min_duration_days: config.min_duration_days,
      max_duration_days: config.max_duration_days,
      allowed_formats: config.allowed_formats,
      allowed_sports: config.allowed_sports,
      offers,
    });
  } catch (error) {
    console.error('Error fetching tournament creation config:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tournament settings' });
  }
});

// POST /api/tournaments/:id/creation-fee/retry - Retry the same order so a draft can never create duplicate charges.
router.post('/:id/creation-fee/retry', verifyToken, verifyHost, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const tournament = await findManageableTournament(connection, req.params.id, req.tHost, { forUpdate: true });
    if (!tournament) {
      await connection.rollback();
      return res.status(404).json({ success: false, error: 'Tournament not found or not yours to manage' });
    }
    if (tournament.is_paid_to_admin) {
      await connection.commit();
      return res.json({ success: true, paid: true, tournament_id: tournament.id });
    }
    if (tournament.status !== 'DRAFT') {
      await connection.rollback();
      return res.status(409).json({ success: false, error: 'Only an unpaid tournament draft can retry its creation fee' });
    }

    const [[ledger]] = await connection.query(
      'SELECT * FROM tournament_fee_payments WHERE tournament_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE',
      [tournament.id]);
    if (!ledger || !(Number(ledger.amount) > 0)) {
      await connection.rollback();
      return res.status(409).json({ success: false, error: 'This draft has no outstanding creation fee' });
    }

    if (ledger.status === 'paid') {
      await connection.rollback();
      return res.status(409).json({ success: false, error: 'This payment is already recorded. Refresh the tournament before retrying.' });
    }
    if (!['created', 'cancelled', 'failed'].includes(ledger.status) || !ledger.razorpay_order_id ||
        ledger.razorpay_order_id !== tournament.razorpay_order_id) {
      await connection.rollback();
      return res.status(409).json({ success: false, error: 'The saved payment order cannot be retried. Please contact support.' });
    }
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      await connection.rollback();
      return res.status(503).json({ success: false, error: 'Payments are not configured for tournament creation right now' });
    }
    await connection.commit();

    return res.json({
      success: true, fee_required: true, tournament_id: tournament.id,
      fee_amount: Number(ledger.amount), currency: ledger.currency,
      razorpay_order_id: ledger.razorpay_order_id, razorpay_key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch { }
    }
    console.error('Error retrying tournament creation fee:', error);
    return res.status(500).json({ success: false, error: 'Could not retry the tournament creation fee' });
  } finally {
    if (connection) connection.release();
  }
});

// POST /api/tournaments/creation-fee/quote - Validate a coupon and return the payable amount.
// The discount is computed here; a client-supplied discount is never trusted or even read.
router.post('/creation-fee/quote', verifyToken, verifyHost, async (req, res) => {
  try {
    const q = await tournamentPricing.quote({
      hostType: req.tHost.type,
      hostId: req.tHost.id,
      couponCode: (req.body || {}).coupon_code,
    });
    res.json({
      success: !q.error,
      error: q.error,
      fee_amount: q.base,
      discount_amount: q.discount,
      payable_amount: q.payable,
      currency: q.currency,
      coupon: q.offer ? { code: q.offer.code, title: q.offer.title, description: q.offer.description } : null,
    });
  } catch (error) {
    console.error('Error quoting tournament creation fee:', error);
    res.status(500).json({ success: false, error: 'Failed to check this coupon' });
  }
});

// GET /api/tournaments/:slug - Public tournament detail
router.get('/:slug', async (req, res) => {
  try {
    const [tournaments] = await pool.query(`
      SELECT t.*, ${HOST_NAME_SQL} as host_name
      FROM tournaments t
      WHERE t.slug = ? OR t.id = ?
    `, [req.params.slug, req.params.slug]);

    if (tournaments.length === 0) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }

    const tournament = tournaments[0];
    // Public endpoint: never expose the host's email (hosts can now be ordinary users) or payment order ids.
    delete tournament.razorpay_order_id;

    const [teamCount] = await pool.query('SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ?', [tournament.id]);
    const [playerCount] = await pool.query("SELECT COUNT(*) as count FROM tournament_participants WHERE tournament_id = ? AND status = 'APPROVED'", [tournament.id]);
    const [streamRows] = await pool.query('SELECT id, match_id, stream_title, stream_status, youtube_url FROM tournament_streams WHERE tournament_id = ? ORDER BY id DESC', [tournament.id]);
    // Only links that still parse as real YouTube videos are exposed, always with server-built embed URLs
    const streams = streamRows
      .map(({ youtube_url, ...s }) => ({ ...s, youtube: youtubePayload(youtube_url) }))
      .filter(s => s.youtube);

    let venueTurf = null;
    if (tournament.venue_turf_id) {
      const [turfRows] = await pool.query('SELECT id, name, location, address, sport_type, images FROM turfs WHERE id = ?', [tournament.venue_turf_id]);
      venueTurf = turfRows[0] || null;
    }

    res.json({
      success: true,
      tournament: {
        ...tournament,
        teams_count: teamCount[0].count,
        players_count: playerCount[0].count,
        venue_turf: venueTurf,
        streams
      }
    });
  } catch (error) {
    console.error('Error fetching tournament details:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tournament' });
  }
});

// POST /api/tournaments - Host creates multi-step tournament
router.post('/', verifyToken, verifyHost, async (req, res) => {
  // Validate before touching the DB: bad input is a 400 the user can fix, not a generic 500.
  const body = req.body || {};
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return res.status(400).json({ success: false, error: 'Tournament name is required' });
  }
  if (typeof body.sport !== 'string' || !body.sport.trim()) {
    return res.status(400).json({ success: false, error: 'Sport is required' });
  }
  const dateCheck = validateTournamentDates(body, { isCreate: true });
  if (dateCheck.error) {
    return res.status(400).json({ success: false, error: dateCheck.error });
  }
  if (body.visibility !== undefined && !['PUBLIC', 'PRIVATE'].includes(body.visibility)) {
    return res.status(400).json({ success: false, error: 'Visibility must be PUBLIC or PRIVATE' });
  }
  if (body.format_type !== undefined && !SUPPORTED_FORMATS.includes(body.format_type)) {
    return res.status(400).json({ success: false, error: `Format must be one of: ${SUPPORTED_FORMATS.join(', ')}` });
  }

  // Admin-controlled gate + duration/format rules. Checked here so a client that hides the UI rules
  // (or calls the API directly) still cannot get around them.
  const tConfig = await tournamentPricing.getConfig();
  if (!tConfig.creation_enabled && req.tHost.type !== 'admin') {
    return res.status(403).json({ success: false, error: tConfig.disabled_message || 'Tournament creation is currently closed.' });
  }
  {
    const start = new Date(`${String(dateCheck.dates.start_date).slice(0, 10)}T00:00:00`);
    const end = new Date(`${String(dateCheck.dates.end_date).slice(0, 10)}T00:00:00`);
    const days = Math.round((end - start) / 86400000) + 1;
    if (Number.isFinite(days)) {
      if (days < tConfig.min_duration_days) {
        return res.status(400).json({ success: false, error: `A tournament must run for at least ${tConfig.min_duration_days} day(s).` });
      }
      if (days > tConfig.max_duration_days) {
        return res.status(400).json({ success: false, error: `A tournament can run for at most ${tConfig.max_duration_days} day(s).` });
      }
    }
    if (tConfig.allowed_formats && body.format_type && !tConfig.allowed_formats.includes(body.format_type)) {
      return res.status(400).json({ success: false, error: `Allowed formats: ${tConfig.allowed_formats.join(', ')}` });
    }
    if (tConfig.allowed_sports && !tConfig.allowed_sports.some((sp) => String(sp).toLowerCase() === body.sport.trim().toLowerCase())) {
      return res.status(400).json({ success: false, error: `Allowed sports: ${tConfig.allowed_sports.join(', ')}` });
    }
  }
  body.name = body.name.trim();
  body.sport = body.sport.trim();
  Object.assign(body, dateCheck.dates);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const ownerId = req.user.id;

    const {
      name, sport, banner, logo, description, venue, location, start_date, end_date,
      reg_open_date, reg_close_date, max_teams, max_players, max_participants, entry_fee, prize_pool_amount,
      visibility, format_type, participation_type, allow_user_teams, allow_user_join_team,
      players_per_team, substitute_limit, match_duration, break_duration, points_for_win,
      points_for_draw, points_for_loss, tie_breaker_rules, number_of_groups, qualification_rules,
      joining_link_active, host_approval_required, venue_turf_id,
      open_registration, allow_team_registration, allow_individual_registration
    } = body;
    const prizePoolAmount = body.prize_pool_amount === undefined || body.prize_pool_amount === '' ? 0 : Number(body.prize_pool_amount);
    if (!Number.isFinite(prizePoolAmount) || prizePoolAmount < 0 || prizePoolAmount > 9999999999.99) {
      return res.status(400).json({ success: false, error: 'Prize pool must be a valid non-negative amount' });
    }

    // If the host picked one of our own turf listings as the venue, verify it exists and
    // reuse its name/location so the tournament's venue text always matches the real listing.
    let resolvedVenue = venue;
    let resolvedLocation = location;
    let resolvedVenueTurfId = null;
    let resolvedLat = null;
    let resolvedLng = null;
    if (venue_turf_id) {
      const [turfRows] = await connection.query('SELECT id, name, location, latitude, longitude FROM turfs WHERE id = ? AND is_active = true', [venue_turf_id]);
      if (turfRows.length > 0) {
        resolvedVenueTurfId = turfRows[0].id;
        resolvedVenue = turfRows[0].name;
        resolvedLocation = turfRows[0].location;
        // Coordinates come from the venue, never from the device: "near me" must not depend on where the host
        // happened to be standing when they filled the form.
        resolvedLat = turfRows[0].latitude ?? null;
        resolvedLng = turfRows[0].longitude ?? null;
      }
    }
    // A host may also pick a point on the map for a venue that is not a Book Arena listing.
    if (resolvedLat === null && Number.isFinite(Number(body.latitude)) && Number.isFinite(Number(body.longitude))) {
      resolvedLat = Number(body.latitude);
      resolvedLng = Number(body.longitude);
    }

    // Generate unique slug and secure join token
    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    const slug = `${baseSlug}-${crypto.randomBytes(3).toString('hex')}`;
    const joinToken = crypto.randomBytes(16).toString('hex');

    // The fee and any coupon discount are worked out here, from the admin's settings and the coupon records.
    // `coupon_code` is the only thing the client gets a say in; the amounts are never read from the request.
    const priceQuote = await tournamentPricing.quote({
      hostType: req.tHost.type,
      hostId: ownerId,
      couponCode: body.coupon_code,
    });
    if (priceQuote.error && body.coupon_code) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: priceQuote.error });
    }
    const baseFee = priceQuote.base;
    const discountAmount = priceQuote.discount;
    const feeAmount = priceQuote.payable;
    const feeCurrency = priceQuote.currency;

    let razorpayOrderId = null;
    if (feeAmount > 0 && process.env.RAZORPAY_KEY_ID) {
      try {
        const order = await razorpay.orders.create({
          amount: toMinor(feeAmount, feeCurrency),
          currency: feeCurrency,
          receipt: `rcpt_tour_${Date.now()}`
        });
        razorpayOrderId = order.id;
      } catch (e) {
        console.error('Razorpay order creation skipped/failed:', e.message);
        await connection.rollback();
        return res.status(502).json({ success: false, error: 'Could not start the payment for the creation fee. Please try again.' });
      }
    }

    // A fee that is due but has no payment order must not silently become a free tournament.
    if (feeAmount > 0 && !razorpayOrderId) {
      await connection.rollback();
      return res.status(503).json({ success: false, error: 'Payments are not configured for tournament creation right now.' });
    }

    const initialStatus = feeAmount > 0 ? 'DRAFT' : 'REGISTRATION_OPEN';

    const [result] = await connection.query(`
      INSERT INTO tournaments (
        owner_id, owner_type, name, sport, banner, logo, description, venue, location, start_date, end_date,
        reg_open_date, reg_close_date, max_teams, max_players, max_participants, entry_fee, prize_pool_amount, creation_fee_amount, creation_fee_payment_status, visibility,
        format_type, participation_type, allow_user_teams, allow_user_join_team, players_per_team,
        substitute_limit, match_duration, break_duration, points_for_win, points_for_draw,
        points_for_loss, tie_breaker_rules, number_of_groups, qualification_rules,
        join_link_active, host_approval_required, status, slug, join_token, is_paid_to_admin, razorpay_order_id, venue_turf_id,
        latitude, longitude, open_registration, allow_team_registration, allow_individual_registration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      ownerId, req.tHost.type, name, sport, banner || null, logo || null, description || null, resolvedVenue, resolvedLocation, start_date, end_date,
      reg_open_date || null, reg_close_date || null, max_teams || null, max_players || null, max_participants || null, 0,
      prizePoolAmount,
      feeAmount, feeAmount > 0 ? 'PENDING' : 'NOT_REQUIRED',
      visibility || 'PUBLIC', format_type || 'Knockout', participation_type || 'TEAM',
      allow_user_teams !== undefined ? allow_user_teams : true,
      allow_user_join_team !== undefined ? allow_user_join_team : true,
      players_per_team || 11, substitute_limit || 5, match_duration || 60, break_duration || 15,
      points_for_win || 3, points_for_draw || 1, points_for_loss || 0,
      tie_breaker_rules || 'head_to_head,goal_diff,goals_scored', number_of_groups || 2, qualification_rules || 'top_2_per_group',
      joining_link_active !== undefined ? joining_link_active : true,
      host_approval_required !== undefined ? host_approval_required : true,
      initialStatus, slug, joinToken, feeAmount === 0, razorpayOrderId, resolvedVenueTurfId,
      resolvedLat, resolvedLng,
      open_registration ? 1 : 0,
      allow_team_registration === undefined ? 1 : (allow_team_registration ? 1 : 0),
      allow_individual_registration === undefined ? 1 : (allow_individual_registration ? 1 : 0)
    ]);

    // Auditable record of what this host was charged. Kept even if pricing changes later.
    if (feeAmount > 0 || discountAmount > 0) {
      await connection.query(
        `INSERT INTO tournament_fee_payments
           (tournament_id, payer_id, payer_role, razorpay_order_id, base_amount, discount_amount, amount, currency, offer_code, status, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, IF(? = 0, 'paid', 'created'), IF(? = 0, NOW(), NULL))`,
        [result.insertId, ownerId, req.tHost.type, razorpayOrderId, baseFee, discountAmount, feeAmount, feeCurrency,
         priceQuote.offer ? priceQuote.offer.code : null, feeAmount, feeAmount]);
    }

    if (feeAmount === 0 && priceQuote.offer && discountAmount > 0) {
      const claimed = await tournamentPricing.claimOffer(connection, {
        offerId: priceQuote.offer.id,
        tournamentId: result.insertId,
        userId: ownerId,
        userRole: req.tHost.type,
        discountAmount,
      });
      if (!claimed) {
        await connection.rollback();
        return res.status(409).json({ success: false, error: 'This coupon can no longer be used. Please check it and try again.' });
      }
    }

    await connection.commit();

    if (initialStatus === 'REGISTRATION_OPEN') fireNotification('tournament.created', { tournamentId: result.insertId });

    res.json({
      success: true,
      message: 'Tournament created successfully',
      tournament_id: result.insertId,
      slug,
      join_token: joinToken,
      invite_url: tournamentInviteUrl(joinToken),
      fee_required: feeAmount > 0,
      fee_amount: feeAmount,
      base_fee_amount: baseFee,
      discount_amount: discountAmount,
      currency: feeCurrency,
      coupon_code: priceQuote.offer ? priceQuote.offer.code : null,
      razorpay_order_id: razorpayOrderId,
      razorpay_key_id: feeAmount > 0 ? process.env.RAZORPAY_KEY_ID : undefined
    });

  } catch (error) {
    await connection.rollback();
    console.error('Error creating tournament:', error);
    res.status(500).json({ success: false, error: 'Failed to create tournament' });
  } finally {
    connection.release();
  }
});

// POST /api/tournaments/:id/join - User submits join request (Backend validations & transaction)
router.post('/:id/join', verifyToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const tournamentId = req.params.id;
    const userId = req.user.id;
    const { team_id, requested_team_name, jersey_number, position, bio } = req.body;

    // 1. Lock tournament row for state & capacity checks
    const [tournaments] = await connection.query('SELECT * FROM tournaments WHERE id = ? FOR UPDATE', [tournamentId]);
    if (tournaments.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }
    const t = tournaments[0];

    // Check status & join link active
    if (!t.join_link_active) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'Registration link is currently disabled' });
    }
    if (['CANCELLED', 'COMPLETED', 'REGISTRATION_CLOSED'].includes(t.status)) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'Tournament registration is closed' });
    }

    // Check dates if configured
    const today = new Date();
    if (t.reg_close_date && new Date(t.reg_close_date) < today) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: 'Registration deadline has passed' });
    }

    // 2. Prevent duplicate participation or multiple requests by same user
    const [existing] = await connection.query(
      'SELECT status FROM tournament_participants WHERE tournament_id = ? AND user_id = ?',
      [tournamentId, userId]
    );

    if (existing.length > 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        error: `You have already registered for this tournament (Status: ${existing[0].status})`
      });
    }

    // 3. Check capacity limit
    if (t.max_participants) {
      const [approvedCount] = await connection.query(
        "SELECT COUNT(*) as count FROM tournament_participants WHERE tournament_id = ? AND status = 'APPROVED'",
        [tournamentId]
      );
      if (approvedCount[0].count >= t.max_participants) {
        await connection.rollback();
        return res.status(400).json({ success: false, error: 'Tournament is full' });
      }
    }

    // 4. User info from DB
    const [users] = await connection.query('SELECT name, profile_pic as profile_photo FROM users WHERE id = ?', [userId]);
    const user = users[0] || {};

    const initialStatus = t.host_approval_required ? 'PENDING' : 'APPROVED';

    // 5. Insert participant record
    await connection.query(`
      INSERT INTO tournament_participants (
        tournament_id, user_id, team_id, player_name, profile_photo, jersey_number, position, bio, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      tournamentId, userId, team_id || null, user.name || 'Player', user.profile_photo || null,
      jersey_number || null, position || null, bio || null, initialStatus
    ]);

    // Insert join request tracking
    await connection.query(`
      INSERT INTO tournament_join_requests (tournament_id, user_id, type, requested_team_name, status)
      VALUES (?, ?, ?, ?, ?)
    `, [tournamentId, userId, team_id ? 'TEAM' : 'INDIVIDUAL', requested_team_name || null, initialStatus]);

    await connection.commit();

    if (initialStatus === 'PENDING') fireNotification('tournament.join_requested', { tournamentId, userId });

    res.json({
      success: true,
      message: initialStatus === 'APPROVED' ? 'Successfully registered for tournament!' : 'Join request submitted! Waiting for host approval.',
      status: initialStatus
    });

  } catch (error) {
    await connection.rollback();
    console.error('Error joining tournament:', error);
    res.status(500).json({ success: false, error: 'Failed to submit join request' });
  } finally {
    connection.release();
  }
});

// POST /api/tournaments/:id/track-view - Public page view counter (Phase 16 analytics)
router.post('/:id/track-view', async (req, res) => {
  try {
    await pool.query('UPDATE tournaments SET view_count = view_count + 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// POST /api/tournaments/:id/track-share - Share button counter (Phase 16 analytics)
router.post('/:id/track-share', async (req, res) => {
  try {
    await pool.query('UPDATE tournaments SET share_count = share_count + 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// GET /api/tournaments/:id/analytics - Organizer dashboard (Phase 16)
router.get('/:id/analytics', verifyToken, verifyHost, async (req, res) => {
  try {
    const tournamentId = req.params.id;

    const t = await findManageableTournament(pool, tournamentId, req.tHost);
    if (!t) {
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }

    const [[teamsRow]] = await pool.query('SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ?', [tournamentId]);
    const [[playersRow]] = await pool.query("SELECT COUNT(*) as count FROM tournament_participants WHERE tournament_id = ? AND status = 'APPROVED'", [tournamentId]);
    const [[regRow]] = await pool.query(
      "SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as revenue FROM tournament_registrations WHERE tournament_id = ? AND status = 'PAID'",
      [tournamentId]
    );
    const [[matchesRow]] = await pool.query(
      "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'FINISHED' THEN 1 ELSE 0 END) as completed FROM tournament_fixtures WHERE tournament_id = ?",
      [tournamentId]
    );
    const [[sponsorRow]] = await pool.query(
      'SELECT COUNT(*) as count, COALESCE(SUM(package_amount), 0) as revenue FROM tournament_sponsors WHERE tournament_id = ?',
      [tournamentId]
    );

    res.json({
      success: true,
      analytics: {
        teams: teamsRow.count,
        players: playersRow.count,
        registrations: regRow.count,
        registration_revenue: Number(regRow.revenue),
        matches_total: matchesRow.total || 0,
        matches_completed: Number(matchesRow.completed) || 0,
        matches_remaining: (matchesRow.total || 0) - (Number(matchesRow.completed) || 0),
        sponsors: sponsorRow.count,
        sponsor_revenue: Number(sponsorRow.revenue),
        views: t.view_count || 0,
        shares: t.share_count || 0,
      }
    });
  } catch (error) {
    console.error('Error computing tournament analytics:', error);
    res.status(500).json({ success: false, error: 'Failed to compute analytics' });
  }
});

// POST /api/tournaments/:id/regenerate-token - Host regenerates joining token
router.post('/:id/regenerate-token', verifyToken, verifyHost, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const newToken = crypto.randomBytes(16).toString('hex');

    const t = await findManageableTournament(pool, tournamentId, req.tHost, { columns: 'id' });
    if (!t) {
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }
    await pool.query('UPDATE tournaments SET join_token = ? WHERE id = ?', [newToken, tournamentId]);

    res.json({
      success: true,
      message: 'Joining link regenerated',
      join_token: newToken,
      invite_url: tournamentInviteUrl(newToken),
    });
  } catch (error) {
    console.error('Error regenerating join token:', error);
    res.status(500).json({ success: false, error: 'Failed to regenerate token' });
  }
});

// PATCH /api/tournaments/:id/toggle-link - Host enables/disables join link
router.patch('/:id/toggle-link', verifyToken, verifyHost, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const { active } = req.body;

    const t = await findManageableTournament(pool, tournamentId, req.tHost, { columns: 'id' });
    if (!t) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    await pool.query('UPDATE tournaments SET join_link_active = ? WHERE id = ?', [active !== undefined ? active : true, tournamentId]);

    res.json({ success: true, message: `Join link ${active ? 'enabled' : 'disabled'} successfully` });
  } catch (error) {
    console.error('Error toggling join link:', error);
    res.status(500).json({ success: false, error: 'Failed to toggle join link' });
  }
});

// PUT /api/tournaments/:id - Host (or admin) edits tournament details
const EDITABLE_FIELDS = ['name', 'description', 'venue', 'location', 'start_date', 'end_date', 'reg_open_date', 'reg_close_date',
  'max_teams', 'max_players', 'prize_pool_amount', 'visibility', 'host_approval_required', 'banner', 'logo',
  'open_registration', 'allow_team_registration', 'allow_individual_registration', 'join_link_active'];
router.put('/:id', verifyToken, verifyHost, async (req, res) => {
  try {
    const t = await findManageableTournament(pool, req.params.id, req.tHost, { columns: 'id, name' });
    if (!t) {
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }
    if (req.body.name !== undefined && !String(req.body.name).trim()) {
      return res.status(400).json({ success: false, error: 'Tournament name cannot be empty' });
    }
    if (req.body.visibility !== undefined && !['PUBLIC', 'PRIVATE'].includes(req.body.visibility)) {
      return res.status(400).json({ success: false, error: 'Visibility must be PUBLIC or PRIVATE' });
    }
    // Edits may send only some dates, so order-check against what is already stored.
    const [[stored]] = await pool.query('SELECT start_date, end_date, reg_open_date, reg_close_date FROM tournaments WHERE id = ?', [req.params.id]);
    const pad = (n) => String(n).padStart(2, '0');
    const asDate = (v) => (v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : null);
    const touchesDates = ['start_date', 'end_date', 'reg_open_date', 'reg_close_date'].some((f) => req.body[f] !== undefined);
    const dateCheck = !touchesDates ? { dates: {} } : validateTournamentDates({
      start_date: asDate(stored.start_date), end_date: asDate(stored.end_date),
      reg_open_date: asDate(stored.reg_open_date), reg_close_date: asDate(stored.reg_close_date),
      ...Object.fromEntries(['start_date', 'end_date', 'reg_open_date', 'reg_close_date']
        .filter((f) => req.body[f] !== undefined).map((f) => [f, req.body[f]])),
    }, { isCreate: false });
    if (dateCheck.error) {
      return res.status(400).json({ success: false, error: dateCheck.error });
    }
    const normalisedDates = dateCheck.dates;

    const updates = [];
    const params = [];
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] === undefined) continue;
      let value = req.body[field];
      if (value === '') value = null;
      if (field in normalisedDates) value = normalisedDates[field];
      if (['max_teams', 'max_players'].includes(field) && value !== null) value = parseInt(value) || null;
      if (field === 'prize_pool_amount') {
        value = Number(value);
        if (!Number.isFinite(value) || value < 0 || value > 9999999999.99) return res.status(400).json({ success: false, error: 'Prize pool must be a valid non-negative amount' });
      }
      if (field === 'name') value = String(value).trim();
      updates.push(field + ' = ?');
      params.push(value);
    }
    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No editable fields provided' });
    }
    params.push(req.params.id);
    await pool.query('UPDATE tournaments SET ' + updates.join(', ') + ' WHERE id = ?', params);

    try {
      await pool.query('INSERT INTO tournament_audit_logs (tournament_id, actor_id, action, entity, entity_id, new_value) VALUES (?, ?, ?, ?, ?, ?)',
        [req.params.id, req.tHost.id, 'UPDATE_TOURNAMENT', 'tournament', req.params.id, JSON.stringify(req.body)]);
    } catch (e) { /* audit is best-effort */ }

    res.json({ success: true, message: 'Tournament updated' });
  } catch (error) {
    console.error('Error updating tournament:', error);
    res.status(500).json({ success: false, error: 'Failed to update tournament' });
  }
});

// PATCH /api/tournaments/:id/status - Host (or admin) moves the tournament through its lifecycle
const HOST_SETTABLE_STATUSES = ['REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'UPCOMING', 'LIVE', 'COMPLETED', 'CANCELLED'];
router.patch('/:id/status', verifyToken, verifyHost, async (req, res) => {
  try {
    const { status } = req.body;
    if (!HOST_SETTABLE_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: 'Status must be one of: ' + HOST_SETTABLE_STATUSES.join(', ') });
    }
    const t = await findManageableTournament(pool, req.params.id, req.tHost, { columns: 'id, status, is_paid_to_admin' });
    if (!t) {
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }
    if (t.status === 'DRAFT' && !t.is_paid_to_admin && req.tHost.type !== 'admin') {
      return res.status(403).json({ success: false, error: 'Pay the platform creation fee before publishing this tournament' });
    }
    await pool.query('UPDATE tournaments SET status = ? WHERE id = ?', [status, req.params.id]);
    if (status === 'REGISTRATION_OPEN' && t.status === 'DRAFT') fireNotification('tournament.created', { tournamentId: req.params.id });
    else if (status === 'REGISTRATION_OPEN' && t.status !== 'REGISTRATION_OPEN') fireNotification('tournament.registration_reopened', { tournamentId: req.params.id });
    if (status === 'COMPLETED') fireNotification('tournament.completed', { tournamentId: req.params.id });
    try {
      await pool.query('INSERT INTO tournament_audit_logs (tournament_id, actor_id, action, entity, entity_id, prev_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.params.id, req.tHost.id, 'SET_STATUS', 'tournament', req.params.id, JSON.stringify({ status: t.status }), JSON.stringify({ status })]);
    } catch (e) { /* audit is best-effort */ }
    res.json({ success: true, message: 'Tournament is now ' + status.replace('_', ' ').toLowerCase(), status });
  } catch (error) {
    console.error('Error setting tournament status:', error);
    res.status(500).json({ success: false, error: 'Failed to update status' });
  }
});

// ----------------------------------------------------
// PAID TEAM REGISTRATION (Phase 7)
// ----------------------------------------------------

// Shared helper: creates the team + captain participant once a registration is confirmed (free or paid)
async function finalizeRegistration(registrationId, tournamentId, userId, teamName, tournament, paymentId = null) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [users] = await connection.query('SELECT name, profile_pic as profile_photo FROM users WHERE id = ?', [userId]);
    const user = users[0] || {};

    // Avoid a duplicate team name (e.g. a race with another registration); never block a paying customer.
    let finalName = teamName;
    const [dupe] = await connection.query(
      'SELECT id FROM tournament_teams WHERE tournament_id = ? AND LOWER(name) = LOWER(?)',
      [tournamentId, finalName]
    );
    if (dupe.length > 0) {
      finalName = `${teamName} (${registrationId})`;
    }

    const [teamResult] = await connection.query(`
      INSERT INTO tournament_teams (tournament_id, name, captain_id, status)
      VALUES (?, ?, ?, 'OPEN')
    `, [tournamentId, finalName, userId]);
    const teamId = teamResult.insertId;

    const initialStatus = tournament.host_approval_required ? 'PENDING' : 'APPROVED';

    const [participantInsert] = await connection.query(`
      INSERT INTO tournament_participants (tournament_id, user_id, team_id, player_name, profile_photo, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [tournamentId, userId, teamId, user.name || 'Captain', user.profile_photo || null, initialStatus]);

    await connection.query(
      `UPDATE tournament_registrations SET status = 'PAID', team_id = ?, razorpay_payment_id = COALESCE(?, razorpay_payment_id) WHERE id = ?`,
      [teamId, paymentId, registrationId]
    );

    await connection.commit();

    // the host hears about the new team; the captain hears back once they are approved (immediately, or when the host approves)
    fireNotification('tournament.registration_created', { tournamentId, registrationId });
    if (initialStatus === 'APPROVED') fireNotification('tournament.join_decided', { participantId: participantInsert.insertId });

    return teamId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// GET /api/tournaments/registrations/mine - User's own registration/payment history
router.get('/registrations/mine', verifyToken, async (req, res) => {
  try {
    const [registrations] = await pool.query(`
      SELECT r.*, t.name as tournament_name, t.slug as tournament_slug, t.sport, t.start_date
      FROM tournament_registrations r
      JOIN tournaments t ON r.tournament_id = t.id
      WHERE r.user_id = ?
      ORDER BY r.created_at DESC
    `, [req.user.id]);
    res.json({ success: true, registrations });
  } catch (error) {
    console.error('Error fetching registrations:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch registrations' });
  }
});

// GET /api/tournaments/:id/registrations - Host views team registrations & payment status
router.get('/:id/registrations', verifyToken, verifyHost, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const t = await findManageableTournament(pool, tournamentId, req.tHost, { columns: 'id' });
    if (!t) {
      return res.status(403).json({ success: false, error: 'Unauthorized or tournament not found' });
    }

    const [registrations] = await pool.query(`
      SELECT r.*, u.name as user_name, u.email as user_email
      FROM tournament_registrations r
      JOIN users u ON r.user_id = u.id
      WHERE r.tournament_id = ?
      ORDER BY r.created_at DESC
    `, [tournamentId]);

    res.json({ success: true, registrations });
  } catch (error) {
    console.error('Error fetching tournament registrations:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch registrations' });
  }
});

// POST /api/tournaments/:id/register - User registers (and pays for) a team
router.post('/:id/register', verifyToken, async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const userId = req.user.id;
    const { team_name } = req.body;

    if (!team_name || !team_name.trim()) {
      return res.status(400).json({ success: false, error: 'Team name is required' });
    }

    const [tournaments] = await pool.query('SELECT * FROM tournaments WHERE id = ?', [tournamentId]);
    if (tournaments.length === 0) {
      return res.status(404).json({ success: false, error: 'Tournament not found' });
    }
    const t = tournaments[0];

    if (t.status !== 'REGISTRATION_OPEN') {
      return res.status(400).json({ success: false, error: 'Registration is not open for this tournament' });
    }
    if (t.reg_close_date && new Date(t.reg_close_date) < new Date()) {
      return res.status(400).json({ success: false, error: 'Registration deadline has passed' });
    }

    // Prevent duplicate active/paid registration by same user for same tournament
    const [existing] = await pool.query(
      "SELECT id, status FROM tournament_registrations WHERE tournament_id = ? AND user_id = ? AND status IN ('PENDING', 'PAID')",
      [tournamentId, userId]
    );
    if (existing.length > 0) {
      return res.status(400).json({ success: false, error: `You already have a ${existing[0].status.toLowerCase()} registration for this tournament` });
    }

    // Reject an obviously duplicate team name up front, before any payment is collected
    const [dupeTeam] = await pool.query(
      'SELECT id FROM tournament_teams WHERE tournament_id = ? AND LOWER(name) = LOWER(?)',
      [tournamentId, team_name.trim()]
    );
    if (dupeTeam.length > 0) {
      return res.status(400).json({ success: false, error: 'A team with this name is already registered' });
    }

    // Enforce max teams (existing teams + registrations already paid)
    if (t.max_teams) {
      const [teamCount] = await pool.query('SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ?', [tournamentId]);
      if (teamCount[0].count >= t.max_teams) {
        return res.status(400).json({ success: false, error: 'Tournament has reached its maximum number of teams' });
      }
    }

  // Player/team entry is free; legacy entry_fee values remain unchanged on historical tournaments.
  const amount = 0;
    let razorpayOrderId = null;

    if (amount > 0) {
      const order = await razorpay.orders.create({
        amount: Math.round(amount * 100),
        currency: 'INR',
        receipt: `tourn_reg_${tournamentId}_${userId}_${Date.now()}`,
      });
      razorpayOrderId = order.id;
    }

    const [result] = await pool.query(`
      INSERT INTO tournament_registrations (tournament_id, user_id, team_name, amount, razorpay_order_id, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [tournamentId, userId, team_name.trim(), amount, razorpayOrderId, amount > 0 ? 'PENDING' : 'PAID']);

    const registrationId = result.insertId;

    // Free tournaments: finalize immediately, no payment step needed
    if (amount === 0) {
      const teamId = await finalizeRegistration(registrationId, tournamentId, userId, team_name.trim(), t);
      return res.json({ success: true, message: 'Registered successfully!', registration_id: registrationId, team_id: teamId, requires_payment: false });
    }

    res.json({
      success: true,
      requires_payment: true,
      registration_id: registrationId,
      order_id: razorpayOrderId,
      amount,
      currency: 'INR',
      key_id: process.env.RAZORPAY_KEY_ID || 'dummy_key',
    });
  } catch (error) {
    console.error('Error registering for tournament:', error);
    res.status(500).json({ success: false, error: 'Failed to register for tournament' });
  }
});

// POST /api/tournaments/registrations/:regId/verify - Verify payment & finalize team registration
router.post('/registrations/:regId/verify', verifyToken, async (req, res) => {
  try {
    const { regId } = req.params;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const [regs] = await pool.query('SELECT * FROM tournament_registrations WHERE id = ? AND user_id = ?', [regId, req.user.id]);
    if (regs.length === 0) {
      return res.status(404).json({ success: false, error: 'Registration not found' });
    }
    const reg = regs[0];

    if (reg.status === 'PAID') {
      return res.json({ success: true, message: 'Already verified', team_id: reg.team_id });
    }

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');

    if (expectedSignature !== razorpay_signature || razorpay_order_id !== reg.razorpay_order_id) {
      await pool.query("UPDATE tournament_registrations SET status = 'FAILED', razorpay_payment_id = ? WHERE id = ?", [razorpay_payment_id || null, regId]);
      return res.status(400).json({ success: false, error: 'Payment verification failed' });
    }

    const [tournaments] = await pool.query('SELECT * FROM tournaments WHERE id = ?', [reg.tournament_id]);
    const t = tournaments[0];

    const teamId = await finalizeRegistration(regId, reg.tournament_id, reg.user_id, reg.team_name, t, razorpay_payment_id);

    res.json({ success: true, message: 'Payment verified, team registered!', team_id: teamId });
  } catch (error) {
    console.error('Error verifying tournament registration:', error);
    res.status(500).json({ success: false, error: 'Failed to verify payment' });
  }
});

// POST /api/tournaments/:id/verify-creation-fee - Verify platform hosting fee payment & publish tournament
router.post('/:id/verify-creation-fee', verifyToken, verifyHost, async (req, res) => {
  const t = await findManageableTournament(pool, req.params.id, req.tHost);
  if (!t) return res.status(404).json({ success: false, error: 'Tournament not found or not yours to manage' });
  const r = await runFeeVerification(t, req.body || {});
  res.status(r.http).json(r.json);
});

// The hosted checkout page (Expo Go, and any browser payment) cannot send the app's login. The order id inside the
// signed payment is bound to exactly one tournament's fee ledger row, so the same signature + gateway checks apply
// and the money can only ever publish that one tournament.
router.post('/creation-fee/hosted/verify', async (req, res) => {
  try {
    const { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    const [[ledger]] = await pool.query('SELECT * FROM tournament_fee_payments WHERE razorpay_order_id = ? LIMIT 1', [razorpay_order_id]);
    const tournamentId = (ledger && ledger.tournament_id) || parseInt(booking_id, 10);
    if (!tournamentId) return res.status(404).json({ success: false, error: 'Unknown payment' });
    const [[t]] = await pool.query('SELECT * FROM tournaments WHERE id = ?', [tournamentId]);
    if (!t) return res.status(404).json({ success: false, error: 'Tournament not found' });
    const r = await runFeeVerification(t, { razorpay_order_id, razorpay_payment_id, razorpay_signature });
    res.status(r.http).json(r.json);
  } catch (error) {
    console.error('hosted creation-fee verify error:', error);
    res.status(500).json({ success: false, error: 'Failed to verify creation fee payment' });
  }
});

// The host closed the payment window. Nothing to undo (the tournament simply stays a DRAFT); this just marks the
// open attempt so the admin's reconciliation list does not show it as still in flight.
router.post('/creation-fee/hosted/cancel', async (req, res) => {
  try {
    const { razorpay_order_id, booking_id } = req.body || {};
    if (razorpay_order_id) {
      await pool.query("UPDATE tournament_fee_payments SET status = 'cancelled' WHERE razorpay_order_id = ? AND status = 'created'", [razorpay_order_id]);
    } else if (booking_id) {
      await pool.query("UPDATE tournament_fee_payments SET status = 'cancelled' WHERE tournament_id = ? AND status = 'created'", [booking_id]);
    }
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});

/**
 * The one place a creation fee is ever accepted. Signature -> gateway -> amount -> credit once.
 * Returns { http, json } so both the signed-in route and the hosted page share exactly these checks.
 */
async function runFeeVerification(t, { razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const connection = await pool.getConnection();
  try {
    const tournamentId = t.id;

    // Already verified: hand back the same receipt instead of charging or publishing anything twice.
    if (t.is_paid_to_admin) {
      const [[led]] = await pool.query("SELECT * FROM tournament_fee_payments WHERE tournament_id = ? AND status = 'paid' LIMIT 1", [tournamentId]);
      return { http: 200, json: { success: true, message: 'Platform creation fee is already verified.', receipt: feeReceipt(t, led) } };
    }

    if (!razorpay_order_id || !razorpay_payment_id) {
      return { http: 400, json: { success: false, error: 'Payment details are missing' } };
    }

    // The order must be the one this tournament was created with.
    const [[ledger]] = await pool.query('SELECT * FROM tournament_fee_payments WHERE tournament_id = ? ORDER BY id DESC LIMIT 1', [tournamentId]);
    if (!ledger || !ledger.razorpay_order_id) {
      return { http: 409, json: { success: false, error: 'This draft has no valid creation-fee order. Please contact support.' } };
    }
    const expectedOrder = ledger.razorpay_order_id;
    if (razorpay_order_id !== expectedOrder || t.razorpay_order_id !== expectedOrder) {
      return { http: 400, json: { success: false, error: 'This payment belongs to a different order' } };
    }

    // 1. Signature proves the checkout that completed really was for this order. Never skipped when a secret is
    //    configured — a missing signature used to mean "no check at all", which published the tournament for free.
    if (!process.env.RAZORPAY_KEY_SECRET) {
      return { http: 503, json: { success: false, error: 'Payment verification is not configured on the server' } };
    }
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (!razorpay_signature || expectedSignature !== razorpay_signature) {
      await markFeeFailed(tournamentId, razorpay_order_id);
      return { http: 400, json: { success: false, error: 'Creation fee payment signature verification failed' } };
    }

    // 2. Ask Razorpay what it actually captured. The signature only proves the checkout completed.
    let payment;
    try {
      payment = await require('../services/routeProvider').fetchPayment(razorpay_payment_id);
    } catch (e) {
      return { http: 502, json: { success: false, error: 'Could not confirm this payment with the gateway. It will be confirmed automatically once available.' } };
    }
    if (!payment || payment.order_id !== razorpay_order_id) {
      return { http: 400, json: { success: false, error: 'This payment does not belong to this order' } };
    }
    if (payment.status !== 'captured') {
      await markFeeFailed(tournamentId, razorpay_order_id);
      return { http: 400, json: { success: false, error: `Payment is ${payment.status}; the tournament remains an unpaid draft.` } };
    }
    const expectedCurrency = String(ledger.currency || '').toUpperCase();
    if (!expectedCurrency || String(payment.currency || '').toUpperCase() !== expectedCurrency) {
      return { http: 400, json: { success: false, error: 'The payment currency does not match the creation fee' } };
    }
    let expectedMinor;
    try {
      expectedMinor = toMinor(ledger.amount, expectedCurrency);
    } catch {
      return { http: 409, json: { success: false, error: 'The creation-fee amount is invalid. Please contact support.' } };
    }
    if (expectedMinor <= 0 || Number(payment.amount) !== expectedMinor) {
      return { http: 400, json: { success: false, error: 'The payment amount does not match the creation fee' } };
    }

    // 3. Credit it once. UNIQUE(razorpay_payment_id) on the ledger makes a repeated call a no-op.
    await connection.beginTransaction();
    const [upd] = await connection.query(
      `UPDATE tournament_fee_payments
          SET status = 'paid', razorpay_payment_id = ?, verified_at = NOW()
        WHERE tournament_id = ? AND status <> 'paid'`,
      [razorpay_payment_id, tournamentId]);

    if (upd.affectedRows && ledger && ledger.offer_code) {
      const [[offer]] = await connection.query('SELECT id FROM tournament_offers WHERE code = ? LIMIT 1', [ledger.offer_code]);
      if (offer) {
        await tournamentPricing.claimOffer(connection, {
          offerId: offer.id,
          tournamentId,
          userId: ledger.payer_id,
          userRole: ledger.payer_role || 'user',
          discountAmount: Number(ledger.discount_amount) || 0,
        });
      }
    }

    await connection.query(
      `UPDATE tournaments SET is_paid_to_admin = true, creation_fee_payment_status = 'PAID', status = 'REGISTRATION_OPEN', razorpay_payment_id = ?
        WHERE id = ? AND is_paid_to_admin = false`,
      [razorpay_payment_id, tournamentId]);
    await connection.commit();

    // Published now, so the "a tournament opened near you" notification fires here rather than at creation.
    try { fireNotification('tournament.created', { tournamentId: Number(tournamentId) }); } catch { }

    const [[freshLedger]] = await pool.query('SELECT * FROM tournament_fee_payments WHERE tournament_id = ? ORDER BY id DESC LIMIT 1', [tournamentId]);
    return {
      http: 200,
      json: {
        success: true,
        message: 'Platform fee verified! Your tournament is now published.',
        receipt: feeReceipt({ ...t, razorpay_payment_id }, freshLedger),
      },
    };
  } catch (error) {
    try { await connection.rollback(); } catch { }
    console.error('Error verifying creation fee:', error);
    return { http: 500, json: { success: false, error: 'Failed to verify creation fee payment' } };
  } finally {
    connection.release();
  }
}

/** Marks the open fee attempt as failed. Never touches a row that is already paid. */
async function markFeeFailed(tournamentId, orderId) {
  try {
    await pool.query(
      "UPDATE tournament_fee_payments SET status = 'failed' WHERE tournament_id = ? AND status = 'created' AND (razorpay_order_id = ? OR razorpay_order_id IS NULL)",
      [tournamentId, orderId || null]);
  } catch (error) {
    console.error('Could not mark tournament creation-fee attempt as failed:', error);
  }
}

/** One receipt shape, used by both the fresh verification and the "already paid" reply. */
function feeReceipt(t, ledger) {
  return {
    payment_reference: t.razorpay_payment_id || (ledger && ledger.razorpay_payment_id) || null,
    order_id: (ledger && ledger.razorpay_order_id) || t.razorpay_order_id || null,
    payment_date: (ledger && ledger.verified_at) || new Date().toISOString(),
    tournament_id: t.id,
    tournament_name: t.name,
    sport: t.sport,
    base_amount: ledger ? Number(ledger.base_amount) : null,
    discount_amount: ledger ? Number(ledger.discount_amount) : 0,
    amount: ledger ? Number(ledger.amount) : null,
    currency: (ledger && ledger.currency) || 'INR',
    coupon_code: (ledger && ledger.offer_code) || null,
    status: 'PAID',
  };
}


// ==================================================================================================
// OPEN REGISTRATION — an unknown team or a lone player asks to join through the invite link / QR code.
// No account is required: a name and a contact number are enough, because most club players have neither.
// Nothing here joins the tournament by itself; every submission becomes a PENDING request for the host.
// ==================================================================================================
const REG_BATTING = ['RIGHT', 'LEFT', 'UNSPECIFIED'];

function regPhone(raw, { required }) {
  const digits = String(raw === undefined || raw === null ? '' : raw).replace(/[^0-9]/g, '');
  if (!digits) return required ? { error: 'A contact number is required' } : { value: null };
  if (digits.length < 7 || digits.length > 15) return { error: 'Enter a valid contact number' };
  return { value: digits };
}
const regRole = (v, sport) => roleForSport(v, sport);
const regBatting = (v, sport) => String(sport || '').trim().toLowerCase() === 'cricket' && REG_BATTING.includes(v) ? v : 'UNSPECIFIED';

/** The tournament behind an invite token, with the same state rules the invite page shows. */
async function openTournamentFor(token) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(token || ''))) return { error: 'Invalid invitation link', status: 404 };
  const [[t]] = await pool.query('SELECT * FROM tournaments WHERE join_token = ?', [token]);
  if (!t) return { error: 'Invalid invitation link', status: 404 };
  if (!t.join_link_active) return { error: 'The host has turned this invitation link off', status: 403 };
  if (!t.open_registration) return { error: 'This tournament is not accepting outside registrations', status: 403 };
  if (t.status === 'CANCELLED') return { error: 'This tournament was cancelled', status: 400 };
  if (t.status === 'COMPLETED') return { error: 'This tournament has finished', status: 400 };
  if (t.status !== 'REGISTRATION_OPEN') return { error: 'Registration is closed for this tournament', status: 400 };
  const deadline = tournamentPricing.ymd(t.reg_close_date);
  if (deadline && deadline < tournamentPricing.todayYmd()) return { error: 'The registration deadline has passed', status: 400 };
  return { tournament: t };
}

// POST /api/tournaments/join/:token/register-team
router.post('/join/:token/register-team', optionalAuthForInvite, async (req, res) => {
  try {
    const found = await openTournamentFor(req.params.token);
    if (found.error) return res.status(found.status).json({ success: false, error: found.error });
    const t = found.tournament;
    if (!t.allow_team_registration) return res.status(403).json({ success: false, error: 'This tournament only accepts individual players' });

    const b = req.body || {};
    const teamName = String(b.team_name || '').trim();
    const captainName = String(b.captain_name || '').trim();
    if (!teamName) return res.status(400).json({ success: false, error: 'Team name is required' });
    if (!captainName) return res.status(400).json({ success: false, error: "The captain's name is required" });
    const phone = regPhone(b.contact_phone, { required: true });
    if (phone.error) return res.status(400).json({ success: false, error: phone.error });

    const rawRoster = Array.isArray(b.roster) ? b.roster : [];
    const roster = [];
    for (const r of rawRoster) {
      const name = String((r && (r.player_name || r.name)) || '').trim();
      if (!name) return res.status(400).json({ success: false, error: 'Every player in the roster needs a name' });
      const p = regPhone(r.phone, { required: false });
      if (p.error) return res.status(400).json({ success: false, error: `${name}: ${p.error}` });
      roster.push({
        player_name: name.slice(0, 120), phone: p.value, player_role: regRole(r.player_role, t.sport),
        batting_style: regBatting(r.batting_style, t.sport), bowling_style: isCricketSport(t.sport) && r.bowling_style ? String(r.bowling_style).slice(0, 40) : null,
        is_captain: !!r.is_captain, is_vice_captain: !!r.is_vice_captain, is_substitute: !!r.is_substitute,
      });
    }
    const names = roster.map((r) => r.player_name.toLowerCase());
    if (new Set(names).size !== names.length) return res.status(400).json({ success: false, error: 'The same player is listed twice' });

    const squadLimit = Number(t.players_per_team) || null;
    const subLimit = t.substitute_limit === null ? null : Number(t.substitute_limit);
    const mains = roster.filter((r) => !r.is_substitute).length;
    const subs = roster.filter((r) => r.is_substitute).length;
    if (squadLimit && mains > squadLimit) return res.status(400).json({ success: false, error: `A team may name at most ${squadLimit} players` });
    if (subLimit !== null && subs > subLimit) return res.status(400).json({ success: false, error: subLimit === 0 ? 'This tournament does not allow substitutes' : `At most ${subLimit} substitutes are allowed` });

    // capacity: approved teams + already-approved requests
    if (t.max_teams) {
      const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM tournament_teams WHERE tournament_id = ?', [t.id]);
      if (Number(c.n) >= Number(t.max_teams)) return res.status(400).json({ success: false, error: 'All team places are taken' });
    }

    const [[dupeTeam]] = await pool.query('SELECT id FROM tournament_teams WHERE tournament_id = ? AND LOWER(name) = LOWER(?) LIMIT 1', [t.id, teamName]);
    if (dupeTeam) return res.status(400).json({ success: false, error: 'A team with that name is already in this tournament' });

    try {
      const [ins] = await pool.query(
        `INSERT INTO tournament_registration_requests
           (tournament_id, kind, user_id, team_name, captain_name, contact_phone, city, logo, roster)
         VALUES (?, 'TEAM', ?, ?, ?, ?, ?, ?, ?)`,
        [t.id, req.inviteUserId || null, teamName, captainName, phone.value,
         b.city ? String(b.city).trim().slice(0, 120) : null,
         b.logo ? String(b.logo).slice(0, 500) : null,
         JSON.stringify(roster)]);
      try { fireNotification('tournament.registration_request', { requestId: ins.insertId, tournamentId: t.id }); } catch { }
      res.json({ success: true, message: 'Your team has been sent to the organizer for approval.', request_id: ins.insertId, status: 'PENDING' });
    } catch (e) {
      if (/duplicate/i.test(e.message)) return res.status(400).json({ success: false, error: 'A request for this team has already been submitted' });
      throw e;
    }
  } catch (error) {
    console.error('Error registering team:', error);
    res.status(500).json({ success: false, error: 'Failed to submit the registration' });
  }
});

// POST /api/tournaments/join/:token/register-player
router.post('/join/:token/register-player', optionalAuthForInvite, async (req, res) => {
  try {
    const found = await openTournamentFor(req.params.token);
    if (found.error) return res.status(found.status).json({ success: false, error: found.error });
    const t = found.tournament;
    if (!t.allow_individual_registration) return res.status(403).json({ success: false, error: 'This tournament only accepts full teams' });

    const b = req.body || {};
    const name = String(b.player_name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Your name is required' });
    const phone = regPhone(b.contact_phone, { required: !req.inviteUserId });
    if (phone.error) return res.status(400).json({ success: false, error: phone.error });

    try {
      const [ins] = await pool.query(
        `INSERT INTO tournament_registration_requests
           (tournament_id, kind, user_id, player_name, contact_phone, city, player_role, batting_style, bowling_style, experience)
         VALUES (?, 'INDIVIDUAL', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.id, req.inviteUserId || null, name.slice(0, 120), phone.value,
         b.city ? String(b.city).trim().slice(0, 120) : null,
         regRole(b.player_role, t.sport), regBatting(b.batting_style, t.sport),
         isCricketSport(t.sport) && b.bowling_style ? String(b.bowling_style).slice(0, 40) : null,
         b.experience ? String(b.experience).trim().slice(0, 255) : null]);
      try { fireNotification('tournament.registration_request', { requestId: ins.insertId, tournamentId: t.id }); } catch { }
      res.json({ success: true, message: 'Your request has been sent to the organizer.', request_id: ins.insertId, status: 'PENDING' });
    } catch (e) {
      if (/duplicate/i.test(e.message)) return res.status(400).json({ success: false, error: 'You have already asked to join this tournament' });
      throw e;
    }
  } catch (error) {
    console.error('Error registering player:', error);
    res.status(500).json({ success: false, error: 'Failed to submit the request' });
  }
});

// ==================================================================================================
// THE ORGANIZER'S APPROVAL DASHBOARD
// ==================================================================================================

// GET /api/tournaments/:id/registration-requests?status=PENDING
router.get('/:id/registration-requests', verifyToken, verifyHost, async (req, res) => {
  try {
    const t = await findManageableTournament(pool, req.params.id, req.tHost, { columns: 'id' });
    if (!t) return res.status(404).json({ success: false, error: 'Tournament not found or not yours to manage' });

    const params = [req.params.id];
    let where = 'WHERE tournament_id = ?';
    const status = String(req.query.status || '').toUpperCase();
    if (['PENDING', 'APPROVED', 'REJECTED', 'WAITLISTED'].includes(status)) { where += ' AND status = ?'; params.push(status); }

    const [rows] = await pool.query(`SELECT * FROM tournament_registration_requests ${where} ORDER BY id DESC LIMIT 300`, params);
    // the host IS entitled to the applicant's contact details — that is the point of the dashboard
    const requests = rows.map((r) => ({ ...r, roster: parseRoster(r.roster) }));
    const [[counts]] = await pool.query(
      `SELECT
         SUM(status = 'PENDING') AS pending, SUM(status = 'APPROVED') AS approved,
         SUM(status = 'REJECTED') AS rejected, SUM(status = 'WAITLISTED') AS waitlisted
       FROM tournament_registration_requests WHERE tournament_id = ?`, [req.params.id]);
    res.json({
      success: true,
      requests,
      counts: {
        pending: Number(counts.pending) || 0, approved: Number(counts.approved) || 0,
        rejected: Number(counts.rejected) || 0, waitlisted: Number(counts.waitlisted) || 0,
      },
    });
  } catch (error) {
    console.error('Error fetching registration requests:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch requests' });
  }
});

function parseRoster(raw) {
  if (!raw) return [];
  try { const r = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(r) ? r : []; } catch { return []; }
}

// PATCH /api/tournaments/:id/registration-requests/:requestId — approve / reject / waitlist
router.patch('/:id/registration-requests/:requestId', verifyToken, verifyHost, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const decision = String((req.body || {}).status || '').toUpperCase();
    if (!['APPROVED', 'REJECTED', 'WAITLISTED'].includes(decision)) {
      connection.release();
      return res.status(400).json({ success: false, error: 'Decision must be APPROVED, REJECTED or WAITLISTED' });
    }
    const reason = (req.body || {}).reason ? String(req.body.reason).trim().slice(0, 255) : null;

    await connection.beginTransaction();
    const t = await findManageableTournament(connection, req.params.id, req.tHost,
      { columns: 'id, max_teams, players_per_team, substitute_limit', forUpdate: true });
    if (!t) { await connection.rollback(); connection.release(); return res.status(404).json({ success: false, error: 'Tournament not found or not yours to manage' }); }

    const [[r]] = await connection.query(
      'SELECT * FROM tournament_registration_requests WHERE id = ? AND tournament_id = ? FOR UPDATE',
      [req.params.requestId, req.params.id]);
    if (!r) { await connection.rollback(); connection.release(); return res.status(404).json({ success: false, error: 'Request not found' }); }
    if (r.status === decision) {
      await connection.rollback(); connection.release();
      return res.json({ success: true, message: `Already ${decision.toLowerCase()}`, unchanged: true });
    }
    if (r.status === 'APPROVED') {
      await connection.rollback(); connection.release();
      return res.status(409).json({ success: false, error: 'This request was already approved; the team or player is in the tournament.' });
    }

    let createdTeamId = null;
    let createdParticipantId = null;

    if (decision === 'APPROVED') {
      if (r.kind === 'TEAM') {
        if (t.max_teams) {
          const [[c]] = await connection.query('SELECT COUNT(*) AS n FROM tournament_teams WHERE tournament_id = ?', [t.id]);
          if (Number(c.n) >= Number(t.max_teams)) {
            await connection.rollback(); connection.release();
            return res.status(400).json({ success: false, error: 'All team places are taken. Reject or waitlist this request instead.' });
          }
        }
        const [[clash]] = await connection.query('SELECT id FROM tournament_teams WHERE tournament_id = ? AND LOWER(name) = LOWER(?) LIMIT 1', [t.id, r.team_name]);
        if (clash) {
          await connection.rollback(); connection.release();
          return res.status(400).json({ success: false, error: 'A team with that name is already in the tournament' });
        }
        const [team] = await connection.query(
          "INSERT INTO tournament_teams (tournament_id, name, logo, captain_id, status) VALUES (?, ?, ?, ?, 'OPEN')",
          [t.id, r.team_name, r.logo || null, r.user_id || null]);
        createdTeamId = team.insertId;

        const roster = parseRoster(r.roster);
        // the captain who submitted the form is a player too, unless they already named themselves
        const listed = roster.some((p) => String(p.player_name || '').trim().toLowerCase() === String(r.captain_name || '').trim().toLowerCase());
        const toInsert = listed ? roster : [{ player_name: r.captain_name, phone: r.contact_phone, player_role: 'PLAYER', batting_style: 'UNSPECIFIED', is_captain: true }, ...roster];
        for (const p of toInsert) {
          await connection.query(
            `INSERT INTO tournament_participants
               (tournament_id, user_id, team_id, player_name, phone, player_role, batting_style, bowling_style,
                is_captain, is_vice_captain, is_substitute, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED')`,
            [t.id, null, createdTeamId, String(p.player_name).slice(0, 120), p.phone || null,
             roleForSport(p.player_role, t.sport),
             REG_BATTING.includes(p.batting_style) ? p.batting_style : 'UNSPECIFIED',
             p.bowling_style || null, p.is_captain ? 1 : 0, p.is_vice_captain ? 1 : 0, p.is_substitute ? 1 : 0]);
        }
      } else {
        // an individual joins the player pool; the host assigns a team afterwards
        const [p] = await connection.query(
          `INSERT INTO tournament_participants
             (tournament_id, user_id, team_id, player_name, phone, player_role, batting_style, bowling_style, status)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'APPROVED')`,
          [t.id, r.user_id || null, r.player_name, r.contact_phone, r.player_role, r.batting_style, r.bowling_style]);
        createdParticipantId = p.insertId;
      }
    }

    await connection.query(
      `UPDATE tournament_registration_requests
          SET status = ?, decision_reason = ?, decided_by = ?, decided_by_type = ?, decided_at = NOW(),
              created_team_id = COALESCE(?, created_team_id), created_participant_id = COALESCE(?, created_participant_id)
        WHERE id = ?`,
      [decision, reason, req.tHost.id, req.tHost.type, createdTeamId, createdParticipantId, r.id]);
    await connection.commit();

    try { fireNotification('tournament.registration_decided', { requestId: r.id, tournamentId: t.id, status: decision }); } catch { }
    res.json({
      success: true,
      message: decision === 'APPROVED'
        ? (r.kind === 'TEAM' ? `${r.team_name} is in the tournament` : `${r.player_name} has been approved`)
        : `Request ${decision.toLowerCase()}`,
      team_id: createdTeamId,
      participant_id: createdParticipantId,
    });
  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error('Error deciding registration request:', error);
    res.status(500).json({ success: false, error: 'Failed to record the decision' });
  } finally {
    connection.release();
  }
});

module.exports = router;
