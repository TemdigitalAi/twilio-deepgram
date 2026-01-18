/**
 * server.js
 * Twilio → Media Stream → Deepgram → GPT → Voice response
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const { twiml } = twilio;
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
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/* =======================
   Globals (simple state)
======================= */
let CURRENT_CALL_SID = null;

/* =======================
   Middlewares
======================= */
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* =======================
   Health check
======================= */
app.get('/', (req, res) => {
  res.send('Twilio Deepgram Server is running');
});

/* ==========================================================
   1. Twilio Webhook — Answer Call
========================================================== */
app.post('/twilio-webhook', (req, res) => {
  console.log('Incoming Twilio call');

  const response = new twiml.VoiceResponse();

  const gather = response.gather({
    input: 'dtmf',
    numDigits: 1,
    timeout: 5,
    action: '/gather-response',
    method: 'POST',
  });

  gather.say(
    'Hi, this is Ava, your virtual assistant. Press any key to start speaking.'
  );

  res.type('text/xml').send(response.toString());
});

/* ==========================================================
   2. Start Media Stream
========================================================== */
app.post('/gather-response', (req, res) => {
  CURRENT_CALL_SID = req.body.CallSid;
  console.log('Key pressed, starting media stream');
  console.log('CallSid:', CURRENT_CALL_SID);

  const response = new twiml.VoiceResponse();
  const streamUrl = `wss://${process.env.RENDER_EXTERNAL_URL}/ws`;

  response.start().stream({
    url: streamUrl,
    track: 'inbound',
  });

  response.say('You can start speaking now.');
  response.pause({ length: 60 });

  res.type('text/xml').send(response.toString());
});

/* ==========================================================
   3. WebSocket — Media Stream → Deepgram → GPT
========================================================== */
wss.on('connection', (ws) => {
  console.log('Media stream connected');

  let hasReplied = false;

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
    console.log('Deepgram connected');
    dgReady = true;

    while (audioQueue.length > 0) {
      dgConnection.send(audioQueue.shift());
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const transcript =
      data.channel?.alternatives?.[0]?.transcript;

    if (!transcript || transcript.length < 4) return;
    if (hasReplied) return;

    hasReplied = true;
    console.log('Transcript:', transcript);

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content:
              'You are Ava, a professional and friendly real estate assistant.',
          },
          { role: 'user', content: transcript },
        ],
        temperature: 0.6,
      });

      const reply = completion.choices[0].message.content.trim();
      console.log('GPT reply:', reply);

      if (!CURRENT_CALL_SID) {
        console.error('No CallSid available');
        return;
      }

      const twimlResponse = `
<Response>
  <Say voice="alice">${reply}</Say>
  <Pause length="60"/>
</Response>
`;

      await twilioClient.calls(CURRENT_CALL_SID).update({
        twiml: twimlResponse,
      });

      console.log('Response sent to Twilio');
    } catch (err) {
      console.error('GPT or Twilio error:', err.message);
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
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
      const audio = Buffer.from(data.media.payload, 'base64');

      if (dgReady) dgConnection.send(audio);
      else audioQueue.push(audio);
    }

    if (data.event === 'stop') {
      dgConnection.finish();
    }
  });

  ws.on('close', () => {
    dgConnection.finish();
  });
});

/* ==========================================================
   4. Start Server
========================================================== */
const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
