// Squads, open registration and cricket innings state.
//
// Three root causes this fixes:
//  1. tournament_participants.user_id was NOT NULL, and the participants query INNER JOINed users — so a roster
//     member who has no Book Arena account could neither be stored nor read back. That is why an organizer could
//     not simply add players by name.
//  2. tournament_join_requests.user_id was NOT NULL too, so an outsider could not ask to join at all.
//  3. a cricket fixture had nowhere to record who is batting, who is at the other end and who is bowling.
//
// Everything here is additive and idempotent; existing rows keep working unchanged.
const pool = require('./config/db');

async function addColumn(table, definition) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${definition}`);
  } catch (e) {
    if (!/duplicate column|already exists/i.test(e.message)) throw e;
  }
}
module.exports = async function ensureTournamentSquadSchema() {
  // ---- 1. roster members who may not have an account ---------------------------------------------------
  await pool.query('ALTER TABLE tournament_participants MODIFY COLUMN user_id INT NULL');
  await addColumn('tournament_participants', 'phone VARCHAR(20) NULL');
  await addColumn('tournament_participants', "player_role VARCHAR(40) NOT NULL DEFAULT 'PLAYER'");
  await addColumn('tournament_participants', "batting_style ENUM('RIGHT','LEFT','UNSPECIFIED') NOT NULL DEFAULT 'UNSPECIFIED'");
  await addColumn('tournament_participants', 'bowling_style VARCHAR(40) NULL');
  await addColumn('tournament_participants', 'is_captain TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('tournament_participants', 'is_vice_captain TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('tournament_participants', 'is_substitute TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('tournament_participants', 'added_by_host TINYINT(1) NOT NULL DEFAULT 0');

  // ---- 2. open registration ----------------------------------------------------------------------------
  await addColumn('tournaments', 'open_registration TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('tournaments', 'allow_team_registration TINYINT(1) NOT NULL DEFAULT 1');
  await addColumn('tournaments', 'allow_individual_registration TINYINT(1) NOT NULL DEFAULT 1');

  // One row per request from outside. Separate from tournament_registrations (which is the PAID entry flow):
  // this is the free "may we join?" request, and it carries the whole submitted roster so the organizer can
  // see exactly what they are approving.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_registration_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tournament_id INT NOT NULL,
      kind ENUM('TEAM','INDIVIDUAL') NOT NULL,
      user_id INT NULL,
      team_name VARCHAR(255) NULL,
      captain_name VARCHAR(255) NULL,
      contact_phone VARCHAR(20) NULL,
      city VARCHAR(120) NULL,
      logo VARCHAR(500) NULL,
      player_name VARCHAR(255) NULL,
      player_role VARCHAR(40) NOT NULL DEFAULT 'PLAYER',
      batting_style ENUM('RIGHT','LEFT','UNSPECIFIED') NOT NULL DEFAULT 'UNSPECIFIED',
      bowling_style VARCHAR(40) NULL,
      experience VARCHAR(255) NULL,
      roster TEXT NULL,
      status ENUM('PENDING','APPROVED','REJECTED','WAITLISTED') NOT NULL DEFAULT 'PENDING',
      decision_reason VARCHAR(255) NULL,
      decided_by INT NULL,
      decided_by_type VARCHAR(10) NULL,
      decided_at DATETIME NULL,
      created_team_id INT NULL,
      created_participant_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_reg_tournament (tournament_id, status),
      INDEX idx_reg_user (user_id)
    )
  `);
  await pool.query("ALTER TABLE tournament_participants MODIFY COLUMN player_role VARCHAR(40) NOT NULL DEFAULT 'PLAYER'");
  await pool.query("ALTER TABLE tournament_registration_requests MODIFY COLUMN player_role VARCHAR(40) NOT NULL DEFAULT 'PLAYER'");
  await addColumn('tournament_match_events', 'client_event_id VARCHAR(64) NULL');
  await addColumn('tournament_match_events', 'undone_by INT NULL');
  await addColumn('tournament_match_events', 'undone_at DATETIME NULL');
  try {
    await pool.query('ALTER TABLE tournament_match_events ADD UNIQUE KEY uniq_match_client_event (match_id, client_event_id)');
  } catch (e) {
    if (!/duplicate key name|already exists/i.test(e.message)) throw e;
  }
  // Stops a double-tap, a refresh or a retried request from creating a second pending request for the same
  // team name or the same signed-in person.
  try {
    await pool.query('ALTER TABLE tournament_registration_requests ADD UNIQUE KEY uniq_req_team (tournament_id, kind, team_name)');
  } catch (e) { if (!/duplicate key name|already exists/i.test(e.message)) throw e; }
  try {
    await pool.query('ALTER TABLE tournament_registration_requests ADD UNIQUE KEY uniq_req_user (tournament_id, kind, user_id)');
  } catch (e) { if (!/duplicate key name|already exists/i.test(e.message)) throw e; }

  // ---- 3. cricket innings state on the fixture ----------------------------------------------------------
  for (const c of [
    'batting_team_id INT NULL',
    'bowling_team_id INT NULL',
    'striker_id INT NULL',
    'non_striker_id INT NULL',
    'bowler_id INT NULL',
    'current_innings INT NOT NULL DEFAULT 1',
    'overs_limit INT NULL',
    'toss_winner_id INT NULL',
    "toss_decision ENUM('BAT','BOWL') NULL",
  ]) await addColumn('tournament_fixtures', c);

  // Ball-by-ball events are already stored in tournament_match_events; this index makes replaying one
  // match's innings cheap no matter how long the tournament has been running.
  try {
    await pool.query('ALTER TABLE tournament_match_events ADD INDEX idx_match_live (match_id, is_undone, id)');
  } catch (e) { if (!/duplicate key name|already exists/i.test(e.message)) throw e; }
};
