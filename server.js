/**
 * server.js - PRO VERSION: POWERFUL & HUMAN-LIKE
 * Features: Barge-in support, Inactivity detection, Ultra-concise responses.
 */

require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const OpenAI = require("openai");

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  DEEPGRAM_API_KEY,
  OPENAI_API_KEY,
  RENDER_EXTERNAL_URL,
} = process.env;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);
app.use("/audio", express.static(AUDIO_DIR));

function baseUrl() {
  return RENDER_EXTERNAL_URL.startsWith("http") ? RENDER_EXTERNAL_URL : `https://${RENDER_EXTERNAL_URL}`;
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
   GPT LOGIC (POWERFUL & CONCISE)
========================= */
const conversationHistory = new Map();
const lastActivity = new Map(); // For silence detection

async function askGPT(text, callSid) {
  if (!conversationHistory.has(callSid)) {
    conversationHistory.set(callSid, [
      {
        role: "system",
        content: "You are Ava, a high-performance real estate assistant. \n\nRULES:\n1. Be extremely concise: 15 words MAX per response.\n2. Be precise and impactful. No fluff.\n3. If interrupted, acknowledge the new input immediately.\n4. Language: English only."
      }
    ]);
  }

  const history = conversationHistory.get(callSid);
  history.push({ role: "user", content: text });

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5,
    max_tokens: 40,
    messages: history,
  });

  const reply = r.choices[0].message.content.trim();
  history.push({ role: "assistant", content: reply });
  return reply;
}

/* =========================
   DEEPGRAM TTS
========================= */
async function deepgramTTS(text, callSid) {
  const file = `${callSid}-${Date.now()}.wav`;
  const filePath = path.join(AUDIO_DIR, file);

  const r = await fetch(
    "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=wav",
    {
      method: "POST",
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }
  );

  if (!r.ok) throw new Error(`TTS Failed: ${r.status}`);
  fs.writeFileSync(filePath, Buffer.from(await r.arrayBuffer()));
  return `${baseUrl()}/audio/${file}`;
}

/* =========================
   WEBSOCKET STREAMING
========================= */
wss.on("connection", (ws) => {
  let callSid = null;
  let deepgramWs = null;
  let isProcessing = false;
  let silenceTimer = null;

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(async () => {
      if (callSid && !isProcessing) {
        console.log("⏰ Silence detected, re-engaging...");
        try {
          const audioUrl = await deepgramTTS("Are you still there? I'm here if you have any questions.", callSid);
          const vr = new twilio.twiml.VoiceResponse();
          vr.play(audioUrl);
          const connect = vr.connect();
          connect.stream({ url: `${baseUrl().replace("https", "wss")}/ws` });
          vr.pause({ length: 3600 });
          await twilioClient.calls(callSid).update({ twiml: vr.toString() });
        } catch (e) { console.error("Silence handler error", e.message); }
      }
    }, 12000); // 12 seconds of silence
  }

  function connectDeepgram() {
    const dgUrl = "wss://api.deepgram.com/v1/listen?model=nova-2&encoding=mulaw&sample_rate=8000&language=en-US&punctuate=true&interim_results=true&endpointing=250";
    deepgramWs = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });

    deepgramWs.on("message", async (data) => {
      try {
        const result = JSON.parse(data);
        if (result.type === "Results") {
          const transcript = result.channel.alternatives[0].transcript.trim();
          
          if (transcript.length > 0) resetSilenceTimer();

          if (result.speech_final && transcript.length > 1 && !isProcessing) {
            isProcessing = true;
            console.log("🎤 USER:", transcript);

            try {
              const reply = await askGPT(transcript, callSid);
              console.log("🤖 AGENT:", reply);

              const audioUrl = await deepgramTTS(reply, callSid);

              const vr = new twilio.twiml.VoiceResponse();
              // BARGE-IN: If the user speaks during this play, Twilio will stop it
              vr.play(audioUrl);
              const connect = vr.connect();
              connect.stream({ url: `${baseUrl().replace("https", "wss")}/ws` });
              vr.pause({ length: 3600 });

              await twilioClient.calls(callSid).update({ twiml: vr.toString() });
            } catch (err) {
              console.error("Error:", err.message);
            } finally {
              isProcessing = false;
            }
          }
        }
      } catch (err) { console.error("DG Error:", err.message); }
    });
  }

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
      console.log("📞 Call Ended");
      conversationHistory.delete(callSid);
      deepgramWs?.close();
    }
  });

  ws.on("close", () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    deepgramWs?.close();
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ POWERFUL AGENT ONLINE ON PORT ${PORT}`);
});
