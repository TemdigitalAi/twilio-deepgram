require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { twiml } = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const OpenAI = require('openai').default;

/* =======================
   Clients
======================= */
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =======================
   App & Server
======================= */
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const { VoiceResponse } = twiml;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* =======================
   Health Check
======================= */
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

/* ==========================================================
   1️⃣ Twilio Entry Point
========================================================== */
app.post('/voice', (req, res) => {
  console.log('📞 Incoming call');

  const response = new VoiceResponse();

  const gather = response.gather({
    input: 'dtmf',
    numDigits: 1,
    timeout: 5,
    action: '/gather-response',
    method: 'POST'
  });

  gather.say("Hi, I'm Ava. Press any key to start talking.");

  res.type('text/xml').send(response.toString());
});

/* ==========================================================
   2️⃣ Start Media Stream
========================================================== */
app.post('/gather-response', (req, res) => {
  console.log('🎯 Key pressed – starting media stream');

  const response = new VoiceResponse();

  response.start().stream({
    url: `wss://${process.env.RENDER_EXTERNAL_URL.replace('https://', '')}/ws`
  });

  response.say("You may begin speaking now.");
  response.pause({ length: 999 });

  res.type('text/xml').send(response.toString());
});

/* ==========================================================
   3️⃣ GPT Helper
========================================================== */
async function getGPTReply(text) {
  try {
    const response = await openai.responses.create({
      model: 'gpt-4o',
      input: [
        {
          role: 'system',
          content: 'You are Ava, a friendly real estate assistant.'
        },
        {
          role: 'user',
          content: text
        }
      ]
    });

    return response.output_text;
  } catch (err) {
    console.error('❌ GPT Error:', err.message);
    return "Sorry, I didn't understand that.";
  }
}

/* ==========================================================
   4️⃣ WebSocket: Twilio → Deepgram → GPT
========================================================== */
wss.on('connection', (ws) => {
  console.log('🔌 Twilio Media Stream connected');

  const dgConnection = deepgram.listen.live({
    model: 'nova-3',
    language: 'en-US',
    smart_format: true,
    punctuate: true,
    interim_results: false, // IMPORTANT
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1
  });

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log('✅ Deepgram connected');
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const transcript =
      data?.channel?.alternatives?.[0]?.transcript;

    if (transcript && transcript.trim()) {
      console.log('📝 Final transcript:', transcript);
      const reply = await getGPTReply(transcript);
      console.log('🤖 GPT reply:', reply);
    }
  });

  dgConnection.on('error', (err) => {
    console.error('❌ Deepgram error:', err);
  });

  ws.on('message', (msg) => {
    const data = JSON.parse(msg);

    if (data.event === 'media') {
      const audio = Buffer.from(data.media.payload, 'base64');
      dgConnection.send(audio);
    }

    if (data.event === 'stop') {
      console.log('⛔ Stream stopped');
      dgConnection.finish();
    }
  });

  ws.on('close', () => {
    console.log('🔒 WebSocket closed');
    dgConnection.finish();
  });
});

/* ==========================================================
   5️⃣ Start Server
========================================================== */
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
});
