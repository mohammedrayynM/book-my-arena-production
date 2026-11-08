// Find Players: the invitation, the short-lived spot reservation, payment confirmation and the receipt — everything that decides who
// is "in" a match. The route layer (routes/match-requests.js) only authenticates and calls these.
//
// Rules this module enforces (all server-side):
//   * Opening a link or starting checkout never takes a spot. A spot is only TAKEN by a payment the backend has verified
//     (Razorpay signature and/or the gateway's own "captured" report — never a client-side "success").
//   * Starting checkout RESERVES a spot for RESERVATION_MINUTES, so two people are not both sent to pay for the last one.
//     The reservation just stops counting when it expires; nothing has to run to release it.
//   * Capacity is enforced inside a transaction on the locked match row; the same payment can never be credited twice;
//     a payment that arrives when the match is full / cancelled / started is refunded in full instead of being kept.
const pool = require('../config/db');
const refunds = require('./refunds');
const { zonedEpoch } = require('../utils/timezone');
const { parseSlotLabel } = require('./slotSchedule');
const { toMinor, fromMinor } = require('../utils/money');
const { inviteUrl } = require('./publicUrl');

const RESERVATION_MINUTES = 10;

const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Player';

/** { startEpoch, endEpoch } of the match in the VENUE's time zone (NaN when it cannot be worked out). */
function matchWindow(match, tz = 'Asia/Kolkata') {
  const date = String(match.match_date instanceof Date ? match.match_date.toISOString() : match.match_date || '').slice(0, 10);
  const time = String(match.match_time || '00:00:00').slice(0, 8).padEnd(8, ':00').slice(0, 8);
  let startEpoch = NaN;
  try { startEpoch = zonedEpoch(date, time, tz); } catch (e) { /* unparseable date */ }
  const slot = parseSlotLabel(match.booking_time_slot);
  const endEpoch = Number.isFinite(startEpoch) ? startEpoch + (slot ? (slot.end - slot.start) : 60) * 60000 : NaN;
  return { startEpoch, endEpoch };
}

/** open | full | cancelled | expired (already started) | completed (ended) | closed — what a joiner is allowed to do right now. */
function sessionState(match, tz, now = Date.now()) {
  if (String(match.status) === 'cancelled') return 'cancelled';
  const { startEpoch, endEpoch } = matchWindow(match, tz);
  if (Number.isFinite(endEpoch) && now >= endEpoch) return 'completed';
  if (Number.isFinite(startEpoch) && now >= startEpoch) return 'expired';
  if (String(match.status) === 'full' || Number(match.filled_slots) >= Number(match.total_slots)) return 'full';
  if (String(match.status) !== 'open') return 'closed';
  return 'open';
}

const STATE_MESSAGE = {
  open: 'Spots are open — join and pay your share.',
  full: 'All player spots are filled.',
  cancelled: 'The host cancelled this booking, so this invitation is closed.',
  expired: 'This match has already started, so joining is closed.',
  completed: 'This session has ended.',
  closed: 'This invitation is no longer accepting players.',
};

/** Spots currently held by someone who started checkout in the last few minutes (and has not paid yet). */
async function activeReservations(db, matchId, excludeUserId = 0) {
  const [[r]] = await db.query(
    "SELECT COUNT(*) AS n FROM match_players WHERE match_id = ? AND payment_status = 'pending' AND reserved_until IS NOT NULL AND reserved_until > NOW() AND user_id <> ?",
    [matchId, excludeUserId || 0]
  );
  return Number(r.n) || 0;
}

/** The invitation page's data: only what a stranger holding the link may see (no phone numbers, emails, coordinates or user ids). */
async function publicInvite(token, viewerUserId = null) {
  const [[m]] = await pool.query(
    `SELECT r.*, t.name AS turf_name, t.address AS turf_address, t.images AS turf_images, t.timezone AS turf_tz, t.currency_code, t.advance_percent AS turf_advance_percent,
            u.name AS host_name_full, u.karma_points AS host_karma
     FROM player_requests r JOIN turfs t ON r.turf_id = t.id JOIN users u ON r.host_id = u.id
     WHERE r.share_token = ?`, [token]);
  if (!m) return null;
  const [players] = await pool.query(
    `SELECT p.id, p.user_id, p.role, p.payment_status, p.status, u.name AS user_name FROM match_players p JOIN users u ON p.user_id = u.id
     WHERE p.match_id = ? AND (p.payment_status = 'paid' OR p.user_id = ?)`, [m.id, viewerUserId || 0]);
  const tz = m.turf_tz || 'Asia/Kolkata';
  const state = sessionState(m, tz);
  const reserved = await activeReservations(pool, m.id, viewerUserId || 0);
  const confirmed = Math.max(1, Number(m.filled_slots) || 1);
  const remaining = Math.max(0, Number(m.total_slots) - confirmed - reserved);
  const mine = viewerUserId ? players.find((p) => Number(p.user_id) === Number(viewerUserId)) : null;
  const { startEpoch, endEpoch } = matchWindow(m, tz);
  const currency = m.currency_code || 'INR';
  const total = Number(m.booking_total_amount) || 0;
  const paidRows = players.filter((p) => p.payment_status === 'paid').map((p) => ({ id: p.id, user_name: firstName(p.user_name), role: p.role, payment_status: p.payment_status, status: p.status, is_you: !!viewerUserId && Number(p.user_id) === Number(viewerUserId) }));
  const [[col]] = await pool.query("SELECT COALESCE(SUM(amount_paid),0) AS s FROM match_players WHERE match_id = ? AND payment_status = 'paid'", [m.id]);

  // whitelisted; deliberately NOT included: contact_phone, latitude, longitude, host email/phone
  const match = {
    id: m.id, share_token: m.share_token, turf_id: m.turf_id, host_id: m.host_id, host_name: firstName(m.host_name_full), host_karma: m.host_karma,
    turf_name: m.turf_name, turf_address: m.turf_address, turf_images: m.turf_images, turf_advance_percent: m.turf_advance_percent,
    sport_type: m.sport_type, match_type: m.match_type, skill_level: m.skill_level, roles_needed: m.roles_needed, note: m.note,
    match_date: m.match_date, match_time: m.match_time, booking_time_slot: m.booking_time_slot, status: m.status,
    total_slots: m.total_slots, filled_slots: m.filled_slots, contribution_amount: m.contribution_amount, booking_total_amount: m.booking_total_amount,
    advance_amount: m.advance_amount, split_amount: m.split_amount,
  };
  const invite = {
    state, message: STATE_MESSAGE[state] || '', can_join: state === 'open' && remaining > 0 && !(mine && mine.payment_status === 'paid') && Number(m.host_id) !== Number(viewerUserId),
    currency, total_amount: total, share_amount: Number(m.contribution_amount) || 0,
    confirmed_participants: confirmed, capacity: Number(m.total_slots), remaining_spots: remaining, reserved_spots: reserved,
    starts_at: Number.isFinite(startEpoch) ? new Date(startEpoch).toISOString() : null, ends_at: Number.isFinite(endEpoch) ? new Date(endEpoch).toISOString() : null,
    amount_collected: Number(col.s) || 0, is_host: !!viewerUserId && Number(m.host_id) === Number(viewerUserId),
    my_status: mine ? { payment_status: mine.payment_status, status: mine.status, match_player_id: mine.id } : null,
    invite_url: inviteUrl(m.share_token), reservation_minutes: RESERVATION_MINUTES,
  };
  return { match, players: paidRows, contribution_total: Number(col.s) || 0, invite };
}

/** Everything the host's "Share with friends" panel needs; only the host (or an admin) may read it. */
async function hostSummary(matchId, userId) {
  const [[m]] = await pool.query(
    `SELECT r.*, t.name AS turf_name, t.timezone AS turf_tz, t.currency_code FROM player_requests r JOIN turfs t ON t.id = r.turf_id WHERE r.id = ?`, [matchId]);
  if (!m) return { status: 404, error: 'Match not found' };
  if (Number(m.host_id) !== Number(userId)) return { status: 403, error: 'Only the host can see this' };
  const [rows] = await pool.query(
    `SELECT p.id, p.role, p.payment_status, p.status, p.amount_paid, p.razorpay_payment_id, p.joined_at, p.confirmed_at, p.reserved_until, u.name AS user_name
     FROM match_players p JOIN users u ON u.id = p.user_id WHERE p.match_id = ? AND p.user_id <> ? ORDER BY p.joined_at`, [matchId, m.host_id]);
  const [[host]] = await pool.query('SELECT name FROM users WHERE id = ?', [m.host_id]);
  const share = Number(m.contribution_amount) || 0;
  const paid = rows.filter((r) => r.payment_status === 'paid');
  const reserved = rows.filter((r) => r.payment_status === 'pending' && r.reserved_until && new Date(r.reserved_until) > new Date());
  const confirmed = 1 + paid.length;
  const currency = m.currency_code || 'INR';
  const hostShareMinor = Math.max(0, toMinor(Number(m.booking_total_amount) || 0, currency) - toMinor(share, currency) * (Number(m.total_slots) - 1));
  const collectedMinor = paid.reduce((s, r) => s + toMinor(r.amount_paid || 0, currency), 0);
  const dueMinor = Math.max(0, toMinor(share, currency) * (Number(m.total_slots) - 1) - collectedMinor);
  const tz = m.turf_tz || 'Asia/Kolkata';
  return {
    status: 200, match_id: m.id, venue: m.turf_name, currency, state: sessionState(m, tz), invite_url: inviteUrl(m.share_token),
    total_amount: Number(m.booking_total_amount) || 0, share_amount: share, host_share: fromMinor(hostShareMinor, currency),
    capacity: Number(m.total_slots), confirmed_participants: confirmed, remaining_spots: Math.max(0, Number(m.total_slots) - confirmed - reserved.length), reserved_spots: reserved.length,
    amount_collected_from_players: fromMinor(collectedMinor, currency), amount_outstanding: fromMinor(dueMinor, currency),
    participants: [
      { name: firstName(host && host.name), role: 'Host', is_host: true, payment_status: 'paid' },
      ...rows.filter((r) => r.payment_status === 'paid' || r.payment_status === 'pending' || r.payment_status === 'failed').map((r) => ({
        name: firstName(r.user_name), role: r.role || 'Player', is_host: false, amount: Number(r.amount_paid) || 0,
        payment_status: r.payment_status === 'pending' && !(r.reserved_until && new Date(r.reserved_until) > new Date()) ? 'expired' : r.payment_status,
        paid_at: r.confirmed_at || null,
      })),
    ],
  };
}

/** A paid participant's receipt (or a clearly-labelled pending acknowledgement). Never a "success" for an unpaid row. */
async function receiptFor(matchPlayerId, userId) {
  const [[row]] = await pool.query(
    `SELECT p.*, r.booking_total_amount, r.contribution_amount, r.match_date, r.match_time, r.booking_time_slot, r.sport_type, r.total_slots, r.share_token, r.id AS match_id,
            t.name AS venue_name, t.currency_code, u.name AS participant_name
     FROM match_players p JOIN player_requests r ON r.id = p.match_id JOIN turfs t ON t.id = r.turf_id JOIN users u ON u.id = p.user_id WHERE p.id = ?`, [matchPlayerId]);
  if (!row || Number(row.user_id) !== Number(userId)) return { status: 404, error: 'Receipt not found' };
  const currency = row.currency_code || 'INR';
  const [bk] = await pool.query('SELECT * FROM bookings WHERE match_request_id = ? ORDER BY id', [row.match_id]);
  const couponCode = (bk.find((b) => b.coupon_code) || {}).coupon_code || null;
  const discountTotal = bk.reduce((s, b) => s + (Number(b.discount_amount) || 0), 0);
  const participants = Number(row.total_slots) || 1;
  const allocatedDiscount = couponCode && discountTotal > 0 ? fromMinor(Math.floor(toMinor(discountTotal, currency) / participants), currency) : 0;
  const paid = row.payment_status === 'paid';
  const ref = (bk[0] && (bk[0].booking_code || `BA-${bk[0].id}`)) || `MATCH-${row.match_id}`;
  return {
    status: 200,
    receipt: {
      state: paid ? 'paid' : (row.payment_status === 'pending' ? 'pending' : 'failed'),
      label: paid ? 'Payment confirmed' : (row.payment_status === 'pending' ? 'Payment pending — not confirmed yet' : 'Payment failed — nothing was charged to this match'),
      booking_reference: ref, match_id: row.match_id, venue: row.venue_name, sport: row.sport_type, date: String(row.match_date).slice(0, 10), time: row.booking_time_slot || String(row.match_time || '').slice(0, 5),
      participant_name: row.participant_name, amount: Number(row.amount_paid) || 0, currency, coupon_code: couponCode, discount_allocated: allocatedDiscount,
      transaction_reference: paid ? (row.razorpay_payment_id || null) : null, confirmed_at: paid ? (row.confirmed_at || row.joined_at) : null, invite_token: row.share_token,
    },
  };
}

// ------------------------------------------------------------------------------------------------------------- refunds
/** A player's payment cannot be honoured (match full / cancelled / started, or a duplicate payment): give it back in full. Never throws. */
async function refundPlayerPayment({ matchId, userId, paymentId, amountMinor, currency = 'INR', reason }) {
  try {
    if (!paymentId || !(amountMinor > 0)) return { attempted: false };
    const [[b]] = await pool.query(
      `SELECT b.id, t.id AS turf_id, t.name AS venue_name, t.owner_id, t.country_code FROM bookings b JOIN turfs t ON t.id = b.turf_id WHERE b.match_request_id = ? ORDER BY b.id LIMIT 1`, [matchId]);
    const conn = await pool.getConnection();
    let rec;
    try {
      rec = await refunds.createRecord(conn, {
        bookingType: 'turf', bookingId: b ? b.id : matchId, paymentId, userId, ownerId: b && b.owner_id, venueId: b && b.turf_id, venueName: b && b.venue_name, countryCode: b && b.country_code,
        businessType: 'SPORTS', originalAmountMinor: amountMinor, amountPaidMinor: amountMinor, cancellationFeeMinor: 0, refundAmountMinor: amountMinor, currency,
        reason: reason || 'Match spot was no longer available', cancelledBy: 'admin', cancellationType: 'admin_cancelled',
      });
    } finally { conn.release(); }
    if (rec && rec.refund) { const r = await refunds.initiate(rec.refund.id); return { attempted: true, refund: (r && r.refund) || rec.refund }; }
    return { attempted: true };
  } catch (e) {
    console.error('[match-join] refund failed (needs admin retry):', e.message);
    return { attempted: true, error: e.message };
  }
}

// ----------------------------------------------------------------------------------------------------- confirm a payment
/**
 * Turn a VERIFIED payment into a confirmed participant. Called by /join/verify (client returns, signature checked) and by the
 * payment.captured webhook (gateway event, signature checked) — whichever arrives first wins and the other is a harmless no-op.
 *
 * `verified` must already be true: the caller checked the Razorpay signature / webhook signature. `capturedMinor` is the amount
 * the gateway reports (undefined when it could not be fetched).
 * Returns { ok, alreadyPaid } | { refunded } | { error, status }.
 */
async function confirmPayment({ matchPlayerId = null, orderId, paymentId, signature = null, userId = null, capturedMinor, currency, verified }) {
  if (!verified) return { status: 400, error: 'Payment is not verified' };
  const conn = await pool.getConnection();
  let outcome;
  try {
    await conn.beginTransaction();
    const [[row]] = matchPlayerId
      ? await conn.query('SELECT * FROM match_players WHERE id = ? FOR UPDATE', [matchPlayerId])
      : await conn.query('SELECT * FROM match_players WHERE razorpay_order_id = ? FOR UPDATE', [orderId]);
    if (!row) { await conn.rollback(); return { status: 404, error: 'Join record not found', notFound: true }; }
    if (userId && Number(row.user_id) !== Number(userId)) { await conn.rollback(); return { status: 403, error: 'Not authorized' }; }
    if (!row.razorpay_order_id || row.razorpay_order_id !== orderId) { await conn.rollback(); return { status: 400, error: 'Payment does not belong to this join request' }; }

    // idempotent: already credited (by the other path, or a double tap) — never twice
    if (row.payment_status === 'paid') {
      await conn.commit();
      const dup = row.razorpay_payment_id && row.razorpay_payment_id !== paymentId;
      outcome = { ok: true, alreadyPaid: true, row };
      if (dup) outcome.duplicateRefund = { matchId: row.match_id, userId: row.user_id, paymentId, amountMinor: capturedMinor, currency };
    } else {
      const [[used]] = await conn.query('SELECT id FROM match_players WHERE razorpay_payment_id = ? AND id <> ? LIMIT 1', [paymentId, row.id]);
      if (used) { await conn.rollback(); return { status: 409, error: 'This payment was already used' }; }

      const [[match]] = await conn.query(
        `SELECT r.*, t.timezone AS tz, t.currency_code FROM player_requests r JOIN turfs t ON t.id = r.turf_id WHERE r.id = ? FOR UPDATE`, [row.match_id]);
      if (!match) { await conn.rollback(); return { status: 404, error: 'Match not found' }; }
      const cur = currency || match.currency_code || 'INR';
      const expectedMinor = toMinor(row.amount_paid || 0, cur);
      if (Number.isFinite(capturedMinor) && expectedMinor > 0 && capturedMinor + 1 < expectedMinor) {
        await conn.rollback();
        console.error(`[match-join] payment ${paymentId} captured ${capturedMinor} but ${expectedMinor} was due; not crediting`);
        return { status: 400, error: 'Payment amount does not match this match share' };
      }

      const state = sessionState(match, match.tz || 'Asia/Kolkata');
      if (state !== 'open' || Number(match.filled_slots) >= Number(match.total_slots)) {
        // the money is real but the spot is gone: record the player as not joined and give the money back
        await conn.query("UPDATE match_players SET payment_status = 'failed', status = 'rejected', razorpay_payment_id = ?, reserved_until = NULL WHERE id = ?", [paymentId, row.id]);
        await conn.commit();
        outcome = { refunded: true, state, refund: { matchId: row.match_id, userId: row.user_id, paymentId, amountMinor: Number.isFinite(capturedMinor) ? capturedMinor : expectedMinor, currency: cur, reason: `Match ${state === 'open' ? 'is full' : state}` } };
      } else {
        await conn.query(
          `UPDATE match_players SET payment_status = 'paid', status = 'approved', razorpay_payment_id = ?, razorpay_signature = ?, confirmed_at = NOW(), reserved_until = NULL WHERE id = ?`,
          [paymentId, signature, row.id]);
        const nextFilled = Number(match.filled_slots || 0) + 1;
        const nextStatus = nextFilled >= Number(match.total_slots || 0) ? 'full' : 'open';
        await conn.query('UPDATE player_requests SET filled_slots = ?, status = ? WHERE id = ?', [nextFilled, nextStatus, match.id]);
        await conn.query('UPDATE users SET karma_points = karma_points + 50 WHERE id = ?', [row.user_id]);
        await conn.commit();
        outcome = { ok: true, matchBefore: match, nextFilled, becameFull: nextStatus === 'full', row: { ...row, id: row.id } };
      }
    }
  } catch (e) {
    try { await conn.rollback(); } catch (x) { /* already */ }
    throw e;
  } finally { conn.release(); }

  // after the commit: refunds never block (or roll back) the confirmation
  if (outcome && outcome.refund) outcome.refundResult = await refundPlayerPayment(outcome.refund);
  if (outcome && outcome.duplicateRefund) outcome.duplicateRefundResult = await refundPlayerPayment({ ...outcome.duplicateRefund, reason: 'Duplicate payment for the same match spot' });
  return outcome;
}

/**
 * Gateway webhook (payment.captured, signature already verified by the caller): a player whose app died right after paying still gets
 * their spot. { notFound: true } when the order is not a Find Players join, so the caller can try the other kinds of payment.
 */
async function confirmByOrder({ orderId, paymentId, amountMinor, currency }) {
  if (!orderId) return { notFound: true };
  const [[row]] = await pool.query('SELECT id FROM match_players WHERE razorpay_order_id = ?', [orderId]);
  if (!row) return { notFound: true };
  const out = await confirmPayment({ matchPlayerId: row.id, orderId, paymentId, capturedMinor: Number.isFinite(Number(amountMinor)) ? Number(amountMinor) : undefined, currency, verified: true });
  if (out && out.ok && !out.alreadyPaid) {
    try { require('../utils/notifications/events').fire('find_players.join_requested', { matchPlayerId: row.id }); } catch (e) { /* notification is best-effort */ }
  }
  return out || { notFound: false };
}

module.exports = { confirmByOrder, RESERVATION_MINUTES, matchWindow, sessionState, STATE_MESSAGE, activeReservations, publicInvite, hostSummary, receiptFor, refundPlayerPayment, confirmPayment, firstName };
