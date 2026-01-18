/**
 * Outbound Call Trigger (Twilio)
 * This file is responsible ONLY for making the outbound call
 */

require('dotenv').config();
const twilio = require('twilio');

// 🔍 Debug env (safe – no secrets printed)
console.log('🔑 Loaded env:', {
  ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
  AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
  FROM_NUMBER: process.env.TWILIO_PHONE_NUMBER,
  RENDER_URL: process.env.RENDER_EXTERNAL_URL,
});

// ❌ Safety checks (VERY IMPORTANT)
if (
  !process.env.TWILIO_ACCOUNT_SID ||
  !process.env.TWILIO_AUTH_TOKEN ||
  !process.env.TWILIO_PHONE_NUMBER ||
  !process.env.RENDER_EXTERNAL_URL
) {
  throw new Error('❌ Missing required environment variables');
}

// ✅ Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// 📞 Contact to call (TEST)
const toPhoneNumber = '+16476797406'; // MUST be E.164 format
const contactName = 'Adity Test';

// 📲 Twilio verified / purchased number
const fromPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

// ✅ CORRECT webhook URL (points to YOUR Render server)
const TWILIO_WEBHOOK_URL = `${process.env.RENDER_EXTERNAL_URL}/voice`;

/**
 * Make the outbound call
 */
async function makeCall() {
  try {
    console.log(`📞 Calling ${contactName} at ${toPhoneNumber}...`);

    const call = await client.calls.create({
      to: toPhoneNumber,
      from: fromPhoneNumber,
      url: TWILIO_WEBHOOK_URL,
      method: 'POST',
    });

    console.log('✅ Call initiated successfully');
    console.log('📌 Call SID:', call.sid);
  } catch (err) {
    console.error('❌ Call failed');
    console.error(err.message);
  }
}

// ▶️ Run immediately (for testing)
makeCall();

module.exports = makeCall;
