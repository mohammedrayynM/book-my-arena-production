// Date/time helpers for notifications. Book Arena venues are in India and bookings store a plain DATE plus a slot label
// like "19:00 - 20:00" or "07:00 PM - 08:00 PM" (no timezone), so wall-clock times are interpreted in APP_TZ_OFFSET_MINUTES
// (default +05:30). All "is it time to remind?" maths happens here, on the server, never in the app.

const OFFSET_MIN = Number.isFinite(Number(process.env.APP_TZ_OFFSET_MINUTES)) && process.env.APP_TZ_OFFSET_MINUTES !== undefined && process.env.APP_TZ_OFFSET_MINUTES !== ''
  ? Number(process.env.APP_TZ_OFFSET_MINUTES) : 330;
const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Calendar date ('YYYY-MM-DD') of an instant, as seen in the app's timezone.
function localDateString(ms = Date.now()) {
  const d = new Date(ms + OFFSET_MIN * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// A SQL DATE as mysql2 returns it (a Date at the SERVER's local midnight) or an ISO/date string -> 'YYYY-MM-DD'.
function dateOnly(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : null;
}

// 'YYYY-MM-DD' + 'HH:MM' (wall clock in the app timezone) -> epoch ms
function toEpoch(dateStr, hhmm = '00:00') {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi || 0) - OFFSET_MIN * 60000;
}

// Whole days from date a to date b (both 'YYYY-MM-DD'); positive when b is later.
function dayDiff(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// 'today' / 'tomorrow' / '26 Sep'
function dayLabel(dateStr, nowMs = Date.now()) {
  if (!dateStr) return '';
  const diff = dayDiff(localDateString(nowMs), dateStr);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  const [, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

// 'YYYY-MM-DD' -> '8 Oct' (or '8 Oct 2027' when not this year)
function prettyDate(dateStr, nowMs = Date.now()) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const thisYear = Number(localDateString(nowMs).slice(0, 4));
  return `${d} ${MONTHS[m - 1]}${y !== thisYear ? ` ${y}` : ''}`;
}

// '19:00' -> '7:00 PM'
function time12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

// One slot label ("19:00 - 20:00", "07:00 PM - 08:00 PM", "7 PM - 8 PM") -> { start:'HH:MM', end:'HH:MM' } or null
function parseSlot(label) {
  const parts = String(label || '').split(/\s*[-–]\s*/);
  const one = (s) => {
    const m = /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(s || '');
    if (!m) return null;
    let h = Number(m[1]);
    const ap = (m[3] || '').toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return `${pad(h)}:${m[2] || '00'}`;
  };
  const start = one(parts[0]);
  const end = one(parts[1]);
  return start ? { start, end } : null;
}

module.exports = { OFFSET_MIN, localDateString, dateOnly, toEpoch, dayDiff, addDays, dayLabel, prettyDate, time12, parseSlot };
