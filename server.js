/**
 * server.js
 * VOICE AGENT EN TEMPS RÉEL — TWILIO + DEEPGRAM + GPT
 * Gère la conversation fluide avec détection de silence
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
   CONFIGURATION
========================= */
const SILENCE_THRESHOLD = 0.01; // Seuil de détection de silence
const SILENCE_DURATION = 1500; // ms avant de considérer que l'utilisateur a fini de parler
const MIN_SPEECH_DURATION = 500; // ms minimum pour considérer que c'est de la parole

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
    timeout: 10,
  });

  gather.say({ voice: "alice", language: "en-US" }, "Hello. Press any key to start your conversation.");

  res.type("text/xml").send(vr.toString());
});

app.post("/start", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  vr.say({ voice: "alice", language: "en-US" }, "How can I help you today?");
  vr.start().stream({ url: `${baseUrl().replace("https", "wss")}/ws` });
  vr.pause({ length: 3600 }); // Pause longue pour maintenir la connexion

  res.type("text/xml").send(vr.toString());
});

/* =========================
   GPT
========================= */
async function askGPT(text, conversationHistory = []) {
  const messages = [
    {
      role: "system",
      content: "You are a helpful real estate assistant. Keep responses concise and natural. Ask follow-up questions when appropriate."
    },
    ...conversationHistory,
    { role: "user", content: text }
  ];

  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.7,
    max_tokens: 150,
    messages: messages,
  });
  
  return r.choices[0].message.content.trim();
}

/* =========================
   DEEPGRAM HTTP STT
========================= */
async function deepgramSTT(audioBuffer) {
  try {
    const r = await fetch(
      "https://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&language=en-US&model=nova-2",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`,
          "Content-Type": "audio/mulaw",
        },
        body: audioBuffer,
      }
    );

    if (!r.ok) {
      console.error("Deepgram STT error:", await r.text());
      return "";
    }

    const j = await r.json();
    return j.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  } catch (error) {
    console.error("Deepgram STT exception:", error);
    return "";
  }
}

/* =========================
   DEEPGRAM TTS
========================= */
async function deepgramTTS(text, callSid) {
  try {
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

    if (!r.ok) {
      console.error("Deepgram TTS error:", await r.text());
      return null;
    }

    fs.writeFileSync(filePath, Buffer.from(await r.arrayBuffer()));
    return `${baseUrl()}/audio/${file}`;
  } catch (error) {
    console.error("Deepgram TTS exception:", error);
    return null;
  }
}

/* =========================
   ANALYSE AUDIO POUR SILENCE
========================= */
function detectSilence(audioBuffer) {
  try {
    // Convertir le buffer μ-law en PCM pour analyse
    const pcmData = mulawToPcm(audioBuffer);
    
    // Calculer l'énergie moyenne
    let sum = 0;
    for (let i = 0; i < pcmData.length; i++) {
      sum += Math.abs(pcmData[i]);
    }
    const avgEnergy = sum / pcmData.length;
    
    return avgEnergy < SILENCE_THRESHOLD;
  } catch (error) {
    console.error("Silence detection error:", error);
    return false;
  }
}

function mulawToPcm(buffer) {
  const pcm = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const mu = buffer[i];
    const sign = (mu & 0x80) ? -1 : 1;
    const magnitude = mu & 0x7F;
    pcm[i] = sign * (Math.exp(magnitude / 16.0) - 1) * 32767 / (Math.exp(7.5) - 1);
  }
  return pcm;
}

/* =========================
   WS MEDIA STREAM - VERSION FONCTIONNELLE
========================= */
wss.on("connection", (ws) => {
  let callSid = null;
  let audioChunks = [];
  let lastSpeechTime = Date.now();
  let isSpeaking = false;
  let conversationHistory = [];
  let processing = false;
  let silenceTimer = null;

  console.log("🔌 WebSocket connected");

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);

      // Gestion de l'événement start
      if (data.event === "start") {
        callSid = data.start.callSid;
        console.log("📞 Call started:", callSid);
        audioChunks = [];
        lastSpeechTime = Date.now();
        isSpeaking = false;
        conversationHistory = [];
        processing = false;
        return;
      }

      // Gestion de l'événement media (audio en temps réel)
      if (data.event === "media" && callSid) {
        const audioBuffer = Buffer.from(data.media.payload, "base64");
        audioChunks.push(audioBuffer);

        // Détecter si l'utilisateur parle ou est silencieux
        const isSilent = detectSilence(audioBuffer);

        if (!isSilent && !isSpeaking) {
          // L'utilisateur commence à parler
          isSpeaking = true;
          console.log("🗣️ User started speaking");
          lastSpeechTime = Date.now();
          
          // Annuler le timer de silence si existant
          if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
        } else if (isSilent && isSpeaking) {
          // L'utilisateur s'est arrêté de parler
          const silenceDuration = Date.now() - lastSpeechTime;
          
          if (silenceDuration > SILENCE_DURATION && !processing) {
            // Vérifier qu'on a assez de parole
            const totalAudioDuration = audioChunks.length * 20; // Twilio envoie 20ms chunks
            
            if (totalAudioDuration > MIN_SPEECH_DURATION) {
              await processUserSpeech();
            } else {
              // Trop court, réinitialiser
              audioChunks = [];
              isSpeaking = false;
            }
          }
        } else if (!isSilent && isSpeaking) {
          // Continuer de parler, mettre à jour le timestamp
          lastSpeechTime = Date.now();
        }
      }

      // Gestion de l'événement stop
      if (data.event === "stop") {
        console.log("📞 Call ended");
        
        // Nettoyer les timers
        if (silenceTimer) clearTimeout(silenceTimer);
        
        // Traiter le dernier audio si nécessaire
        if (audioChunks.length > 0 && !processing) {
          await processUserSpeech();
        }
      }

    } catch (error) {
      console.error("WebSocket message error:", error);
    }
  });

  ws.on("close", () => {
    console.log("🔌 WebSocket disconnected");
    if (silenceTimer) clearTimeout(silenceTimer);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });

  // Fonction pour traiter la parole de l'utilisateur
  async function processUserSpeech() {
    if (processing) return;
    
    processing = true;
    console.log("📝 Processing user speech...");

    try {
      // Concaténer tous les chunks audio
      const audioBuffer = Buffer.concat(audioChunks);
      audioChunks = []; // Réinitialiser pour la prochaine parole
      
      // Transcrire l'audio
      const transcript = await deepgramSTT(audioBuffer);
      
      if (!transcript || transcript.trim().length === 0) {
        console.log("🔇 No speech detected or empty transcript");
        processing = false;
        isSpeaking = false;
        return;
      }

      console.log("🧠 USER:", transcript);
      
      // Ajouter à l'historique
      conversationHistory.push({ role: "user", content: transcript });

      // Obtenir la réponse de GPT
      const reply = await askGPT(transcript, conversationHistory);
      console.log("🤖 AGENT:", reply);
      
      // Ajouter la réponse à l'historique
      conversationHistory.push({ role: "assistant", content: reply });

      // Convertir en audio
      const audioUrl = await deepgramTTS(reply, callSid);
      
      if (!audioUrl) {
        throw new Error("Failed to generate TTS audio");
      }

      // Jouer la réponse via Twilio
      const vr = new twilio.twiml.VoiceResponse();
      vr.play(audioUrl);

      await twilioClient.calls(callSid).update({ twiml: vr.toString() });
      
      console.log("✅ Response played successfully");

    } catch (error) {
      console.error("Processing error:", error);
    } finally {
      processing = false;
      isSpeaking = false;
    }
  }
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ SERVER READY");
  console.log("🌐 Webhook URL:", `${baseUrl()}/voice`);
  console.log("🔌 WebSocket URL:", `${baseUrl().replace('https', 'wss')}/ws`);
  console.log("🏥 Health check:", `${baseUrl()}/health`);
});