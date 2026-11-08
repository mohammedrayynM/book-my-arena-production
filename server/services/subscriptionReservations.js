// Subscription reservations as seen by the NORMAL booking engine and the owner's slot tools. Read-only helpers + the date
// math shared with the subscription engine. A slot reserved by an ACTIVE subscription is never bookable by anyone else.
const pool = require('../config/db');
const T = require('../utils/notifications/time');

const SLOT_MESSAGE = 'This slot is reserved for a subscription member.';

const pad = (n) => String(n).padStart(2, '0');
const toMinutes = (hhmm) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const ymdOf = (v) => (v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : String(v).slice(0, 10));
const dayOfWeek = (ymd) => { const [y, m, d] = ymdOf(ymd).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }; // 0 = Sunday
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

/** 8 Sep + 1 month = 8 Oct. 31 Jan + 1 month = 28/29 Feb (clamped, never overflowing into March). Calendar months, not 30 days. */
function addMonthsClamped(ymd, months) {
  const [y, m, d] = ymdOf(ymd).split('-').map(Number);
  const total = (y * 12 + (m - 1)) + Number(months);
  const ny = Math.floor(total / 12); const nm = (total % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
}
const addDays = (ymd, n) => { const [y, m, d] = ymdOf(ymd).split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d + Number(n))); return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`; };

/** "1,3,5" -> Set{1,3,5}; 'all' / empty / null -> null (every day). Invalid input -> undefined. */
function parseWeekdays(csv) {
  if (csv == null || csv === '' || String(csv).toLowerCase() === 'all') return null;
  const parts = String(Array.isArray(csv) ? csv.join(',') : csv).split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (!parts.length || !parts.every((p) => /^[0-6]$/.test(p))) return undefined;
  return new Set(parts.map(Number));
}
const weekdaysCsv = (set) => (set ? [...set].sort().join(',') : 'all');

/** Every date in [startYmd, endExclusiveYmd) whose weekday is in the set (null = all). */
function occurrencesBetween(startYmd, endExclusiveYmd, set) {
  const out = []; let cur = ymdOf(startYmd); let guard = 0; endExclusiveYmd = ymdOf(endExclusiveYmd);
  while (cur < endExclusiveYmd && guard++ < 800) { if (!set || set.has(dayOfWeek(cur))) out.push(cur); cur = addDays(cur, 1); }
  return out;
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/** Active reservations on a venue/court/date, as minute ranges. */
async function reservedRangesForDate(turfId, courtId, date, conn = pool) {
  const [rows] = await conn.query(
    "SELECT start_time, end_time FROM subscription_reservations WHERE turf_id = ? AND court_key = ? AND reservation_date = ? AND status = 'active' AND active_key = 1",
    [turfId, courtId ? Number(courtId) : 0, ymdOf(date)]
  );
  return rows.map((r) => ({ start: toMinutes(r.start_time), end: toMinutes(r.end_time) }));
}

/** Is this normal-booking slot (e.g. "07:00 PM - 08:00 PM") covered by an active subscription reservation? */
async function slotReserved({ turfId, courtId, date, slotLabel }) {
  const s = T.parseSlot(slotLabel);
  if (!s) return false;
  const start = toMinutes(s.start); const end = s.end ? toMinutes(s.end) : start + 60;
  const ranges = await reservedRangesForDate(turfId, courtId, date);
  return ranges.some((r) => overlaps(start, end, r.start, r.end));
}

/**
 * Serialise with subscription activation / manual membership on one venue: holds the venue row lock (the same one the
 * subscription engine takes) until release(). Normal-booking confirmation uses it around "check conflicts -> confirm", so a booking
 * and a subscription can never both win the same slot.
 */
async function lockVenue(turfId) {
  const conn = await pool.getConnection();
  try { await conn.beginTransaction(); await conn.query('SELECT id FROM turfs WHERE id = ? FOR UPDATE', [turfId]); }
  catch (e) { try { await conn.rollback(); } catch (x) { /* ignore */ } conn.release(); throw e; }
  let done = false;
  return { release: async () => { if (done) return; done = true; try { await conn.commit(); } finally { conn.release(); } } };
}

module.exports = { lockVenue, SLOT_MESSAGE, toMinutes, ymdOf, dayOfWeek, addMonthsClamped, addDays, parseWeekdays, weekdaysCsv, occurrencesBetween, overlaps, reservedRangesForDate, slotReserved };
