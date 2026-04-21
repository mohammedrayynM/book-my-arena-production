const axios = require('axios');
require('dotenv').config();

const sendSMS = async (numbers, message) => {
  const apiKey = process.env.FAST2SMS_API_KEY;

  if (!apiKey || apiKey === 'your_fast2sms_api_key_here') {
    console.warn('⚠️ Fast2SMS API Key not configured. Skipping SMS.');
    return { success: false, message: 'API Key not configured' };
  }

  try {
    const response = await axios.get('https://www.fast2sms.com/dev/bulkV2', {
      headers: {
        authorization: apiKey
      },
      params: {
        route: 'q',
        message: message,
        flash: '0',
        numbers: numbers
      }
    });

    if (response.data.return) {
      console.log(`✅ SMS sent successfully to ${numbers}`);
      return { success: true, data: response.data };
    } else {
      console.error('❌ Fast2SMS error:', response.data.message);
      return { success: false, error: response.data.message };
    }
  } catch (error) {
    console.error('🔥 Fast2SMS Request Failed:', error.message);
    return { success: false, error: error.message };
  }
};

module.exports = { sendSMS };
