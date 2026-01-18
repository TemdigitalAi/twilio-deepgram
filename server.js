/**
 * server.js
 * Twilio → Media Stream → Deepgram → GPT → Voice response
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
  res.send('✅ Twilio Deepgram Voice Agent running');
});

/* ==========================================================
   1️⃣ Twilio Webhook — ANSWER CALL (FAST RESPONSE)
========================================================== */
app.post('/twilio-webhook', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const streamUrl = `wss://${process.env.RENDER_EXTERNAL_URL}/ws`;

  response.say(
    'Hello, this is Ava, your virtual assistant. You can start speaking now.'
  );

  response.start().stream({
    url: streamUrl,
    track: 'inbound',
  });

  response.pause({ length: 60 });

  res
    .status(200)
    .type('text/xml')
    .send(response.toString());
});

/* ==========================================================
   2️⃣ WebSocket — Media Stream → Deepgram → GPT → Twilio
========================================================== */
wss.on('connection', (ws) => {
  console.log('🔌 Media stream connected');

  let callSid = null;
  let replied = false;
  let dgReady = false;

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
    dgReady = true;
    console.log('✅ Deepgram connected');
  });

  dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
    if (replied) return;

    const transcript =
      data?.channel?.alternatives?.[0]?.transcript;

    if (!transcript || transcript.length < 3) return;

    replied = true;
    console.log('📝 Transcript:', transcript);

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
      console.log('🤖 GPT reply:', reply);

      if (!callSid) {
        console.error('❌ Missing CallSid, cannot respond');
        return;
      }

      const twiml = `
<Response>
  <Say voice="alice">${reply}</Say>
  <Pause length="60"/>
</Response>
`;

      await twilioClient.calls(callSid).update({ twiml });
      console.log('📞 Voice response sent to Twilio');
    } catch (err) {
      console.error('❌ GPT / Twilio error:', err.message);
    }
  });

  dg.on(LiveTranscriptionEvents.Error, (err) => {
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
      callSid = data.start.callSid;
      console.log('📞 CallSid:', callSid);
    }

    if (data.event === 'media' && dgReady) {
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
   3️⃣ Start Server
========================================================== */
const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
