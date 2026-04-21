const pool = require('./config/db');

async function migrate() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(150),
        email VARCHAR(200) UNIQUE,
        password_hash VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("Users table created");

    try {
      await pool.query('ALTER TABLE bookings ADD COLUMN user_id INT NULL');
      await pool.query('ALTER TABLE bookings ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL');
      console.log("Added user_id to bookings");
    } catch(err) {
      console.log("user_id might already exist or err:", err.message);
    }
    
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

migrate();
