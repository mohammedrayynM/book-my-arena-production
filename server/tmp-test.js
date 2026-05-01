const pool = require('./config/db');

async function test() {
  try {
    const [settings] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'commission_percent'");
    const commission = settings.length > 0 ? parseFloat(settings[0].setting_value) : 10;
    
    const query = `
      SELECT 
        DATE(b.booking_date) as date,
        t.id as turf_id,
        t.name as turf_name,
        o.name as owner_name,
        COALESCE(SUM(b.amount), 0) as total_earnings,
        COALESCE(SUM((b.original_price - b.discount_amount) * (? / 100)), 0) as commission_amount,
        COALESCE(SUM((b.original_price - b.discount_amount) * ((100 - ?) / 100)), 0) as owner_payout,
        COALESCE(dp.status, 'not_paid') as status,
        dp.paid_at
      FROM bookings b
      JOIN turfs t ON b.turf_id = t.id
      JOIN owners o ON t.owner_id = o.id
      LEFT JOIN daily_payouts dp ON dp.turf_id = t.id AND dp.payout_date = DATE(b.booking_date)
      WHERE b.status = 'confirmed' AND b.payment_status = 'success' 
        AND b.booking_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
      GROUP BY DATE(b.booking_date), t.id, t.name, o.name, dp.status, dp.paid_at
      ORDER BY DATE(b.booking_date) DESC, t.name ASC
    `;
    
    const [rows] = await pool.query(query, [commission, commission]);
    console.log("PAYOUTS ROWS:", rows);
    process.exit(0);
  } catch (err) {
    console.error("SQL ERROR:", err);
    process.exit(1);
  }
}

test();
