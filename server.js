/**
 * server.js
 * Real Estate Voice Agent - FINAL OPTIMIZED
 * 
 * FIXES:
 * - English greeting from the start
 * - Better Deepgram detection (nova-2 → nova-3)
 * - Improved speech recognition
 * - Fast and responsive
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const OpenAI = require("openai");

/* =========================
   ENV VALIDATION
========================= */
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  DEEPGRAM_API_KEY,
  OPENAI_API_KEY,
  RENDER_EXTERNAL_URL,
  LOCAL_TEST,
} = process.env;

if (!TWILIO_ACCOUNT_SID) throw new Error("❌ Missing TWILIO_ACCOUNT_SID");
if (!TWILIO_AUTH_TOKEN) throw new Error("❌ Missing TWILIO_AUTH_TOKEN");
if (!DEEPGRAM_API_KEY) throw new Error("❌ Missing DEEPGRAM_API_KEY");
if (!OPENAI_API_KEY) throw new Error("❌ Missing OPENAI_API_KEY");
if (!RENDER_EXTERNAL_URL) throw new Error("❌ Missing RENDER_EXTERNAL_URL");

console.log("✅ All environment variables present");

/* =========================
   CLIENTS
========================= */
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
   OPTIMIZED TIMING
========================= */
const MIN_CHARS = 3;
const MAX_HISTORY = 10;
const UTTERANCE_END_MS = 700;       // Balanced (not too fast, not too slow)
const ENDPOINTING_MS = 250;         // Good detection
const SAFETY_TIMEOUT = 1500;        // 1.5s backup

/* =========================
   HELPERS
========================= */
function baseUrl() {
  return RENDER_EXTERNAL_URL.startsWith("http")
    ? RENDER_EXTERNAL_URL
    : `https://${RENDER_EXTERNAL_URL}`;
}

function wsUrl() {
  if (LOCAL_TEST === "true") {
    return "ws://localhost:10000/ws";
  }
  const url = new URL(baseUrl());
  return `wss://${url.host}/ws`;
}

/* =========================
   ROUTES
========================= */
app.get("/", (req, res) => {
  res.send("✅ Real Estate Voice Agent Active");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "voice-agent"
  });
});

/* =========================
   TWILIO WEBHOOK - ENGLISH GREETING
========================= */
app.post("/voice", (req, res) => {
  console.log("\n📞 ════════════════════════════════");
  console.log("📞 NEW INCOMING CALL");
  console.log("📞 ════════════════════════════════");
  console.log("📱 From:", req.body.From);
  console.log("📱 CallSid:", req.body.CallSid);
  console.log("📞 ════════════════════════════════\n");

  const vr = new VoiceResponse();

  // ✅ ENGLISH GREETING FROM START
  vr.say(
    { voice: "Polly.Joanna", language: "en-US" },
    "Hello, this is Ava from Prestige Real Estate. How can I help you today?"
  );

  // Start WebSocket stream
  vr.start().stream({ url: wsUrl() });
  vr.pause({ length: 60 });

  res.type("text/xml").send(vr.toString());
});

/* =========================
   GPT - CONCISE & FAST
========================= */
async function askGPT({ conversationHistory, memory }) {
  try {
    const systemPrompt = {
      role: "system",
      content: `You are Ava, a real estate phone assistant at Prestige Real Estate.

Your role:
- Help people BUY or SELL houses
- You DO NOT handle rentals
- Be concise and guide the conversation

Memory:
- Name: ${memory.name || "unknown"}
- Intent: ${memory.intent || "unknown - ask if BUY or SELL"}
- Budget: ${memory.budget || "unknown"}
- Location: ${memory.location || "unknown"}

Rules:
- Speak in ENGLISH
- Keep responses SHORT (1-2 sentences)
- Ask ONE question at a time
- Be proactive and friendly
- If asked about rentals → redirect to buying/selling
- If caller repeats → acknowledge and move forward
- Never mention being AI

Memory format:
Start with: [MEM: name=John, intent=BUY, budget=500000]
Then your response.

Examples:
User: "Do you have houses to rent?"
You: "I specialize in buying and selling. Are you looking to buy or sell a property?"

User: "I want to buy"
You: [MEM: intent=BUY] "Great! What area are you interested in?"

User: "Around $400k in Miami"
You: [MEM: budget=400000, location=Miami] "Perfect! When are you looking to buy?"

Be natural, brief, and action-oriented.`
    };

    const messages = [systemPrompt, ...conversationHistory];

    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.6,
      max_tokens: 100,
      stream: true,
      messages: messages,
    });

    let fullResponse = "";
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      fullResponse += content;
    }

    return fullResponse.trim();

  } catch (e) {
    console.error("❌ GPT error:", e.message);
    return "Sorry, could you repeat that please?";
  }
}

/* =========================
   PARSE MEMORY
========================= */
function parseMemoryUpdate(response, memory) {
  const memMatch = response.match(/\[MEM:\s*([^\]]+)\]/);
  
  if (memMatch) {
    const updates = memMatch[1];
    const cleanResponse = response.replace(/\[MEM:[^\]]+\]\s*/, "").trim();
    
    updates.split(",").forEach(pair => {
      const [key, ...valueParts] = pair.split("=");
      const value = valueParts.join("=").trim();
      const cleanKey = key.trim();
      
      if (memory.hasOwnProperty(cleanKey) && value && value !== "null") {
        memory[cleanKey] = value;
        console.log(`   📝 Memory: ${cleanKey} = ${value}`);
      }
    });
    
    return cleanResponse;
  }
  
  return response;
}

/* =========================
   WEBSOCKET
========================= */
wss.on("connection", (ws) => {
  console.log("\n🔌 ════════════════════════════════");
  console.log("🔌 NEW MEDIA CONNECTION");
  console.log("🔌 ════════════════════════════════");

  let utteranceBuffer = "";
  let isProcessing = false;
  let isSpeaking = false;
  let safetyTimer = null;
  let callSid = null;
  let lastUserText = "";

  const memory = {
    name: null,
    intent: null,
    budget: null,
    location: null,
  };

  const conversationHistory = [];

  /* =========
     HANDLE USER SPEECH
  ========= */
  async function handleUserUtterance(text) {
    if (text.length < MIN_CHARS) {
      console.log(`   ⚠️ Too short: ${text.length} chars`);
      return;
    }
    
    if (isProcessing) {
      console.log("   ⏳ Already processing");
      return;
    }

    // Anti-repetition
    if (text === lastUserText) {
      console.log("   🔁 Repeated - moving forward");
    }
    lastUserText = text;

    isProcessing = true;
    console.log(`\n👤 USER: "${text}"`);

    try {
      conversationHistory.push({
        role: "user",
        content: text
      });

      const rawResponse = await askGPT({
        conversationHistory,
        memory
      });

      const cleanResponse = parseMemoryUpdate(rawResponse, memory);

      conversationHistory.push({
        role: "assistant",
        content: cleanResponse
      });

      if (conversationHistory.length > MAX_HISTORY) {
        conversationHistory.splice(0, 2);
      }

      console.log(`🤖 AVA: "${cleanResponse}"`);
      console.log(`🧠 Memory:`, JSON.stringify(memory, null, 2));

      // TODO: Send to TTS
      // await sendToTTS(cleanResponse, ws);

    } catch (error) {
      console.error("❌ Error:", error.message);
    } finally {
      isProcessing = false;
    }
  }

  /* =========
     DEEPGRAM - IMPROVED DETECTION
  ========= */
  const dg = deepgram.listen.live({
    model: "nova-3",  // ✅ Better model (was nova-2)
    language: "en-US",  // ✅ English primary (was "multi")
    encoding: "mulaw",
    sample_rate: 8000,
    smart_format: true,
    interim_results: true,
    utterance_end_ms: UTTERANCE_END_MS,
    vad_events: true,
    endpointing: ENDPOINTING_MS,
    punctuate: true,  // ✅ Better transcription
    diarize: false,
  });

  console.log("🎤 Deepgram connected (nova-3, en-US)");

  /* =========
     DEEPGRAM EVENTS
  ========= */

  dg.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript || "";
    if (!transcript) return;

    // Show interim
    if (!data.is_final && transcript.length > 0) {
      process.stdout.write(`\r   🎤 [interim] ${transcript}                    `);
    }

    // Accumulate final
    if (data.is_final) {
      utteranceBuffer += " " + transcript;
      console.log(`\r   ✅ [final] ${transcript}`);
      
      clearTimeout(safetyTimer);
      safetyTimer = setTimeout(() => {
        const trimmed = utteranceBuffer.trim();
        if (trimmed) {
          console.log("   ⏰ Safety timeout");
          handleUserUtterance(trimmed);
          utteranceBuffer = "";
        }
      }, SAFETY_TIMEOUT);
    }
  });

  dg.on(LiveTranscriptionEvents.UtteranceEnd, (data) => {
    clearTimeout(safetyTimer);
    
    const finalText = utteranceBuffer.trim();
    utteranceBuffer = "";

    if (finalText) {
      console.log("   ✅ UtteranceEnd detected");
      handleUserUtterance(finalText);
    }
  });

  dg.on(LiveTranscriptionEvents.SpeechStarted, () => {
    console.log("   🎤 Speech started");
    
    if (isSpeaking) {
      console.log("   ⚠️ Interrupted");
      isSpeaking = false;
      // TODO: Stop TTS
    }
  });

  dg.on(LiveTranscriptionEvents.Error, (error) => {
    console.error("❌ Deepgram error:", error);
  });

  dg.on(LiveTranscriptionEvents.Close, () => {
    console.log("🔒 Deepgram closed");
  });

  /* =========
     TWILIO WEBSOCKET
  ========= */
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.event === "media") {
        dg.send(Buffer.from(data.media.payload, "base64"));
      }

      if (data.event === "start") {
        callSid = data.start.callSid;
        console.log(`📞 Call started: ${callSid}`);
      }

      if (data.event === "stop") {
        console.log("\n📞 ════════════════════════════════");
        console.log("📞 CALL ENDED");
        console.log(`📡 CallSid: ${callSid}`);
        console.log(`⏱️  Exchanges: ${conversationHistory.length / 2}`);
        console.log("📊 SUMMARY:");
        console.log(JSON.stringify(memory, null, 2));
        console.log("📞 ════════════════════════════════\n");
      }

    } catch (e) {
      console.error("❌ WebSocket error:", e.message);
    }
  });

  ws.on("close", () => {
    clearTimeout(safetyTimer);
    dg.finish();
    console.log("🔒 WebSocket closed");
  });

  ws.on("error", (error) => {
    console.error("❌ WebSocket error:", error.message);
  });
});

/* =========================
   ERROR HANDLING
========================= */
process.on("uncaughtException", (error) => {
  console.error("💥 Uncaught exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 Unhandled rejection:", reason);
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("\n🚀 ════════════════════════════════");
  console.log("🚀 VOICE AGENT STARTED");
  console.log("🚀 ════════════════════════════════");
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 URL: ${baseUrl()}`);
  console.log(`🔌 WebSocket: ${wsUrl()}`);
  console.log(`📞 Webhook: ${baseUrl()}/voice`);
  console.log("🚀 ════════════════════════════════");
  console.log("✅ Ready for calls\n");
});