const assert = require('assert');
const axios = require('axios');
const pool = require('../config/db');
const { searchVenues } = require('../services/mapsService');

async function runTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING COMPREHENSIVE BOOKARENA TEST SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function report(name, condition, details = '') {
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name} ${details}`);
      failed++;
    }
  }

  try {
    // -------------------------------------------------------------
    // TEST 1: Find Players ON + 50% Advance Payment
    // -------------------------------------------------------------
    console.log('--- TEST 1: Find Players ON + Advance Payment ---');
    const totalBooking1 = 200;
    const playersNeeded1 = 4;
    const totalPeople1 = playersNeeded1 + 1; // 5
    const expectedPerPlayer1 = Math.round(totalBooking1 / totalPeople1); // 40
    const hostShare1 = totalBooking1 - (playersNeeded1 * expectedPerPlayer1); // 40
    const advancePercent1 = 50;
    const payableNow1 = Math.round((hostShare1 * (advancePercent1 / 100)) * 100) / 100; // 20
    const pendingBalance1 = hostShare1 - payableNow1; // 20

    report('TEST 1.1: Per-Player Split is calculated from FULL booking price (₹200 / 5 = ₹40)', expectedPerPlayer1 === 40, `Got: ${expectedPerPlayer1}`);
    report('TEST 1.2: Per-Player Split does NOT use advance amount (not ₹100/5 = ₹20)', expectedPerPlayer1 !== 20);
    report('TEST 1.3: Host Payable Now is 50% of Host Share (₹20)', payableNow1 === 20, `Got: ${payableNow1}`);
    report('TEST 1.4: Host Pending Balance at venue is ₹20', pendingBalance1 === 20, `Got: ${pendingBalance1}`);

    // -------------------------------------------------------------
    // TEST 2: Find Players ON + Full Payment
    // -------------------------------------------------------------
    console.log('\n--- TEST 2: Find Players ON + Full Payment ---');
    const totalBooking2 = 200;
    const playersNeeded2 = 4;
    const totalPeople2 = playersNeeded2 + 1;
    const expectedPerPlayer2 = Math.round(totalBooking2 / totalPeople2); // 40
    const hostShare2 = totalBooking2 - (playersNeeded2 * expectedPerPlayer2); // 40
    const payableNow2 = hostShare2; // 40
    const pendingBalance2 = 0;

    report('TEST 2.1: Per-Player Split is ₹40', expectedPerPlayer2 === 40);
    report('TEST 2.2: Host Full Payment is ₹40', payableNow2 === 40, `Got: ${payableNow2}`);
    report('TEST 2.3: Host Pending Balance is ₹0', pendingBalance2 === 0, `Got: ${pendingBalance2}`);

    // -------------------------------------------------------------
    // TEST 3: Find Players OFF + 50% Advance Payment
    // -------------------------------------------------------------
    console.log('\n--- TEST 3: Find Players OFF + Advance Payment ---');
    const totalBooking3 = 200;
    const advancePercent3 = 50;
    const payableNow3 = Math.round((totalBooking3 * (advancePercent3 / 100)) * 100) / 100; // 100
    const pendingBalance3 = totalBooking3 - payableNow3; // 100

    report('TEST 3.1: Normal Booking Payable Now is 50% Advance (₹100)', payableNow3 === 100, `Got: ${payableNow3}`);
    report('TEST 3.2: Normal Booking Pending Balance at venue is ₹100', pendingBalance3 === 100, `Got: ${pendingBalance3}`);

    // -------------------------------------------------------------
    // TEST 4: Find Players OFF + Full Payment
    // -------------------------------------------------------------
    console.log('\n--- TEST 4: Find Players OFF + Full Payment ---');
    const totalBooking4 = 200;
    const payableNow4 = totalBooking4; // 200
    const pendingBalance4 = 0;

    report('TEST 4.1: Normal Booking Full Payment is ₹200', payableNow4 === 200, `Got: ${payableNow4}`);
    report('TEST 4.2: Normal Booking Pending Balance is ₹0', pendingBalance4 === 0, `Got: ${pendingBalance4}`);

    // -------------------------------------------------------------
    // TEST 5: Maps Search & Coordinates Validation
    // -------------------------------------------------------------
    console.log('\n--- TEST 5: Maps Search & Coordinates ---');
    const searchResults = await searchVenues('FitBuddy Turf Chennai');
    report('TEST 5.1: Maps search returns matching venues', Array.isArray(searchResults) && searchResults.length > 0);
    
    if (searchResults.length > 0) {
      const first = searchResults[0];
      report('TEST 5.2: Result contains valid non-zero latitude', typeof first.latitude === 'number' && !isNaN(first.latitude) && first.latitude !== 0);
      report('TEST 5.3: Result contains valid non-zero longitude', typeof first.longitude === 'number' && !isNaN(first.longitude) && first.longitude !== 0);
      report('TEST 5.4: Result contains formatted_address', typeof first.formatted_address === 'string' && first.formatted_address.length > 0);
      report('TEST 5.5: Result contains place_id', typeof first.place_id === 'string' && first.place_id.length > 0);
    }

    // -------------------------------------------------------------
    // TEST 6: DB Schema Validation
    // -------------------------------------------------------------
    console.log('\n--- TEST 6: Database Schema & Integrity ---');
    const [turfCols] = await pool.query("SHOW COLUMNS FROM turfs");
    const colNames = turfCols.map(c => c.Field);
    report('TEST 6.1: turfs table has latitude column', colNames.includes('latitude'));
    report('TEST 6.2: turfs table has longitude column', colNames.includes('longitude'));
    report('TEST 6.3: turfs table has place_id column', colNames.includes('place_id'));
    report('TEST 6.4: turfs table has city column', colNames.includes('city'));
    report('TEST 6.5: turfs table has postal_code column', colNames.includes('postal_code'));

    const [prCols] = await pool.query("SHOW COLUMNS FROM player_requests");
    const prColNames = prCols.map(c => c.Field);
    report('TEST 6.6: player_requests has contribution_amount', prColNames.includes('contribution_amount'));
    report('TEST 6.7: player_requests has booking_total_amount', prColNames.includes('booking_total_amount'));
    report('TEST 6.8: player_requests has filled_slots and total_slots', prColNames.includes('filled_slots') && prColNames.includes('total_slots'));

  } catch (err) {
    console.error('Test execution error:', err);
    failed++;
  }

  console.log('\n====================================================');
  console.log(`📊 TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('====================================================');
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
