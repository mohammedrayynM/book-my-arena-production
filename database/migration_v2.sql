-- Migration script for new features
-- 1. Service Fee Setting
INSERT INTO settings (setting_key, setting_value) VALUES ('service_fee', '20')
ON DUPLICATE KEY UPDATE setting_value = setting_value;

-- 2. Update bookings table for detailed breakdown
ALTER TABLE bookings 
ADD COLUMN IF NOT EXISTS service_fee DECIMAL(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(10, 2) DEFAULT 0;

-- 3. Update special_pricing to support percentage offers
ALTER TABLE special_pricing
ADD COLUMN IF NOT EXISTS offer_percentage INT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS offer_label VARCHAR(50) DEFAULT NULL;
