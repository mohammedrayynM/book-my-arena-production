const pool = require('./config/db');
require('dotenv').config();

async function seed() {
  try {
    console.log('📡 Seeding coordinates for turfs...');
    
    // Seed coordinates for Pernambut (matches user's specific location request)
    await pool.query("UPDATE turfs SET latitude = 12.9365, longitude = 78.7188 WHERE location LIKE '%Pernambut%'");
    
    // Seed some coordinates for popular Chennai areas
    await pool.query("UPDATE turfs SET latitude = 13.0850, longitude = 80.2100 WHERE location LIKE '%Anna Nagar%' AND (latitude IS NULL OR latitude = 13.0827)");
    await pool.query("UPDATE turfs SET latitude = 12.9800, longitude = 80.2200 WHERE location LIKE '%Velachery%' AND (latitude IS NULL OR latitude = 13.0827)");
    await pool.query("UPDATE turfs SET latitude = 13.0400, longitude = 80.2300 WHERE location LIKE '%T Nagar%'");
    await pool.query("UPDATE turfs SET latitude = 13.0200, longitude = 80.1400 WHERE location LIKE '%Porur%'");
    await pool.query("UPDATE turfs SET latitude = 13.0000, longitude = 80.2500 WHERE location LIKE '%Adyar%'");
    await pool.query("UPDATE turfs SET latitude = 13.0500, longitude = 80.2400 WHERE location LIKE '%Nungambakkam%'");
    
    // Default for others
    await pool.query("UPDATE turfs SET latitude = 13.0827, longitude = 80.2707 WHERE latitude IS NULL");

    console.log('✅ Coordinates seeded successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  }
}

seed();
