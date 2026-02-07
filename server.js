/**
 * server.js - PRO VERSION: POWERFUL & HUMAN-LIKE
 * Architecture clean & modulaire
 * - server.js = orchestration (Twilio, WebSocket, flow)
 * - services/deepgram.service.js = STT Deepgram
 * - services/googleTts.service.js = Google TTS
 * - services/tts.service.js = Router TTS (Google → fallback)
 */

require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

/* =========================
   IMPORT SERVICES
========================= */
const { createDeepgramSTT } = require("./services/deepgram.service");
const { speak } = require("./services/tts.service");

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

/* =========================
   APP INIT
========================= */
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* =========================
   AUDIO FILES
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
   TWILIO WEBHOOKS
========================= */
app.post("/voice", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  const gather = vr.gather({ numDigits: 1, action: "/start", method: "POST" });
  gather.say({ voice: "en-US-Standard-C" }, "Hey! Press any key to start.");
  res.type("text/xml").send(vr.toString());
});

app.post("/start", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  const connect = vr.connect();
  connect.stream({ url: `${baseUrl().replace("https", "wss")}/ws` });
  vr.pause({ length: 3600 });
  res.type("text/xml").send(vr.toString());
});

/* =========================
   GPT LOGIC
========================= */
const conversationHistory = new Map();

async function askGPT(text, callSid) {
  if (!conversationHistory.has(callSid)) {
    conversationHistory.set(callSid, [
      {
        role: "system",
        content:
          "You are Ava, a high-performance real estate assistant.\n\n" +
          "RULES:\n" +
          "1. Be extremely concise.\n" +
          "2. Natural, interruptible answers.\n" +
          "3. No fluff.\n" +
          "4. English only.",
      },
    ]);
  }

  const history = conversationHistory.get(callSid);
  history.push({ role: "user", content: text });

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5,
    max_tokens: 35,
    messages: history,
  });

  const reply = r.choices[0].message.content.trim();
  history.push({ role: "assistant", content: reply });
  return reply;
}

/* =========================
   WEBSOCKET STREAMING
========================= */
wss.on("connection", (ws) => {
  let callSid = null;
  let deepgramWs = null;
  let isProcessing = false;
  let silenceTimer = null;

  /* ---------- SILENCE HANDLER ---------- */
  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(async () => {
      if (!callSid || isProcessing) return;

      try {
        const audioUrl = await speak(
          "Are you still there? I'm here if you have any questions.",
          {
            audioDir: AUDIO_DIR,
            callSid,
            baseUrl: baseUrl(),
          }
        );

        const vr = new twilio.twiml.VoiceResponse();
        vr.play(audioUrl);
        const connect = vr.connect();
        connect.stream({ url: `${baseUrl().replace("https", "wss")}/ws` });
        vr.pause({ length: 3600 });

        await twilioClient.calls(callSid).update({ twiml: vr.toString() });
      } catch (e) {
        console.error("Silence handler error:", e.message);
      }
    }, 10000);
  }

  /* ---------- CONNECT DEEPGRAM (STT) ---------- */
  function connectDeepgram() {
    deepgramWs = createDeepgramSTT(DEEPGRAM_API_KEY, async (transcript, isFinal) => {
      if (!transcript) return;

      resetSilenceTimer();

      if (!isFinal || transcript.length < 2 || isProcessing) return;

      isProcessing = true;
      console.log("🎤 USER:", transcript);

      try {
        const reply = await askGPT(transcript, callSid);
        console.log("🤖 AGENT:", reply);

        const audioUrl = await speak(reply, {
          audioDir: AUDIO_DIR,
          callSid,
          baseUrl: baseUrl(),
        });

        const vr = new twilio.twiml.VoiceResponse();
        vr.play(audioUrl);
        const connect = vr.connect();
        connect.stream({ url: `${baseUrl().replace("https", "wss")}/ws` });
        vr.pause({ length: 3600 });

        await twilioClient.calls(callSid).update({ twiml: vr.toString() });
      } catch (err) {
        console.error("Agent error:", err.message);
      } finally {
        isProcessing = false;
      }
    });
  }

  /* ---------- TWILIO EVENTS ---------- */
  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      callSid = data.start.callSid;
      console.log("📞 Call Connected:", callSid);
      connectDeepgram();
      resetSilenceTimer();
    }

    if (data.event === "media" && deepgramWs?.readyState === WebSocket.OPEN) {
      deepgramWs.send(Buffer.from(data.media.payload, "base64"));
    }

    if (data.event === "stop") {
      if (silenceTimer) clearTimeout(silenceTimer);
      conversationHistory.delete(callSid);
      deepgramWs?.close();
      console.log("📞 Call Ended");
    }
  });

  ws.on("close", () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    deepgramWs?.close();
  });
});

/* =========================
   SERVER START
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ POWERFUL AGENT ONLINE ON PORT ${PORT}`);
});
