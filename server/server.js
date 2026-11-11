const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const pool = require('./config/db');

const app = express();
const PORT = process.env.PORT || 5000;

// Ensure required tables exist for Find Players features (idempotent).
// This prevents runtime failures if migrations were not executed on a fresh DB.
async function ensureFindPlayersTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS player_availability (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        sport_type VARCHAR(50) NOT NULL,
        turf_id INT,
        preferred_location VARCHAR(300),
        availability_start TIME NOT NULL,
        availability_end TIME NOT NULL,
        availability_date DATE NOT NULL,
        role VARCHAR(50),
        skill_level ENUM('beginner', 'intermediate', 'advanced', 'all') DEFAULT 'all',
        status ENUM('active', 'expired', 'cancelled') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (user_id),
        INDEX (status),
        INDEX (availability_date),
        INDEX (sport_type)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS player_invites (
        id INT AUTO_INCREMENT PRIMARY KEY,
        match_id INT NOT NULL,
        availability_id INT NOT NULL,
        status ENUM('pending', 'accepted', 'declined') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    console.error('⚠️ Failed to ensure Find Players tables:', e.message);
  }
}

ensureFindPlayersTables();

// Ensure additional columns needed for "Need Players for This Slot" flow.
async function ensureMatchRequestEnhancements() {
  const isDuplicateColumnErr = (e) =>
    /Duplicate column name|already exists/i.test(String(e?.message || ''));

  async function ensureColumn(table, columnSql) {
    try {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
    } catch (e) {
      if (!isDuplicateColumnErr(e)) {
        console.error(`⚠️ Failed to add column on ${table}: ${columnSql}`, e.message);
      }
    }
  }

  async function ensureIndex(sql) {
    try {
      await pool.query(sql);
    } catch (e) {
      // TiDB/MySQL variants: ignore "already exists" errors
      if (!/Duplicate key name|already exists/i.test(String(e?.message || ''))) {
        console.error('⚠️ Failed to ensure index:', e.message);
      }
    }
  }

  try {
    // player_requests enhancements
    await ensureColumn('player_requests', "share_token VARCHAR(64)");
    await ensureColumn('player_requests', "booking_time_slot VARCHAR(120)");
    await ensureColumn('player_requests', "contact_phone VARCHAR(30)");
    await ensureColumn('player_requests', "contribution_amount DECIMAL(10,2) DEFAULT 0");
    await ensureColumn('player_requests', "booking_total_amount DECIMAL(10,2) DEFAULT 0");
    await ensureColumn('player_requests', "note VARCHAR(500)");

    await ensureIndex('CREATE UNIQUE INDEX idx_player_requests_share_token ON player_requests (share_token)');

    // match_players payment tracking
    await ensureColumn('match_players', "amount_paid DECIMAL(10,2) DEFAULT 0");
    await ensureColumn('match_players', "razorpay_order_id VARCHAR(64)");
    await ensureColumn('match_players', "razorpay_payment_id VARCHAR(64)");
    await ensureColumn('match_players', "razorpay_signature VARCHAR(128)");

    await ensureIndex('CREATE INDEX idx_match_players_match_payment ON match_players (match_id, payment_status)');
    // join-link reservations + confirmation time, and "one payment can never be credited twice"
    await ensureColumn('match_players', "reserved_until DATETIME NULL");
    await ensureColumn('match_players', "confirmed_at DATETIME NULL");
    await ensureIndex('CREATE UNIQUE INDEX idx_match_players_payment_id ON match_players (razorpay_payment_id)');
    await ensureIndex('CREATE INDEX idx_match_players_order_id ON match_players (razorpay_order_id)');

    // bookings link + applied offset
    await ensureColumn('bookings', 'match_request_id INT');
    await ensureColumn('bookings', "contribution_offset DECIMAL(10,2) DEFAULT 0");
    await ensureColumn('bookings', "razorpay_order_id VARCHAR(64)");
    await ensureIndex('CREATE INDEX idx_bookings_match_request_id ON bookings (match_request_id)');

    // turf photo enhancements
    await ensureColumn('turfs', "photos JSON");
    await ensureColumn('turfs', "coverImage VARCHAR(500)");
    await ensureColumn('turfs', "photosCount INT DEFAULT 0");
  } catch (e) {
    console.error('⚠️ Failed to ensure match request enhancements:', e.message);
  }
}

ensureMatchRequestEnhancements();

// Ensure coupon enhancements needed for owner/admin coupon rules (idempotent).
async function ensureCouponEnhancements() {
  const isDuplicateColumnErr = (e) =>
    /Duplicate column name|already exists/i.test(String(e?.message || ''));

  async function ensureColumn(table, columnSql) {
    try {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
    } catch (e) {
      if (!isDuplicateColumnErr(e)) {
        console.error(`⚠️ Failed to add column on ${table}: ${columnSql}`, e.message);
      }
    }
  }

  async function ensureIndex(sql) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (!/Duplicate key name|already exists/i.test(String(e?.message || ''))) {
        console.error('⚠️ Failed to ensure index:', e.message);
      }
    }
  }

  try {
    // Owner coupons: extra validation fields
    await ensureColumn('coupons', "valid_from DATE");
    await ensureColumn('coupons', "valid_until DATE");
    await ensureColumn('coupons', "max_discount_cap DECIMAL(10,2) DEFAULT NULL");
    await ensureColumn('coupons', "per_user_limit INT DEFAULT NULL");
    await ensureColumn('coupons', "court_id INT DEFAULT NULL");

    // Coupon usage: track user_id for per-user limits (nullable for legacy rows)
    await ensureColumn('coupon_usages', "user_id INT DEFAULT NULL");
    await ensureIndex('CREATE INDEX idx_coupon_usages_user_id ON coupon_usages (user_id)');
  } catch (e) {
    console.error('⚠️ Failed to ensure coupon enhancements:', e.message);
  }
}

ensureCouponEnhancements();

// Ensure venue billing models, status, and owner deletion columns exist (idempotent)
async function ensureAdminAndVenueEnhancements() {
  const isDuplicateColumnErr = (e) =>
    /Duplicate column name|already exists/i.test(String(e?.message || ''));

  async function ensureColumn(table, columnSql) {
    try {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
    } catch (e) {
      if (!isDuplicateColumnErr(e)) {
        console.error(`⚠️ Failed to add column on ${table}: ${columnSql}`, e.message);
      }
    }
  }

  try {
    // turfs billing & status columns
    await ensureColumn('turfs', "billing_model ENUM('MONTHLY', 'PERCENTAGE') DEFAULT 'PERCENTAGE'");
    await ensureColumn('turfs', "commission_percentage DECIMAL(5,2) DEFAULT 5.00");
    await ensureColumn('turfs', "subscription_status VARCHAR(50) DEFAULT 'ACTIVE'");
    await ensureColumn('turfs', "subscription_start_date DATE");
    await ensureColumn('turfs', "next_billing_date DATE");
    await ensureColumn('turfs', "status VARCHAR(50) DEFAULT 'ACTIVE'");
    await ensureColumn('turfs', "is_deleted TINYINT(1) DEFAULT 0");

    // owners deletion / status columns
    await ensureColumn('owners', "is_deleted TINYINT(1) DEFAULT 0");
    await ensureColumn('owners', "status VARCHAR(50) DEFAULT 'ACTIVE'");
  } catch (e) {
    console.error('⚠️ Failed to ensure admin & venue enhancements:', e.message);
  }
}

ensureAdminAndVenueEnhancements();

// Ensure contact/inbox messages table exists (idempotent).
async function ensureContactMessagesTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contact_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(180) NOT NULL,
        message TEXT NOT NULL,
        is_read TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (is_read),
        INDEX (created_at)
      )
    `);
  } catch (e) {
    console.error('⚠️ Failed to ensure contact_messages table:', e.message);
  }
}

ensureContactMessagesTable();

// ---------------------------------------------------------------------------------------------------------------
// Tournament schema. migrate_tournaments() CREATEs the base tables; everything below either ALTERs `tournaments` /
// `tournament_fixtures` or references them, so it must WAIT for it.
//
// These used to be fired off side by side. migrate_tournaments() is async, so on a database where the tables did not
// exist yet the dependent steps raced it, lost, logged "Table 'tournaments' doesn't exist" and gave up — leaving
// `tournaments.owner_type`, `tournaments.venue_turf_id` and the live-match columns permanently missing. Every
// tournament query selects owner_type (HOST_NAME_SQL), so on such a deployment the whole tournament section fails.
// Reproduced on a fresh DB; chaining them fixes it. Each step is idempotent, so re-running is safe.
// ---------------------------------------------------------------------------------------------------------------
const migrateTournaments = require('./migrate_tournaments');
const ensureTournamentRegistrationsTable = require('./migrate_tournament_registrations');
const ensureTournamentSponsorsTable = require('./migrate_sponsors');
const ensureTournamentPlansTable = require('./migrate_tournament_plans');
const ensureTournamentAnalyticsColumns = require('./migrate_tournament_analytics');
const ensureTournamentHostTypeColumn = require('./migrate_tournament_host_type');
const ensureTournamentVenueColumn = require('./migrate_tournament_venue');
const ensureLiveMatchSchema = require('./migrate_live_match');

const step = (name, fn) => () => fn().catch(err => console.error(`${name} migration error:`, err.message));

const tournamentSchemaReady = migrateTournaments()
  .then(step('Tournament registrations', ensureTournamentRegistrationsTable))
  .then(step('Tournament sponsors', ensureTournamentSponsorsTable))
  .then(step('Tournament plans', ensureTournamentPlansTable))
  .then(step('Tournament analytics', ensureTournamentAnalyticsColumns))
  .then(step('Tournament host type', ensureTournamentHostTypeColumn))
  .then(step('Tournament venue', ensureTournamentVenueColumn))
  .then(step('Live match schema', ensureLiveMatchSchema))
  .then(step('Tournament config', require('./migrate_tournament_config')))
  .then(step('Tournament squads', require('./migrate_tournament_squads')))
  .then(() => console.log('✅ Tournament schema ready'))
  .catch(err => console.error('Tournament schema migration error:', err.message));

// Ensure player ranking settings table exists (independent of the tournament tables)
const ensureRankingSettingsTable = require('./migrate_rankings');
ensureRankingSettingsTable().catch(err => console.error('Ranking settings migration error:', err.message));

// Ensure users.push_token column exists (fixes a pre-existing no-op bug — see migrate_push_tokens.js)
const ensurePushTokenColumn = require('./migrate_push_tokens');
ensurePushTokenColumn().catch(err => console.error('Push token migration error:', err.message));

// Ensure advertisements table exists
const ensureAdvertisementsTable = require('./migrate_ads');
ensureAdvertisementsTable().catch(err => console.error('Advertisements migration error:', err.message));

// Notification system: schema first, then the scheduler worker (reminders, expiry, push retries)
const ensureNotificationSchema = require('./migrate_notifications');
ensureNotificationSchema()
  .then(() => require('./utils/notifications/scheduler').start())
  .catch(err => console.error('Notification startup error:', err.message));

// Route split-payment system: new, additive columns on turfs (route_enabled defaults false for every existing turf) +
// the new route_split_transfers / route_audit_log tables. See migrate_route_split.js for why this is separate from the
// older, already-present (and unused) turf_subscriptions/razorpay_transfers Route mechanism.
const ensureRouteSplitSchema = require('./migrate_route_split');
// Admin-controlled billing configuration (versioned per turf), fee/tax rules, subscription ledger, payment audit —
// additive; must run after the route split tables exist.
ensureRouteSplitSchema()
  .then(() => require('./migrate_billing_config')())
  .catch(err => console.error('Route split / billing config migration error:', err.message));

// Activities: the second (ticket-based) booking engine, fully separate from sports/turf slot booking. Additive —
// owners.business_types defaults to SPORTS-only for every existing owner.
const ensureActivitiesSchema = require('./migrate_activities');
// the global layer alters turfs/bookings/activities, so it runs after the activities tables exist
const ensureGlobalSchema = require('./migrate_global');
ensureActivitiesSchema().catch(err => console.error('Activities migration error:', err.message)).then(() => ensureGlobalSchema())
  // after the notification schema (which defines the original status enum) and the global layer
  .then(() => require('./migrate_subscriptions')())
  .then(() => require('./migrate_onboarding_and_approvals')())
  // sport categories, venue<->sport links, discovery indexes (needs turfs/bookings/advertisements to exist)
  .then(() => require('./migrate_discovery')())
  .then(() => require('./migrate_slots_policy')())
  .catch(err => console.error('Global migration error:', err.message));

// Middleware
const allowedOrigins = new Set([
  process.env.CLIENT_URL,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://bookarena.in',
  'https://bookarena.in',
  'http://www.bookarena.in',
  'https://www.bookarena.in',
  'http://3.27.94.251',
  'https://3.27.94.251'
].filter(Boolean));

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin) || origin.endsWith('bookarena.in')) {
      return callback(null, true);
    }
    // Allow request without CORS headers instead of throwing 500 error
    callback(null, false);
  },
  credentials: true
}));
// Skip global JSON parsing for the Razorpay webhook — it needs the raw, unparsed body
// to verify the signature (see routes/bookings.js POST /webhook). Parsing it here first
// would consume the request stream and make signature verification always fail.
app.use((req, res, next) => {
  if (req.originalUrl === '/api/bookings/webhook') return next();
  express.json({ limit: '10mb' })(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

// Serve uploaded images statically
// Mounted at /api/uploads as per documentation (serves uploads/ads and uploads/turfs)
app.use('/api/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api/uploads', express.static(path.join(__dirname, 'uploads/turfs')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads/turfs')));

// Routes
const turfRoutes = require('./routes/turfs');
const bookingRoutes = require('./routes/bookings');
const ownerRoutes = require('./routes/owners');
const adminRoutes = require('./routes/admin');
const couponRoutes = require('./routes/coupons');
const userRoutes = require('./routes/users');
const subscriptionRoutes = require('./routes/subscriptions');
const matchRoutes = require('./routes/match-requests');
const playerAvailabilityRoutes = require('./routes/player-availability');
const messagesRoutes = require('./routes/messages');
const adminMessagesRoutes = require('./routes/admin-messages');
const adminCouponsRoutes = require('./routes/admin-coupons');
const promotionsRoutes = require('./routes/promotions');
const tournamentRoutes = require('./routes/tournaments');
const tournamentManagementRoutes = require('./routes/tournament-management');
const tournamentMatchesRoutes = require('./routes/tournament-matches');
const tournamentLiveRoutes = require('./routes/tournament-live');
const adminTournamentsRoutes = require('./routes/admin-tournaments');
const playerProfilesRoutes = require('./routes/player-profiles');
const notificationsRoutes = require('./routes/notifications');
const adminNotificationsRoutes = require('./routes/admin-notifications');
const adminRouteRoutes = require('./routes/admin-route');
const adminBillingRoutes = require('./routes/admin-billing');
const ownerBillingRoutes = require('./routes/owner-billing');

app.use('/api/turfs', turfRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/owners', ownerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/users', userRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/match-requests', matchRoutes);
app.use('/api/player-availability', playerAvailabilityRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/admin/messages', adminMessagesRoutes);
app.use('/api/admin/coupons', adminCouponsRoutes);
app.use('/api/promotions', promotionsRoutes);
app.use('/api/tournaments', tournamentRoutes);
app.use('/api/tournaments', tournamentManagementRoutes);
app.use('/api/tournaments', tournamentLiveRoutes);
app.use('/api/tournament-matches', tournamentMatchesRoutes);
app.use('/api/admin-tournaments', adminTournamentsRoutes);
app.use('/api/players', playerProfilesRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/admin/notifications', adminNotificationsRoutes);
app.use('/api/admin/route', adminRouteRoutes);
app.use('/api/admin/billing', adminBillingRoutes);
app.use('/api/admin/discovery', require('./routes/admin-discovery'));
app.use('/api/discovery', require('./routes/discovery'));
app.use('/api/app-config', require('./routes/discovery').configRouter);
app.use('/api/owner-billing', ownerBillingRoutes);
app.use('/api/activities', require('./routes/activities'));
app.use('/api/owner-activities', require('./routes/owner-activities'));
app.use('/api/activity-staff', require('./routes/activity-staff-auth'));
app.use('/api/admin/activities', require('./routes/admin-activities'));
app.use('/api/global', require('./routes/global'));
app.use('/api/admin/global', require('./routes/admin-global'));
app.use('/api/admin/subscriptions', require('./routes/admin-subscriptions'));
app.use('/api/cancellations', require('./routes/cancellations'));
app.use('/api/rankings', require('./routes/rankings'));
app.use('/api/ads', require('./routes/ads'));
app.use('/api/admin-ads', require('./routes/admin-ads'));

// ✅ Standalone Email endpoint — works even when DB is in demo/mock mode
const { sendEmail } = require('./utils/email');
app.post('/api/notify/booking', async (req, res) => {
  try {
    const { customer_email, customer_name, turf_name, booking_date, time_slot, amount, service_fee, discount_amount } = req.body;

    if (!customer_email) {
      return res.status(400).json({ error: 'Email address is required' });
    }

    let msg = `✅ Booking Confirmed!\n\nHi ${customer_name}, your slot at **${turf_name}** is officially booked.\n\n📅 Date: ${booking_date}\n⏰ Time: ${time_slot}\n\n💰 **Price Breakdown:**\n`;

    if (discount_amount > 0) msg += `   - Base Price: ₹${parseFloat(amount) + parseFloat(discount_amount) - (parseFloat(service_fee) || 0)}\n   - Discount: -₹${discount_amount}\n`;
    if (service_fee > 0) msg += `   - Service Fee: +₹${service_fee}\n`;

    msg += `\n✨ **Total Paid: ₹${amount}**\n\nThank you for choosing Book Arena! 🏟️`;

    // Never send booking confirmations to the admin mailbox.
    const adminEmails = new Set(
      [process.env.ADMIN_EMAIL, process.env.EMAIL_USER]
        .map(v => String(v || '').trim().toLowerCase())
        .filter(Boolean)
    );
    const toKey = String(customer_email || '').trim().toLowerCase();
    if (adminEmails.has(toKey)) {
      return res.json({ success: true, message: 'Admin recipient suppressed' });
    }

    const result = await sendEmail(customer_email, 'Booking Confirmed - Book Arena', msg);

    if (result.success) {
      res.json({ success: true, message: 'Confirmation Email sent!' });
    } else {
      res.json({ success: false, message: result.error || result.message || 'Email not sent' });
    }
  } catch (err) {
    console.error('Notify error:', err.message);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});


// Health check
app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 as healthy');
    res.json({
      status: 'ok',
      db: rows[0].healthy === 1 ? 'connected' : 'error',
      message: 'Book Arena API is running 🏟️'
    });
  } catch (err) {
    res.json({
      status: 'api_only',
      db: 'disconnected',
      error: err.message,
      message: 'Server OK but database connection failed'
    });
  }
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🏟️  Book Arena API Server`);
  console.log(`📡 Running on http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}\n`);
});
