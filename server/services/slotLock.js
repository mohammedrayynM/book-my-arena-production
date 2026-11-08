// Venue-wide named lock held on ONE dedicated connection. The previous helpers called GET_LOCK / RELEASE_LOCK through the
// pool, so the release usually ran on a different connection and silently did nothing (the lock then stayed held until that
// connection died, making later requests wait 5 s and fail), and the lock name included the court, so a venue-wide action and a
// court booking never excluded each other. Same call signature as before: acquireSlotLock(turfId, courtId, date) /
// releaseSlotLock(turfId, courtId, date); the court/date arguments are accepted but the lock is per VENUE.
const pool = require('../config/db');

const held = new Map(); // lockName -> connection (only one holder per name at a time, enforced by MySQL)
// Requests for the same venue queue IN-PROCESS first, so a burst of customers waits on a cheap promise instead of each parking a
// database connection inside GET_LOCK (which would exhaust the pool and starve the holder's own queries). MySQL's lock then only
// arbitrates between server instances.
const queues = new Map(); // lockName -> tail promise
const releasers = new Map(); // lockName -> function that lets the next in-process waiter go
const nameOf = (turfId) => `slot_lock_v2_${Number(turfId)}`;

async function acquireSlotLock(turfId, _courtId, _date, timeoutSec = 5) {
  const name = nameOf(turfId);
  const prev = queues.get(name) || Promise.resolve();
  let open; const mine = new Promise((r) => { open = r; });
  queues.set(name, prev.then(() => mine));
  const deadline = Date.now() + timeoutSec * 1000;
  await Promise.race([prev, new Promise((r) => setTimeout(r, timeoutSec * 1000))]);
  if (Date.now() >= deadline) { open(); return false; }          // waited the whole timeout: give up cleanly
  releasers.set(name, open);
  const ok = await acquireDb(name, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
  if (!ok) { releasers.delete(name); open(); }
  return ok;
}

async function acquireDb(name, timeoutSec) {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT GET_LOCK(?, ?) AS acquired', [name, timeoutSec]);
    if (rows && rows[0] && Number(rows[0].acquired) === 1) { held.set(name, conn); return true; }
  } catch (e) { /* fall through: release the connection */ }
  conn.release();
  return false;
}

async function releaseSlotLock(turfId) {
  const name = nameOf(turfId);
  const conn = held.get(name);
  const open = releasers.get(name);
  held.delete(name); releasers.delete(name);
  try { if (conn) await conn.query('SELECT RELEASE_LOCK(?)', [name]); }
  finally { if (conn) conn.release(); if (open) open(); }
}

module.exports = { acquireSlotLock, releaseSlotLock };
