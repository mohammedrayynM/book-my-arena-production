-- Special Pricing Table
-- Allows owners to set custom prices for specific days, dates, and time slots

CREATE TABLE IF NOT EXISTS special_pricing (
  id INT AUTO_INCREMENT PRIMARY KEY,
  turf_id INT NOT NULL,
  court_id INT DEFAULT NULL,
  day_of_week INT, -- 0=Sunday, 1=Monday, ... 6=Saturday (NULL = all days)
  specific_date DATE, -- For specific date overrides (NULL = recurring by day_of_week)
  time_slot VARCHAR(50) NOT NULL, -- e.g., "6:00 AM - 7:00 AM"
  special_price DECIMAL(10, 2) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  offer_percentage INT DEFAULT NULL,
  offer_label VARCHAR(100) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (turf_id) REFERENCES turfs(id) ON DELETE CASCADE,
  UNIQUE KEY unique_pricing (turf_id, court_id, day_of_week, specific_date, time_slot)
);

-- Index for faster lookups
CREATE INDEX idx_special_pricing_turf_date ON special_pricing(turf_id, specific_date);
CREATE INDEX idx_special_pricing_turf_day ON special_pricing(turf_id, day_of_week);
CREATE INDEX idx_special_pricing_turf_court ON special_pricing(turf_id, court_id);