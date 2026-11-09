// Discovery (search/nearby/sports/offers), Google-login gate and admin controls, against a THROWAWAY database.
process.env.JWT_SECRET = 'test-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const db = require('./helpers/testDb');
const { OAuth2Client } = require('google-auth-library');
const { parseQuery } = require('../services/discoverySearch');

let googlePayload = null; // what the fake Google "verifies"
OAuth2Client.prototype.verifyIdToken = async function ({ idToken, audience }) {
  if (idToken === 'bad' || audience !== process.env.GOOGLE_CLIENT_ID || !googlePayload) throw new Error('invalid token');
  return { getPayload: () => googlePayload };
};

let app; let adminToken; let adminId;
const q = (sql, p) => db.pool.query(sql, p);

async function addVenue(f) {
  const o = { name: 'V', location: null, city: null, address: null, sport_type: null, price_per_hour: 800, latitude: null, longitude: null, ...f };
  const cols = Object.keys(o);
  const [r] = await q(`INSERT INTO turfs (owner_id, ${cols.join(',')}) VALUES (1, ${cols.map(() => '?').join(',')})`, cols.map((c) => o[c]));
  return r.insertId;
}
const cat = async (slug) => (await q('SELECT id FROM sport_categories WHERE slug = ?', [slug]))[0][0].id;
async function link(turf, ...slugs) { for (const s of slugs) await q('INSERT IGNORE INTO turf_sports (turf_id, category_id) VALUES (?, ?)', [turf, await cat(s)]); }

test.before(async () => {
  await db.setup();
  for (const ddl of ['ALTER TABLE turfs ADD COLUMN location VARCHAR(255)', 'ALTER TABLE turfs ADD COLUMN city VARCHAR(100)', 'ALTER TABLE turfs ADD COLUMN address VARCHAR(255)',
    'ALTER TABLE turfs ADD COLUMN state_province VARCHAR(100)', 'ALTER TABLE turfs ADD COLUMN sport_type VARCHAR(255)', 'ALTER TABLE turfs ADD COLUMN price_per_hour DECIMAL(10,2)',
    'ALTER TABLE turfs ADD COLUMN latitude DECIMAL(10,7) NULL', 'ALTER TABLE turfs ADD COLUMN longitude DECIMAL(10,7) NULL', 'ALTER TABLE turfs ADD COLUMN is_deleted TINYINT DEFAULT 0',
    'ALTER TABLE turfs ADD COLUMN images TEXT', 'ALTER TABLE turfs ADD COLUMN rating DECIMAL(3,2) NULL']) await q(ddl).catch(() => {});
  await q('CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100), email VARCHAR(150), password_hash VARCHAR(255) NULL, google_id VARCHAR(64) NULL, profile_pic VARCHAR(500) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  await q('CREATE TABLE IF NOT EXISTS advertisements (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(100), description TEXT, image_url VARCHAR(500), video_url VARCHAR(500), sponsor_name VARCHAR(100), link_url VARCHAR(500), placement VARCHAR(30), priority INT DEFAULT 0, is_active BOOLEAN DEFAULT true, start_date DATE NULL, end_date DATE NULL, impression_count INT DEFAULT 0, click_count INT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  await q('CREATE TABLE IF NOT EXISTS admin_coupons (id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(30), label VARCHAR(100), discount_type VARCHAR(20), discount_value DECIMAL(10,2), min_booking_amount DECIMAL(10,2) NULL, max_discount_cap DECIMAL(10,2) NULL, is_active BOOLEAN DEFAULT true, valid_from DATE NULL, valid_until DATE NULL, max_uses INT NULL, used_count INT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  await q('CREATE TABLE IF NOT EXISTS settings (id INT AUTO_INCREMENT PRIMARY KEY, setting_key VARCHAR(100) NOT NULL, setting_value TEXT, UNIQUE KEY uq_settings_key (setting_key))').catch(() => {});
  await require('../migrate_discovery')();
  app = express(); app.use(express.json());
  app.use('/api/admin/discovery', require('../routes/admin-discovery'));
  app.use('/api/discovery', require('../routes/discovery'));
  app.use('/api/app-config', require('../routes/discovery').configRouter);
  app.use('/api/users', require('../routes/users'));
});
test.beforeEach(async () => {
  await db.reset(); await q('DELETE FROM turf_sports'); await q('DELETE FROM users'); await q('DELETE FROM advertisements'); await q('DELETE FROM admin_coupons');
  await q("DELETE FROM settings WHERE setting_key = 'auth_google_login_enabled'");
  const seedSlugs = require('../migrate_discovery').SEED.map((x) => x.slug);
  await q(`DELETE FROM sport_categories WHERE slug NOT IN (${seedSlugs.map(() => '?').join(',')})`, seedSlugs);
  await q('UPDATE sport_categories SET is_enabled = 1');
  require('../services/discoverySearch').clearCategoryCache(); require('../services/authSettings').setGoogleEnabled(false);
  adminId = (await q("INSERT INTO admins (username) VALUES ('root')"))[0].insertId;
  adminToken = jwt.sign({ id: adminId, role: 'admin' }, 'test-secret');
  googlePayload = null;
});
test.after(async () => { await db.pool.end(); });
const names = (r) => r.body.results.map((x) => x.name);

test('query parser recognizes venue names and specific amusement park categories', () => {
  const venue = parseQuery('Green Play Turf', []);
  assert.equal(venue.turfGroup, true);
  assert.deepEqual(venue.textTokens, ['green']);

  const park = parseQuery('Freedom amusement park in Pernambut', []);
  assert.deepEqual([...park.activityCategories], ['AMUSEMENT_PARK']);
  assert.deepEqual(park.textTokens, ['freedom', 'pernambut']);
});

test('seed has the four home sports first and is idempotent', async () => {
  await require('../migrate_discovery')();
  const r = await request(app).get('/api/discovery/sports');
  assert.deepEqual(r.body.sports.slice(0, 4).map((s) => s.name), ['Cricket Turf', 'Badminton', 'Football Turf', 'Snooker']);
  assert.equal(new Set(r.body.sports.map((s) => s.slug)).size, r.body.sports.length);
});

test('sport + city: "badminton in Chennai" returns only Chennai badminton venues', async () => {
  const a = await addVenue({ name: 'Smash Arena', city: 'Chennai' }); await link(a, 'badminton');
  const b = await addVenue({ name: 'Kick Off', city: 'Chennai' }); await link(b, 'football-turf');
  const c = await addVenue({ name: 'Shuttle Hub', city: 'Pune' }); await link(c, 'badminton');
  const r = await request(app).get('/api/discovery/search').query({ q: 'badminton in Chennai' });
  assert.deepEqual(names(r), ['Smash Arena']);
  assert.deepEqual(r.body.parsed.sports, ['Badminton']);
});

test('"turf in Pernambut" matches the generic turf group in that locality only', async () => {
  const a = await addVenue({ name: 'Green Turf', location: 'Pernambut', city: 'Vellore' }); await link(a, 'cricket-turf');
  const b = await addVenue({ name: 'Other Turf', city: 'Chennai' }); await link(b, 'football-turf');
  const c = await addVenue({ name: 'Cue Club', location: 'Pernambut' }); await link(c, 'snooker');
  const r = await request(app).get('/api/discovery/search').query({ q: 'turf in Pernambut' });
  assert.deepEqual(names(r), ['Green Turf']);
});

test('a venue with several sports is found under each, once', async () => {
  const a = await addVenue({ name: 'Multi', city: 'Goa' }); await link(a, 'badminton', 'table-tennis');
  for (const s of ['badminton', 'table tennis']) { const r = await request(app).get('/api/discovery/search').query({ q: s }); assert.deepEqual(names(r), ['Multi']); }
  const r = await request(app).get('/api/discovery/search').query({ q: 'badminton' });
  assert.deepEqual(r.body.results[0].sports.sort(), ['Badminton', 'Table Tennis']);
});

test('legacy venues with only sport_type text are still found', async () => {
  await addVenue({ name: 'Old Venue', city: 'Salem', sport_type: 'Snooker' });
  const r = await request(app).get('/api/discovery/search').query({ q: 'snooker in salem' });
  assert.deepEqual(names(r), ['Old Venue']);
});

test('venue-name search includes an exact match when the query also contains its city', async () => {
  await addVenue({ name: '5th Yard Turf', city: 'Coimbatore', sport_type: 'Cricket Turf' });
  const r = await request(app).get('/api/discovery/search')
    .query({ q: '5th Yard Turf Coimbatore', type: 'venue' });
  assert.equal(r.body.results[0].name, '5th Yard Turf');
  assert.equal(r.body.exactMatch.name, '5th Yard Turf');
});

test('sitemap lists public venue URLs and excludes hidden venues', async () => {
  const visible = await addVenue({ name: 'Visible sitemap venue' });
  const hidden = await addVenue({ name: 'Hidden sitemap venue', is_active: 0 });
  const r = await request(app).get('/api/discovery/sitemap.xml').expect(200);
  assert.match(r.headers['content-type'], /application\/xml/);
  assert.match(r.text, new RegExp(`/turfs/${visible}`));
  assert.doesNotMatch(r.text, new RegExp(`/turfs/${hidden}`));
});

test('hidden venues never appear (inactive, blocked, unapproved, deleted)', async () => {
  const mk = async (n, f) => { const id = await addVenue({ name: n, city: 'Kochi', ...f }); await link(id, 'badminton'); };
  await mk('Visible', {}); await mk('Inactive', { is_active: 0 }); await mk('Blocked', { status: 'BLOCKED' }); await mk('Pending', { approval_status: 'PENDING' }); await mk('Deleted', { is_deleted: 1 });
  const r = await request(app).get('/api/discovery/search').query({ q: 'badminton kochi' });
  assert.deepEqual(names(r), ['Visible']);
});

test('nearby sorts by real distance, never invents distance, and honours radius', async () => {
  const near = await addVenue({ name: 'Near', latitude: 13.0827, longitude: 80.2707 });
  const mid = await addVenue({ name: 'Mid', latitude: 13.2, longitude: 80.3 });
  await addVenue({ name: 'Far', latitude: 19.07, longitude: 72.87 });
  await addVenue({ name: 'NoCoords' });
  const r = await request(app).get('/api/discovery/nearby').query({ lat: 13.08, lng: 80.27, radius: 50 });
  assert.deepEqual(names(r), ['Near', 'Mid']);
  assert.ok(r.body.results[0].distance_km < 2);
  assert.equal(near > 0 && mid > 0, true);
  const nl = await request(app).get('/api/discovery/search').query({ q: 'snooker near me' });
  assert.ok(nl.body.notice, 'near me without coordinates explains why');
  assert.deepEqual(nl.body.results, []);
});

test('unmatched query returns nothing (not everything) plus suggestions', async () => {
  const a = await addVenue({ name: 'Alpha', city: 'Chennai' }); await link(a, 'badminton');
  const r = await request(app).get('/api/discovery/search').query({ q: 'zzzzqq' });
  assert.deepEqual(r.body.results, []);
  assert.ok(r.body.suggestions.length > 0);
});

test('pagination: limit+1 detection, no duplicates across pages', async () => {
  for (let i = 0; i < 7; i++) { const id = await addVenue({ name: `Court ${i}`, city: 'Pune' }); await link(id, 'badminton'); }
  const p1 = await request(app).get('/api/discovery/search').query({ q: 'badminton', limit: 3, page: 1 });
  const p2 = await request(app).get('/api/discovery/search').query({ q: 'badminton', limit: 3, page: 2 });
  const p3 = await request(app).get('/api/discovery/search').query({ q: 'badminton', limit: 3, page: 3 });
  assert.equal(p1.body.hasMore, true); assert.equal(p3.body.hasMore, false);
  const all = [...names(p1), ...names(p2), ...names(p3)];
  assert.equal(all.length, 7); assert.equal(new Set(all).size, 7);
});

test('SQL metacharacters in the query are inert', async () => {
  const r = await request(app).get('/api/discovery/search').query({ q: "'; DROP TABLE turfs; --" });
  assert.equal(r.status, 200);
  const [[c]] = await q('SELECT COUNT(*) n FROM turfs'); assert.ok(c.n >= 0);
});

test('offers: only real active offers; none when none exist', async () => {
  assert.deepEqual((await request(app).get('/api/discovery/offers')).body.offers, []);
  await q("INSERT INTO admin_coupons (code, label, discount_type, discount_value) VALUES ('LIVE10', 'Ten off', 'percentage', 10)");
  await q("INSERT INTO admin_coupons (code, discount_type, discount_value, valid_until) VALUES ('OLD', 'flat', 50, '2020-01-01')");
  await q("INSERT INTO advertisements (title, placement, is_active) VALUES ('Live ad', 'HOME_BANNER', true), ('Off ad', 'HOME_BANNER', false)");
  const o = (await request(app).get('/api/discovery/offers')).body.offers;
  assert.deepEqual(o.map((x) => x.title).sort(), ['Live ad', 'Ten off']);
});

test('google toggle: default off, admin-only, persisted, reflected in app-config', async () => {
  assert.equal((await request(app).get('/api/app-config')).body.auth.google_login_enabled, false);
  assert.equal((await request(app).put('/api/admin/discovery/auth-settings').send({ google_login_enabled: true })).status, 401);
  const ownerTok = jwt.sign({ id: 1, role: 'owner' }, 'test-secret');
  assert.equal((await request(app).put('/api/admin/discovery/auth-settings').set('Authorization', `Bearer ${ownerTok}`).send({ google_login_enabled: true })).status, 403);
  assert.equal((await request(app).put('/api/admin/discovery/auth-settings').set('Authorization', `Bearer ${adminToken}`).send({ google_login_enabled: 'yes' })).status, 400);
  assert.equal((await request(app).put('/api/admin/discovery/auth-settings').set('Authorization', `Bearer ${adminToken}`).send({ google_login_enabled: true })).status, 200);
  assert.equal((await request(app).get('/api/app-config')).body.auth.google_login_enabled, true);
  const [[row]] = await q("SELECT setting_value v FROM settings WHERE setting_key = 'auth_google_login_enabled'"); assert.equal(row.v, 'true');
});

test('google login is refused while disabled, works when enabled, never makes admins', async () => {
  googlePayload = { sub: 'g1', email: 'Sam@Example.com', email_verified: true, name: 'Sam', picture: 'http://p' };
  let r = await request(app).post('/api/users/google-login').send({ idToken: 'ok' });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'GOOGLE_DISABLED');
  await request(app).put('/api/admin/discovery/auth-settings').set('Authorization', `Bearer ${adminToken}`).send({ google_login_enabled: true });
  r = await request(app).post('/api/users/google-login').send({ idToken: 'ok' });
  assert.equal(r.status, 200); assert.equal(r.body.user.email, 'sam@example.com');
  const dec = jwt.verify(r.body.token, 'test-secret'); assert.notEqual(dec.role, 'admin');
  assert.equal((await request(app).post('/api/users/google-login').send({ idToken: 'ok' })).body.user.id, r.body.user.id, 'second login reuses the account');
  assert.equal((await request(app).post('/api/users/google-login').send({ idToken: 'bad' })).status, 401);
  assert.equal((await request(app).post('/api/users/google-login').send({})).status, 400);
  googlePayload = { sub: 'g1', email: 'x@example.com', email_verified: false };
  assert.equal((await request(app).post('/api/users/google-login').send({ idToken: 'ok' })).status, 401);
  googlePayload = { sub: 'OTHER', email: 'sam@example.com', email_verified: true, name: 'Sam' };
  assert.equal((await request(app).post('/api/users/google-login').send({ idToken: 'ok' })).status, 409);
});

test('admin sports: create, duplicate rejected, disable hides from public + search', async () => {
  const H = { Authorization: `Bearer ${adminToken}` };
  const c = await request(app).post('/api/admin/discovery/sports').set(H).send({ name: 'Archery Range', aliases: ['archery'] });
  assert.equal(c.status, 201);
  assert.equal((await request(app).post('/api/admin/discovery/sports').set(H).send({ name: 'archery range' })).status, 409);
  const v = await addVenue({ name: 'Bow Club', city: 'Delhi' }); await q('INSERT INTO turf_sports VALUES (?, ?, NOW())', [v, c.body.id]);
  assert.deepEqual(names(await request(app).get('/api/discovery/search').query({ q: 'archery' })), ['Bow Club']);
  assert.equal((await request(app).put(`/api/admin/discovery/sports/${c.body.id}`).set(H).send({ is_enabled: false })).status, 200);
  assert.ok(!(await request(app).get('/api/discovery/sports')).body.sports.some((s) => s.name === 'Archery Range'));
  assert.deepEqual(names(await request(app).get('/api/discovery/search').query({ q: 'archery' })), []);
  assert.equal((await request(app).get('/api/admin/discovery/sports')).status, 401);
});

test('venueSports: validates ids, de-duplicates, syncs legacy text, replaces on edit', async () => {
  const vs = require('../services/venueSports');
  const bad = await vs.resolveSelection({ sport_ids: [999999] }); assert.ok(bad.error);
  assert.ok((await vs.resolveSelection({ sport_ids: [] })).error);
  assert.ok((await vs.resolveSelection({ sport_ids: 'x' })).error);
  assert.equal((await vs.resolveSelection({ sport_type: 'Cricket' })).ids, null, 'legacy text payloads are left alone');
  const b = await cat('badminton'); const s = await cat('snooker');
  const sel = await vs.resolveSelection({ sport_ids: [b, s, b, String(s)] });
  assert.deepEqual(sel.ids, [b, s]); assert.equal(sel.text, 'Badminton, Snooker');
  const v = await addVenue({ name: 'Owner Venue', city: 'Mysore' });
  await vs.sync(v, sel.ids); await vs.sync(v, sel.ids);
  assert.deepEqual((await vs.forVenue(v)).map((x) => x.slug).sort(), ['badminton', 'snooker']);
  await vs.sync(v, [s]);
  assert.deepEqual((await vs.forVenue(v)).map((x) => x.slug), ['snooker']);
  await q('UPDATE sport_categories SET is_enabled = 0 WHERE id = ?', [b]);
  assert.ok((await vs.resolveSelection({ sport_ids: [b] })).error, 'a disabled sport cannot be newly chosen');
});

test('migration relaxes NOT NULL coordinates (keeping the type) so unknown locations are stored as NULL', async () => {
  await q('ALTER TABLE turfs MODIFY COLUMN latitude DECIMAL(10,7) NOT NULL DEFAULT 0');
  await require('../migrate_discovery')();
  const [[c]] = await q("SELECT COLUMN_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'turfs' AND COLUMN_NAME = 'latitude'");
  assert.equal(c.IS_NULLABLE, 'YES'); assert.match(c.COLUMN_TYPE, /decimal\(10,7\)/i);
  const id = await addVenue({ name: 'No GPS', latitude: null, longitude: null });
  const r = await request(app).get('/api/discovery/nearby').query({ lat: 13.0, lng: 80.2, radius: 500 });
  assert.ok(!names(r).includes('No GPS'), 'venues without coordinates never get a distance');
  assert.ok(id > 0);
});
