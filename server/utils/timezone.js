// Venue-local time math using the platform's own Intl database — no dependency, DST-correct, and independent of the
// server's timezone. A venue's "8:00 PM" is 8 PM in ITS timezone (Asia/Dubai, Europe/London, America/New_York...).

function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

// wall-clock parts of an instant in a timezone
function wallParts(epochMs, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; for (const { type, value } of f.formatToParts(new Date(epochMs))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/**
 * The instant (epoch ms) at which the wall clock in `tz` reads dateStr 'YYYY-MM-DD' + timeStr 'HH:MM[:SS]'.
 * Two refinement passes make it correct across DST changes.
 */
function zonedEpoch(dateStr, timeStr, tz) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(timeStr || '00:00'));
  if (!dm || !tm) return NaN;
  const wantUtc = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], +(tm[3] || 0));
  if (!isValidTimezone(tz)) return wantUtc; // unknown zone: treat as UTC rather than guessing a server zone
  let guess = wantUtc;
  for (let i = 0; i < 3; i++) {
    const w = wallParts(guess, tz);
    const shown = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
    guess -= shown - wantUtc;
  }
  return guess;
}

/** 'YYYY-MM-DD' for "today" in a timezone. */
function todayIn(tz, now = Date.now()) {
  const w = wallParts(now, isValidTimezone(tz) ? tz : 'UTC');
  const p = (n) => String(n).padStart(2, '0');
  return `${w.y}-${p(w.m)}-${p(w.d)}`;
}

module.exports = { isValidTimezone, zonedEpoch, wallParts, todayIn };
