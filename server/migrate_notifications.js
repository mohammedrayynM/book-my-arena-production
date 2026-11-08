// Idempotent schema for the centralized notification system + the small alignment the subscription lifecycle needs.
//
// Recipients are identified by (recipient_type, recipient_id) because Book Arena keeps users, owners and admins in three
// tables whose ids overlap.
const pool = require('./config/db');

module.exports = async function ensureNotificationSchema() {
  try {
    // ---- in-app notifications (the source for the Notification Center; push is just another channel) ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        recipient_type VARCHAR(10) NOT NULL,
        recipient_id INT NOT NULL,
        notification_type VARCHAR(60) NOT NULL,
        category VARCHAR(30) NOT NULL,
        title VARCHAR(160) NOT NULL,
        message VARCHAR(500) NOT NULL,
        entity_type VARCHAR(40) NULL,
        entity_id VARCHAR(60) NULL,
        deep_link VARCHAR(255) NULL,
        image_url VARCHAR(500) NULL,
        metadata JSON NULL,
        event_key VARCHAR(190) NOT NULL,
        is_read BOOLEAN NOT NULL DEFAULT false,
        read_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NULL,
        UNIQUE KEY uniq_event (event_key),
        INDEX idx_recipient_created (recipient_type, recipient_id, id),
        INDEX idx_recipient_unread (recipient_type, recipient_id, is_read, id),
        INDEX idx_type (notification_type),
        INDEX idx_created (created_at)
      )
    `);

    // ---- devices (a person may have several) ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_push_tokens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        recipient_type VARCHAR(10) NOT NULL,
        recipient_id INT NOT NULL,
        push_token VARCHAR(255) NOT NULL,
        platform VARCHAR(20) NULL,
        device_id VARCHAR(120) NULL,
        device_name VARCHAR(120) NULL,
        app_version VARCHAR(30) NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        deactivated_reason VARCHAR(60) NULL,
        last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_token (push_token),
        INDEX idx_recipient (recipient_type, recipient_id, is_active)
      )
    `);

    // ---- one row per (notification, device): the delivery log AND the push queue ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        notification_id BIGINT NOT NULL,
        device_id INT NOT NULL,
        provider VARCHAR(20) NOT NULL DEFAULT 'expo',
        status VARCHAR(12) NOT NULL DEFAULT 'PENDING',
        ticket_id VARCHAR(80) NULL,
        error VARCHAR(255) NULL,
        retry_count INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMP NULL,
        sent_at TIMESTAMP NULL,
        delivered_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_delivery (notification_id, device_id),
        INDEX idx_status_next (status, next_attempt_at),
        INDEX idx_ticket (status, sent_at)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        recipient_type VARCHAR(10) NOT NULL,
        recipient_id INT NOT NULL,
        category VARCHAR(30) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_pref (recipient_type, recipient_id, category)
      )
    `);

    // ---- admin broadcasts (audit trail for platform announcements / promotions) ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_broadcasts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        admin_id INT NOT NULL,
        kind VARCHAR(20) NOT NULL,
        title VARCHAR(160) NOT NULL,
        message VARCHAR(500) NOT NULL,
        segment JSON NULL,
        recipient_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ---- customer sport/activity subscriptions ----
    // routes/subscriptions.js was written against columns the live table never had (end_date, amount_paid...) and against
    // a status list without "cancelled"/"pending". Extend the enum so the lifecycle the code already intends can work:
    // pending (order created, unpaid) -> active (paid) -> expired | cancelled.
    // user_subscriptions is a pre-existing live table that no migration creates. On a brand-new database it is simply
    // absent, and the ALTERs below used to throw and abort the rest of this migration. Skip them instead.
    const [[subsTable]] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'user_subscriptions'");
    if (!subsTable || !subsTable.n) {
      console.log('ℹ️ user_subscriptions not present yet — skipping its notification-related indexes.');
      return;
    }
    await pool.query("ALTER TABLE user_subscriptions MODIFY COLUMN status ENUM('pending','active','expired','pending_renewal','paused','cancelled','past_due','suspended','refunded') NOT NULL DEFAULT 'pending'");
    // one row per Razorpay order: a duplicate verify/webhook can never create a second subscription
    try { await pool.query('ALTER TABLE user_subscriptions ADD UNIQUE KEY uniq_sub_order (razorpay_order_id)'); } catch (e) { if (!/Duplicate key name|already exists/i.test(e.message)) throw e; }
    try { await pool.query('ALTER TABLE user_subscriptions ADD INDEX idx_sub_status_expiry (status, expiry_date)'); } catch (e) { if (!/Duplicate key name|already exists/i.test(e.message)) throw e; }
    try { await pool.query('ALTER TABLE user_subscriptions ADD INDEX idx_sub_user (user_id)'); } catch (e) { if (!/Duplicate key name|already exists/i.test(e.message)) throw e; }
  } catch (error) {
    console.error('Notification schema migration error:', error.message);
  }
};
