const pool = require('./config/db');

async function migrate() {
  try {
    const [columns] = await pool.query('DESCRIBE turfs');
    const columnNames = columns.map(c => c.Field);

    if (!columnNames.includes('slug')) {
      console.log('Adding slug column...');
      await pool.query('ALTER TABLE turfs ADD COLUMN slug VARCHAR(255)');
    }

    // Generate slugs for existing turfs if they don't have one
    const [turfs] = await pool.query('SELECT id, name, location FROM turfs');
    for (const turf of turfs) {
      // Create a slug from name and location if possible
      let slug = turf.name.toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      
      const locSlug = turf.location ? turf.location.toLowerCase().replace(/[^a-z0-9]/g, '-') : '';
      if (locSlug && !slug.includes(locSlug)) {
        slug = `${slug}-${locSlug}`;
      }

      await pool.query('UPDATE turfs SET slug = ? WHERE id = ?', [slug, turf.id]);
      console.log(`Updated turf ${turf.id} with slug: ${slug}`);
    }

    // Make slug unique and indexed
    try {
      await pool.query('ALTER TABLE turfs MODIFY slug VARCHAR(255) NOT NULL');
      await pool.query('CREATE UNIQUE INDEX idx_turf_slug ON turfs(slug)');
      console.log('Slug column is now unique and indexed.');
    } catch (e) {
      console.log('Index might already exist or duplicates found.', e.message);
    }

    console.log('✅ Slug migration completed.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
