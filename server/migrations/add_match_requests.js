const pool = require('../config/db');

async function migrate() {
  try {
    console.log('🚀 Starting Match Requests Migration...');

    // 1. Player Requests Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS player_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        host_id INT NOT NULL,
        turf_id INT NOT NULL,
        court_id INT,
        sport_type VARCHAR(50) NOT NULL,
        match_type ENUM('friendly', 'competitive') DEFAULT 'friendly',
        match_date DATE NOT NULL,
        match_time TIME NOT NULL,
        total_slots INT NOT NULL,
        filled_slots INT DEFAULT 0,
        roles_needed JSON,
        skill_level ENUM('beginner', 'intermediate', 'advanced', 'all') DEFAULT 'all',
        advance_amount DECIMAL(10, 2) DEFAULT 0,
        split_amount DECIMAL(10, 2) DEFAULT 0,
        visibility_radius INT DEFAULT 10,
        latitude DECIMAL(10, 8),
        longitude DECIMAL(11, 8),
        status ENUM('open', 'full', 'cancelled', 'completed') DEFAULT 'open',
        is_featured BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (host_id) REFERENCES users(id),
        FOREIGN KEY (turf_id) REFERENCES turfs(id)
      )
    `);
    console.log('✅ player_requests table created.');

    // 2. Match Players Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS match_players (
        id INT AUTO_INCREMENT PRIMARY KEY,
        match_id INT NOT NULL,
        user_id INT NOT NULL,
        role VARCHAR(50),
        payment_type ENUM('advance', 'split') DEFAULT 'advance',
        payment_status ENUM('paid', 'pending', 'failed') DEFAULT 'pending',
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'approved',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (match_id) REFERENCES player_requests(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    console.log('✅ match_players table created.');

    // 3. User Karma and Badges
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS karma_points INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS badges JSON
    `);
    console.log('✅ users table updated with karma and badges.');

    console.log('✨ Match Requests Migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
