// Owner analytics + downloadable reports for the ticket engine. Everything is scoped to one owner (and optionally one
// of their activities). Date ranges are on the ENTRY date (booking_date): that is a plain DATE with no timezone, so
// "this week" means "visits this week" — no created_at/NOW() timezone drift (the DB stores UTC, the server runs local).
const pool = require('../config/db');

const ymd = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const localStamp = (d) => `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const APP_TZ_OFFSET_MIN = Number(process.env.APP_TZ_OFFSET_MINUTES || 330); // India
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function scope(ownerId, activityId, alias = 'b') {
  const where = [`${alias}.owner_id = ?`]; const params = [ownerId];
  if (activityId) { where.push(`${alias}.activity_id = ?`); params.push(activityId); }
  return { where, params };
}

async function sums(ownerId, activityId, from, to) {
  const { where, params } = scope(ownerId, activityId);
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS bookings, COALESCE(SUM(b.total_amount),0) AS revenue
     FROM activity_bookings b WHERE ${where.join(' AND ')} AND b.status = 'confirmed' AND b.booking_date BETWEEN ? AND ?`, [...params, from, to]
  );
  const [[q]] = await pool.query(
    `SELECT COALESCE(SUM(i.quantity),0) AS tickets FROM activity_booking_items i JOIN activity_bookings b ON b.id = i.booking_id
     WHERE ${where.join(' AND ')} AND b.status = 'confirmed' AND b.booking_date BETWEEN ? AND ?`, [...params, from, to]
  );
  return { bookings: Number(r.bookings), revenue: Number(r.revenue), tickets: Number(q.tickets) };
}

// The currency amounts are shown in: the owner's venue currency (a single owner with venues in two countries gets 'mixed').
async function ownerCurrencies(ownerId, activityId = null) {
  const [rows] = await pool.query(`SELECT DISTINCT currency_code FROM activities WHERE owner_id = ?${activityId ? ' AND id = ?' : ''}`, activityId ? [ownerId, activityId] : [ownerId]);
  return rows.map((r) => r.currency_code);
}

async function analytics({ ownerId, activityId = null, now = new Date() }) {
  const today = ymd(now);
  const [today_, week, month] = await Promise.all([
    sums(ownerId, activityId, today, today),
    sums(ownerId, activityId, ymd(addDays(now, -6)), today),
    sums(ownerId, activityId, ymd(addDays(now, -29)), today),
  ]);
  const { where, params } = scope(ownerId, activityId, 't');
  const nowStamp = localStamp(now);
  const b = scope(ownerId, activityId);
  const sc = scope(ownerId, activityId, 't');
  // the five reads are independent — run them together (the DB is a network hop away)
  const [[[tk]], [byType], [peakDates], [daily], [scans]] = await Promise.all([
    // ticket-level counts in PEOPLE (quantity_covered), across every confirmed-or-later booking
    pool.query(
      `SELECT COALESCE(SUM(t.quantity_covered),0) AS total,
              COALESCE(SUM(t.redeemed_quantity),0) AS redeemed,
              COALESCE(SUM(CASE WHEN t.status IN ('CANCELLED','REFUNDED') THEN t.quantity_covered ELSE 0 END),0) AS cancelled,
              COALESCE(SUM(CASE WHEN t.status = 'EXPIRED' OR (t.status IN ('VALID','UNUSED','SCANNED') AND t.valid_until < ?) THEN t.quantity_covered - t.redeemed_quantity ELSE 0 END),0) AS expired,
              COALESCE(SUM(CASE WHEN t.status IN ('VALID','UNUSED','SCANNED') AND t.valid_until >= ? THEN t.quantity_covered - t.redeemed_quantity ELSE 0 END),0) AS upcoming
       FROM activity_tickets t WHERE ${where.join(' AND ')}`, [nowStamp, nowStamp, ...params]
    ).then((r) => [r[0]]),
    pool.query(
      `SELECT tt.name, SUM(i.quantity) AS tickets, SUM(i.line_total) AS revenue
       FROM activity_booking_items i JOIN activity_bookings b ON b.id = i.booking_id JOIN activity_ticket_types tt ON tt.id = i.ticket_type_id
       WHERE ${b.where.join(' AND ')} AND b.status = 'confirmed' GROUP BY tt.id, tt.name ORDER BY tickets DESC`, b.params
    ),
    pool.query(
      `SELECT b.booking_date AS date, SUM(i.quantity) AS tickets
       FROM activity_booking_items i JOIN activity_bookings b ON b.id = i.booking_id
       WHERE ${b.where.join(' AND ')} AND b.status = 'confirmed' GROUP BY b.booking_date ORDER BY tickets DESC LIMIT 5`, b.params
    ),
    pool.query(
      `SELECT b.booking_date AS date, COALESCE(SUM(b.total_amount),0) AS revenue, COUNT(*) AS bookings
       FROM activity_bookings b WHERE ${b.where.join(' AND ')} AND b.status = 'confirmed' AND b.booking_date BETWEEN ? AND ?
       GROUP BY b.booking_date ORDER BY b.booking_date`, [...b.params, ymd(addDays(now, -29)), today]
    ),
    pool.query(
      `SELECT UNIX_TIMESTAMP(l.created_at) AS ts, l.quantity_redeemed AS qty
       FROM activity_qr_scan_logs l JOIN activity_tickets t ON t.id = l.ticket_id
       WHERE ${sc.where.join(' AND ')} AND l.result = 'VALID'`, sc.params
    ),
  ]);
  const total = Number(tk.total), redeemed = Number(tk.redeemed), cancelled = Number(tk.cancelled);
  const expired = Number(tk.expired), upcoming = Number(tk.upcoming);
  const usable = total - cancelled;

  const hours = Array.from({ length: 24 }, () => 0);
  for (const s of scans) hours[new Date(Number(s.ts) * 1000 + APP_TZ_OFFSET_MIN * 60000).getUTCHours()] += Number(s.qty);
  const peakHours = hours.map((entries, hour) => ({ hour, entries })).filter((h) => h.entries > 0).sort((a, c) => c.entries - a.entries).slice(0, 5);

  const currencies = await ownerCurrencies(ownerId, activityId);
  return {
    currency: currencies[0] || 'INR', currencies, today: today_, week, month,
    tickets: { total, redeemed, expired, cancelled, upcoming, no_show: expired, redemption_rate: usable > 0 ? Math.round((redeemed / usable) * 1000) / 10 : 0 },
    by_ticket_type: byType.map((r) => ({ name: r.name, tickets: Number(r.tickets), revenue: Number(r.revenue) })),
    peak_dates: peakDates.map((r) => ({ date: ymd(new Date(r.date)), tickets: Number(r.tickets) })),
    peak_entry_hours: peakHours,
    daily: daily.map((r) => ({ date: ymd(new Date(r.date)), revenue: Number(r.revenue), bookings: Number(r.bookings) })),
  };
}

// ---------------------------------------------------------------- reports (CSV / Excel-openable)
const REPORTS = {
  bookings: {
    header: ['Booking ID', 'Activity', 'Customer', 'Phone', 'Entry date', 'Status', 'Payment', 'Subtotal', 'Add-ons', 'Discount', 'Tax', 'Total', 'Refund', 'Refund status'],
    sql: `SELECT b.booking_code, a.name, b.customer_name, b.customer_phone, b.booking_date, b.status, b.payment_status, b.subtotal_amount, b.addon_amount, b.discount_amount, b.tax_amount, b.total_amount, b.refund_amount, b.refund_status
          FROM activity_bookings b JOIN activities a ON a.id = b.activity_id WHERE {where} AND b.booking_date BETWEEN ? AND ? ORDER BY b.booking_date, b.id`,
  },
  tickets: {
    header: ['Booking ID', 'Activity', 'Entry date', 'Ticket status', 'People covered', 'Redeemed', 'Valid from', 'Valid until', 'First scanned'],
    sql: `SELECT b.booking_code, a.name, b.booking_date, t.status, t.quantity_covered, t.redeemed_quantity, t.valid_from, t.valid_until, t.first_scanned_at
          FROM activity_tickets t JOIN activity_bookings b ON b.id = t.booking_id JOIN activities a ON a.id = t.activity_id WHERE {where} AND b.booking_date BETWEEN ? AND ? ORDER BY b.booking_date, t.id`,
  },
  redemptions: {
    header: ['Booking ID', 'Activity', 'Entry date', 'Scan result', 'People', 'Scanned by', 'Method'],
    sql: `SELECT b.booking_code, a.name, b.booking_date, l.result, l.quantity_redeemed, COALESCE(s.name, 'Owner'), IF(l.note = 'MANUAL_VERIFICATION', 'Manual', 'QR')
          FROM activity_qr_scan_logs l JOIN activity_tickets t ON t.id = l.ticket_id JOIN activity_bookings b ON b.id = t.booking_id JOIN activities a ON a.id = t.activity_id
          LEFT JOIN activity_staff s ON s.id = l.scanned_by_staff_id WHERE {where} AND b.booking_date BETWEEN ? AND ? ORDER BY l.id`,
  },
  revenue: {
    header: ['Entry date', 'Bookings', 'Revenue'],
    sql: `SELECT b.booking_date, COUNT(*), SUM(b.total_amount) FROM activity_bookings b WHERE {where} AND b.status = 'confirmed' AND b.booking_date BETWEEN ? AND ? GROUP BY b.booking_date ORDER BY b.booking_date`,
  },
  ticket_types: {
    header: ['Ticket type', 'Tickets sold', 'Revenue'],
    sql: `SELECT tt.name, SUM(i.quantity), SUM(i.line_total) FROM activity_booking_items i JOIN activity_bookings b ON b.id = i.booking_id JOIN activity_ticket_types tt ON tt.id = i.ticket_type_id
          WHERE {where} AND b.status = 'confirmed' AND b.booking_date BETWEEN ? AND ? GROUP BY tt.id, tt.name ORDER BY 2 DESC`,
  },
  cancelled: {
    header: ['Booking ID', 'Activity', 'Customer', 'Entry date', 'Cancelled by', 'Total', 'Refund', 'Refund status'],
    sql: `SELECT b.booking_code, a.name, b.customer_name, b.booking_date, b.cancelled_by, b.total_amount, b.refund_amount, b.refund_status
          FROM activity_bookings b JOIN activities a ON a.id = b.activity_id WHERE {where} AND b.status = 'cancelled' AND b.cancelled_at IS NOT NULL AND b.booking_date BETWEEN ? AND ? ORDER BY b.booking_date`,
  },
  expired: {
    header: ['Booking ID', 'Activity', 'Entry date', 'People covered', 'Redeemed', 'No-show'],
    sql: `SELECT b.booking_code, a.name, b.booking_date, t.quantity_covered, t.redeemed_quantity, t.quantity_covered - t.redeemed_quantity
          FROM activity_tickets t JOIN activity_bookings b ON b.id = t.booking_id JOIN activities a ON a.id = t.activity_id
          WHERE {where} AND (t.status = 'EXPIRED' OR (t.status IN ('VALID','UNUSED','SCANNED') AND t.valid_until < ?)) AND b.booking_date BETWEEN ? AND ? ORDER BY b.booking_date`,
    needsNow: true,
  },
};

// Spreadsheet apps execute cells that start with = + - @ as formulas — prefix those so customer-typed names can't.
const safeCell = (v) => {
  if (v == null) return '';
  const s = v instanceof Date ? ymd(v) : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};
const csvEscape = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const htmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function buildReport({ ownerId, activityId = null, type, from, to, format = 'csv', now = new Date() }) {
  const def = REPORTS[type];
  if (!def) return { error: 'Unknown report type' };
  if (!isYmd(from) || !isYmd(to) || to < from) return { error: 'from and to must be YYYY-MM-DD dates, from <= to' };
  const sc = scope(ownerId, activityId, 'b');
  const sql = def.sql.replace('{where}', sc.where.join(' AND '));
  const params = def.needsNow ? [...sc.params, localStamp(now), from, to] : [...sc.params, from, to];
  const [rows] = await pool.query({ sql, rowsAsArray: true }, params);
  const cells = rows.map((r) => r.map(safeCell));
  const stamp = `${type}_${from}_to_${to}`;
  if (format === 'xls') {
    const html = `<html><head><meta charset="utf-8"></head><body><table border="1"><tr>${def.header.map((h) => `<th>${htmlEscape(h)}</th>`).join('')}</tr>${cells.map((r) => `<tr>${r.map((c) => `<td>${htmlEscape(c)}</td>`).join('')}</tr>`).join('')}</table></body></html>`;
    return { body: html, contentType: 'application/vnd.ms-excel; charset=utf-8', filename: `${stamp}.xls`, rowCount: rows.length };
  }
  const body = '﻿' + [def.header, ...cells].map((r) => r.map((c) => csvEscape(String(c))).join(',')).join('\r\n') + '\r\n';
  return { body, contentType: 'text/csv; charset=utf-8', filename: `${stamp}.csv`, rowCount: rows.length };
}

module.exports = { ownerCurrencies, analytics, buildReport, REPORT_TYPES: Object.keys(REPORTS), ymd, localStamp };
