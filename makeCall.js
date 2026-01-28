/**
 * makeCall.js
 * Initiates the outbound call via Twilio
 */

require('dotenv').config();
const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  RENDER_EXTERNAL_URL,
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

async function makeCall(toPhone) {
  const baseUrl = RENDER_EXTERNAL_URL.startsWith('http') ? RENDER_EXTERNAL_URL : `https://${RENDER_EXTERNAL_URL}`;
  const voiceUrl = `${baseUrl}/voice`;

  console.log(`🚀 Dialing ${toPhone}...`);

  try {
    const call = await client.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: toPhone,
      url: voiceUrl,
      method: 'POST',
    });

    console.log(`✅ Call SID: ${call.sid}`);
    return call.sid;
  } catch (err) {
    console.error('❌ Call failed:', err.message);
    throw err;
  }
}

module.exports = makeCall;
