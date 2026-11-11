const pool = require('./config/db');
(async () => {
  const [cols] = await pool.query('SHOW COLUMNS FROM tournament_participants');
  console.log('tournament_participants columns:', cols.map(c => c.Field + ' (' + c.Type + ')').join(', '));
  const [tables] = await pool.query("SHOW TABLES LIKE '%player%'");
  console.log('player tables:', tables.map(t => Object.values(t)[0]).join(', '));
  const [userCols] = await pool.query('SHOW COLUMNS FROM users');
  console.log('users columns:', userCols.map(c => c.Field).join(', '));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
