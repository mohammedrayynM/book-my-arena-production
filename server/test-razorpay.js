const Razorpay = require('razorpay');
require('dotenv').config();

const rzp = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

async function testRazorpay() {
  console.log('Testing Razorpay keys...');
  console.log('Key ID:', process.env.RAZORPAY_KEY_ID);
  
  try {
    const order = await rzp.orders.create({
      amount: 100, // ₹1
      currency: 'INR',
      receipt: 'test_receipt_1'
    });
    console.log('✅ Success! Order Created:', order.id);
  } catch (err) {
    console.error('❌ Razorpay Error:', err);
  }
}

testRazorpay();
