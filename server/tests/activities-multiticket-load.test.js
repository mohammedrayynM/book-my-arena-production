/**
 * End-to-end tests for Multi-Ticket Booking, Freedom Park Journey, Single QR Code,
 * Item-by-Item Controlled Redemptions, and High-Concurrency Load Testing.
 */
const crypto = require('crypto');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const axios = require('axios');
const pool = require('../config/db');

const BASE = 'http://localhost:9000/api';
const results = [];
const check = (name, cond, extra) => {
    results.push(!!cond);
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond ? '' : ' :: ' + JSON.stringify(extra)));
};
const call = async (method, url, token, data) => {
    const r = await axios({
        method,
        url: BASE + url,
        data,
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        validateStatus: () => true
    });
    return { status: r.status, data: r.data };
};
const sign = (o, p) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${o}|${p}`).digest('hex');

(async () => {
    console.log('=== MULTI-TICKET & FREEDOM PARK AUTOMATED TEST SUITE ===\n');
    const stamp = Date.now();
    const todayStr = new Date().toISOString().slice(0, 10);

    try {
        // =============================================================
        // PHASE 1: Freedom Park Navigation (Slug + Numeric ID)
        // =============================================================
        console.log('--- Phase 1: Freedom Park Navigation & Catalog ---');
        const bySlug = await call('get', '/activities/freedom-amusement-park-2a59f9');
        check('Freedom Park opens via slug', bySlug.status === 200 && bySlug.data.activity.name.toLowerCase().includes('freedom'), bySlug.data);

        const byId = await call('get', '/activities/180001');
        check('Freedom Park opens via numeric ID fallback', byId.status === 200 && byId.data.activity.id === 180001, byId.data);

        const allTypes = bySlug.data.ticket_types || [];
        const activeTickets = allTypes.filter(t => t.is_active !== false && t.is_active !== 0);
        check('Freedom Park has multi-ticket product types (Entry, Ride, Activity)',
            activeTickets.some(t => (t.product_type || 'ENTRY') === 'ENTRY') &&
            activeTickets.some(t => t.product_type === 'RIDE') &&
            activeTickets.some(t => t.product_type === 'ACTIVITY'),
            activeTickets.map(t => ({ name: t.name, type: t.product_type, price: t.price }))
        );

        const avail = await call('get', `/activities/freedom-amusement-park-2a59f9/availability?date=${todayStr}`);
        check('Availability returns open capacity for today', avail.status === 200 && avail.data.ticket_types.length >= 3, avail.data);

        // =============================================================
        // PHASE 2: Required-Entry Validation
        // =============================================================
        console.log('\n--- Phase 2: Required-Entry Validation ---');
        const goKarting = activeTickets.find(t => t.name.includes('Go-Karting'));
        if (goKarting && goKarting.requires_entry) {
            const reqWithout = await call('post', '/activities/price-preview', null, {
                activity_id: 180001,
                booking_date: todayStr,
                items: [{ ticket_type_id: goKarting.id, quantity: 1 }]
            });
            check('Ride with requires_entry is rejected without entry ticket',
                reqWithout.status === 400 && (reqWithout.data.error || '').toLowerCase().includes('entry'),
                reqWithout.data
            );
        } else {
            console.log('SKIP - No ride with requires_entry found, skipping entry requirement test');
        }

        // =============================================================
        // PHASE 3: Multi-Ticket Pricing
        // =============================================================
        console.log('\n--- Phase 3: Multi-Ticket Pricing ---');
        const adultEntry = activeTickets.find(t => t.name.includes('Adult Entry'));
        const childEntry = activeTickets.find(t => t.name.includes('Child Entry'));
        const trampoline = activeTickets.find(t => t.name.includes('Trampoline'));

        const itemsToBook = [];
        let expectedSubtotal = 0;
        if (adultEntry) { itemsToBook.push({ ticket_type_id: adultEntry.id, quantity: 2 }); expectedSubtotal += Number(adultEntry.price) * 2; }
        if (childEntry) { itemsToBook.push({ ticket_type_id: childEntry.id, quantity: 1 }); expectedSubtotal += Number(childEntry.price) * 1; }
        if (goKarting) { itemsToBook.push({ ticket_type_id: goKarting.id, quantity: 2 }); expectedSubtotal += Number(goKarting.price) * 2; }
        if (trampoline) { itemsToBook.push({ ticket_type_id: trampoline.id, quantity: 1 }); expectedSubtotal += Number(trampoline.price) * 1; }

        const calcPreview = await call('post', '/activities/price-preview', null, {
            activity_id: 180001,
            booking_date: todayStr,
            items: itemsToBook
        });
        check(`Backend computes correct subtotal (expected ${expectedSubtotal})`,
            calcPreview.status === 200 && calcPreview.data.subtotal === expectedSubtotal,
            { expected: expectedSubtotal, got: calcPreview.data?.subtotal }
        );

        // =============================================================
        // PHASE 4: Full Booking + Single QR Code
        // =============================================================
        console.log('\n--- Phase 4: Booking + Single QR Code ---');
        const userEmail = `multi_test_${stamp}@example.com`;
        await call('post', '/users/register', null, { name: 'Multi Ticket User', email: userEmail, phone: '9888877777', password: 'Test#Password1' });
        const userLogin = await call('post', '/users/login', null, { email: userEmail, password: 'Test#Password1' });
        const userToken = userLogin.data.token;
        const userId = userLogin.data.user.id;

        const bookingRes = await call('post', '/activities/book', userToken, {
            activity_id: 180001,
            booking_date: todayStr,
            items: itemsToBook,
            customer_name: 'Multi Ticket User',
            customer_phone: '9888877777'
        });
        check('Multi-ticket booking created', bookingRes.status === 200 && bookingRes.data.order_id, bookingRes.data);

        const bookingId = bookingRes.data.booking_id;
        const orderId = bookingRes.data.order_id;
        const fakePaymentId = 'pay_multi_' + stamp;
        const signature = sign(orderId, fakePaymentId);

        const verifyRes = await call('post', '/activities/verify', userToken, {
            booking_id: bookingId,
            razorpay_order_id: orderId,
            razorpay_payment_id: fakePaymentId,
            razorpay_signature: signature
        });
        check('Payment verified and booking confirmed', verifyRes.status === 200 && verifyRes.data.status === 'confirmed', verifyRes.data);

        const [tickets] = await pool.query('SELECT * FROM activity_tickets WHERE booking_id = ?', [bookingId]);
        const totalQty = itemsToBook.reduce((s, it) => s + it.quantity, 0);
        check(`Single QR ticket covers all ${totalQty} people`,
            tickets.length === 1 && Number(tickets[0].quantity_covered) === totalQty,
            { count: tickets.length, covered: tickets[0]?.quantity_covered }
        );

        const [bookingItems] = await pool.query(
            'SELECT bi.*, tt.name AS ticket_name FROM activity_booking_items bi JOIN activity_ticket_types tt ON tt.id = bi.ticket_type_id WHERE bi.booking_id = ?',
            [bookingId]
        );
        check('Booking items record each entitlement separately with 0 redeemed',
            bookingItems.length === itemsToBook.length && bookingItems.every(bi => Number(bi.redeemed_quantity) === 0),
            bookingItems.map(b => ({ name: b.ticket_name, qty: b.quantity, redeemed: b.redeemed_quantity }))
        );

        // =============================================================
        // PHASE 5: Granular Gate-by-Gate Redemptions
        // =============================================================
        console.log('\n--- Phase 5: Granular Gate-by-Gate Redemption ---');
        // Get the actual owner of activity 180001
        const [[actRow]] = await pool.query('SELECT owner_id FROM activities WHERE id = 180001');
        const [[ownerRow]] = await pool.query('SELECT email FROM owners WHERE id = ?', [actRow.owner_id]);

        // We need to get a token for this owner — try login with a known password, or create JWT directly
        let ownerToken;
        const ownerLoginAttempt = await call('post', '/owners/login', null, { email: ownerRow.email, password: 'Owner#12345' });
        if (ownerLoginAttempt.status === 200 && ownerLoginAttempt.data.token) {
            ownerToken = ownerLoginAttempt.data.token;
        } else {
            // Generate JWT directly for the test
            const jwt = require('jsonwebtoken');
            ownerToken = jwt.sign({ id: actRow.owner_id, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '1h' });
        }

        const singleQr = tickets[0].qr_token;

        // Preview scan
        const scanPreview = await call('post', '/owner-activities/scan', ownerToken, { qr_token: singleQr, preview: true });
        check('Scanner preview shows valid ticket with items',
            scanPreview.status === 200 && scanPreview.data.ok === true,
            scanPreview.data
        );

        // Redeem Adult Entry (2 tickets)
        const adultItem = bookingItems.find(bi => bi.ticket_name.includes('Adult Entry'));
        if (adultItem) {
            const entryGateScan = await call('post', '/owner-activities/scan', ownerToken, {
                qr_token: singleQr,
                booking_item_id: adultItem.id,
                quantity: 2
            });
            check('Entry gate redeems 2 Adult Entry tickets',
                entryGateScan.status === 200 && entryGateScan.data.ok === true,
                entryGateScan.data
            );
        }

        // Redeem 1 Go-Karting
        const gokartItem = bookingItems.find(bi => bi.ticket_name.includes('Go-Karting'));
        if (gokartItem) {
            const gokartScan = await call('post', '/owner-activities/scan', ownerToken, {
                qr_token: singleQr,
                booking_item_id: gokartItem.id,
                quantity: 1
            });
            check('Go-Karting gate redeems 1 ticket',
                gokartScan.status === 200 && gokartScan.data.ok === true,
                gokartScan.data
            );

            // Over-redemption rejection
            const oversell = await call('post', '/owner-activities/scan', ownerToken, {
                qr_token: singleQr,
                booking_item_id: gokartItem.id,
                quantity: 5
            });
            check('Over-redemption rejected (quantity exceeds remaining)',
                oversell.status === 200 && oversell.data.ok === false,
                oversell.data
            );
        }

        // Customer view shows updated entitlements
        const custView = await call('get', `/activities/my/tickets/${bookingId}`, userToken);
        const viewItems = custView.data.items || [];
        check('Customer ticket screen shows per-item redemption counts',
            viewItems.length === itemsToBook.length && viewItems.some(i => Number(i.redeemed_quantity) > 0),
            viewItems.map(i => ({ name: i.name, redeemed: i.redeemed_quantity, total: i.quantity }))
        );

        // Cleanup test booking
        await pool.query('DELETE FROM activity_qr_scan_logs WHERE ticket_id IN (SELECT id FROM activity_tickets WHERE booking_id = ?)', [bookingId]);
        await pool.query('DELETE FROM activity_tickets WHERE booking_id = ?', [bookingId]);
        await pool.query('DELETE FROM activity_booking_items WHERE booking_id = ?', [bookingId]);
        await pool.query('DELETE FROM activity_bookings WHERE id = ?', [bookingId]);
        await pool.query('DELETE FROM users WHERE id = ?', [userId]);

        // =============================================================
        // PHASE 6: Load Testing
        // =============================================================
        console.log('\n--- Phase 6: Concurrency Load Testing ---');

        async function loadTest(concurrency, label) {
            console.log(`  ${label}: ${concurrency} concurrent requests...`);
            const endpoints = [
                () => call('get', '/activities'),
                () => call('get', '/activities/categories'),
                () => call('get', '/activities/freedom-amusement-park-2a59f9'),
                () => call('get', `/activities/freedom-amusement-park-2a59f9/availability?date=${todayStr}`),
                () => call('post', '/activities/price-preview', null, {
                    activity_id: 180001,
                    booking_date: todayStr,
                    items: [{ ticket_type_id: adultEntry.id, quantity: 1 }]
                })
            ];

            const start = Date.now();
            const latencies = [];
            let ok = 0;
            let fail = 0;

            await Promise.all(Array.from({ length: concurrency }, async (_, i) => {
                const ep = endpoints[i % endpoints.length];
                const t0 = Date.now();
                try {
                    const res = await ep();
                    latencies.push(Date.now() - t0);
                    if (res.status === 200) ok++; else fail++;
                } catch {
                    fail++;
                    latencies.push(Date.now() - t0);
                }
            }));

            const dur = ((Date.now() - start) / 1000).toFixed(2);
            latencies.sort((a, b) => a - b);
            const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
            const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
            const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
            console.log(`  [${label}] ${dur}s | ${ok}/${concurrency} ok | p50=${p50}ms p95=${p95}ms p99=${p99}ms`);
            return { ok, fail, p50, p95, p99 };
        }

        const t500 = await loadTest(500, '500 VU');
        check('500 concurrent requests — all succeed', t500.fail === 0, t500);
        check('500 VU p95 < 500ms', t500.p95 <= 500, { p95: t500.p95 });

        const t1k = await loadTest(1000, '1000 VU');
        check('1000 concurrent requests — >=99% succeed', t1k.ok >= 990, t1k);
        check('1000 VU p95 < 1000ms', t1k.p95 <= 1000, { p95: t1k.p95 });

        // =============================================================
        // SUMMARY
        // =============================================================
        console.log('\n========================================');
        const passed = results.filter(Boolean).length;
        console.log(`${passed}/${results.length} checks passed`);
        console.log('========================================');
        process.exit(passed === results.length ? 0 : 1);

    } catch (e) {
        console.error('FATAL:', e.message, e.stack);
        process.exit(1);
    }
})();
