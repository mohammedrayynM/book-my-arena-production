const pool = require('./config/db');

async function run() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS turf_sessions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                turf_id INT NOT NULL,
                court_id INT DEFAULT NULL,
                name VARCHAR(100) NOT NULL,
                start_time TIME NOT NULL,
                end_time TIME NOT NULL,
                is_enabled BOOLEAN DEFAULT TRUE,
                FOREIGN KEY (turf_id) REFERENCES turfs(id) ON DELETE CASCADE
            )
        `);
        console.log('✅ turf_sessions table created');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error creating table:', err);
        process.exit(1);
    }
}

run();
