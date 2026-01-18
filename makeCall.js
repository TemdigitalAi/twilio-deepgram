require('dotenv').config();
const twilio = require('twilio');

/* =========================
   ENV
========================= */
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  RENDER_EXTERNAL_URL,
} = process.env;

/* =========================
   NUMÉROS (REMPLIS)
========================= */
// ✅ Numéro Twilio (FROM)
const FROM_PHONE_NUMBER = '+14388126271';

// ✅ Ton numéro personnel VÉRIFIÉ dans Twilio
const TO_PHONE_NUMBER = '+14388361014';

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('❌ Missing Twilio credentials');
}

if (!RENDER_EXTERNAL_URL) {
  throw new Error('❌ Missing RENDER_EXTERNAL_URL');
}

/* =========================
   CLIENT
========================= */
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/* =========================
   MAKE CALL
========================= */
async function makeCall() {
  try {
    console.log('📞 Creating call...');
    console.log('FROM (Twilio):', FROM_PHONE_NUMBER);
    console.log('TO (You):', TO_PHONE_NUMBER);
    console.log('URL:', `${RENDER_EXTERNAL_URL}/voice`);

    const call = await client.calls.create({
      from: FROM_PHONE_NUMBER,                 // ✅ Twilio number
      to: TO_PHONE_NUMBER,                     // ✅ Verified number
      url: `${RENDER_EXTERNAL_URL}/voice`,     // Webhook Twilio
      method: 'POST',
    });

    console.log('✅ Call created successfully');
    console.log('📡 Call SID:', call.sid);
  } catch (err) {
    console.error('❌ CALL FAILED');
    console.error(err.message);
    if (err.code) console.error('Twilio Code:', err.code);
  }
}

makeCall();
