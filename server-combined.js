require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { twiml } = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const OpenAI = require('openai');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

/* ============================
   ENV CHECKS
============================ */
if (!process.env.DEEPGRAM_API_KEY) throw new Error('Missing DEEPGRAM_API_KEY');
if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
if (!process.env.RENDER_EXTERNAL_URL) throw new Error('Missing RENDER_EXTERNAL_URL');

/* ============================
   CLIENTS
============================ */
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ============================
   MIDDLEWARE
============================ */
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* ============================
   1️⃣ TWILIO ENTRYPOINT
============================ */
app.post('/twilio-webhook', (req, res) => {
  const response = new twiml.VoiceResponse();

  const gather = response.gather({
    input: 'dtmf',
    numDigits: 1,
    timeout: 5,
    action: '/gather-response',
    method: 'POST',
  });

  gather.say("Press any key to begin speaking.");
  res.type('text/xml').send(response.toString());
});

/* ============================
   2️⃣ START MEDIA STREAM
============================ */
app.post('/gather-response', (req, res) => {
  const wsUrl =
    process.env.LOCAL_TEST === 'true'
      ? 'ws://localhost:2004/ws'
      : `wss://${process.env.RENDER_EXTERNAL_URL}/ws`;

  const response = new twiml.VoiceResponse();

  response.start().stream({ url: wsUrl });
  response.say("You can start talking now.");
  response.pause({ length: 999 });

  res.type('text/xml').send(response.toString());
});

/* ============================
   3️⃣ WEBSOCKET — TWILIO → DG → GPT
============================ */
wss.on('connection', (ws) => {
  console.log('🔌 Twilio Media Stream connected');

  const dg = deepgram.listen.live({
    model: 'nova-3',
    language: 'en-US',
    smart_format: true,
    punctuate: true,
    interim_results: true,
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
  });

  dg.on(LiveTranscriptionEvents.Open, () => {
    console.log('✅ Deepgram connected');
  });

  dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const transcript =
      data?.channel?.alternatives?.[0]?.transcript;

    if (!transcript || transcript.trim() === '') return;

    console.log('📝 Transcript:', transcript);

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are Ava, a real estate assistant.' },
          { role: 'user', content: transcript },
        ],
        temperature: 0.6,
      });

      const reply = completion.choices[0].message.content;
      console.log('🤖 GPT Reply:', reply);
    } catch (err) {
      console.error('❌ GPT Error:', err.message);
    }
  });

  dg.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('❌ Deepgram error:', err);
  });

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.event === 'media') {
      const audio = Buffer.from(data.media.payload, 'base64');
      dg.send(audio);
    }

    if (data.event === 'stop') {
      console.log('🛑 Stream stopped');
      dg.finish();
    }
  });

  ws.on('close', () => {
    console.log('🔒 WebSocket closed');
    dg.finish();
  });
});

/* ============================
   SERVER START
============================ */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
