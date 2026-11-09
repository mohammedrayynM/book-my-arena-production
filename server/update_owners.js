const fs = require('fs');
let f = fs.readFileSync('server/routes/owners.js', 'utf8');

f = f.replace(
    "const [turfs] = await pool.query('SELECT * FROM turfs WHERE id = ? AND owner_id = ?'",
    "const [turfs] = await pool.query('SELECT *, monthly_subscription_amount, razorpay_linked_account_id FROM turfs WHERE id = ? AND owner_id = ?'"
);

const replaceTarget = `    res.json({
      total: Math.round(totalEarnings * 100) / 100,`;

const replacement = `    const currentMonthStr = new Date().toISOString().slice(0, 7);
    const [subRows] = await pool.query('SELECT * FROM turf_subscriptions WHERE turf_id = ? AND cycle_month = ?', [turfId, currentMonthStr]);
    const subData = subRows.length > 0 ? subRows[0] : null;

    res.json({
      subscription: {
        amount: parseFloat(turfs[0].monthly_subscription_amount || 0),
        collected: parseFloat(subData?.collected_amount || 0),
        status: subData ? subData.status : 'UNPAID',
        linked_account: turfs[0].razorpay_linked_account_id || null,
        month: currentMonthStr
      },
      total: Math.round(totalEarnings * 100) / 100,`;

if (!f.includes('const currentMonthStr =')) {
    f = f.replace(replaceTarget, replacement);
}

fs.writeFileSync('server/routes/owners.js', f);
console.log('Done owner update');
