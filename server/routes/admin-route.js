// /api/admin/route — admin-only management of the NEW per-turf Razorpay Route split configuration. Each turf picks a
// commission mode — a percentage of the booking, or a flat ₹ amount per booking — never both at once.
//
// A turf goes through, in order: not_configured -> configured (commission + linked account set) -> approved
// (an admin signed off) -> active (route_enabled = true; the split engine now runs for its bookings). Route is only
// ever OFF by default; nothing here is reachable by an owner or a customer, and no field here is ever trusted from a
// booking/payment request — routes/bookings.js only ever reads these columns back out of the database.
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const routeSplit = require('../services/routeSplit');

router.use(verifyToken, verifyAdmin);

const bad = (res, status, error) => res.status(status).json({ success: false, error });
const LIVE_CONFIRM_PHRASE = 'ENABLE LIVE PAYOUTS';

async function audit(turfId, adminId, action, field, oldValue, newValue) {
  await pool.query(
    'INSERT INTO route_audit_log (turf_id, admin_id, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)',
    [turfId, adminId, action, field || null, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue)]
  );
}

async function loadTurf(id) {
  const [[t]] = await pool.query(
    `SELECT t.id, t.name, t.owner_id, o.name AS owner_name, t.route_enabled, t.route_status, t.route_linked_account_id,
            t.route_commission_type, t.route_split_percentage, t.route_flat_amount, t.route_environment,
            t.route_configured_at, t.route_approved_at, t.route_approved_by
     FROM turfs t LEFT JOIN owners o ON o.id = t.owner_id WHERE t.id = ?`, [id]
  );
  return t || null;
}

// GET /turfs?enabled=1 — every turf's Route configuration (for the admin picker/list)
router.get('/turfs', async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.enabled === '1' || req.query.enabled === 'true') where.push('t.route_enabled = true');
    if (req.query.status) { where.push('t.route_status = ?'); params.push(req.query.status); }
    const [rows] = await pool.query(
      `SELECT t.id, t.name, t.owner_id, o.name AS owner_name, t.route_enabled, t.route_status,
              t.route_commission_type, t.route_split_percentage, t.route_flat_amount,
              t.route_linked_account_id, t.route_environment, t.route_configured_at, t.route_approved_at
       FROM turfs t LEFT JOIN owners o ON o.id = t.owner_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY t.route_enabled DESC, t.name ASC`, params
    );
    res.json({ success: true, turfs: rows });
  } catch (e) { console.error('admin route turfs:', e.message); bad(res, 500, 'Could not load turfs'); }
});

// GET /turfs/:id — one turf's config + its recent split transfers
router.get('/turfs/:id', async (req, res) => {
  try {
    const turf = await loadTurf(req.params.id);
    if (!turf) return bad(res, 404, 'Turf not found');
    const [transfers] = await pool.query('SELECT * FROM route_split_transfers WHERE turf_id = ? ORDER BY id DESC LIMIT 20', [req.params.id]);
    const [audit_log] = await pool.query('SELECT a.*, ad.username AS admin_name FROM route_audit_log a LEFT JOIN admins ad ON ad.id = a.admin_id WHERE a.turf_id = ? ORDER BY a.id DESC LIMIT 20', [req.params.id]);
    res.json({ success: true, turf, transfers, audit_log });
  } catch (e) { console.error('admin route turf:', e.message); bad(res, 500, 'Could not load this turf'); }
});

// PUT /turfs/:id/config  { route_commission_type?, route_split_percentage?, route_flat_amount?, route_linked_account_id?, route_environment?, confirm_live_text? }
// Sets configuration fields. Never touches route_enabled — enabling is a separate, later step (POST /enable).
router.put('/turfs/:id/config', async (req, res) => {
  try {
    const turf = await loadTurf(req.params.id);
    if (!turf) return bad(res, 404, 'Turf not found');
    const body = req.body || {};
    const sets = []; const params = []; const changes = [];

    if (body.route_commission_type !== undefined) {
      const type = String(body.route_commission_type).trim();
      if (!routeSplit.validCommissionType(type)) return bad(res, 400, 'route_commission_type must be "percentage", "flat", or "subscription"');
      sets.push('route_commission_type = ?'); params.push(type);
      changes.push(['route_commission_type', turf.route_commission_type, type]);
    }
    if (body.monthly_subscription_amount !== undefined) {
      const sub = Math.round(Number(body.monthly_subscription_amount) * 100) / 100;
      sets.push('monthly_subscription_amount = ?'); params.push(sub);
      changes.push(['monthly_subscription_amount', turf.monthly_subscription_amount, sub]);
    }
    if (body.route_split_percentage !== undefined) {
      if (!routeSplit.validPercentage(body.route_split_percentage)) return bad(res, 400, 'route_split_percentage must be a number between 0 and 100');
      const pct = Math.round(Number(body.route_split_percentage) * 100) / 100;
      sets.push('route_split_percentage = ?'); params.push(pct);
      changes.push(['route_split_percentage', turf.route_split_percentage, pct]);
    }
    if (body.route_flat_amount !== undefined) {
      if (!routeSplit.validFlatAmount(body.route_flat_amount)) return bad(res, 400, 'route_flat_amount must be zero or a positive number');
      const flat = Math.round(Number(body.route_flat_amount) * 100) / 100;
      sets.push('route_flat_amount = ?'); params.push(flat);
      changes.push(['route_flat_amount', turf.route_flat_amount, flat]);
    }
    if (body.route_linked_account_id !== undefined) {
      const acct = String(body.route_linked_account_id).trim();
      if (!routeSplit.validLinkedAccountId(acct)) return bad(res, 400, 'route_linked_account_id must look like a Razorpay linked account id ("acc_...")');
      sets.push('route_linked_account_id = ?'); params.push(acct);
      changes.push(['route_linked_account_id', turf.route_linked_account_id, acct]);
    }
    if (body.route_environment !== undefined) {
      const env = String(body.route_environment).trim();
      if (!['test', 'live'].includes(env)) return bad(res, 400, 'route_environment must be "test" or "live"');
      if (env === 'live' && turf.route_environment !== 'live') {
        // The single most consequential flip in this whole feature: from here on, a Route transfer for this turf is a
        // REAL Razorpay payout. Require the admin to type an unambiguous confirmation phrase, the same pattern used
        // for the notification system's "send to everyone" broadcast confirmation.
        if (String(body.confirm_live_text || '').trim() !== LIVE_CONFIRM_PHRASE) {
          return bad(res, 400, `Type "${LIVE_CONFIRM_PHRASE}" in confirm_live_text to switch this turf to live payouts`);
        }
      }
      sets.push('route_environment = ?'); params.push(env);
      changes.push(['route_environment', turf.route_environment, env]);
    }
    if (sets.length === 0) return bad(res, 400, 'Nothing to update');

    const effectiveTurf = {
      route_commission_type: body.route_commission_type !== undefined ? body.route_commission_type : turf.route_commission_type,
      route_split_percentage: body.route_split_percentage !== undefined ? body.route_split_percentage : turf.route_split_percentage,
      route_flat_amount: body.route_flat_amount !== undefined ? body.route_flat_amount : turf.route_flat_amount,
    };
    const willBeConfigured = routeSplit.hasValidCommission(effectiveTurf)
      && (body.route_linked_account_id !== undefined ? routeSplit.validLinkedAccountId(body.route_linked_account_id) : routeSplit.validLinkedAccountId(turf.route_linked_account_id || ''));
    if (turf.route_status === 'not_configured' && willBeConfigured) {
      sets.push('route_status = ?', 'route_configured_at = NOW()'); params.push('configured');
      changes.push(['route_status', turf.route_status, 'configured']);
    }

    await pool.query(`UPDATE turfs SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
    for (const [field, oldV, newV] of changes) await audit(req.params.id, req.user.id, 'configure', field, oldV, newV);

    res.json({ success: true, turf: await loadTurf(req.params.id) });
  } catch (e) { console.error('admin route config:', e.message); bad(res, 500, 'Could not update this turf\'s Route configuration'); }
});

// POST /turfs/:id/approve — admin sign-off; required before Route can be enabled
router.post('/turfs/:id/approve', async (req, res) => {
  try {
    const turf = await loadTurf(req.params.id);
    if (!turf) return bad(res, 404, 'Turf not found');
    if (!['configured', 'approved'].includes(turf.route_status)) {
      return bad(res, 400, `Set a commission (percentage or flat amount) and a linked account first (current status: ${turf.route_status})`);
    }
    await pool.query('UPDATE turfs SET route_status = ?, route_approved_at = NOW(), route_approved_by = ? WHERE id = ?', ['approved', req.user.id, req.params.id]);
    await audit(req.params.id, req.user.id, 'approve', 'route_status', turf.route_status, 'approved');
    res.json({ success: true, turf: await loadTurf(req.params.id) });
  } catch (e) { console.error('admin route approve:', e.message); bad(res, 500, 'Could not approve this turf'); }
});

// POST /turfs/:id/enable — the only action that actually turns the split engine on for this turf's future bookings
router.post('/turfs/:id/enable', async (req, res) => {
  try {
    const turf = await loadTurf(req.params.id);
    if (!turf) return bad(res, 404, 'Turf not found');
    if (!['approved', 'suspended'].includes(turf.route_status) && !turf.route_enabled) {
      return bad(res, 400, `This turf must be approved first (current status: ${turf.route_status})`);
    }
    await pool.query('UPDATE turfs SET route_enabled = true, route_status = ? WHERE id = ?', ['active', req.params.id]);
    await audit(req.params.id, req.user.id, 'enable', 'route_enabled', turf.route_enabled ? 'true' : 'false', 'true');
    res.json({ success: true, turf: await loadTurf(req.params.id) });
  } catch (e) { console.error('admin route enable:', e.message); bad(res, 500, 'Could not enable Route for this turf'); }
});

// POST /turfs/:id/disable — turns it back off; existing (non-Route) settlement behaviour applies again immediately
router.post('/turfs/:id/disable', async (req, res) => {
  try {
    const turf = await loadTurf(req.params.id);
    if (!turf) return bad(res, 404, 'Turf not found');
    const nextStatus = turf.route_status === 'active' ? 'suspended' : turf.route_status;
    await pool.query('UPDATE turfs SET route_enabled = false, route_status = ? WHERE id = ?', [nextStatus, req.params.id]);
    await audit(req.params.id, req.user.id, 'disable', 'route_enabled', turf.route_enabled ? 'true' : 'false', 'false');
    res.json({ success: true, turf: await loadTurf(req.params.id) });
  } catch (e) { console.error('admin route disable:', e.message); bad(res, 500, 'Could not disable Route for this turf'); }
});

// GET /transfers?turf_id=&status=&limit=&cursor= — the split-transfer ledger
router.get('/transfers', async (req, res) => {
  try {
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const where = ['1=1']; const params = [];
    if (req.query.turf_id) { where.push('r.turf_id = ?'); params.push(Number(req.query.turf_id)); }
    if (req.query.status) { where.push('r.status = ?'); params.push(req.query.status); }
    if (req.query.cursor && /^\d+$/.test(req.query.cursor)) { where.push('r.id < ?'); params.push(Number(req.query.cursor)); }
    const [rows] = await pool.query(
      `SELECT r.*, t.name AS turf_name FROM route_split_transfers r JOIN turfs t ON t.id = r.turf_id
       WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ${lim + 1}`, params
    );
    const page = rows.slice(0, lim);
    res.json({ success: true, transfers: page, next_cursor: rows.length > lim ? String(page[page.length - 1].id) : null });
  } catch (e) { console.error('admin route transfers:', e.message); bad(res, 500, 'Could not load transfers'); }
});

// GET /audit?turf_id=&limit=
router.get('/audit', async (req, res) => {
  try {
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const where = ['1=1']; const params = [];
    if (req.query.turf_id) { where.push('a.turf_id = ?'); params.push(Number(req.query.turf_id)); }
    const [rows] = await pool.query(
      `SELECT a.*, ad.username AS admin_name, t.name AS turf_name FROM route_audit_log a
       LEFT JOIN admins ad ON ad.id = a.admin_id LEFT JOIN turfs t ON t.id = a.turf_id
       WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ${lim}`, params
    );
    res.json({ success: true, audit_log: rows });
  } catch (e) { console.error('admin route audit:', e.message); bad(res, 500, 'Could not load the audit log'); }
});

module.exports = router;
