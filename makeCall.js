/**
 * makeCall.js
 * Responsible ONLY for initiating an outbound Twilio call
 */

require('dotenv').config();
const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  RENDER_EXTERNAL_URL,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('❌ Missing Twilio credentials');
}
if (!TWILIO_PHONE_NUMBER) {
  throw new Error('❌ Missing TWILIO_PHONE_NUMBER');
}
if (!RENDER_EXTERNAL_URL) {
  throw new Error('❌ Missing RENDER_EXTERNAL_URL');
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/**
 * Initiates a call
 * @param {string} toNumber - E.164 format (ex: +14388361014)
 */
async function makeCall(toNumber) {
  const baseUrl = RENDER_EXTERNAL_URL.startsWith('http')
    ? RENDER_EXTERNAL_URL
    : `https://${RENDER_EXTERNAL_URL}`;

  console.log(`📞 Calling ${toNumber} from ${TWILIO_PHONE_NUMBER}`);

  const call = await client.calls.create({
    to: toNumber,
    from: TWILIO_PHONE_NUMBER,
    url: `${baseUrl}/voice`, // 👈 CRITICAL: entrypoint in server.js
    method: 'POST',
  });

  console.log('✅ Call initiated. Call SID:', call.sid);
  return call.sid;
}

module.exports = makeCall;
