/**
 * server.js
 * STABLE VOICE AGENT — RENDER SAFE
 * Twilio Media Stream → Deepgram HTTP STT → GPT → Deepgram TTS → Twilio Play
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const OpenAI = require("openai");

/* =========================
   ENV
========================= */
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  DEEPGRAM_API_KEY,
  OPENAI_API_KEY,
  RENDER_EXTERNAL_URL,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !DEEPGRAM_API_KEY || !OPENAI_API_KEY || !RENDER_EXTERNAL_URL) {
  throw new Error("❌ Missing env vars");
}

/* =========================
   CLIENTS
========================= */
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* =========================
   AUDIO DIR
========================= */
const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);
app.use("/audio", express.static(AUDIO_DIR));

function baseUrl() {
  return RENDER_EXTERNAL_URL.startsWith("http")
    ? RENDER_EXTERNAL_URL
    : `https://${RENDER_EXTERNAL_URL}`;
}

/* =========================
   TWILIO WEBHOOK
========================= */
app.post("/voice", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  const gather = vr.gather({
    numDigits: 1,
    action: "/start",
    method: "POST",
  });

  gather.say({ voice: "alice" }, "Hello. Press any key to start.");

  res.type("text/xml").send(vr.toString());
});

app.post("/start", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  vr.say({ voice: "alice" }, "How can I help you today?");
  vr.start().stream({ url: `${baseUrl().replace("https", "wss")}/ws` });
  vr.pause({ length: 60 });

  res.type("text/xml").send(vr.toString());
});

/* =========================
   GPT
========================= */
async function askGPT(text) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.4,
    max_tokens: 80,
    messages: [
      {
        role: "system",
        content: "You are a real estate assistant. Ask short questions.",
      },
      { role: "user", content: text },
    ],
  });
  return r.choices[0].message.content.trim();
}

/* =========================
   DEEPGRAM HTTP STT
========================= */
async function deepgramSTT(audioBuffer) {
  const r = await fetch(
    "https://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&language=en-US",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": "audio/mulaw",
      },
      body: audioBuffer,
    }
  );

  const j = await r.json();
  return j.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
}

/* =========================
   DEEPGRAM TTS
========================= */
async function deepgramTTS(text, callSid) {
  const file = `${callSid}-${Date.now()}.wav`;
  const filePath = path.join(AUDIO_DIR, file);

  const r = await fetch(
    "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=16000",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    }
  );

  fs.writeFileSync(filePath, Buffer.from(await r.arrayBuffer()));
  return `${baseUrl()}/audio/${file}`;
}

/* =========================
   WS MEDIA STREAM
========================= */
wss.on("connection", (ws) => {
  let callSid = null;
  let audioChunks = [];

  ws.on("message", async (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      callSid = data.start.callSid;
      console.log("📞 Call started:", callSid);
    }

    if (data.event === "media") {
      audioChunks.push(Buffer.from(data.media.payload, "base64"));
    }

    if (data.event === "stop") {
      console.log("📞 Call ended");

      const audioBuffer = Buffer.concat(audioChunks);
      audioChunks = [];

      const transcript = await deepgramSTT(audioBuffer);
      console.log("🧠 USER:", transcript);

      if (!transcript) return;

      const reply = await askGPT(transcript);
      console.log("🤖 AVA:", reply);

      const audioUrl = await deepgramTTS(reply, callSid);

      const vr = new twilio.twiml.VoiceResponse();
      vr.play(audioUrl);

      await twilioClient.calls(callSid).update({ twiml: vr.toString() });
    }
  });
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ SERVER READY");
  console.log("🌐 /voice =", `${baseUrl()}/voice`);
});