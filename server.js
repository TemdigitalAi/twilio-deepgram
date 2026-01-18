/**
 * server.js
 * Twilio → Media Stream → Deepgram → GPT → Voice
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const OpenAI = require('openai');

/* =======================
   App & Server
======================= */
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

/* =======================
   Clients
======================= */
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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
   Health check
======================= */
app.get('/', (req, res) => {
  res.send('Twilio Deepgram Server running');
});

/* ==========================================================
   1. Twilio Webhook — MUST RESPOND FAST
========================================================== */
app.post('/twilio-webhook', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  response.say('Hello, this is Ava. Please hold.');

  response.pause({ length: 1 });

  response.redirect(
    { method: 'POST' },
    '/gather-response'
  );

  res
    .status(200)
    .type('text/xml')
    .send(response.toString());
});

/* ==========================================================
   2. Gather → Start Media Stream
========================================================== */
app.post('/gather-response', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const callSid = req.body.CallSid;
  console.log('Starting media stream for CallSid:', callSid);

  const streamUrl = `wss://${process.env.RENDER_EXTERNAL_URL}/ws?callSid=${callSid}`;

  response.start().stream({
    url: streamUrl,
    track: 'inbound',
  });

  response.say('You can start speaking now.');
  response.pause({ length: 60 });

  res
    .status(200)
    .type('text/xml')
    .send(response.toString());
});

/* ==========================================================
   3. WebSocket — Media Stream → Deepgram → GPT → Twilio
========================================================== */
wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.replace('/ws?', ''));
  const callSid = params.get('callSid');

  console.log('WebSocket connected for CallSid:', callSid);

  let replied = false;

  const dg = deepgram.listen.live({
    model: 'nova-3',
    language: 'en-US',
    punctuate: true,
    interim_results: false,
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
  });

  dg.on(LiveTranscriptionEvents.Open, () => {
    console.log('Deepgram connected');
  });

  dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
    if (replied) return;

    const transcript =
      data?.channel?.alternatives?.[0]?.transcript;

    if (!transcript || transcript.length < 3) return;

    replied = true;
    console.log('Transcript:', transcript);

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content:
              'You are Ava, a friendly and professional real estate assistant.',
          },
          { role: 'user', content: transcript },
        ],
        temperature: 0.6,
      });

      const reply = completion.choices[0].message.content.trim();
      console.log('GPT reply:', reply);

      const twiml = `
<Response>
  <Say voice="alice">${reply}</Say>
  <Pause length="60"/>
</Response>
`;

      await twilioClient.calls(callSid).update({ twiml });

      console.log('Twilio response sent');
    } catch (err) {
      console.error('GPT/Twilio error:', err.message);
    }
  });

  dg.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('Deepgram error:', err);
  });

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    if (data.event === 'media') {
      const audio = Buffer.from(
        data.media.payload,
        'base64'
      );
      dg.send(audio);
    }

    if (data.event === 'stop') {
      dg.finish();
    }
  });

  ws.on('close', () => {
    dg.finish();
  });
});

/* ==========================================================
   4. Start Server
========================================================== */
const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
