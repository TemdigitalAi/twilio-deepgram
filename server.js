/**
 * server.js - THE ULTIMATE NATURAL VOICE AGENT
 * Optimized for human-like speed and fluid English conversation.
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
  gather.say({ voice: "en-US-Standard-C" }, "Hey there! Press any key to start our conversation.");
  res.type("text/xml").send(vr.toString());
});

app.post("/start", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  // Immediate transition to streaming
  const connect = vr.connect();
  connect.stream({ url: `${baseUrl().replace("https", "wss")}/ws` });
  vr.pause({ length: 3600 }); // Keep the line open for 1 hour
  res.type("text/xml").send(vr.toString());
});

/* =========================
   GPT LOGIC (HUMAN STYLE)
========================= */
const conversationHistory = new Map();

async function askGPT(text, callSid) {
  if (!conversationHistory.has(callSid)) {
    conversationHistory.set(callSid, [
      {
        role: "system",
        content: "You are a professional and warm real estate assistant named Ava. Your goal is to have a natural, fluid conversation. \n\nGUIDELINES:\n1. Speak like a real human: use varied sentence structures and show genuine interest in the caller's needs.\n2. Avoid being repetitive: don't start every sentence with the same fillers. Use a diverse range of natural responses.\n3. Be concise but complete: provide helpful information in 1-3 clear sentences. Avoid being overly brief or robotic.\n4. Stay engaged: acknowledge what the user said specifically before moving to the next point or asking a follow-up question.\n5. Tone: Helpful, knowledgeable, and empathetic.\n6. Language: Strictly English."
      }
    ]);
  }

  const history = conversationHistory.get(callSid);
  history.push({ role: "user", content: text });

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7, // Balanced for consistency and natural feel
    max_tokens: 100, // Increased to allow for complete, natural sentences
    messages: history,
  });

  const reply = r.choices[0].message.content.trim();
  history.push({ role: "assistant", content: reply });
  return reply;
}

/* =========================
   DEEPGRAM TTS (AURA ENGINE)
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

  function connectDeepgram() {
    // Changement vers le modèle 'nova-2' standard pour éviter l'erreur 403
    const dgUrl = "wss://api.deepgram.com/v1/listen?model=nova-2&encoding=mulaw&sample_rate=8000&language=en-US&punctuate=true&interim_results=true&endpointing=250&smart_format=true";
    
    console.log("🔗 Connecting to Deepgram...");
    deepgramWs = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });

    deepgramWs.on("open", () => {
      console.log("✅ Deepgram Connection Open");
    });

    deepgramWs.on("error", (err) => {
      console.error("❌ Deepgram WebSocket Error:", err.message);
      // Ne pas faire planter le serveur
    });

    deepgramWs.on("message", async (data) => {
      try {
        const result = JSON.parse(data);
        if (result.type === "Results") {
          const transcript = result.channel.alternatives[0].transcript.trim();
          
          if (result.speech_final && transcript.length > 1 && !isProcessing) {
            isProcessing = true;
            console.log("🎤 USER:", transcript);

            try {
              const reply = await askGPT(transcript, callSid);
              console.log("🤖 AGENT:", reply);

              const audioUrl = await deepgramTTS(reply, callSid);

              // Update the call with the new response WITHOUT breaking the stream
              const vr = new twilio.twiml.VoiceResponse();
              vr.play(audioUrl);
              const connect = vr.connect();
              connect.stream({ url: `${baseUrl().replace("https", "wss")}/ws` });
              vr.pause({ length: 3600 });

              await twilioClient.calls(callSid).update({ twiml: vr.toString() });

            } catch (err) {
              console.error("Processing Error:", err.message);
            } finally {
              isProcessing = false;
            }
          }
        }
      } catch (err) {
        console.error("Deepgram Error:", err.message);
      }
    });
  }

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.event === "start") {
      callSid = data.start.callSid;
      console.log("📞 Call Connected:", callSid);
      connectDeepgram();
    }
    if (data.event === "media" && deepgramWs?.readyState === WebSocket.OPEN) {
      deepgramWs.send(Buffer.from(data.media.payload, "base64"));
    }
    if (data.event === "stop") {
      console.log("📞 Call Ended");
      conversationHistory.delete(callSid);
      deepgramWs?.close();
    }
  });

  ws.on("close", () => deepgramWs?.close());
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ AGENT ONLINE ON PORT ${PORT}`);
});
