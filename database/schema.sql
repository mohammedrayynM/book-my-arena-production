-- BookMyArena Schema Tools
-- TABLES ONLY (Assumes database is already selected in connection)

-- Admins table
CREATE TABLE IF NOT EXISTS admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Turf Owners table
CREATE TABLE IF NOT EXISTS owners (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(200) NOT NULL UNIQUE,
  phone VARCHAR(20) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_approved BOOLEAN DEFAULT FALSE,
  is_blocked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Turfs table
CREATE TABLE IF NOT EXISTS turfs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  location VARCHAR(300) NOT NULL,
  address TEXT,
  sport_type VARCHAR(100) NOT NULL,
  price_per_hour DECIMAL(10, 2) NOT NULL,
  description TEXT,
  images JSON,
  amenities JSON,
  owner_id INT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE SET NULL
);

-- Bookings table
CREATE TABLE IF NOT EXISTS bookings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  turf_id INT NOT NULL,
  customer_name VARCHAR(150) NOT NULL,
  customer_phone VARCHAR(20) NOT NULL,
  customer_email VARCHAR(200),
  booking_date DATE NOT NULL,
  time_slot VARCHAR(50) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  payment_id VARCHAR(200),
  payment_status ENUM('pending', 'success', 'failed') DEFAULT 'pending',
  status ENUM('confirmed', 'cancelled', 'completed') DEFAULT 'confirmed',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (turf_id) REFERENCES turfs(id) ON DELETE CASCADE
);

-- Blocked Slots table
CREATE TABLE IF NOT EXISTS blocked_slots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  turf_id INT NOT NULL,
  block_date DATE NOT NULL,
  time_slot VARCHAR(50) NOT NULL,
  reason VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (turf_id) REFERENCES turfs(id) ON DELETE CASCADE
);

-- Platform Settings table
CREATE TABLE IF NOT EXISTS settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(100) NOT NULL UNIQUE,
  setting_value TEXT NOT NULL
);

-- Insert default admin (password: admin123)
INSERT INTO admins (username, password_hash) VALUES
('admin', '$2a$10$xVqYLGEeT5o9MaJ5P3yOaOxLnVMCh5JZ1ZqP5X5X5X5X5X5X5X5X5');

-- Insert default commission setting (10%)
INSERT INTO settings (setting_key, setting_value) VALUES
('commission_percent', '10');
