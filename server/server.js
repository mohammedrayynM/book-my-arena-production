const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./config/db');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Routes
const turfRoutes = require('./routes/turfs');
const bookingRoutes = require('./routes/bookings');
const ownerRoutes = require('./routes/owners');
const adminRoutes = require('./routes/admin');
const couponRoutes = require('./routes/coupons');
const userRoutes = require('./routes/users');

app.use('/api/turfs', turfRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/owners', ownerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/users', userRoutes);

// ✅ Standalone Email endpoint — works even when DB is in demo/mock mode
const { sendEmail } = require('./utils/email');
app.post('/api/notify/booking', async (req, res) => {
  try {
    const { customer_email, customer_name, turf_name, booking_date, time_slot, amount, service_fee, discount_amount } = req.body;

    if (!customer_email) {
      return res.status(400).json({ error: 'Email address is required' });
    }

    let msg = `✅ Booking Confirmed!\n\nHi ${customer_name}, your slot at **${turf_name}** is officially booked.\n\n📅 Date: ${booking_date}\n⏰ Time: ${time_slot}\n\n💰 **Price Breakdown:**\n`;
    
    if (discount_amount > 0) msg += `   - Base Price: ₹${parseFloat(amount) + parseFloat(discount_amount) - (parseFloat(service_fee) || 0)}\n   - Discount: -₹${discount_amount}\n`;
    if (service_fee > 0) msg += `   - Service Fee: +₹${service_fee}\n`;
    
    msg += `\n✨ **Total Paid: ₹${amount}**\n\nThank you for choosing Book Arena! 🏟️`;

    const result = await sendEmail(customer_email, 'Booking Confirmed - Book Arena', msg);

    if (result.success) {
      res.json({ success: true, message: 'Confirmation Email sent!' });
    } else {
      res.json({ success: false, message: result.error || result.message || 'Email not sent' });
    }
  } catch (err) {
    console.error('Notify error:', err.message);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});


// Health check
app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 as healthy');
    res.json({ 
      status: 'ok', 
      db: rows[0].healthy === 1 ? 'connected' : 'error',
      message: 'Book Arena API is running 🏟️' 
    });
  } catch (err) {
    res.json({ 
      status: 'api_only', 
      db: 'disconnected', 
      error: err.message,
      message: 'Server OK but database connection failed' 
    });
  }
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🏟️  Book Arena API Server`);
  console.log(`📡 Running on http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}\n`);
});
