// The My Bookings tab rules live in a plain ES module shared with the app; load it here without a bundler.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../mobile/lib/bookingBuckets.js'), 'utf8').replace(/export /g, '');
const { bucketOf, dateOnly } = new Function(`${src}; return { bucketOf, dateOnly };`)();
const T = '2026-10-18';
test('buckets', () => {
  assert.equal(bucketOf({ status: 'confirmed', payment_status: 'success', booking_date: '2026-10-20' }, T), 'upcoming');
  assert.equal(bucketOf({ status: 'confirmed', payment_status: 'success', booking_date: '2026-10-18' }, T), 'upcoming', 'today is still upcoming');
  assert.equal(bucketOf({ status: 'confirmed', payment_status: 'success', booking_date: '2026-10-01' }, T), 'completed');
  assert.equal(bucketOf({ status: 'cancelled', payment_status: 'success', booking_date: '2026-10-20' }, T), 'cancelled');
  assert.equal(bucketOf({ status: 'pending', payment_status: 'pending', booking_date: '2026-10-20' }, T), 'pending');
  assert.equal(bucketOf({ status: 'confirmed', payment_status: 'pending', booking_date: '2026-10-20' }, T), 'pending');
  assert.equal(bucketOf({ status: 'confirmed', payment_status: 'failed', booking_date: '2026-10-20' }, T), 'cancelled');
  assert.equal(dateOnly('2026-10-19T18:30:00.000Z'), '2026-10-19');
});
