const pool = require('./config/db');

async function migratePhotos() {
  try {
    const [rows] = await pool.query('DESCRIBE turfs');
    const columns = rows.map(r => r.Field);
    
    if (!columns.includes('photos')) {
      console.log('Adding photos column...');
      await pool.query('ALTER TABLE turfs ADD COLUMN photos JSON');
    }
    
    if (!columns.includes('coverImage')) {
      console.log('Adding coverImage column...');
      await pool.query('ALTER TABLE turfs ADD COLUMN coverImage VARCHAR(500)');
    }
    
    if (!columns.includes('photosCount')) {
      console.log('Adding photosCount column...');
      await pool.query('ALTER TABLE turfs ADD COLUMN photosCount INT DEFAULT 0');
    }
    
    console.log('✅ Columns added. Migrating existing turf rows...');
    
    // Select all existing turfs
    const [turfs] = await pool.query('SELECT id, images, photos, coverImage FROM turfs');
    for (const turf of turfs) {
      let currentImages = [];
      try {
        if (typeof turf.images === 'string') {
          currentImages = JSON.parse(turf.images);
        } else if (Array.isArray(turf.images)) {
          currentImages = turf.images;
        }
      } catch (e) {
        console.error(`Failed to parse images for turf ID ${turf.id}`);
      }
      
      // If currentImages is empty but there's a fallback placeholder
      // or if it contains objects or strings, map it to strings (URLs)
      const mappedPhotos = currentImages.map(img => {
        if (typeof img === 'string') return img;
        if (img && typeof img === 'object' && img.url) return img.url;
        return null;
      }).filter(Boolean);
      
      const cover = mappedPhotos.length > 0 ? mappedPhotos[0] : null;
      const count = mappedPhotos.length;
      
      console.log(`Migrating turf ID ${turf.id}: ${count} photos, cover: ${cover}`);
      
      await pool.query(
        'UPDATE turfs SET photos = ?, coverImage = ?, photosCount = ? WHERE id = ?',
        [JSON.stringify(mappedPhotos), cover, count, turf.id]
      );
    }
    
    console.log('✅ Turf rows migrated successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

migratePhotos();
