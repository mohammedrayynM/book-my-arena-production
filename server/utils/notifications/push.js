// Push delivery through Expo's push service (the provider the app is built on: expo-notifications + Expo push tokens).
//
// One notification_deliveries row exists per (notification, device). This file turns those rows into sent pushes and records
// what happened - so a failed push never touches the in-app notification, and never touches the booking/payment that caused it.
//
//   PENDING -> SENDING -> SENT -> DELIVERED          happy path (SENT = accepted by Expo, DELIVERED = receipt ok)
//                      -> RETRY (transient, backs off, max 5)   -> FAILED (permanent, or retries exhausted)
//   SKIPPED   the device was deactivated before we got to it
const axios = require('axios');
const pool = require('../../config/db');

const sendUrl = () => process.env.EXPO_PUSH_URL || 'https://exp.host/--/api/v2/push/send';
const receiptsUrl = () => process.env.EXPO_RECEIPTS_URL || 'https://exp.host/--/api/v2/push/getReceipts';
const MAX_RETRIES = 5;
const BACKOFF_SECONDS = [60, 300, 900, 3600, 10800];
const CHUNK = 100;

const headers = () => {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (process.env.EXPO_ACCESS_TOKEN) h.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  return h;
};

// Android notification channel (created by the app at startup)
const channelFor = (category) => (['BOOKINGS', 'PAYMENTS', 'SUBSCRIPTIONS'].includes(category) ? 'bookings' : ['TOURNAMENTS', 'FIND_PLAYERS'].includes(category) ? 'matches' : 'default');

// Permanent failures are never retried; everything else is treated as transient.
const PERMANENT = new Set(['DeviceNotRegistered', 'MessageTooBig', 'InvalidCredentials', 'MismatchSenderId']);

async function deactivateToken(deviceId, reason) {
  await pool.query('UPDATE user_push_tokens SET is_active = false, deactivated_reason = ? WHERE id = ?', [String(reason).slice(0, 60), deviceId]);
}

async function markFailed(deliveryId, error) {
  await pool.query("UPDATE notification_deliveries SET status = 'FAILED', error = ? WHERE id = ?", [String(error).slice(0, 255), deliveryId]);
}

async function markRetry(delivery, error) {
  const attempt = delivery.retry_count + 1;
  if (attempt > MAX_RETRIES) return markFailed(delivery.id, `gave up after ${MAX_RETRIES} retries: ${error}`);
  const wait = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)];
  await pool.query(
    "UPDATE notification_deliveries SET status = 'RETRY', retry_count = ?, error = ?, next_attempt_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?",
    [attempt, String(error).slice(0, 255), wait, delivery.id]
  );
}

/**
 * Sends every due delivery of one notification. Safe to call concurrently (each delivery is claimed atomically first) and
 * safe to call repeatedly (already-sent deliveries are not selected again).
 */
async function deliver(notificationId) {
  const summary = { sent: 0, failed: 0, retry: 0, skipped: 0 };
  const [[n]] = await pool.query('SELECT id, notification_type, category, title, message, deep_link, entity_type, entity_id FROM notifications WHERE id = ?', [notificationId]);
  if (!n) return summary;
  const [rows] = await pool.query(
    `SELECT d.id, d.retry_count, d.device_id, t.push_token, t.is_active, t.platform
     FROM notification_deliveries d JOIN user_push_tokens t ON t.id = d.device_id
     WHERE d.notification_id = ? AND d.status IN ('PENDING', 'RETRY') AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= NOW())`,
    [notificationId]
  );

  const claimed = [];
  for (const r of rows) {
    if (!r.is_active) { await pool.query("UPDATE notification_deliveries SET status = 'SKIPPED', error = 'device inactive' WHERE id = ? AND status IN ('PENDING','RETRY')", [r.id]); summary.skipped++; continue; }
    const [c] = await pool.query("UPDATE notification_deliveries SET status = 'SENDING' WHERE id = ? AND status IN ('PENDING','RETRY')", [r.id]);
    if (c.affectedRows === 1) claimed.push(r);
  }
  if (claimed.length === 0) return summary;

  for (let i = 0; i < claimed.length; i += CHUNK) {
    const chunk = claimed.slice(i, i + CHUNK);
    const messages = chunk.map((d) => ({
      to: d.push_token,
      title: n.title,
      body: n.message,
      data: { notification_id: n.id, type: n.notification_type, category: n.category, deep_link: n.deep_link },
      sound: 'default',
      priority: 'high',
      channelId: channelFor(n.category),
      ttl: 86400,
    }));

    let tickets;
    try {
      const res = await axios.post(sendUrl(), messages, { headers: headers(), timeout: 15000 });
      tickets = res.data && res.data.data;
      if (!Array.isArray(tickets) || tickets.length !== chunk.length) throw new Error('unexpected response from the push service');
    } catch (e) {
      // network error / 5xx / 429 / malformed response: the whole chunk is transient
      const reason = e.response ? `push service HTTP ${e.response.status}` : e.message;
      for (const d of chunk) { await markRetry(d, reason); summary.retry++; }
      continue;
    }

    for (let k = 0; k < chunk.length; k++) {
      const d = chunk[k];
      const tk = tickets[k] || {};
      if (tk.status === 'ok') {
        await pool.query("UPDATE notification_deliveries SET status = 'SENT', ticket_id = ?, sent_at = NOW(), error = NULL WHERE id = ?", [tk.id || null, d.id]);
        summary.sent++;
        continue;
      }
      const code = (tk.details && tk.details.error) || 'unknown';
      if (code === 'DeviceNotRegistered') await deactivateToken(d.device_id, 'device_not_registered');
      if (PERMANENT.has(code)) { await markFailed(d.id, `${code}: ${tk.message || ''}`); summary.failed++; }
      else { await markRetry(d, `${code}: ${tk.message || ''}`); summary.retry++; }
    }
  }
  return summary;
}

// Expo confirms delivery to the device (or reports a dead token) in "receipts", available ~15 minutes after sending.
async function checkReceipts() {
  const [rows] = await pool.query(
    `SELECT d.id, d.ticket_id, d.device_id FROM notification_deliveries d
     WHERE d.status = 'SENT' AND d.ticket_id IS NOT NULL AND d.delivered_at IS NULL
       AND d.sent_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE) AND d.sent_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
     LIMIT 300`
  );
  const out = { delivered: 0, failed: 0 };
  for (let i = 0; i < rows.length; i += 300) {
    const chunk = rows.slice(i, i + 300);
    let receipts;
    try {
      const res = await axios.post(receiptsUrl(), { ids: chunk.map((r) => r.ticket_id) }, { headers: headers(), timeout: 15000 });
      receipts = (res.data && res.data.data) || {};
    } catch (e) { continue; } // try again next tick
    for (const r of chunk) {
      const rc = receipts[r.ticket_id];
      if (!rc) continue;
      if (rc.status === 'ok') { await pool.query("UPDATE notification_deliveries SET status = 'DELIVERED', delivered_at = NOW() WHERE id = ?", [r.id]); out.delivered++; }
      else {
        const code = (rc.details && rc.details.error) || 'unknown';
        if (code === 'DeviceNotRegistered') await deactivateToken(r.device_id, 'device_not_registered');
        await markFailed(r.id, `${code}: ${rc.message || ''}`);
        out.failed++;
      }
    }
  }
  return out;
}

// Worker entry: retry what is due, and rescue deliveries stuck in SENDING (the process died mid-send).
async function processDue() {
  await pool.query("UPDATE notification_deliveries SET status = 'RETRY', next_attempt_at = NOW(), error = 'recovered after interrupted send' WHERE status = 'SENDING' AND updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)");
  const [due] = await pool.query(
    `SELECT DISTINCT notification_id FROM notification_deliveries
     WHERE (status = 'RETRY' AND next_attempt_at <= NOW()) OR (status = 'PENDING' AND created_at < DATE_SUB(NOW(), INTERVAL 30 SECOND))
     LIMIT 200`
  );
  const totals = { notifications: due.length, sent: 0, failed: 0, retry: 0, skipped: 0 };
  for (const { notification_id: id } of due) {
    const s = await deliver(id);
    for (const k of ['sent', 'failed', 'retry', 'skipped']) totals[k] += s[k];
  }
  return totals;
}

module.exports = { deliver, checkReceipts, processDue, channelFor, MAX_RETRIES };
