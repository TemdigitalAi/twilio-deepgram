/**
 * server.js
 * Twilio (call) → DTMF → Media Stream (WS) → Deepgram (STT)
 * → GPT → Twilio <Say> → loop
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
if (!RENDER_EXTERNAL_URL) throw new Error('Missing RENDER_EXTERNAL_URL');

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
  return RENDER_EXTERNAL_URL.startsWith('http')
    ? RENDER_EXTERNAL_URL
    : `https://${RENDER_EXTERNAL_URL}`;
}

function getWsUrl() {
  if (LOCAL_TEST === 'true') return 'ws://localhost:10000/ws';
  const host = new URL(getPublicBaseUrl()).host;
  return `wss://${host}/ws`;
}

function escapeForSay(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* =========================
   HEALTH
========================= */
app.get('/', (req, res) => {
  res.send('✅ Twilio + Deepgram + GPT server is live');
});

/* ==========================================================
   /voice — Entrée de l’appel
========================================================== */
app.post('/voice', (req, res) => {
  const vr = new VoiceResponse();

  const gather = vr.gather({
    input: 'dtmf',
    numDigits: 1,
    timeout: 8,
    action: `${getPublicBaseUrl()}/gather-response`,
    method: 'POST',
  });

  gather.say(
    { voice: 'alice' },
    'Hello, this is Ava. Press any key to start talking.'
  );

  vr.redirect({ method: 'POST' }, `${getPublicBaseUrl()}/voice`);
  res.type('text/xml').send(vr.toString());
});

/* ==========================================================
   /gather-response — START STREAM (sans parler)
========================================================== */
app.post('/gather-response', (req, res) => {
  const vr = new VoiceResponse();

  // ⚠️ IMPORTANT : on ne parle plus ici
  vr.start().stream({ url: getWsUrl() });
  vr.pause({ length: 600 });

  res.type('text/xml').send(vr.toString());
});

/* ==========================================================
   GPT
========================================================== */
async function getGPTReply(text) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content:
            'You are Ava, a professional assistant. Detect language (FR/EN) and reply briefly.',
        },
        { role: 'user', content: text },
      ],
    });

    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error('❌ GPT Error:', err.message);
    return 'Sorry, can you repeat that?';
  }
}

/* ==========================================================
   MEDIA STREAM → DEEPGRAM → GPT → TWILIO
========================================================== */
wss.on('connection', (ws) => {
  console.log('🔌 Media Stream connected');

  let callSid = null;
  let bufferText = '';
  let isUpdatingCall = false;
  let silenceTimer = null;

  // 🔧 réglages stabilité
  const SILENCE_MS = 1500;
  const MIN_CHARS = 3;

  function resetSilenceTimer(cb) {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(cb, SILENCE_MS);
  }

  async function speak(reply) {
    if (!callSid || isUpdatingCall) return;

    isUpdatingCall = true;
    try {
      const vr = new VoiceResponse();
      vr.say({ voice: 'alice' }, escapeForSay(reply));
      // ⚠️ PAS de redirect ici → évite les coupures

      await twilioClient.calls(callSid).update({
        twiml: vr.toString(),
      });
    } catch (err) {
      console.error('❌ Twilio update error:', err.message);
    } finally {
      setTimeout(() => (isUpdatingCall = false), 1200);
    }
  }

  const dg = deepgram.listen.live({
    model: 'nova-3',
    language: 'multi',
    encoding: 'mulaw',
    sample_rate: 8000,
    interim_results: true,
    vad_events: true,
    endpointing: 300,
  });

  dg.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data?.channel?.alternatives?.[0]?.transcript;
    if (!transcript || !data.is_final) return;

    bufferText += ' ' + transcript;

    resetSilenceTimer(async () => {
      const text = bufferText.trim();
      bufferText = '';

      if (!text || text.length < MIN_CHARS) return;

      console.log('🧠 User:', text);

      const reply = await getGPTReply(text);
      console.log('🤖 Ava:', reply);

      await speak(reply);
    });
  });

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.event === 'start') {
      callSid = data.start.callSid;
      console.log('▶️ Call SID:', callSid);
    }

    if (data.event === 'media') {
      dg.send(Buffer.from(data.media.payload, 'base64'));
    }
  });

  ws.on('close', () => {
    console.log('🔒 WS closed');
    dg.finish();
  });
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
