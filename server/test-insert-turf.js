const pool = require('./config/db');

(async () => {
  try {
    const name = '__test_turf__';
    const location = 'Test Location';
    const sport_type = 'cricket';
    const price_per_hour = 500;
    const slug = 'test-turf-' + Date.now();
    const lat = 13.08;
    const lng = 80.27;

    const [result] = await pool.query(
      `INSERT INTO turfs (name, location, address, sport_type, price_per_hour, description, images, photos, coverImage, photosCount, amenities, owner_id, open_time, close_time, markup_type, markup_value, slot_duration, time_format, advance_percent, slug, latitude, longitude, default_price, early_morning_price, morning_price, afternoon_price, evening_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, location, '', sport_type, price_per_hour, '', '[]', '[]', null, 0, '[]', 1, '06:00', '23:00', 'fixed', 0, 60, '12h', 100, slug, lat, lng, null, null, null, null, null]
    );
    console.log('SUCCESS - insertId:', result.insertId);

    // cleanup
    await pool.query('DELETE FROM turfs WHERE id = ?', [result.insertId]);
    console.log('Cleaned up test row');
    process.exit(0);
  } catch (err) {
    console.error('FAILED:', err.message);
    console.error('SQL State:', err.sqlState);
    console.error('Error No:', err.errno);
    process.exit(1);
  }
})();
