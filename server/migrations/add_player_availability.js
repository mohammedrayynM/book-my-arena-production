const pool = require('../config/db');

async function migrate() {
  try {
    console.log('🚀 Starting Player Availability Migration...');

    // 1. Player Availability Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS player_availability (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        sport_type VARCHAR(50) NOT NULL,
        turf_id INT,
        preferred_location VARCHAR(300),
        availability_start TIME NOT NULL,
        availability_end TIME NOT NULL,
        availability_date DATE NOT NULL,
        role VARCHAR(50),
        skill_level ENUM('beginner', 'intermediate', 'advanced', 'all') DEFAULT 'all',
        status ENUM('active', 'expired', 'cancelled') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (turf_id) REFERENCES turfs(id) ON DELETE SET NULL,
        INDEX (user_id),
        INDEX (status),
        INDEX (availability_date),
        INDEX (sport_type)
      )
    `);
    console.log('✅ player_availability table created.');

    // 2. Player Invites Table (for inviting available players to matches)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS player_invites (
        id INT AUTO_INCREMENT PRIMARY KEY,
        match_id INT NOT NULL,
        availability_id INT NOT NULL,
        status ENUM('pending', 'accepted', 'declined') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (match_id) REFERENCES player_requests(id) ON DELETE CASCADE,
        FOREIGN KEY (availability_id) REFERENCES player_availability(id) ON DELETE CASCADE
      )
    `);
    console.log('✅ player_invites table created.');

    console.log('✨ Player Availability Migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
