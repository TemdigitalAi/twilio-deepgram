// celui apeller par lagence pour faire parler le bot


const { googleTTS } = require("./googleTts.service");
const { deepgramTTS } = require("./deepgram.service");

async function speak(text, ctx) {
  try {
    return await googleTTS(text, ctx.audioDir, ctx.callSid, ctx.baseUrl);
  } catch (e) {
    console.warn("Google TTS failed → Deepgram fallback");
    return await deepgramTTS(text, ctx.audioDir, ctx.callSid, ctx.baseUrl);
  }
}

module.exports = { speak };
