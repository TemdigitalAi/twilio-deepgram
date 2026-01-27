/**
 * makeCall.js
 * Lance un appel sortant via Twilio
 */

require('dotenv').config();
const twilio = require('twilio');

/* =========================
   ENV
========================= */
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  RENDER_EXTERNAL_URL,
} = process.env;

/* =========================
   VALIDATION ENV
========================= */
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('❌ Missing Twilio credentials (TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN)');
}

if (!TWILIO_PHONE_NUMBER) {
  throw new Error('❌ Missing TWILIO_PHONE_NUMBER');
}

if (!RENDER_EXTERNAL_URL) {
  throw new Error('❌ Missing RENDER_EXTERNAL_URL');
}

/* =========================
   CLIENT TWILIO
========================= */
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/* =========================
   HELPERS
========================= */
function formatPhoneNumber(phone) {
  // Nettoyer le numéro
  let cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
  
  // Si commence par +, on garde tel quel
  if (cleaned.startsWith('+')) {
    return cleaned;
  }
  
  // Si commence par 1, on ajoute +
  if (cleaned.startsWith('1') && cleaned.length === 11) {
    return '+' + cleaned;
  }
  
  // Si 10 chiffres, on assume +1 (Canada/US)
  if (cleaned.length === 10) {
    return '+1' + cleaned;
  }
  
  return cleaned;
}

/* =========================
   MAKE CALL
========================= */
async function makeCall(toPhone) {
  if (!toPhone) {
    throw new Error('❌ Missing destination phone number');
  }

  // Formater le numéro
  const formattedPhone = formatPhoneNumber(toPhone);

  // Construire l'URL du webhook
  const baseUrl = RENDER_EXTERNAL_URL.startsWith('http')
    ? RENDER_EXTERNAL_URL
    : `https://${RENDER_EXTERNAL_URL}`;
  
  const voiceUrl = `${baseUrl}/voice`;

  console.log('📞 Creating call...');
  console.log('FROM (Twilio):', TWILIO_PHONE_NUMBER);
  console.log('TO (Client):', formattedPhone);
  console.log('VOICE URL:', voiceUrl);

  try {
    const call = await client.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: formattedPhone,
      url: voiceUrl,
      method: 'POST',
      timeout: 60,
    });

    console.log('✅ Call created successfully');
    console.log('📡 Call SID:', call.sid);
    console.log('📊 Status:', call.status);

    return call.sid;

  } catch (err) {
    console.error('❌ Twilio call failed');
    console.error('Message:', err.message);
    if (err.code) {
      console.error('Twilio error code:', err.code);
      
      // Messages d'erreur courants
      const errorMessages = {
        20003: 'Authentification échouée',
        21212: 'Le numéro ne peut pas recevoir d\'appels',
        21214: 'Numéro invalide',
        21217: 'Numéro non vérifié (compte trial Twilio)',
      };
      
      if (errorMessages[err.code]) {
        console.error('Info:', errorMessages[err.code]);
      }
    }
    throw err;
  }
}

/* =========================
   EXPORT
========================= */
module.exports = makeCall;

