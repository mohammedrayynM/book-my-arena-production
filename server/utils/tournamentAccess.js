// Role-aware tournament ownership. A tournament is hosted by an owner, a regular user, or an admin.
// `tournaments.owner_id` is the host's id inside the table named by `tournaments.owner_type`
// ('owner' | 'user' | 'admin'), so ids from different tables can never be confused.
// Admins can manage any tournament; everyone else only their own.

// User JWTs carry no `role` claim (routes/users.js signs { id, email }), owner/admin JWTs do.
function hostIdentity(jwtUser) {
  const role = jwtUser && (jwtUser.role === 'owner' || jwtUser.role === 'admin') ? jwtUser.role : 'user';
  return { type: role, id: jwtUser.id };
}

// Any authenticated account (user / owner / admin) may host. Must run after verifyToken.
function verifyHost(req, res, next) {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  req.tHost = hostIdentity(req.user);
  next();
}

// Loads a tournament only if the caller may manage it (owner of it, or admin).
async function findManageableTournament(db, tournamentId, host, { columns = '*', forUpdate = false } = {}) {
  let sql = `SELECT ${columns} FROM tournaments WHERE id = ?`;
  const params = [tournamentId];
  if (host.type !== 'admin') {
    sql += ' AND owner_id = ? AND owner_type = ?';
    params.push(host.id, host.type);
  }
  if (forUpdate) sql += ' FOR UPDATE';
  const [rows] = await db.query(sql, params);
  return rows[0] || null;
}

// Same lookup returned as an array (0 or 1 rows) so legacy "tournaments.length === 0" checks keep working.
async function manageableRows(db, tournamentId, host, columns = '*', forUpdate = false) {
  const t = await findManageableTournament(db, tournamentId, host, { columns, forUpdate });
  return t ? [t] : [];
}

// For rows that already carry owner_id + owner_type (e.g. a fixture joined to its tournament).
function canManageRow(row, host) {
  if (!row) return false;
  if (host.type === 'admin') return true;
  return Number(row.owner_id) === Number(host.id) && row.owner_type === host.type;
}

// Host display name/email resolved from whichever table owns the tournament (alias `t` = tournaments).
const HOST_NAME_SQL = `(CASE t.owner_type
  WHEN 'user' THEN (SELECT name FROM users WHERE id = t.owner_id)
  WHEN 'admin' THEN 'Book Arena'
  ELSE (SELECT name FROM owners WHERE id = t.owner_id) END)`;
const HOST_EMAIL_SQL = `(CASE t.owner_type
  WHEN 'user' THEN (SELECT email FROM users WHERE id = t.owner_id)
  WHEN 'admin' THEN NULL
  ELSE (SELECT email FROM owners WHERE id = t.owner_id) END)`;

module.exports = { hostIdentity, verifyHost, findManageableTournament, manageableRows, canManageRow, HOST_NAME_SQL, HOST_EMAIL_SQL };
