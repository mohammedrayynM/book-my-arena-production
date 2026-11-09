const fs = require('fs');
let f = fs.readFileSync('routes/admin.js', 'utf8');

const additional = `
// ========= RAZORPAY & ROUTE MANAGEMENT =========
// GET /api/admin/razorpay-transfers
router.get('/razorpay-transfers', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [transfers] = await pool.query(\`
      SELECT r.*, t.name as turf_name, o.name as owner_name
      FROM razorpay_transfers r
      JOIN turfs t ON r.turf_id = t.id
      JOIN owners o ON t.owner_id = o.id
      ORDER BY r.created_at DESC LIMIT 200
    \`);
    res.json({ transfers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch razorpay transfers' });
  }
});

// GET /api/admin/turf-subscriptions
router.get('/turf-subscriptions', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [subscriptions] = await pool.query(\`
      SELECT s.*, t.name as turf_name, t.monthly_subscription_amount as expected_amount, t.razorpay_linked_account_id
      FROM turf_subscriptions s
      JOIN turfs t ON s.turf_id = t.id
      ORDER BY s.cycle_month DESC, t.name ASC
    \`);
    res.json({ subscriptions });
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch turf subscriptions' });
  }
});

module.exports = router;
`;

f = f.replace('owner_email } = req.body;', 'owner_email, monthly_subscription_amount, razorpay_linked_account_id } = req.body;');
f = f.replace('close_time = ?, owner_email = ?', 'close_time = ?, owner_email = ?, monthly_subscription_amount = ?, razorpay_linked_account_id = ?');
f = f.replace('owner_email || null, req.params.id]', 'owner_email || null, monthly_subscription_amount || 0, razorpay_linked_account_id || null, req.params.id]');

if (!f.includes('/api/admin/razorpay-transfers')) {
    f = f.replace('module.exports = router;', additional);
}
fs.writeFileSync('routes/admin.js', f);
console.log('updated admin.js');
