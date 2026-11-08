// Date-only fields of a tournament. Stored as SQL DATE, exchanged as 'YYYY-MM-DD' strings.
const DATE_FIELDS = ['start_date', 'end_date', 'reg_open_date', 'reg_close_date'];
// Every SQL DATE column the tournament APIs return (sent to clients as plain YYYY-MM-DD)
const RESPONSE_DATE_FIELDS = [...DATE_FIELDS, 'match_date', 'expiry_date'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Returns the normalised 'YYYY-MM-DD' string, or null when the value is not a real calendar date.
function parseDateOnly(value) {
  if (typeof value !== 'string') return null;
  const m = DATE_RE.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  return m[0];
}

function todayString(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const DATE_LABELS = {
  start_date: 'Start date',
  end_date: 'End date',
  reg_open_date: 'Registration open date',
  reg_close_date: 'Registration close date',
};

// Validates the date fields present in `body`. On success returns { dates } with normalised values
// (empty optional dates become null); on failure returns { error } with a message the user can act on.
// `isCreate` additionally requires start/end and forbids a start date in the past. (Editing keeps the
// past allowed so a tournament that is already running can still be updated.)
function validateTournamentDates(body, { isCreate }) {
  const dates = {};
  for (const field of DATE_FIELDS) {
    const raw = body[field];
    const empty = raw === undefined || raw === null || raw === '';
    if (empty) {
      if (isCreate && (field === 'start_date' || field === 'end_date')) {
        return { error: `${DATE_LABELS[field]} is required` };
      }
      if (raw !== undefined) dates[field] = null;
      continue;
    }
    const parsed = parseDateOnly(raw);
    if (!parsed) return { error: `${DATE_LABELS[field]} must be a valid date in YYYY-MM-DD format` };
    dates[field] = parsed;
  }

  // ISO date strings compare correctly as plain strings.
  const { start_date: start, end_date: end, reg_open_date: regOpen, reg_close_date: regClose } = dates;
  if (isCreate && start && start < todayString()) return { error: 'Start date cannot be in the past' };
  if (start && end && end < start) return { error: 'End date cannot be before the start date' };
  if (regOpen && regClose && regClose < regOpen) return { error: 'Registration close date cannot be before it opens' };
  return { dates };
}

// mysql2 turns SQL DATE into a JS Date at *local* midnight, which JSON-serialises to the previous
// UTC day on any server east of UTC (2026-12-01 -> "2026-11-30T18:30:00.000Z"). Clients need the plain
// calendar date, so wrap res.json and emit date-only fields as 'YYYY-MM-DD'.
function makeDateOnlyResponses(fields) {
  return function dateOnlyResponsesFor(req, res, next) {
  const original = res.json.bind(res);
  const pad = (n) => String(n).padStart(2, '0');
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object' && !(node instanceof Date) && !Buffer.isBuffer(node)) {
      const out = {};
      for (const [key, val] of Object.entries(node)) {
        out[key] = (val instanceof Date && fields.includes(key) && !Number.isNaN(val.getTime()))
          ? `${val.getFullYear()}-${pad(val.getMonth() + 1)}-${pad(val.getDate())}`
          : walk(val);
      }
      return out;
    }
    return node;
  };
  res.json = (body) => original(walk(body));
  next();
  };
}
const dateOnlyResponses = makeDateOnlyResponses(RESPONSE_DATE_FIELDS);

module.exports = { makeDateOnlyResponses, DATE_FIELDS, RESPONSE_DATE_FIELDS, parseDateOnly, todayString, validateTournamentDates, dateOnlyResponses };
