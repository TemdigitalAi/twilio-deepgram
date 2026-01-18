/**
 * server.js
 * Twilio → Media Stream → Deepgram → GPT
 */

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

/* =======================
   Clients
======================= */
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* =======================
   Middlewares
======================= */
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* =======================
   ROUTE DE TEST (OPTIONNEL)
======================= */
app.get('/', (req, res) => {
  res.send('✅ Twilio Deepgram Server is running');
});

/* ==========================================================
   1️⃣ Twilio Webhook — ANSWER CALL
   URL: /twilio-webhook
========================================================== */
app.post('/twilio-webhook', (req, res) => {
  console.log('📞 Incoming Twilio call');

  const response = new twiml.VoiceResponse();

  const gather = response.gather({
    input: 'dtmf',
    numDigits: 1,
    timeout: 5,
    action: '/gather-response',
    method: 'POST',
  });

  gather.say(
    "Hi, this is Ava, your virtual assistant. Press any key to start speaking."
  );

  res.type('text/xml');
  res.send(response.toString());
});

/* ==========================================================
   2️⃣ After key press → START MEDIA STREAM
========================================================== */
app.post('/gather-response', (req, res) => {
  console.log('🎯 Key pressed, starting media stream');

  const response = new twiml.VoiceResponse();

  const streamUrl = `wss://${process.env.RENDER_EXTERNAL_URL}/ws`;

  response.start().stream({
    url: streamUrl,
  });

  response.say('You may begin speaking now.');
  response.pause({ length: 60 });

  res.type('text/xml');
  res.send(response.toString());
});

/* ==========================================================
   3️⃣ WebSocket — Twilio Media Stream
========================================================== */
wss.on('connection', (ws) => {
  console.log('🔌 Twilio Media Stream connected');

  const dgConnection = deepgram.listen.live({
    model: 'nova-3',
    language: 'en-US',
    punctuate: true,
    interim_results: true,
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
  });

  let dgReady = false;
  const audioQueue = [];

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log('✅ Deepgram connected');
    dgReady = true;

    while (audioQueue.length > 0) {
      dgConnection.send(audioQueue.shift());
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const transcript =
      data?.channel?.alternatives?.[0]?.transcript;

    if (transcript && transcript.trim() !== '') {
      console.log('📝 Transcript:', transcript);

      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content:
                'You are Ava, a friendly real estate assistant.',
            },
            { role: 'user', content: transcript },
          ],
          temperature: 0.7,
        });

        const reply =
          completion.choices[0].message.content.trim();

        console.log('🤖 GPT Reply:', reply);
        // 👉 (TTS viendra ici plus tard)
      } catch (err) {
        console.error('❌ GPT Error:', err.message);
      }
    }
  });

  dgConnection.on('error', (err) => {
    console.error('❌ Deepgram error:', err);
  });

  dgConnection.on('close', () => {
    console.log('🛑 Deepgram connection closed');
  });

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.event === 'start') {
      console.log(
        `▶️ Stream started | Call SID: ${data.start.callSid}`
      );
    }

    if (data.event === 'media') {
      const audio = Buffer.from(
        data.media.payload,
        'base64'
      );

      if (dgReady) {
        dgConnection.send(audio);
      } else {
        audioQueue.push(audio);
      }
    }

    if (data.event === 'stop') {
      console.log('⛔ Stream stopped by Twilio');
      dgConnection.close();
    }
  });

  ws.on('close', () => {
    console.log('🔒 WebSocket closed');
    dgConnection.close();
  });
});

/* ==========================================================
   4️⃣ START SERVER (RENDER COMPATIBLE)
========================================================== */
const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
