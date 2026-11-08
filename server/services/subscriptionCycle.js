// Anniversary-based billing cycles for a turf's platform subscription (pure date maths, no DB).
//
// A cycle that starts on 8 September ends on 7 October; the next one starts on 8 October. The anniversary day is kept
// even across short months (an anchor on the 31st starts cycles on 28/29 Feb, 31 Mar, 30 Apr ...). Dates are plain
// 'YYYY-MM-DD' calendar dates with no timezone, so there is no off-by-one at midnight.

const PERIOD_MONTHS = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) throw new Error(`"${s}" is not a YYYY-MM-DD date`);
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error(`"${s}" is not a real date`);
  return { y, mo, d };
}
const pad = (n) => String(n).padStart(2, '0');
const fmt = (y, mo, d) => `${y}-${pad(mo)}-${pad(d)}`;
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

// the start date of cycle number k (k >= 0) for an anchor
function cycleStart(anchor, k, months) {
  const a = parseYmd(anchor);
  const total = a.y * 12 + (a.mo - 1) + k * months;
  const y = Math.floor(total / 12), mo = (total % 12) + 1;
  return fmt(y, mo, Math.min(a.d, daysInMonth(y, mo)));
}
function dayBefore(ymd) {
  const { y, mo, d } = parseYmd(ymd);
  const dt = new Date(Date.UTC(y, mo - 1, d - 1));
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/**
 * The cycle containing `onDate`: { start, end, index }. `onDate` before the anchor has no cycle (returns null) — a
 * subscription that has not started yet is not billable.
 */
function cycleContaining(anchor, onDate, period = 'MONTHLY') {
  const months = PERIOD_MONTHS[period];
  if (!months) throw new Error(`unknown subscription period "${period}"`);
  if (onDate < anchor) return null; // YYYY-MM-DD strings compare chronologically
  const a = parseYmd(anchor), t = parseYmd(onDate);
  let k = Math.floor(((t.y * 12 + t.mo - 1) - (a.y * 12 + a.mo - 1)) / months);
  if (k < 0) k = 0;
  while (cycleStart(anchor, k, months) > onDate) k -= 1;
  while (cycleStart(anchor, k + 1, months) <= onDate) k += 1;
  return { index: k, start: cycleStart(anchor, k, months), end: dayBefore(cycleStart(anchor, k + 1, months)) };
}

module.exports = { PERIOD_MONTHS, cycleContaining, cycleStart, dayBefore };
