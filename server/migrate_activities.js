// Idempotent schema for the SECOND booking engine: ticket-based Activities (amusement parks, water parks, go-karting,
// bowling, trampoline parks, adventure parks, kids play areas, gaming zones, escape rooms, exhibitions, events...).
//
// This is deliberately separate from the sports/turf slot-booking engine (bookings, courts, slots) — see
// server/services/activityPayments.js and routes/activities.js for why. Nothing here is read by, or writes to, the
// turfs/bookings/courts tables. The only shared surface is `owners` (every activity has an owner_id) and the existing
// payment/notification infrastructure.
//
// Every new owners column defaults to the current behaviour (business_types = ["SPORTS"]), so every existing owner's
// panel looks exactly as it does today until they explicitly opt into Activities from their profile.
const pool = require('./config/db');

async function ensureColumn(table, columnSql) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
  } catch (e) {
    if (!/Duplicate column name|already exists/i.test(String(e?.message || ''))) {
      console.error(`⚠️ Activities: failed to add column on ${table}: ${columnSql}`, e.message);
    }
  }
}

module.exports = async function ensureActivitiesSchema() {
  try {
    // ---- which business modules an owner's panel shows. NULL means "SPORTS only" (every existing owner, unchanged
    // behaviour) — the application layer (not a SQL default, to avoid JSON-default-literal portability issues)
    // treats a NULL/empty value as ['SPORTS']. See server/services/businessTypes.js.
    await ensureColumn('owners', 'business_types JSON NULL');

    // ---- lookup: activity categories (admin-managed, seeded below) ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        key_name VARCHAR(40) NOT NULL UNIQUE,
        label VARCHAR(60) NOT NULL,
        icon VARCHAR(10) NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INT NOT NULL DEFAULT 0
      )
    `);
    const seed = [
      ['AMUSEMENT_PARK', 'Amusement Park', '🎢', 1], ['WATER_PARK', 'Water Park', '🌊', 2],
      ['GO_KARTING', 'Go-Karting', '🏎️', 3], ['BOWLING', 'Bowling', '🎳', 4],
      ['TRAMPOLINE', 'Trampoline Park', '🤸', 5], ['ADVENTURE', 'Adventure Park', '🧗', 6],
      ['KIDS_PLAY', 'Kids Play Area', '👨‍👩‍👧', 7], ['GAMING_ZONE', 'Gaming Zone', '🎮', 8],
      ['ESCAPE_ROOM', 'Escape Room', '🚪', 9], ['EXHIBITION', 'Exhibition', '🎟️', 10],
      ['EVENT', 'Event', '🎭', 11], ['OTHER', 'Other', '🎯', 12],
    ];
    for (const [key_name, label, icon, sort_order] of seed) {
      await pool.query('INSERT IGNORE INTO activity_categories (key_name, label, icon, sort_order) VALUES (?, ?, ?, ?)', [key_name, label, icon, sort_order]);
    }

    // ---- the activity itself (one per venue/experience; an owner may have several) ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activities (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_id INT NOT NULL,
        category_id INT NOT NULL,
        name VARCHAR(150) NOT NULL,
        slug VARCHAR(180) NOT NULL UNIQUE,
        description TEXT NULL,
        location VARCHAR(150) NULL,
        address VARCHAR(255) NULL,
        latitude DECIMAL(10,7) NULL,
        longitude DECIMAL(10,7) NULL,
        phone VARCHAR(20) NULL,
        email VARCHAR(150) NULL,
        images JSON NULL,
        videos JSON NULL,
        opening_days JSON NULL,
        opening_time TIME NULL,
        closing_time TIME NULL,
        age_restriction_min INT NULL,
        rules TEXT NULL,
        facilities JSON NULL,
        cancellation_policy TEXT NULL,
        terms TEXT NULL,
        timed_entry_enabled BOOLEAN NOT NULL DEFAULT false,
        ticket_qr_mode VARCHAR(12) NOT NULL DEFAULT 'single', -- 'single' (one QR per booking) | 'per_ticket' (one QR per unit)
        partial_entry_enabled BOOLEAN NOT NULL DEFAULT false,
        status VARCHAR(12) NOT NULL DEFAULT 'draft', -- draft | pending | approved | rejected | suspended
        is_featured BOOLEAN NOT NULL DEFAULT false,
        rating DECIMAL(2,1) NULL,
        commission_percent DECIMAL(5,2) NULL, -- admin-set, informational only in this pass — no transfer is wired to it yet (see services/activityBooking.js notes)
        approved_by INT NULL,
        approved_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_activities_owner (owner_id),
        INDEX idx_activities_status (status),
        INDEX idx_activities_category (category_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_ticket_types (
        id INT AUTO_INCREMENT PRIMARY KEY,
        activity_id INT NOT NULL,
        name VARCHAR(60) NOT NULL,
        description VARCHAR(255) NULL,
        price DECIMAL(10,2) NOT NULL,
        weekend_price DECIMAL(10,2) NULL,
        min_quantity INT NOT NULL DEFAULT 1,
        max_quantity INT NOT NULL DEFAULT 10,
        age_min INT NULL,
        age_max INT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ticket_types_activity (activity_id)
      )
    `);

    // ---- per-date, per-ticket-type capacity: the only thing that gates whether a date is bookable at all ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_inventory (
        id INT AUTO_INCREMENT PRIMARY KEY,
        activity_id INT NOT NULL,
        ticket_type_id INT NOT NULL,
        date DATE NOT NULL,
        capacity INT NOT NULL,
        sold INT NOT NULL DEFAULT 0,
        is_closed BOOLEAN NOT NULL DEFAULT false,
        special_price DECIMAL(10,2) NULL, -- festival/peak-date override for this ticket type on this date
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_inventory (ticket_type_id, date),
        INDEX idx_inventory_activity_date (activity_id, date)
      )
    `);

    // ---- optional timed-entry windows (visitor-count capacity per entry slot, independent of ticket type) ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_time_windows (
        id INT AUTO_INCREMENT PRIMARY KEY,
        activity_id INT NOT NULL,
        date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        capacity INT NOT NULL,
        sold INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_time_windows_activity_date (activity_id, date)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_addons (
        id INT AUTO_INCREMENT PRIMARY KEY,
        activity_id INT NOT NULL,
        name VARCHAR(60) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INT NOT NULL DEFAULT 0,
        INDEX idx_addons_activity (activity_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_offers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        activity_id INT NOT NULL,
        code VARCHAR(40) NOT NULL,
        label VARCHAR(100) NULL,
        discount_type VARCHAR(12) NOT NULL, -- flat | percentage
        discount_value DECIMAL(10,2) NOT NULL,
        min_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        max_discount_cap DECIMAL(10,2) NULL,
        valid_from DATE NULL,
        valid_until DATE NULL,
        max_uses INT NULL,
        used_count INT NOT NULL DEFAULT 0,
        per_user_limit INT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_offer_code (activity_id, code),
        INDEX idx_offers_activity (activity_id)
      )
    `);

    // ---- the booking itself (one purchase; may cover several ticket types + add-ons) ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_bookings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        booking_code VARCHAR(20) NOT NULL UNIQUE,
        activity_id INT NOT NULL,
        owner_id INT NOT NULL,
        user_id INT NULL,
        customer_name VARCHAR(150) NULL,
        customer_phone VARCHAR(20) NULL,
        customer_email VARCHAR(150) NULL,
        booking_date DATE NOT NULL,
        time_window_id INT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | confirmed | cancelled | refunded
        payment_status VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | success | failed | refunded
        razorpay_order_id VARCHAR(64) NULL,
        razorpay_payment_id VARCHAR(64) NULL,
        subtotal_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        addon_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        offer_id INT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_abookings_activity_date (activity_id, booking_date),
        INDEX idx_abookings_owner (owner_id),
        INDEX idx_abookings_user (user_id),
        INDEX idx_abookings_order (razorpay_order_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_booking_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        booking_id INT NOT NULL,
        ticket_type_id INT NOT NULL,
        quantity INT NOT NULL,
        unit_price DECIMAL(10,2) NOT NULL,
        line_total DECIMAL(10,2) NOT NULL,
        INDEX idx_booking_items_booking (booking_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_booking_addons (
        id INT AUTO_INCREMENT PRIMARY KEY,
        booking_id INT NOT NULL,
        addon_id INT NOT NULL,
        quantity INT NOT NULL,
        unit_price DECIMAL(10,2) NOT NULL,
        line_total DECIMAL(10,2) NOT NULL,
        INDEX idx_booking_addons_booking (booking_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_offer_usages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        offer_id INT NOT NULL,
        booking_id INT NOT NULL,
        user_id INT NULL,
        customer_email VARCHAR(150) NULL,
        customer_phone VARCHAR(20) NULL,
        discount_amount DECIMAL(10,2) NOT NULL,
        used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_offer_usages_offer (offer_id)
      )
    `);

    // ---- the redeemable unit: a QR token. Never the booking id — a fresh random token per ticket. ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_tickets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        booking_id INT NOT NULL,
        activity_id INT NOT NULL,
        owner_id INT NOT NULL,
        booking_item_id INT NULL, -- set when ticket_qr_mode = 'per_ticket'; null for a whole-booking QR
        qr_token VARCHAR(64) NOT NULL UNIQUE,
        quantity_covered INT NOT NULL DEFAULT 1,
        redeemed_quantity INT NOT NULL DEFAULT 0,
        status VARCHAR(12) NOT NULL DEFAULT 'VALID', -- UNUSED|VALID|SCANNED|COMPLETED|EXPIRED|CANCELLED|REFUNDED|BLOCKED
        valid_from DATETIME NOT NULL,
        valid_until DATETIME NOT NULL,
        first_scanned_at DATETIME NULL,
        first_scanned_by INT NULL,
        completed_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_tickets_booking (booking_id),
        INDEX idx_tickets_owner (owner_id),
        INDEX idx_tickets_activity (activity_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_qr_scan_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ticket_id INT NULL,
        qr_token_tried VARCHAR(64) NULL,
        scanned_by_owner_id INT NOT NULL,
        scanned_by_staff_id INT NULL,
        result VARCHAR(16) NOT NULL, -- VALID|ALREADY_USED|EXPIRED|WRONG_OWNER|CANCELLED|REFUNDED|NOT_FOUND|BLOCKED
        quantity_redeemed INT NOT NULL DEFAULT 0,
        note VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_scan_logs_ticket (ticket_id),
        INDEX idx_scan_logs_owner (scanned_by_owner_id, created_at)
      )
    `);

    // ---- a minimal staff/sub-account system, scoped ONLY to scanning + today's entries for one owner ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_staff (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_id INT NOT NULL,
        name VARCHAR(150) NOT NULL,
        email VARCHAR(150) NOT NULL,
        phone VARCHAR(20) NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(12) NOT NULL DEFAULT 'ENTRY_STAFF', -- MANAGER | ENTRY_STAFF
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_staff_owner_email (owner_id, email),
        INDEX idx_staff_owner (owner_id)
      )
    `);
    // ---- phase 2: cancellation/refund policy, QR validity mode, tax, refund tracking, reminders ----
    // Every new column defaults to the earlier behaviour (no customer self-cancel, no tax) so existing activities are unchanged.
    await ensureColumn('activities', 'cancellation_hours_before INT NULL'); // NULL = customers may not self-cancel; N = allowed until N hours before entry
    await ensureColumn('activities', 'refund_percent DECIMAL(5,2) NOT NULL DEFAULT 100');
    await ensureColumn('activities', 'tax_percent DECIMAL(5,2) NOT NULL DEFAULT 0');
    await ensureColumn('activities', "qr_validity_mode VARCHAR(8) NOT NULL DEFAULT 'hours'"); // day | hours | custom
    await ensureColumn('activities', 'qr_valid_from TIME NULL');
    await ensureColumn('activities', 'qr_valid_until TIME NULL');
    await ensureColumn('activity_bookings', 'tax_amount DECIMAL(10,2) NOT NULL DEFAULT 0');
    await ensureColumn('activity_bookings', 'cancelled_by VARCHAR(10) NULL'); // customer | owner | admin | system
    await ensureColumn('activity_bookings', 'cancelled_at DATETIME NULL');
    await ensureColumn('activity_bookings', 'refund_amount DECIMAL(10,2) NOT NULL DEFAULT 0');
    await ensureColumn('activity_bookings', "refund_status VARCHAR(10) NOT NULL DEFAULT 'none'"); // none | pending | processed
    await ensureColumn('activity_bookings', 'refund_processed_at DATETIME NULL');
    await ensureColumn('activity_bookings', 'reminder_sent_at DATETIME NULL');
  } catch (e) {
    console.error('⚠️ Activities migration error:', e.message);
  }
};
