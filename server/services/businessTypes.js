// What modules an owner's single Owner Panel shows. Every existing owner implicitly does 'SPORTS' (turfs/courts), and
// stays exactly that way until they explicitly add 'ACTIVITY' and/or 'EVENT' from their profile. This file is the only
// place that reads/writes `owners.business_types`.
const pool = require('../config/db');

const VALID_TYPES = ['SPORTS', 'ACTIVITY', 'EVENT'];

function normalize(raw) {
  let types;
  if (raw == null) types = ['SPORTS'];
  else if (Array.isArray(raw)) types = raw;
  else { try { types = JSON.parse(raw); } catch (e) { types = ['SPORTS']; } }
  const clean = [...new Set(types.filter((t) => VALID_TYPES.includes(t)))];
  return clean.length ? clean : ['SPORTS'];
}

async function getOwnerBusinessTypes(ownerId) {
  const [[row]] = await pool.query('SELECT business_types FROM owners WHERE id = ?', [ownerId]);
  if (!row) return null;
  return normalize(row.business_types);
}

async function setOwnerBusinessTypes(ownerId, types) {
  if (!Array.isArray(types) || types.length === 0) return { error: 'Select at least one business type' };
  const invalid = types.filter((t) => !VALID_TYPES.includes(t));
  if (invalid.length) return { error: `Unknown business type(s): ${invalid.join(', ')}` };
  const clean = [...new Set(types)];
  await pool.query('UPDATE owners SET business_types = ? WHERE id = ?', [JSON.stringify(clean), ownerId]);
  return { business_types: clean };
}

module.exports = { VALID_TYPES, normalize, getOwnerBusinessTypes, setOwnerBusinessTypes };
