/**
 * server.js
 * Twilio (call) → Media Stream (WS) → Deepgram (STT)
 * → GPT → ElevenLabs (TTS) → Twilio <Play>
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
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
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  RENDER_EXTERNAL_URL,
  LOCAL_TEST,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) throw new Error('Missing TWILIO creds');
if (!DEEPGRAM_API_KEY) throw new Error('Missing DEEPGRAM_API_KEY');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
if (!ELEVENLABS_API_KEY) throw new Error('Missing ELEVENLABS_API_KEY');
if (!ELEVENLABS_VOICE_ID) throw new Error('Missing ELEVENLABS_VOICE_ID');
if (!RENDER_EXTERNAL_URL) throw new Error('Missing RENDER_EXTERNAL_URL');

/* =========================
   CLIENTS
========================= */
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const deepgram = createClient(DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* =========================
   SERVER
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
  return `wss://${new URL(getPublicBaseUrl()).host}/ws`;
}

/* =========================
   HEALTH
========================= */
app.get('/', (_, res) => {
  res.send('✅ Voice agent live');
});

/* =========================
   ENTRY CALL
========================= */
app.post('/voice', (req, res) => {
  const vr = new VoiceResponse();
  vr.start().stream({ url: getWsUrl() });
  vr.pause({ length: 600 });
  res.type('text/xml').send(vr.toString());
});

/* =========================
   GPT
========================= */
async function getGPTReply(text) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.4,
    messages: [
      { role: 'system', content: 'You are Ava, a natural voice assistant. Reply briefly.' },
      { role: 'user', content: text },
    ],
  });
  return completion.choices[0].message.content.trim();
}

/* =========================
   ELEVENLABS TTS
========================= */
async function synthesizeSpeech(text, callSid) {
  const audioPath = path.join('/tmp', `${callSid}.mp3`);

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.75,
        },
      }),
    }
  );

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(audioPath, buffer);
  return audioPath;
}

/* =========================
   MEDIA STREAM
========================= */
wss.on('connection', (ws) => {
  console.log('🔌 Media stream connected');

  let callSid = null;
  let bufferText = '';
  let silenceTimer = null;
  let speaking = false;

  const SILENCE_MS = 1500;
  const MIN_CHARS = 3;

  function resetSilence(cb) {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(cb, SILENCE_MS);
  }

  async function speak(reply) {
    if (!callSid || speaking) return;
    speaking = true;

    try {
      const audioPath = await synthesizeSpeech(reply, callSid);
      const vr = new VoiceResponse();
      vr.play(`${getPublicBaseUrl()}/audio/${path.basename(audioPath)}`);
      await twilioClient.calls(callSid).update({ twiml: vr.toString() });
    } finally {
      setTimeout(() => (speaking = false), 800);
    }
  }

  const dg = deepgram.listen.live({
    model: 'nova-3',
    language: 'multi',
    encoding: 'mulaw',
    sample_rate: 8000,
    interim_results: true,
    vad_events: true,
  });

  dg.on(LiveTranscriptionEvents.Transcript, (data) => {
    if (!data.is_final) return;
    const transcript = data.channel.alternatives[0].transcript;
    if (!transcript) return;

    bufferText += ' ' + transcript;

    resetSilence(async () => {
      const text = bufferText.trim();
      bufferText = '';
      if (text.length < MIN_CHARS) return;

      console.log('🧠 User:', text);
      const reply = await getGPTReply(text);
      console.log('🤖 Ava:', reply);
      await speak(reply);
    });
  });

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);
    if (data.event === 'start') callSid = data.start.callSid;
    if (data.event === 'media') dg.send(Buffer.from(data.media.payload, 'base64'));
  });

  ws.on('close', () => dg.finish());
});

/* =========================
   SERVE AUDIO
========================= */
app.get('/audio/:file', (req, res) => {
  const filePath = path.join('/tmp', req.params.file);
  res.sendFile(filePath);
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on ${PORT}`);
});
