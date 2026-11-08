const pool = require('./config/db');

async function ensureColumn(table, columnSql) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`);
  } catch (e) {
    if (!/Duplicate column name|already exists/i.test(String(e?.message || ''))) {
      console.error(`⚠️ Failed to add column on ${table}: ${columnSql}`, e.message);
    }
  }
}

async function ensureIndex(sql) {
  try {
    await pool.query(sql);
  } catch (e) {
    if (!/Duplicate key name|already exists/i.test(String(e?.message || ''))) {
      console.error('⚠️ Failed to ensure index:', e.message);
    }
  }
}

async function migrateTournaments() {
  console.log('🔄 Starting Tournament System Database Migrations...');
  try {
    // 1. Tournament Settings (For Admin Pricing)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        fee_amount DECIMAL(10,2) DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Insert default setting if empty
    const [settings] = await pool.query('SELECT COUNT(*) as count FROM tournament_settings');
    if (settings[0].count === 0) {
      await pool.query('INSERT INTO tournament_settings (fee_amount, is_active) VALUES (0, true)');
    }

    // 2. Tournaments Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournaments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        sport VARCHAR(100) NOT NULL,
        banner VARCHAR(500),
        logo VARCHAR(500),
        description TEXT,
        venue VARCHAR(255),
        location VARCHAR(255),
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        reg_open_date DATE,
        reg_close_date DATE,
        max_teams INT,
        max_players INT,
        max_participants INT,
        entry_fee DECIMAL(10,2) DEFAULT 0,
        visibility ENUM('PUBLIC', 'PRIVATE', 'LINK_ONLY') DEFAULT 'PUBLIC',
        format_type ENUM('Knockout', 'Round Robin', 'Group Stage + Knockout') DEFAULT 'Knockout',
        status ENUM('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'UPCOMING', 'LIVE', 'COMPLETED', 'CANCELLED') DEFAULT 'DRAFT',
        slug VARCHAR(255) UNIQUE NOT NULL,
        join_token VARCHAR(100) UNIQUE,
        join_link_active BOOLEAN DEFAULT true,
        host_approval_required BOOLEAN DEFAULT true,
        participation_type ENUM('TEAM', 'INDIVIDUAL') DEFAULT 'TEAM',
        allow_user_teams BOOLEAN DEFAULT true,
        allow_user_join_team BOOLEAN DEFAULT true,
        players_per_team INT DEFAULT 11,
        substitute_limit INT DEFAULT 5,
        match_duration INT DEFAULT 60,
        break_duration INT DEFAULT 15,
        points_for_win INT DEFAULT 3,
        points_for_draw INT DEFAULT 1,
        points_for_loss INT DEFAULT 0,
        tie_breaker_rules VARCHAR(255) DEFAULT 'head_to_head,goal_diff,goals_scored',
        number_of_groups INT DEFAULT 2,
        qualification_rules VARCHAR(255) DEFAULT 'top_2_per_group',
        is_paid_to_admin BOOLEAN DEFAULT false,
        razorpay_order_id VARCHAR(100),
        razorpay_payment_id VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (owner_id),
        INDEX (status),
        INDEX (slug),
        INDEX (join_token)
      )
    `);

    // Ensure columns exist if table was created in earlier schema
    await ensureColumn('tournaments', "max_participants INT");
    await ensureColumn('tournaments', "prize_pool_amount DECIMAL(12,2) NOT NULL DEFAULT 0");
    await ensureColumn('tournaments', "creation_fee_amount DECIMAL(10,2) NOT NULL DEFAULT 0");
    await ensureColumn('tournaments', "creation_fee_payment_status VARCHAR(20) NOT NULL DEFAULT 'NOT_REQUIRED'");
    await ensureColumn('tournaments', "participation_type ENUM('TEAM', 'INDIVIDUAL') DEFAULT 'TEAM'");
    await ensureColumn('tournaments', "allow_user_teams BOOLEAN DEFAULT true");
    await ensureColumn('tournaments', "allow_user_join_team BOOLEAN DEFAULT true");
    await ensureColumn('tournaments', "players_per_team INT DEFAULT 11");
    await ensureColumn('tournaments', "substitute_limit INT DEFAULT 5");
    await ensureColumn('tournaments', "match_duration INT DEFAULT 60");
    await ensureColumn('tournaments', "break_duration INT DEFAULT 15");
    await ensureColumn('tournaments', "points_for_win INT DEFAULT 3");
    await ensureColumn('tournaments', "points_for_draw INT DEFAULT 1");
    await ensureColumn('tournaments', "points_for_loss INT DEFAULT 0");
    await ensureColumn('tournaments', "tie_breaker_rules VARCHAR(255) DEFAULT 'head_to_head,goal_diff,goals_scored'");
    await ensureColumn('tournaments', "number_of_groups INT DEFAULT 2");
    await ensureColumn('tournaments', "qualification_rules VARCHAR(255) DEFAULT 'top_2_per_group'");

    // 3. Tournament Teams Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_teams (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tournament_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        logo VARCHAR(500),
        color VARCHAR(50),
        captain_id INT,
        vice_captain_id INT,
        description TEXT,
        max_players INT,
        group_name VARCHAR(50),
        status ENUM('OPEN', 'LOCKED') DEFAULT 'OPEN',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (tournament_id),
        INDEX (captain_id)
      )
    `);
    await ensureColumn('tournament_teams', "group_name VARCHAR(50)");

    // 4. Tournament Participants Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_participants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tournament_id INT NOT NULL,
        user_id INT NOT NULL,
        team_id INT,
        player_name VARCHAR(255),
        profile_photo VARCHAR(500),
        jersey_number VARCHAR(20),
        position VARCHAR(100),
        bio TEXT,
        status ENUM('PENDING', 'APPROVED', 'REJECTED', 'WAITLISTED', 'CANCELLED') DEFAULT 'PENDING',
        registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (tournament_id),
        INDEX (user_id),
        INDEX (team_id)
      )
    `);
    await ensureColumn('tournament_participants', "player_name VARCHAR(255)");
    await ensureColumn('tournament_participants', "profile_photo VARCHAR(500)");

    // 5. Tournament Join Requests
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_join_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tournament_id INT NOT NULL,
        user_id INT NOT NULL,
        type ENUM('INDIVIDUAL', 'TEAM') DEFAULT 'INDIVIDUAL',
        requested_team_name VARCHAR(255),
        status ENUM('PENDING', 'APPROVED', 'REJECTED', 'WAITLISTED', 'CANCELLED') DEFAULT 'PENDING',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (tournament_id),
        INDEX (user_id)
      )
    `);
    await ensureColumn('tournament_join_requests', "requested_team_name VARCHAR(255)");

    // 6. Tournament Fixtures (Matches) Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_fixtures (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tournament_id INT NOT NULL,
        stage VARCHAR(100),
        group_name VARCHAR(50),
        round_number INT DEFAULT 1,
        match_number INT DEFAULT 1,
        next_match_id INT,
        next_match_slot ENUM('A', 'B'),
        team_a_id INT,
        team_b_id INT,
        match_date DATE,
        match_time TIME,
        venue VARCHAR(255),
        referee_name VARCHAR(255),
        notes TEXT,
        status ENUM('SCHEDULED', 'LIVE', 'PAUSED', 'FINISHED', 'POSTPONED', 'CANCELLED') DEFAULT 'SCHEDULED',
        winner_id INT,
        youtube_url VARCHAR(500),
        team_a_score INT DEFAULT 0,
        team_b_score INT DEFAULT 0,
        period_info JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (tournament_id),
        INDEX (team_a_id),
        INDEX (team_b_id),
        INDEX (status)
      )
    `);
    await ensureColumn('tournament_fixtures', "round_number INT DEFAULT 1");
    await ensureColumn('tournament_fixtures', "match_number INT DEFAULT 1");
    await ensureColumn('tournament_fixtures', "next_match_id INT");
    await ensureColumn('tournament_fixtures', "next_match_slot ENUM('A', 'B')");
    await ensureColumn('tournament_fixtures', "referee_name VARCHAR(255)");
    await ensureColumn('tournament_fixtures', "notes TEXT");
    await ensureColumn('tournament_fixtures', "period_info JSON");

    // 7. Tournament Match Events (Score changes)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_match_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        match_id INT NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        team_id INT,
        player_id INT,
        value INT DEFAULT 0,
        metadata JSON,
        created_by INT NOT NULL,
        is_undone BOOLEAN DEFAULT false,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (match_id),
        INDEX (team_id),
        INDEX (player_id)
      )
    `);

    // 8. Tournament Announcements
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_announcements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tournament_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (tournament_id)
      )
    `);

    // 9. Tournament Audit Logs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tournament_id INT NOT NULL,
        actor_id INT NOT NULL,
        action VARCHAR(255) NOT NULL,
        entity VARCHAR(100),
        entity_id INT,
        prev_value JSON,
        new_value JSON,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (tournament_id),
        INDEX (actor_id)
      )
    `);

    // 10. Tournament Streams
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tournament_streams (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tournament_id INT NOT NULL,
        match_id INT,
        youtube_url VARCHAR(500) NOT NULL,
        stream_title VARCHAR(255),
        stream_status ENUM('UPCOMING', 'LIVE', 'ENDED') DEFAULT 'LIVE',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (tournament_id),
        INDEX (match_id)
      )
    `);

    console.log('✅ Tournament System Migrations completed successfully.');
  } catch (error) {
    console.error('❌ Error running Tournament System Migrations:', error.message);
  }
}

module.exports = migrateTournaments;
