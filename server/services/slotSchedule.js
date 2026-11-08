// THE single source of truth for slot generation and slot-time math. The website, the mobile app, the owner Slot Control,
// the availability checks and the booking/blocking routes all go through here — nobody builds slot labels or compares
// slot text on their own any more.
//
// Model
//  - A venue (or court) has an *operating window* on each local calendar day D: either "24 hours" (00:00 → 24:00 of D) or
//    open→close, where close <= open means the window runs past midnight into D+1 (an overnight session that belongs to D).
//  - Slots are `duration` minutes long, start at `open`, and each must END at or before the window end (no slot sticks out
//    past closing time). Offsets are minutes from 00:00 of D, so an after-midnight slot has startMin >= 1440.
//  - A slot's identity everywhere is its label ("8:00 PM - 9:00 PM"); conflicts are decided on the *time range*, never on the
//    label text, so 12h/24h label styles or 30/60-minute changes can never hide a clash.
const { zonedEpoch, wallParts, isValidTimezone } = require('../utils/timezone');

const DAY = 1440;
const pad = (n) => String(n).padStart(2, '0');

/** "06:00", "6:00 PM", "18:00:00", "24:00" -> minutes from midnight (24:00 -> 1440). NaN when it isn't a time. */
function parseClock(value) {
  const s = String(value == null ? '' : value).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!m) return NaN;
  let h = parseInt(m[1], 10); const mi = parseInt(m[2], 10); const ap = m[3] && m[3].toUpperCase();
  if (mi > 59) return NaN;
  if (ap) { if (h < 1 || h > 12) return NaN; if (ap === 'PM' && h !== 12) h += 12; if (ap === 'AM' && h === 12) h = 0; }
  if (h === 24 && mi === 0 && !ap) return DAY;
  if (h > 23) return NaN;
  return h * 60 + mi;
}

const truthy = (v) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';

/**
 * Resolve the operating window of a venue/court row. Returns { is24, open, end, overnight } in minutes (end is absolute from the
 * start of the operating day, so end > open always) or { error } for configurations that cannot produce valid slots.
 * Legacy rows: open 00:00 + close 00:00/23:59/24:00 has always meant "all day" and still does (no silent change).
 */
function resolveWindow({ open_time, close_time, is_24_hours } = {}) {
  if (truthy(is_24_hours)) return { is24: true, open: 0, end: DAY, overnight: false };
  const open = parseClock(open_time == null || open_time === '' ? '06:00' : open_time);
  let close = parseClock(close_time == null || close_time === '' ? '23:00' : close_time);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return { error: 'Opening and closing times must be valid times (HH:MM).' };
  if (open === DAY) return { error: 'Opening time cannot be 24:00.' };
  if (open === 0 && (close === 0 || close === DAY || close === DAY - 1)) return { is24: true, open: 0, end: DAY, overnight: false, legacy: true };
  if (close === open) return { error: 'Opening and closing time are the same. Turn on 24-hour operation, or choose different times.' };
  const overnight = close < open;
  if (overnight) close += DAY;
  return { is24: false, open, end: close, overnight };
}

/** Validation for the owner forms / API. Returns an error string or null. */
function validateSchedule({ open_time, close_time, is_24_hours, slot_duration }) {
  if (slot_duration !== undefined && ![30, 60].includes(Number(slot_duration))) return 'Slot duration must be 30 or 60 minutes.';
  if (truthy(is_24_hours)) return null;
  const w = resolveWindow({ open_time, close_time });
  if (w.error) return w.error;
  if (w.end - w.open < (Number(slot_duration) || 30)) return 'The operating window is shorter than one slot.';
  return null;
}

const clock12 = (min) => { const m = ((min % DAY) + DAY) % DAY; const h = Math.floor(m / 60); return `${h % 12 || 12}:${pad(m % 60)} ${h >= 12 ? 'PM' : 'AM'}`; };
const clock24 = (min) => { const m = ((min % DAY) + DAY) % DAY; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };

/**
 * Every slot of the operating day: [{ label, startMin, endMin, period }]. startMin/endMin are offsets from 00:00 of the operating day.
 * `timeFormat` only changes the label text ('12h' default, '24h'); the stored identity is still compared by range.
 */
function generateDaySlots(cfg, { duration = 60, timeFormat = '12h' } = {}) {
  const w = resolveWindow(cfg);
  if (w.error) return [];
  const step = Number(duration) === 30 ? 30 : 60;
  const f = timeFormat === '24h' ? clock24 : clock12;
  const out = [];
  for (let s = w.open; s + step <= w.end; s += step) out.push({ label: `${f(s)} - ${f(s + step)}`, startMin: s, endMin: s + step });
  return out;
}

/** Parse a slot label ("6:00 PM - 7:00 PM", "18:00 - 19:00", "11:00 PM - 12:00 AM") -> { start, end } clock minutes (end > start). */
function parseSlotLabel(label) {
  const parts = String(label || '').split(/\s*[-–—]\s*/);
  if (parts.length < 2) return null;
  const a = parseClock(parts[0]); let b = parseClock(parts[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b <= a) b += DAY;
  return { start: a, end: b };
}

/**
 * Place a label on the operating-day axis of a window: an after-midnight slot of an overnight window (start before opening time)
 * moves a day later, so 6 PM and 1 AM of the same session compare in the right order.
 */
function intervalOf(label, window) {
  const p = parseSlotLabel(label);
  if (!p) return null;
  let { start, end } = p;
  if (window && window.overnight && start < window.open) { start += DAY; end += DAY; }
  return { start, end };
}
const rangesOverlap = (a, b) => !!a && !!b && a.start < b.end && b.start < a.end;
const labelsOverlap = (x, y, window) => rangesOverlap(intervalOf(x, window), intervalOf(y, window));

/** Window-less conflict test (used where the venue config isn't at hand): also tests the neighbouring day so a 11:30 PM–12:30 AM slot clashes with 12:00 AM–1:00 AM. */
function labelsConflict(x, y) {
  const a = intervalOf(x, null), b = intervalOf(y, null);
  if (!a || !b) return String(x).trim() === String(y).trim();
  return [-DAY, 0, DAY].some((sh) => rangesOverlap(a, { start: b.start + sh, end: b.end + sh }));
}

function periodOf(startMin) {
  const m = ((startMin % DAY) + DAY) % DAY;
  return m < 360 ? 'earlyMorning' : m < 720 ? 'morning' : m < 1080 ? 'afternoon' : 'evening';
}

/** Wall-clock start of a slot as an epoch, in the venue timezone. Returns NaN for a local time that does not exist (DST gap). */
function slotStartEpoch(dateStr, startMin, tz) {
  const zone = isValidTimezone(tz) ? tz : 'Asia/Kolkata';
  const dayShift = Math.floor(startMin / DAY);
  const m = ((startMin % DAY) + DAY) % DAY;
  const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + dayShift);
  const ds = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const epoch = zonedEpoch(ds, `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, zone);
  const w = wallParts(epoch, zone);   // round-trip: if the clock reads something else, that wall time was skipped (spring-forward)
  return (w.h === Math.floor(m / 60) && w.mi === m % 60) ? epoch : NaN;
}

/** Does this slot still lie in the future at `now`, in the venue's own timezone? */
function isFutureSlot(dateStr, slot, tz, now = Date.now()) {
  const e = slotStartEpoch(dateStr, slot.startMin, tz);
  return Number.isFinite(e) && e > now;
}

module.exports = { DAY, parseClock, resolveWindow, validateSchedule, generateDaySlots, parseSlotLabel, intervalOf, rangesOverlap, labelsOverlap, labelsConflict, periodOf, slotStartEpoch, isFutureSlot, clock12, clock24, truthy };
