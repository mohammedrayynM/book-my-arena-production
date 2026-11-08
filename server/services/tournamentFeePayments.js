const pool = require('../config/db');
const { toMinor } = require('../utils/money');
const tournamentPricing = require('./tournamentPricing');
const { fire: fireNotification } = require('../utils/notifications/events');

async function confirmCapturedFeePayment({ orderId, paymentId, amountMinor, currency }) {
  const connection = await pool.getConnection();
  let tournamentId;
  try {
    await connection.beginTransaction();
    const [[ledger]] = await connection.query(
      'SELECT * FROM tournament_fee_payments WHERE razorpay_order_id = ? LIMIT 1 FOR UPDATE',
      [orderId]);
    if (!ledger) {
      await connection.rollback();
      return { notFound: true };
    }

    tournamentId = ledger.tournament_id;
    const [[tournament]] = await connection.query(
      'SELECT id, is_paid_to_admin, razorpay_payment_id, status FROM tournaments WHERE id = ? FOR UPDATE',
      [tournamentId]);
    if (!tournament) {
      await connection.rollback();
      return { notFound: false, accepted: false, error: 'Tournament draft was not found' };
    }

    if (ledger.status === 'paid') {
      await connection.rollback();
      return ledger.razorpay_payment_id === paymentId
        ? { notFound: false, accepted: true, duplicate: true }
        : { notFound: false, accepted: false, error: 'A different payment is already recorded for this order' };
    }
    if (tournament.is_paid_to_admin) {
      await connection.rollback();
      return tournament.razorpay_payment_id === paymentId
        ? { notFound: false, accepted: true, duplicate: true }
        : { notFound: false, accepted: false, error: 'A different payment already published this tournament' };
    }
    if (!['created', 'cancelled', 'failed'].includes(ledger.status) || tournament.status !== 'DRAFT') {
      await connection.rollback();
      return { notFound: false, accepted: false, error: 'The payment is not for an unpaid tournament draft' };
    }

    const expectedCurrency = String(ledger.currency || '').toUpperCase();
    if (!expectedCurrency || String(currency || '').toUpperCase() !== expectedCurrency) {
      await connection.rollback();
      return { notFound: false, accepted: false, error: 'Captured payment currency does not match the creation fee' };
    }
    let expectedMinor;
    try {
      expectedMinor = toMinor(ledger.amount, expectedCurrency);
    } catch {
      await connection.rollback();
      return { notFound: false, accepted: false, error: 'Saved creation-fee amount is invalid' };
    }
    if (!paymentId || expectedMinor <= 0 || Number(amountMinor) !== expectedMinor) {
      await connection.rollback();
      return { notFound: false, accepted: false, error: 'Captured payment amount does not match the creation fee' };
    }

    const [updatedLedger] = await connection.query(
      `UPDATE tournament_fee_payments
          SET status = 'paid', razorpay_payment_id = ?, verified_at = NOW()
        WHERE id = ? AND status <> 'paid'`,
      [paymentId, ledger.id]);
    if (!updatedLedger.affectedRows) {
      await connection.rollback();
      return { notFound: false, accepted: false, error: 'Payment ledger changed during verification' };
    }

    if (ledger.offer_code) {
      const [[offer]] = await connection.query('SELECT id FROM tournament_offers WHERE code = ? LIMIT 1', [ledger.offer_code]);
      if (offer) {
        await tournamentPricing.claimOffer(connection, {
          offerId: offer.id,
          tournamentId,
          userId: ledger.payer_id,
          userRole: ledger.payer_role || 'user',
          discountAmount: Number(ledger.discount_amount) || 0,
        });
      }
    }

    const [updatedTournament] = await connection.query(
      `UPDATE tournaments
          SET is_paid_to_admin = true, status = 'REGISTRATION_OPEN', razorpay_payment_id = ?
        WHERE id = ? AND is_paid_to_admin = false AND status = 'DRAFT'`,
      [paymentId, tournamentId]);
    if (!updatedTournament.affectedRows) {
      await connection.rollback();
      return { notFound: false, accepted: false, error: 'Tournament state changed during payment verification' };
    }

    await connection.commit();
    try { fireNotification('tournament.created', { tournamentId: Number(tournamentId) }); } catch { }
    return { notFound: false, accepted: true };
  } catch (error) {
    try { await connection.rollback(); } catch { }
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { confirmCapturedFeePayment };
