// Idempotent schema setup for the admin-controlled advertisement system (Phase 19).
const pool = require('./config/db');

module.exports = async function ensureAdvertisementsTable() {
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS advertisements (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      image_url VARCHAR(500) NULL,
      video_url VARCHAR(500) NULL,
      sponsor_name VARCHAR(255) NULL,
      link_url VARCHAR(500) NULL,
      placement VARCHAR(50) NOT NULL DEFAULT 'HOME_BANNER',
      priority INT NOT NULL DEFAULT 1,
      start_date DATE NULL,
      end_date DATE NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      impression_count INT NOT NULL DEFAULT 0,
      click_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_placement (placement, is_active)
    )
  `);

  // Ensure placement column type is VARCHAR(50) if it was previously an ENUM
  try {
    await pool.query(`ALTER TABLE advertisements MODIFY COLUMN placement VARCHAR(50) NOT NULL DEFAULT 'HOME_BANNER'`);
  } catch (e) {
    // ignore
  }

  await ensureColumn('advertisements', 'description TEXT NULL');
  await ensureColumn('advertisements', 'priority INT NOT NULL DEFAULT 1');
};

if (require.main === module) {
  module.exports().then(() => {
    console.log('✅ Advertisements schema migration complete.');
    process.exit(0);
  }).catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  });
}
