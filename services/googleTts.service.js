/**
 * services/googleTts.service.js
 *
 * Rôle :
 * - Transformer texte → audio via Google Cloud TTS
 * - Ajouter des pauses humaines (SSML)
 * - Compatible Twilio Voice (MULAW / 8000 Hz)
 * - Compatible Render (credentials via env var)
 */

const fs = require("fs");
const path = require("path");
const textToSpeech = require("@google-cloud/text-to-speech");

/* =========================
   INIT GOOGLE CREDENTIALS (RENDER)
========================= */
/**
 * Render ne permet pas d'uploader un fichier secret.
 * On reconstruit donc le fichier JSON depuis
 * GOOGLE_APPLICATION_CREDENTIALS_JSON
 * AVANT de créer le client Google.
 */
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  const credsPath = "/tmp/google-creds.json";

  if (!fs.existsSync(credsPath)) {
    fs.writeFileSync(
      credsPath,
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
    );
  }

  process.env.GOOGLE_APPLICATION_CREDENTIALS = credsPath;
}

/* =========================
   GOOGLE TTS CLIENT
========================= */
const client = new textToSpeech.TextToSpeechClient();

/* =========================
   SSML HUMANIZER
========================= */
/**
 * Transforme un texte brut en SSML naturel :
 * - pauses après ponctuation
 * - rythme conversationnel
 * - respiration humaine
 * - ton chaleureux
 */
function toSSML(text) {
  if (!text || !text.trim()) {
    return "<speak></speak>";
  }

  // Échapper caractères interdits en SSML
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `
<speak>
  <prosody rate="95%" pitch="-1st">
    <break time="200ms"/>
    ${escaped
      .replace(/([,.])/g, '$1 <break time="200ms"/>')
      .replace(/([?!])/g, '$1 <break time="350ms"/>')}
  </prosody>
</speak>
`;
}

/* =========================
   GOOGLE TTS FUNCTION
========================= */
/**
 * googleTTS
 * @param {string} text      → texte à prononcer
 * @param {string} audioDir  → dossier /audio
 * @param {string} callSid   → identifiant unique d’appel
 * @param {string} baseUrl   → URL publique (Twilio <Play>)
 *
 * @returns {string} URL publique du fichier audio
 */
async function googleTTS(text, audioDir, callSid, baseUrl) {
  if (!text || !text.trim()) {
    throw new Error("Google TTS: empty text");
  }

  const filename = `${callSid}-${Date.now()}.wav`;
  const filepath = path.join(audioDir, filename);

  const request = {
    input: {
      ssml: toSSML(text), // 🧠 SSML HUMAIN
    },
    voice: {
      languageCode: "en-US",
      name: "en-US-Neural2-F", // Voix féminine naturelle
    },
    audioConfig: {
      audioEncoding: "MULAW", // OBLIGATOIRE pour Twilio
      sampleRateHertz: 8000,  // Téléphonie
      speakingRate: 1.0,      // le rythme est piloté par SSML
    },
  };

  const [response] = await client.synthesizeSpeech(request);

  fs.writeFileSync(filepath, response.audioContent, "binary");

  return `${baseUrl}/audio/${filename}`;
}

module.exports = { googleTTS };
