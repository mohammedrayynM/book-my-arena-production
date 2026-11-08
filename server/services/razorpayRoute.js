const pool = require('../config/db');
const Razorpay = require('razorpay');
require('dotenv').config();

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// LEGACY, CURRENTLY UNUSED: this is the older "monthly platform subscription fee deducted from booking revenue" Route
// mechanism (turfs.monthly_subscription_amount / turfs.razorpay_linked_account_id / turf_subscriptions), a different
// business model from the new per-turf percentage split in services/routeSplit.js. No call site in the app invokes
// processRouteTransfer any more (see routes/bookings.js, which now calls routeSplit.processSplitTransfer instead) — as
// of this fix, ZERO live turfs have a linked account or a subscription amount set, so this function has never actually
// transferred money. It is kept, and its pre-existing bug below is fixed, only so the code is correct if the business
// later decides to revive this model; it is not wired into anything automatically.
//
/**
 * Perform Razorpay Route transfer for a captured payment.
 * Ensures atomicity and idempotency.
 * @param {string} razorpay_payment_id
 * @param {Array<number>} bookingIds
 */
async function processRouteTransfer(razorpay_payment_id, bookingIds) {
    if (!razorpay_payment_id || !bookingIds || bookingIds.length === 0) return null;

    // 1. Check if we already processed this payment
    const [existingTransfer] = await pool.query(
        'SELECT * FROM razorpay_transfers WHERE razorpay_payment_id = ?',
        [razorpay_payment_id]
    );
    if (existingTransfer.length > 0) {
        console.log(`[Route] Payment ${razorpay_payment_id} already processed. Transfer status: ${existingTransfer[0].status}`);
        return existingTransfer[0];
    }

    // Use a transaction or lock to prevent race conditions on the subscription ledger
    const connection = await pool.getConnection();

    try {
        // Acquire a global DB lock for this turf to prevent concurrent bookings
        // from overlapping the subscription deduction
        const placeholders = bookingIds.map(() => '?').join(',');
        // BUG FIX: bookingIds must be bound as query parameters for the `?` placeholders above — without this second
        // argument mysql2 throws "syntax error, unexpected '?'" on every call, which is why this has never worked.
        const [bookings] = await connection.query(
            `SELECT turf_id, SUM(advance_amount) as total_captured, razorpay_order_id, MAX(booking_date) as booking_date
       FROM bookings WHERE id IN (${placeholders}) GROUP BY turf_id, razorpay_order_id`,
            bookingIds
        );

        if (bookings.length === 0) {
            throw new Error(`Bookings not found for IDs: ${bookingIds.join(',')}`);
        }

        const { turf_id, total_captured, razorpay_order_id, booking_date } = bookings[0];

        await connection.query('SELECT GET_LOCK(?, 15)', [`route_turf_${turf_id}`]);

        try {
            // 2. Get Turf Configuration and Linked Account
            const [turfRows] = await connection.query(
                'SELECT owner_id, razorpay_linked_account_id, monthly_subscription_amount FROM turfs WHERE id = ?',
                [turf_id]
            );

            const turf = turfRows[0];
            if (!turf) throw new Error(`Turf ${turf_id} not found`);

            const linkedAccountId = turf.razorpay_linked_account_id;
            const subAmount = parseFloat(turf.monthly_subscription_amount || 0);
            const grossAmount = parseFloat(total_captured || 0);

            if (grossAmount <= 0) {
                console.log(`[Route] Zero payment amount for ${razorpay_payment_id}. Skipping transfer.`);
                return null;
            }

            // Determine current subscription month ledger based on actual date
            // We can use the current month (when payment is made) OR the booking date month.
            // Usually it's based on when the payment occurs.
            const currentMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

            let platformAmount = 0;
            let ownerAmount = grossAmount;

            if (linkedAccountId && subAmount > 0) {
                // Fetch or create the ledger for this cycle
                await connection.query(
                    `INSERT IGNORE INTO turf_subscriptions (turf_id, cycle_month, subscription_amount, collected_amount, status)
           VALUES (?, ?, ?, 0, 'UNPAID')`,
                    [turf_id, currentMonth, subAmount]
                );

                const [ledgerRows] = await connection.query(
                    `SELECT collected_amount FROM turf_subscriptions WHERE turf_id = ? AND cycle_month = ?`,
                    [turf_id, currentMonth]
                );
                const collectedAlready = parseFloat(ledgerRows[0].collected_amount || 0);
                const remainingSub = Math.max(0, subAmount - collectedAlready);

                // Platform takes up to the remaining subscription amount from the gross
                platformAmount = Math.min(grossAmount, remainingSub);
                ownerAmount = grossAmount - platformAmount;

                // Note: Due to floating point issues, let's round
                platformAmount = Math.round(platformAmount * 100) / 100;
                ownerAmount = Math.round(ownerAmount * 100) / 100;

                // Update ledger locally (will commit in the actual DB later if transfer request succeeds or is valid)
                if (platformAmount > 0) {
                    const newCollected = Math.round((collectedAlready + platformAmount) * 100) / 100;
                    const newStatus = newCollected >= subAmount ? 'PAID' : 'UNPAID';
                    await connection.query(
                        `UPDATE turf_subscriptions SET collected_amount = ?, status = ? WHERE turf_id = ? AND cycle_month = ?`,
                        [newCollected, newStatus, turf_id, currentMonth]
                    );
                }
            }

            // Record the transfer intent first
            const [insertResult] = await connection.query(
                `INSERT INTO razorpay_transfers 
         (booking_id, turf_id, razorpay_payment_id, razorpay_order_id, gross_amount, platform_amount, owner_amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
                [bookingIds[0], turf_id, razorpay_payment_id, razorpay_order_id, grossAmount, platformAmount, ownerAmount]
            );
            const transferRecordId = insertResult.insertId;

            // Make Razorpay API Call
            let transferResult = null;
            if (linkedAccountId && ownerAmount > 0) {
                try {
                    // Razorpay expects amount in paise
                    const amountInPaise = Math.round(ownerAmount * 100);

                    transferResult = await razorpay.payments.transfer(razorpay_payment_id, {
                        transfers: [
                            {
                                account: linkedAccountId,
                                amount: amountInPaise,
                                currency: "INR",
                                notes: {
                                    booking_ids: bookingIds.join(','),
                                    turf_id: String(turf_id)
                                },
                                linked_account_notes: ["booking_ids"],
                                on_hold: 0 // Optional: Set to 1 if you want to hold funds until match happens
                            }
                        ]
                    });

                    const razorpay_transfer_id = transferResult.items && transferResult.items.length > 0 ? transferResult.items[0].id : null;

                    await connection.query(
                        `UPDATE razorpay_transfers SET status = 'processed', razorpay_transfer_id = ? WHERE id = ?`,
                        [razorpay_transfer_id, transferRecordId]
                    );
                    console.log(`[Route] Successfully transferred ₹${ownerAmount} to ${linkedAccountId} for payment ${razorpay_payment_id}`);

                } catch (apiError) {
                    console.error(`[Route] Razorpay Transfer API failed for ${razorpay_payment_id}:`, apiError);
                    // Rollback ledger since the transfer failed
                    if (platformAmount > 0) {
                        await connection.query(
                            `UPDATE turf_subscriptions SET collected_amount = collected_amount - ?, status = 'UNPAID' WHERE turf_id = ? AND cycle_month = ?`,
                            [platformAmount, turf_id, currentMonth]
                        );
                    }
                    await connection.query(
                        `UPDATE razorpay_transfers SET status = 'failed', error_message = ? WHERE id = ?`,
                        [apiError.error?.description || apiError.message || 'API Error', transferRecordId]
                    );
                    throw apiError;
                }
            } else {
                // No owner amount or no linked account. Sub assumes full amount or nothing to transfer.
                console.log(`[Route] No transfer initiated to owner. Owner amount: ₹${ownerAmount}, LinkedAccount: ${linkedAccountId || 'N/A'}`);
                await connection.query(
                    `UPDATE razorpay_transfers SET status = 'processed', error_message = ? WHERE id = ?`,
                    [linkedAccountId ? 'Zero owner amount' : 'No linked account configured', transferRecordId]
                );
            }

            return {
                success: true,
                grossAmount,
                platformAmount,
                ownerAmount,
                linkedAccountId
            };

        } finally {
            await connection.query('SELECT RELEASE_LOCK(?)', [`route_turf_${turf_id}`]);
        }
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            console.log(`[Route] Payment ${razorpay_payment_id} was already processed concurrently.`);
            return null;
        }
        console.error(`[Route] Processing failed for ${razorpay_payment_id}:`, error);
        // Returning null allows the caller to know it failed, but the webhook can retry later
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = {
    processRouteTransfer
};
