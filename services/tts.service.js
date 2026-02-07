/**
 * services/tts.service.js
 *
 * Rôle :
 * - Aura (Deepgram) = TTS principal (voix la plus humaine)
 * - Google TTS = fallback sécurisé
 */

const { deepgramTTS } = require("./deepgram.service");
const { googleTTS } = require("./googleTts.service");

async function speak(text, ctx) {
  if (!text || !text.trim()) {
    throw new Error("TTS: empty text");
  }

  // 1️⃣ Aura (PRIORITÉ)
  try {
    return await deepgramTTS(
      text,
      ctx.audioDir,
      ctx.callSid,
      ctx.baseUrl
    );
  } catch (err) {
    console.warn("Aura TTS failed → fallback Google", err.message);
  }

  // 2️⃣ Google TTS (FALLBACK)
  return await googleTTS(
    text,
    ctx.audioDir,
    ctx.callSid,
    ctx.baseUrl
  );
}

module.exports = { speak };
