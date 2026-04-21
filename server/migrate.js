const mysql = require('mysql2/promise');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function migrate() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
    multipleStatements: true
  });

  try {
    console.log('🚀 Starting Full Migration...');

    const files = [
      '../database/schema.sql',
      '../database/coupons.sql',
      '../database/special_pricing.sql'
    ];

    for (const file of files) {
      console.log(`📄 Running ${file}...`);
      const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
      
      // We run queries one by one or as multiple statements
      // Some statements like ALTER TABLE can be tricky with multipleStatements
      try {
        await connection.query(sql);
        console.log(`✅ ${file} completed successfully.`);
      } catch (err) {
        if (err.message.includes('already exists') || err.message.includes('Duplicate column name')) {
          console.log(`ℹ️ ${file} had some pre-existing elements, skipped those.`);
        } else {
          console.error(`❌ Error in ${file}:`, err.message);
        }
      }
    }

    // Additional manual fixes for bookings table just in case migrate-special-pricing missed it
    try {
        console.log('🔧 Verifying bookings table columns...');
        await connection.query(`
            ALTER TABLE bookings 
            ADD COLUMN IF NOT EXISTS original_price DECIMAL(10, 2) DEFAULT NULL,
            ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(10, 2) DEFAULT 0,
            ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(50) DEFAULT NULL
        `);
        console.log('✅ Bookings table verified.');
    } catch (err) {
        // Falling back to individual ALTER TABLEs if TiDB doesn't like ADD COLUMN IF NOT EXISTS (it sometimes doesn't)
        const cols = [
            ['original_price', 'DECIMAL(10, 2) DEFAULT NULL'],
            ['discount_amount', 'DECIMAL(10, 2) DEFAULT 0'],
            ['coupon_code', 'VARCHAR(50) DEFAULT NULL']
        ];
        for(const [col, def] of cols) {
            try {
                await connection.query(`ALTER TABLE bookings ADD COLUMN ${col} ${def}`);
                console.log(`✅ Added column ${col}`);
            } catch (e) {
                console.log(`ℹ️ Column ${col} might already exist`);
            }
        }
    }

    console.log('🎉 Migration completed!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    await connection.end();
  }
}

migrate();
