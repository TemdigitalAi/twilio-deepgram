/**
 * makeCall.js
 * Déclenche un appel sortant Twilio (CLI ONLY)
 */

require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const TO = process.argv[2];
const FROM = process.env.TWILIO_PHONE_NUMBER;
const WEBHOOK = `https://${process.env.RENDER_EXTERNAL_URL}/twilio-webhook`;

if (!TO) {
  console.error('❌ Usage: node makeCall.js +15145551234');
  process.exit(1);
}

if (!FROM) {
  console.error('❌ Missing TWILIO_PHONE_NUMBER');
  process.exit(1);
}

console.log('📞 Calling:', TO);
console.log('📤 From:', FROM);
console.log('🌐 Webhook:', WEBHOOK);

(async () => {
  try {
    const call = await client.calls.create({
      to: TO,
      from: FROM,
      url: WEBHOOK,
      method: 'POST',
    });

    console.log('✅ Call initiated');
    console.log('Call SID:', call.sid);
  } catch (err) {
    console.error('❌ Twilio error:', err.message);
  }
})();
