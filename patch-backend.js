const fs = require('fs');
const path = require('path');

// 1. Path to bookings.js
const bookingsPath = path.join(__dirname, 'server', 'routes', 'bookings.js');
let bookingsContent = fs.readFileSync(bookingsPath, 'utf8');

// Replace checkSlotsAvailable query
const originalQuery = `  let bookingQuery = \`
    SELECT time_slot FROM bookings
    WHERE turf_id = ? AND booking_date = ? AND time_slot IN (\${placeholders})
    AND status != ? AND payment_status = ?
  \`;
  const bookingParams = [turfId, bookingDate, ...targetSlots, 'cancelled', 'success'];`;

const newQuery = `  let bookingQuery = \`
    SELECT time_slot FROM bookings
    WHERE turf_id = ? AND booking_date = ? AND time_slot IN (\${placeholders})
    AND (
      (payment_status = 'success' AND status != 'cancelled')
      OR
      (payment_status = 'pending' AND status = 'pending' AND created_at > NOW() - INTERVAL 4 MINUTE)
    )
  \`;
  const bookingParams = [turfId, bookingDate, ...targetSlots];`;

if (bookingsContent.includes(originalQuery)) {
    bookingsContent = bookingsContent.replace(originalQuery, newQuery);
    console.log('✅ Updated checkSlotsAvailable query in bookings.js');
} else {
    // Try with CRLF
    const originalQueryCRLF = originalQuery.replace(/\n/g, '\r\n');
    const newQueryCRLF = newQuery.replace(/\n/g, '\r\n');
    if (bookingsContent.includes(originalQueryCRLF)) {
        bookingsContent = bookingsContent.replace(originalQueryCRLF, newQueryCRLF);
        console.log('✅ Updated checkSlotsAvailable query (CRLF) in bookings.js');
    } else {
        console.error('❌ Could not find originalQuery in bookings.js');
    }
}

// Add release route
const releaseRoute = `// POST /api/bookings/release — Release or cancel a pending/temporary booking slot
router.post('/release', async (req, res) => {
  try {
    const { booking_id } = req.body;
    if (!booking_id) {
      return res.status(400).json({ error: 'booking_id is required' });
    }
    const ids = String(booking_id).split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      await pool.query(
        \`UPDATE bookings SET payment_status = 'failed', status = 'cancelled' WHERE id IN (\${placeholders}) AND status = 'pending'\`,
        [...ids]
      );
    }
    res.json({ success: true, message: 'Temporary booking slots released successfully' });
  } catch (err) {
    console.error('Error releasing slot:', err);
    res.status(500).json({ error: 'Failed to release slot: ' + err.message });
  }
});

module.exports = router;`;

if (!bookingsContent.includes('router.post(\'/release\'')) {
    bookingsContent = bookingsContent.replace('module.exports = router;', releaseRoute);
    console.log('✅ Added /release endpoint to bookings.js');
} else {
    console.log('ℹ️ /release endpoint already exists in bookings.js');
}

fs.writeFileSync(bookingsPath, bookingsContent, 'utf8');


// 2. Path to turfs.js
const turfsPath = path.join(__dirname, 'server', 'routes', 'turfs.js');
let turfsContent = fs.readFileSync(turfsPath, 'utf8');

const originalTurfQuery = `    // Get booked slots - only count confirmed/successful payments
    let bookedQuery = 'SELECT time_slot FROM bookings WHERE turf_id = ? AND booking_date = ? AND status != ? AND payment_status = ?';
    const bookedParams = [turfId, date, 'cancelled', 'success'];`;

const newTurfQuery = `    // Get booked slots (confirmed or temporarily locked in the last 4 minutes)
    let bookedQuery = \`
      SELECT time_slot FROM bookings 
      WHERE turf_id = ? AND booking_date = ? 
      AND (
        (payment_status = 'success' AND status != 'cancelled')
        OR
        (payment_status = 'pending' AND status = 'pending' AND created_at > NOW() - INTERVAL 4 MINUTE)
      )
    \`;
    const bookedParams = [turfId, date];`;

if (turfsContent.includes(originalTurfQuery)) {
    turfsContent = turfsContent.replace(originalTurfQuery, newTurfQuery);
    console.log('✅ Updated booked slots query in turfs.js');
} else {
    // Try CRLF
    const originalTurfQueryCRLF = originalTurfQuery.replace(/\n/g, '\r\n');
    const newTurfQueryCRLF = newTurfQuery.replace(/\n/g, '\r\n');
    if (turfsContent.includes(originalTurfQueryCRLF)) {
        turfsContent = turfsContent.replace(originalTurfQueryCRLF, newTurfQueryCRLF);
        console.log('✅ Updated booked slots query (CRLF) in turfs.js');
    } else {
        console.error('❌ Could not find originalTurfQuery in turfs.js');
    }
}

fs.writeFileSync(turfsPath, turfsContent, 'utf8');
console.log('🎉 Backend patching completed successfully!');
