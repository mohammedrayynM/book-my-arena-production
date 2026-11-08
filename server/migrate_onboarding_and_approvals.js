// Idempotent migration for multi-category venue onboarding, approval workflows, and court moderation.
// Adds category, booking model, capabilities, and approval status to turfs and courts.
// Preserves all existing data by defaulting existing rows to 'APPROVED'.

const pool = require('./config/db');

async function ensureColumn(table, columnSql) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
    console.log(`✅ Added column on ${table}: ${columnSql.split(' ')[0]}`);
  } catch (e) {
    if (!/Duplicate column name|already exists/i.test(String(e?.message || ''))) {
      console.error(`⚠️ Failed to add column on ${table}: ${columnSql}`, e.message);
    }
  }
}

async function ensureIndex(sql) {
  try {
    await pool.query(sql);
    console.log('✅ Index ensured');
  } catch (e) {
    if (!/Duplicate key name|already exists/i.test(String(e?.message || ''))) {
      console.error('⚠️ Failed to ensure index:', e.message);
    }
  }
}

module.exports = async function ensureOnboardingAndApprovalsSchema() {
  try {
    console.log('🚀 Running Onboarding, Category & Approval Migration...');

    // 1. TURFS Table Enhancements
    // Conceptual fields:
    // - category / categories
    // - booking_model: 'SLOT', 'TICKET', 'SESSION'
    // - enabled_capabilities: JSON array of enabled features
    // - approval_status: 'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ACTION_REQUIRED'
    // - admin_feedback: Notes/reasons from admin review
    await ensureColumn('turfs', "category VARCHAR(50) NOT NULL DEFAULT 'SPORTS'");
    await ensureColumn('turfs', "categories JSON NULL");
    await ensureColumn('turfs', "booking_model VARCHAR(20) NOT NULL DEFAULT 'SLOT'");
    await ensureColumn('turfs', "enabled_capabilities JSON NULL");
    await ensureColumn('turfs', "approval_status VARCHAR(30) NOT NULL DEFAULT 'APPROVED'");
    await ensureColumn('turfs', "admin_feedback TEXT NULL");
    await ensureColumn('turfs', "registration_step INT DEFAULT 3");
    await ensureColumn('turfs', "draft_data JSON NULL");

    // 2. COURTS Table Enhancements
    // Each newly added court can have independent approval status
    await ensureColumn('courts', "approval_status VARCHAR(30) NOT NULL DEFAULT 'APPROVED'");
    await ensureColumn('courts', "admin_feedback TEXT NULL");
    await ensureColumn('courts', "approved_by INT NULL");
    await ensureColumn('courts', "approved_at DATETIME NULL");

    // 3. Ensure any existing legacy turfs and courts are marked 'APPROVED' so they never break
    try {
      await pool.query("UPDATE turfs SET approval_status = 'APPROVED' WHERE approval_status IS NULL OR approval_status = ''");
      await pool.query("UPDATE courts SET approval_status = 'APPROVED' WHERE approval_status IS NULL OR approval_status = ''");
    } catch (e) {
      console.error('⚠️ Could not backfill approval_status:', e.message);
    }

    // 4. Ensure indices for query performance
    await ensureIndex('CREATE INDEX idx_turfs_owner_approval ON turfs (owner_id, approval_status)');
    await ensureIndex('CREATE INDEX idx_courts_turf_approval ON courts (turf_id, approval_status)');

    console.log('🎉 Onboarding & Approvals schema migration completed successfully.');
  } catch (err) {
    console.error('❌ Onboarding & Approvals migration failed:', err.message);
  }
};
