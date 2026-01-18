/**
 * server.js
 * Twilio (Call) → Media Stream (WS) → Deepgram (STT)
 * → GPT → Twilio <Say> → loop
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const OpenAI = require("openai");

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

if (!TWILIO_ACCOUNT_SID) throw new Error("Missing TWILIO_ACCOUNT_SID");
if (!TWILIO_AUTH_TOKEN) throw new Error("Missing TWILIO_AUTH_TOKEN");
if (!TWILIO_PHONE_NUMBER) throw new Error("Missing TWILIO_PHONE_NUMBER");
if (!DEEPGRAM_API_KEY) throw new Error("Missing DEEPGRAM_API_KEY");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!RENDER_EXTERNAL_URL) throw new Error("Missing RENDER_EXTERNAL_URL");

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
const wss = new WebSocket.Server({ server, path: "/ws" });
const { VoiceResponse } = twilio.twiml;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* =========================
   HELPERS
========================= */
function baseUrl() {
  return RENDER_EXTERNAL_URL.startsWith("http")
    ? RENDER_EXTERNAL_URL
    : `https://${RENDER_EXTERNAL_URL}`;
}

function wsUrl() {
  if (LOCAL_TEST === "true") return "ws://localhost:10000/ws";
  return `wss://${new URL(baseUrl()).host}/ws`;
}

/* =========================
   HEALTH
========================= */
app.get("/", (_, res) => {
  res.send("✅ Voice agent running");
});

/* =========================
   ENTRY CALL
========================= */
app.post("/voice", (req, res) => {
  const vr = new VoiceResponse();

  vr.say(
    { voice: "alice" },
    "Hello, this is Ava. Please speak after the beep."
  );

  vr.start().stream({ url: wsUrl() });
  vr.pause({ length: 600 });

  res.type("text/xml").send(vr.toString());
});

/* =========================
   GPT
========================= */
async function askGPT(text) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content:
          "You are Ava, a professional phone assistant. Detect language and reply briefly.",
      },
      { role: "user", content: text },
    ],
  });

  return completion.choices[0].message.content.trim();
}

/* =========================
   MEDIA STREAM
========================= */
wss.on("connection", (ws) => {
  console.log("🔌 Media stream connected");

  let callSid = null;
  let buffer = "";
  let silenceTimer = null;
  let speaking = false;

  const SILENCE_MS = 1500;
  const MIN_CHARS = 3;

  function resetSilence(cb) {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(cb, SILENCE_MS);
  }

  async function speak(text) {
    if (!callSid || speaking) return;
    speaking = true;

    try {
      const vr = new VoiceResponse();
      vr.say({ voice: "alice" }, text);

      await twilioClient.calls(callSid).update({
        twiml: vr.toString(),
      });
    } catch (err) {
      console.error("❌ Twilio say error:", err.message);
    } finally {
      setTimeout(() => (speaking = false), 1200);
    }
  }

  const dg = deepgram.listen.live({
    model: "nova-3",
    language: "multi",
    encoding: "mulaw",
    sample_rate: 8000,
    interim_results: true,
    vad_events: true,
  });

  dg.on(LiveTranscriptionEvents.Transcript, (data) => {
    if (!data.is_final) return;

    const text = data.channel.alternatives[0].transcript;
    if (!text) return;

    buffer += " " + text;

    resetSilence(async () => {
      const finalText = buffer.trim();
      buffer = "";

      if (finalText.length < MIN_CHARS) return;

      console.log("🧠 User:", finalText);
      const reply = await askGPT(finalText);
      console.log("🤖 Ava:", reply);

      await speak(reply);
    });
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      callSid = data.start.callSid;
      console.log("📞 Call SID:", callSid);
    }

    if (data.event === "media") {
      dg.send(Buffer.from(data.media.payload, "base64"));
    }
  });

  ws.on("close", () => {
    dg.finish();
    console.log("🔒 WS closed");
  });
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server listening on ${PORT}`);
});
