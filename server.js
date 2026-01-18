/**
 * server.js
 * Twilio (call) → DTMF → Media Stream (WS) → Deepgram (STT) → GPT → Twilio (Say) → loop
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const OpenAI = require('openai');

/* =========================
   ENV
========================= */
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  DEEPGRAM_API_KEY,
  OPENAI_API_KEY,
  RENDER_EXTERNAL_URL,
  LOCAL_TEST,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) throw new Error('Missing TWILIO creds');
if (!TWILIO_PHONE_NUMBER) throw new Error('Missing TWILIO_PHONE_NUMBER');
if (!DEEPGRAM_API_KEY) throw new Error('Missing DEEPGRAM_API_KEY');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
if (!RENDER_EXTERNAL_URL) throw new Error('Missing RENDER_EXTERNAL_URL (must be https://...)');

/* =========================
   CLIENTS
========================= */
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const deepgram = createClient(DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* =========================
   SERVER SETUP
========================= */
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const { VoiceResponse } = twilio.twiml;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* =========================
   HELPERS
========================= */
function getPublicBaseUrl() {
  // Must be like https://twilio-deepgram-v1ay.onrender.com
  return RENDER_EXTERNAL_URL.startsWith('http') ? RENDER_EXTERNAL_URL : `https://${RENDER_EXTERNAL_URL}`;
}

function getWsUrl() {
  if (LOCAL_TEST === 'true') return 'ws://localhost:10000/ws';
  const host = new URL(getPublicBaseUrl()).host;
  return `wss://${host}/ws`;
}

// Simple SSML escape for Twilio <Say>
function escapeForSay(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* =========================
   HEALTH CHECK
========================= */
app.get('/', (req, res) => {
  res.send('✅ Twilio + Deepgram + GPT server is live');
});

/* ==========================================================
   1) /voice — Call entrypoint (agent speaks first, asks to press key)
   (Works for inbound OR outbound calls. For outbound: calls.create(url=/voice))
========================================================== */
app.post('/voice', (req, res) => {
  console.log('📞 Call started → /voice');

  const response = new VoiceResponse();

  const gather = response.gather({
    input: 'dtmf',
    numDigits: 1,
    timeout: 8,
    action: '/gather-response',
    method: 'POST',
  });

  gather.say({ voice: 'alice' }, "Hello, this is Ava. Press any key to start talking.");

  // If no key pressed, repeat
  response.redirect({ method: 'POST' }, '/voice');

  res.type('text/xml').send(response.toString());
});

/* ==========================================================
   2) /gather-response — Start Media Stream after key press
========================================================== */
app.post('/gather-response', (req, res) => {
  console.log('🎯 DTMF received → starting stream');

  const response = new VoiceResponse();
  const wsUrl = getWsUrl();

  response.start().stream({ url: wsUrl });

  response.say({ voice: 'alice' }, 'You may begin speaking now.');
  response.pause({ length: 600 });

  res.type('text/xml').send(response.toString());
});

/* ==========================================================
   3) GPT helper — auto language response + concise
========================================================== */
async function getGPTReply(userText) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.5,
      messages: [
        {
          role: 'system',
          content: [
            "You are Ava, a helpful and professional real-estate assistant.",
            "RULES:",
            "1) Detect the user's language (French or English) and reply in the same language.",
            "2) Keep replies short for phone calls (1–2 sentences).",
            "3) Ask 1 question at a time.",
          ].join('\n'),
        },
        { role: 'user', content: userText },
      ],
    });

    return completion.choices?.[0]?.message?.content?.trim() || "Sorry, can you repeat that?";
  } catch (err) {
    console.error('❌ GPT Error:', err.message);
    return "Sorry, can you repeat that?";
  }
}

/* ==========================================================
   4) WS — Twilio → Deepgram → (end-of-utterance) → GPT → Twilio Say → loop
========================================================== */
wss.on('connection', (ws) => {
  console.log('🔌 Media Stream connected (/ws)');

  const baseUrl = getPublicBaseUrl();
  let callSid = null;

  // --- Utterance buffering ---
  let bufferText = '';
  let lastTranscriptAt = Date.now();

  // Controls to avoid talking over itself
  let isUpdatingCall = false;

  // Silence / end-of-phrase tuning
  const SILENCE_MS = 900;     // if no transcript for 0.9s → consider phrase ended
  const MIN_CHARS = 3;        // ignore very tiny noises
  const MAX_UTTERANCE_CHARS = 500;

  // Fallback timer if DG doesn't send utterance-end events
  let silenceTimer = null;

  function resetSilenceTimer(onSilence) {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(onSilence, SILENCE_MS);
  }

  async function speakReplyInCall(reply) {
    if (!callSid) return;
    if (isUpdatingCall) return;

    isUpdatingCall = true;
    try {
      const vr = new VoiceResponse();
      vr.say({ voice: 'alice' }, escapeForSay(reply));

      // Restart loop: require keypress again? (NO) — we continue automatically
      // We redirect to /gather-response to re-open Media Stream after speaking.
      vr.redirect({ method: 'POST' }, `${baseUrl}/gather-response`);

      await twilioClient.calls(callSid).update({ twiml: vr.toString() });
    } catch (err) {
      console.error('❌ Twilio calls.update error:', err.message);
    } finally {
      // small cooldown to avoid rapid updates
      setTimeout(() => { isUpdatingCall = false; }, 350);
    }
  }

  async function finalizeUtteranceAndRespond(reason = 'silence') {
    const text = bufferText.trim();
    bufferText = '';

    if (!text || text.length < MIN_CHARS) return;

    console.log(`🧠 Utterance finalized (${reason}):`, text);

    const reply = await getGPTReply(text);
    console.log('🤖 GPT Reply:', reply);

    await speakReplyInCall(reply);
  }

  // Deepgram live
  const dg = deepgram.listen.live({
    model: 'nova-3',
    // "multi" gives better chance for FR/EN without hardcoding, if supported
    // If your DG account rejects "multi", change to 'en-US' or 'fr'
    language: 'multi',
    smart_format: true,
    punctuate: true,
    interim_results: true,
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,

    // These help end-of-utterance detection (if supported on your plan/model)
    vad_events: true,
    endpointing: 300,
  });

  dg.on(LiveTranscriptionEvents.Open, () => {
    console.log('✅ Deepgram connected');
  });

  // If SDK exposes UtteranceEnd, we use it; otherwise fallback timer handles it.
  if (LiveTranscriptionEvents.UtteranceEnd) {
    dg.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
      await finalizeUtteranceAndRespond('dg_utterance_end');
    });
  }

  dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
    try {
      const alt = data?.channel?.alternatives?.[0];
      const transcript = alt?.transcript || '';
      const isFinal = data?.is_final === true;

      if (!transcript) return;

      lastTranscriptAt = Date.now();

      // Build buffer: we add finals strongly; interims are optional but helpful
      if (isFinal) {
        bufferText += (bufferText ? ' ' : '') + transcript.trim();
        if (bufferText.length > MAX_UTTERANCE_CHARS) {
          bufferText = bufferText.slice(-MAX_UTTERANCE_CHARS);
        }
        console.log('📝 Final:', transcript.trim());
      } else {
        // you can log interims if you want:
        // console.log('… interim:', transcript.trim());
      }

      resetSilenceTimer(async () => {
        // If enough time passed since last transcript → treat as end of phrase
        const now = Date.now();
        if (now - lastTranscriptAt >= SILENCE_MS) {
          await finalizeUtteranceAndRespond('silence_timer');
        }
      });
    } catch (err) {
      console.error('❌ Transcript handler error:', err);
    }
  });

  dg.on('error', (err) => {
    console.error('❌ Deepgram error:', err);
  });

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    if (data.event === 'start') {
      callSid = data?.start?.callSid || null;
      console.log('▶️ Stream started | Call SID:', callSid);
    }

    if (data.event === 'media') {
      const audio = Buffer.from(data.media.payload, 'base64');
      dg.send(audio);
    }

    if (data.event === 'stop') {
      console.log('⛔ Stream stopped by Twilio');
      try { dg.finish(); } catch {}
      if (silenceTimer) clearTimeout(silenceTimer);
    }
  });

  ws.on('close', () => {
    console.log('🔒 WS closed');
    try { dg.finish(); } catch {}
    if (silenceTimer) clearTimeout(silenceTimer);
  });
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
