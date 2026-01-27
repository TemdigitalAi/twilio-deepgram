/**
 * server.js
 * CLEAN REAL ESTATE VOICE AGENT — PRODUCTION READY
 * Twilio IVR → Deepgram STT (WS) → GPT-4o → Deepgram TTS → Twilio <Play>
 * FAST • CLEAN • STABLE • ≤ 2s silence
 *
 * FIXED:
 * ✅ NO hangup after Gather (prevents call drop after key press)
 * ✅ Deepgram STT uses nova-2 (stable live WS)
 * ✅ Short end-of-utterance timing for low silence
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
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
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
  LOCAL_TEST,
} = process.env;

if (
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !DEEPGRAM_API_KEY ||
  !OPENAI_API_KEY ||
  !RENDER_EXTERNAL_URL
) {
  throw new Error("❌ Missing required environment variables");
}

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
   AUDIO FILES (AUTO-CLEAN)
========================= */
const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);
app.use("/audio", express.static(AUDIO_DIR));

function autoDelete(filePath) {
  setTimeout(() => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }, 60_000);
}

/* =========================
   TIMING (OPTIMIZED)
========================= */
const MIN_CHARS = 3;
const MAX_HISTORY = 8; // 4 échanges max
const UTTERANCE_END_MS = 450;
const ENDPOINTING_MS = 180;
const SAFETY_TIMEOUT = 700;

/* =========================
   HELPERS
========================= */
function baseUrl() {
  return RENDER_EXTERNAL_URL.startsWith("http")
    ? RENDER_EXTERNAL_URL
    : `https://${RENDER_EXTERNAL_URL}`;
}

function wsUrl() {
  return LOCAL_TEST === "true"
    ? "ws://localhost:10000/ws"
    : `wss://${new URL(baseUrl()).host}/ws`;
}

/* =========================
   ROUTES
========================= */
app.get("/", (_, res) => res.send("✅ Voice Agent Ready"));
app.get("/health", (_, res) => res.json({ ok: true }));

/* =========================
   TWILIO IVR
========================= */
app.post("/voice", (req, res) => {
  console.log("\n📞 INCOMING CALL:", req.body.CallSid);

  const vr = new VoiceResponse();

  const gather = vr.gather({
    numDigits: 1,
    action: "/start",
    method: "POST",
    timeout: 8,
  });

  gather.say(
    { voice: "alice" },
    "Hello, this is Ava from Prestige Real Estate. Press any key to begin."
  );

  // ✅ IMPORTANT: NO hangup here (prevents drop after key press)
  res.type("text/xml").send(vr.toString());
});

app.post("/start", (req, res) => {
  console.log("✅ KEY PRESSED:", req.body.Digits, "CallSid:", req.body.CallSid);

  const vr = new VoiceResponse();

  vr.say({ voice: "alice" }, "Great. How can I help you today?");
  vr.start().stream({ url: wsUrl() });

  // Keep call open (Twilio will continue streaming)
  vr.pause({ length: 60 });

  res.type("text/xml").send(vr.toString());
});

/* =========================
   GPT (FAST & SHORT)
========================= */
async function askGPT(history, memory) {
  const system = {
    role: "system",
    content: `
You are Ava, a real estate phone assistant.
Only BUY or SELL.
English only.
Max 1 short sentence + 1 question.

Memory:
intent=${memory.intent || "unknown"}
budget=${memory.budget || "unknown"}
location=${memory.location || "unknown"}

If rentals → politely redirect.
Never mention AI.
`,
  };

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.4,
    max_tokens: 90,
    messages: [system, ...history],
  });

  return res.choices[0].message.content.trim();
}

/* =========================
   TTS (DEEPGRAM → WAV)
========================= */
async function generateTTS(text, callSid) {
  const filename = `${callSid}-${Date.now()}.wav`;
  const filepath = path.join(AUDIO_DIR, filename);

  const resp = await fetch(
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

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`❌ Deepgram TTS failed: ${resp.status} ${errTxt}`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(filepath, buffer);
  autoDelete(filepath);

  return `${baseUrl()}/audio/${filename}`;
}

/* =========================
   PLAY AUDIO + RESUME STT
========================= */
async function playAndResume(callSid, audioUrl) {
  const vr = new VoiceResponse();

  vr.play(audioUrl);

  // Resume media stream after playback
  vr.start().stream({ url: wsUrl() });
  vr.pause({ length: 60 });

  await twilioClient.calls(callSid).update({ twiml: vr.toString() });
}

/* =========================
   WEBSOCKET CORE
========================= */
wss.on("connection", (ws) => {
  console.log("🔌 NEW MEDIA CONNECTION");

  let callSid = null;
  let buffer = "";
  let safetyTimer = null;
  let busy = false;

  const memory = { intent: null, budget: null, location: null };
  const history = [];

  // ✅ Deepgram STT — STABLE LIVE WS
  const dg = deepgram.listen.live({
    model: "nova-2", // ✅ MUST (stable)
    language: "en-US",
    encoding: "mulaw",
    sample_rate: 8000,
    interim_results: true,
    vad_events: true,
    utterance_end_ms: UTTERANCE_END_MS,
    endpointing: ENDPOINTING_MS,
  });

  dg.on(LiveTranscriptionEvents.Error, (e) => {
    console.error("❌ Deepgram STT error:", e);
  });

  async function handle(text) {
    if (busy || !callSid || text.length < MIN_CHARS) return;

    busy = true;
    try {
      history.push({ role: "user", content: text });
      if (history.length > MAX_HISTORY) history.splice(0, 2);

      const reply = await askGPT(history, memory);
      history.push({ role: "assistant", content: reply });

      const audioUrl = await generateTTS(reply, callSid);
      await playAndResume(callSid, audioUrl);
    } catch (err) {
      console.error("❌ HANDLE ERROR:", err.message);
      // fallback: keep call alive even if something fails
      try {
        await playAndResume(callSid, `${baseUrl()}/audio/fallback.wav`);
      } catch (_) {}
    } finally {
      busy = false;
    }
  }

  dg.on(LiveTranscriptionEvents.Transcript, (data) => {
    const t = data.channel?.alternatives?.[0]?.transcript;
    if (!t) return;

    if (data.is_final) {
      buffer += " " + t;

      clearTimeout(safetyTimer);
      safetyTimer = setTimeout(() => {
        const final = buffer.trim();
        buffer = "";
        handle(final);
      }, SAFETY_TIMEOUT);
    }
  });

  dg.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    clearTimeout(safetyTimer);
    const final = buffer.trim();
    buffer = "";
    handle(final);
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      callSid = data.start.callSid;
      console.log("📞 Call started:", callSid);
    }

    if (data.event === "media") {
      dg.send(Buffer.from(data.media.payload, "base64"));
    }

    if (data.event === "stop") {
      console.log("📞 Call ended:", callSid);
    }
  });

  ws.on("close", () => {
    clearTimeout(safetyTimer);
    dg.finish();
    console.log("🔒 WebSocket closed");
  });

  ws.on("error", (e) => console.error("❌ WS error:", e.message));
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ CLEAN VOICE AGENT — PRODUCTION READY");
  console.log("🌐 Webhook:", `${baseUrl()}/voice`);
  console.log("🔌 WS:", wsUrl());
});