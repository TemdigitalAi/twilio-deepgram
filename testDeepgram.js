/**
 * testDeepgram.js
 * Référence OFFICIELLE pour l'écoute humaine
 * (silences, hésitations, rectifications)
 */

require('dotenv').config();
const { createClient } = require('@deepgram/sdk');
const mic = require('mic');

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

/**
 * =========================
 * ÉTAT DE CONVERSATION
 * (sera IDENTIQUE dans server.js)
 * =========================
 */
const STATE = {
  clientSpeaking: false,
  lastSpeechAt: null,
  silenceTimer: null,
  transcriptBuffer: '',
};

/**
 * =========================
 * MICRO LOCAL (simulation appel)
 * =========================
 */
const microphone = mic({
  rate: '16000',
  channels: '1',
  debug: false,
  exitOnSilence: 0,
});

const micStream = microphone.getAudioStream();

/**
 * =========================
 * DEEPGRAM LIVE
 * =========================
 */
const dg = deepgram.listen.live({
  model: 'nova-2',
  language: 'fr-CA',
  smart_format: true,
  punctuate: true,

  interim_results: false, // ❌ jamais de partiel
  utterances: true,       // ✅ phrases complètes
  endpointing: 3500,      // ✅ 3.5s silence humain
});

/**
 * =========================
 * AUDIO → DEEPGRAM
 * =========================
 */
micStream.on('data', (chunk) => {
  dg.send(chunk);

  STATE.clientSpeaking = true;
  STATE.lastSpeechAt = Date.now();

  if (STATE.silenceTimer) {
    clearTimeout(STATE.silenceTimer);
    STATE.silenceTimer = null;
  }
});

/**
 * =========================
 * TRANSCRIPTION FINALE
 * =========================
 */
dg.on('transcriptReceived', (data) => {
  if (!data.is_final || !data.speech_final) return;

  const text = data.channel.alternatives[0].transcript.trim();
  if (!text) return;

  console.log(`🎙️ Client (final): ${text}`);

  STATE.clientSpeaking = false;
  STATE.transcriptBuffer += (STATE.transcriptBuffer ? ' ' : '') + text;

  // ⏸️ Pause humaine avant interprétation
  STATE.silenceTimer = setTimeout(() => {
    if (!STATE.clientSpeaking && STATE.transcriptBuffer) {
      console.log('🧠 PHRASE À INTERPRÉTER :', STATE.transcriptBuffer);

      /**
       * ⚠️ C'EST CETTE CHAÎNE QUI SERA ENVOYÉE À GPT PLUS TARD
       * sendToGPT(STATE.transcriptBuffer)
       */

      STATE.transcriptBuffer = '';
    }
  }, 1200); // 1.2s = réflexion humaine
});

/**
 * =========================
 * LOGS / ERREURS
 * =========================
 */
dg.on('open', () => {
  console.log('🟢 Deepgram connecté. Parle naturellement...');
});

dg.on('error', console.error);
micStream.on('error', console.error);

/**
 * =========================
 * DÉMARRAGE
 * =========================
 */
microphone.start();