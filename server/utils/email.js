const nodemailer = require('nodemailer');
require('dotenv').config();

const sendEmail = async (toEmail, subject, text, html, options = {}) => {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  const toKey = String(toEmail || '').trim().toLowerCase();
  const shouldSuppressAdminRecipients = options?.suppressAdminRecipients === true;

  if (shouldSuppressAdminRecipients) {
    const suppressed = new Set(
      String(process.env.SUPPRESS_EMAILS_TO || '')
        .split(',')
        .map(s => String(s || '').trim().toLowerCase())
        .filter(Boolean)
    );
    if (user) suppressed.add(String(user).trim().toLowerCase());
    if (process.env.ADMIN_EMAIL) suppressed.add(String(process.env.ADMIN_EMAIL).trim().toLowerCase());

    if (toKey && suppressed.has(toKey)) {
      console.log(`⚠️ Email suppressed for ${toEmail}`);
      return { success: false, message: 'Recipient suppressed' };
    }
  }

  if (!user || user === 'your_email@gmail.com' || !pass || pass === 'your_app_password_here') {
    console.warn('⚠️ Email credentials not configured. Skipping Email.');
    return { success: false, message: 'Email credentials not configured' };
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail', // You can change this to 'smtp.sendgrid.net' etc. if using a different provider
      auth: {
        user: user,
        pass: pass
      }
    });

    const mailOptions = {
      from: `"Book Arena" <${user}>`,
      to: toEmail,
      subject: subject,
      text: text,
      html: html || text // Use html if provided, else fall back to text
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent successfully to ${toEmail} [ID: ${info.messageId}]`);
    return { success: true, data: info };
  } catch (error) {
    console.error('🔥 Email sending failed:', error.message);
    return { success: false, error: error.message };
  }
};

module.exports = { sendEmail };
