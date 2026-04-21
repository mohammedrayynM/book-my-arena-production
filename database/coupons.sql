-- Coupon System Schema
-- Allows owners to create coupon codes for discounts

CREATE TABLE IF NOT EXISTS coupons (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  discount_type ENUM('flat', 'percentage') NOT NULL,
  discount_value DECIMAL(10, 2) NOT NULL,
  expiry_date DATE,
  turf_id INT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  max_uses INT DEFAULT NULL, -- NULL = unlimited
  used_count INT DEFAULT 0,
  min_booking_amount DECIMAL(10, 2) DEFAULT 0, -- Minimum booking amount to apply coupon
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (turf_id) REFERENCES turfs(id) ON DELETE CASCADE,
  INDEX idx_coupons_code (code),
  INDEX idx_coupons_turf (turf_id),
  INDEX idx_coupons_expiry (expiry_date)
);

-- Table to track coupon usage per booking
CREATE TABLE IF NOT EXISTS coupon_usages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  coupon_id INT NOT NULL,
  booking_id INT NOT NULL,
  customer_email VARCHAR(200),
  customer_phone VARCHAR(20),
  discount_amount DECIMAL(10, 2) NOT NULL,
  used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE CASCADE,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
  UNIQUE KEY unique_booking_coupon (booking_id, coupon_id),
  INDEX idx_coupon_usages_email (customer_email),
  INDEX idx_coupon_usages_phone (customer_phone)
);

-- Update bookings table to include coupon reference
ALTER TABLE bookings 
ADD COLUMN coupon_code VARCHAR(50) DEFAULT NULL,
ADD COLUMN original_price DECIMAL(10, 2) DEFAULT NULL,
ADD COLUMN discount_amount DECIMAL(10, 2) DEFAULT 0;