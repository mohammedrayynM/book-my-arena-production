// Removing a venue (turf) safely.
//
// Venues are ARCHIVED, never hard-deleted: bookings, payments, refunds, payouts, subscriptions and audit rows point at
// turfs.id (and in the original schema `bookings.turf_id` is ON DELETE CASCADE, so a hard DELETE would wipe the whole
// booking + payment history of that venue). Archiving sets is_deleted = 1 / is_active = 0 / status = 'BLOCKED', which every
// public query already excludes (search, featured, All Venues, venue page, slots) and which booking creation already
// refuses. History stays queryable for admins, owners and customers. The owner account and the owner's other venues are
// never touched.
const pool = require('../config/db');

async function countOrZero(sql, params) {
  try { const [[r]] = await pool.query(sql, params); return Number(r?.n || 0); } catch (e) { return 0; } // table may not exist on older installs
}

/** What still depends on this venue going forward (things an archive would NOT cancel automatically). */
async function venueImpact(turfId) {
  const upcomingBookings = await countOrZero(
    "SELECT COUNT(*) AS n FROM bookings WHERE turf_id = ? AND status = 'confirmed' AND payment_status = 'success' AND booking_date >= CURDATE()", [turfId]);
  const activeSubscriptions = await countOrZero(
    "SELECT COUNT(*) AS n FROM user_subscriptions WHERE turf_id = ? AND status IN ('active','past_due') AND expiry_date >= CURDATE()", [turfId]);
  const pastBookings = await countOrZero('SELECT COUNT(*) AS n FROM bookings WHERE turf_id = ?', [turfId]);
  return { upcomingBookings, activeSubscriptions, pastBookings };
}

/**
 * @param {{turfId:number, actor:{role:'admin'|'owner', id:number}, ownerId?:number|null, force?:boolean}} p
 * @returns {Promise<{status:number, body:object}>}
 */
async function archiveVenue({ turfId, actor, ownerId = null, force = false }) {
  const id = Number(turfId);
  if (!Number.isInteger(id) || id <= 0) return { status: 400, body: { success: false, error: 'A valid venue id is required', code: 'INVALID_ID' } };

  const [[turf]] = await pool.query('SELECT id, name, owner_id, is_deleted FROM turfs WHERE id = ?', [id]);
  if (!turf) return { status: 404, body: { success: false, error: 'This venue no longer exists.', code: 'VENUE_NOT_FOUND' } };
  if (ownerId != null && Number(turf.owner_id) !== Number(ownerId)) return { status: 403, body: { success: false, error: 'You do not own this venue', code: 'FORBIDDEN' } };
  if (Number(turf.is_deleted) === 1) {
    return { status: 200, body: { success: true, archived: true, already: true, message: `${turf.name} was already deleted.`, venue: { id: turf.id, name: turf.name } } };
  }

  const impact = await venueImpact(id);
  if (!force && (impact.upcomingBookings > 0 || impact.activeSubscriptions > 0)) {
    const parts = [];
    if (impact.upcomingBookings) parts.push(`${impact.upcomingBookings} upcoming paid booking${impact.upcomingBookings === 1 ? '' : 's'}`);
    if (impact.activeSubscriptions) parts.push(`${impact.activeSubscriptions} active subscription${impact.activeSubscriptions === 1 ? '' : 's'}`);
    return {
      status: 409,
      body: {
        success: false, code: 'VENUE_HAS_UPCOMING', impact, venue: { id: turf.id, name: turf.name },
        error: actor.role === 'admin'
          ? `${turf.name} still has ${parts.join(' and ')}. Deleting will hide the venue and stop new bookings, but those existing bookings are NOT cancelled or refunded automatically.`
          : `${turf.name} still has ${parts.join(' and ')}. Cancel them first, or contact Book Arena support to remove this venue.`,
      },
    };
  }

  const by = `${actor.role}:${actor.id}`;
  try {
    await pool.query("UPDATE turfs SET is_deleted = 1, is_active = 0, status = 'BLOCKED', deleted_at = NOW(), deleted_by = ? WHERE id = ?", [by, id]);
  } catch (e) {
    if (!/Unknown column/i.test(e.message)) throw e;
    await pool.query("UPDATE turfs SET is_deleted = 1, is_active = 0, status = 'BLOCKED' WHERE id = ?", [id]); // before the startup migration added deleted_at/deleted_by
  }
  // stop selling new monthly plans for it (existing subscriptions keep their records)
  await pool.query('UPDATE subscription_plans SET is_active = FALSE WHERE turf_id = ?', [id]).catch(() => {});
  console.log(`[venue] ${turf.name} (#${id}) archived by ${by}${force ? ' (forced)' : ''}; impact ${JSON.stringify(impact)}`);
  return {
    status: 200,
    body: { success: true, archived: true, message: `${turf.name} was deleted. Its booking and payment history is kept.`, venue: { id: turf.id, name: turf.name }, impact },
  };
}

module.exports = { archiveVenue, venueImpact };
