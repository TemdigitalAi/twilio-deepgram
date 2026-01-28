/**
 * server.js
 * AGENT VOCAL FONCTIONNEL — Conversation bidirectionnelle fluide
 * Twilio Media Stream → Deepgram WebSocket STT (avec VAD) → GPT → Deepgram TTS → Twilio
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

  gather.say({ voice: "alice", language: "fr-FR" }, "Bonjour. Appuyez sur n'importe quelle touche pour commencer.");

  res.type("text/xml").send(vr.toString());
});

app.post("/start", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  vr.say({ voice: "alice", language: "fr-FR" }, "Comment puis-je vous aider aujourd'hui?");
  vr.start().stream({ url: `${baseUrl().replace("https", "wss")}/ws` });
  vr.pause({ length: 60 });

  res.type("text/xml").send(vr.toString());
});

/* =========================
   GPT — Historique de conversation
========================= */
const conversationHistory = new Map(); // callSid -> messages[]

async function askGPT(text, callSid) {
  // Initialiser l'historique si nécessaire
  if (!conversationHistory.has(callSid)) {
    conversationHistory.set(callSid, [
      {
        role: "system",
        content: "Tu es un assistant immobilier professionnel et amical. Pose des questions courtes et claires. Réponds de manière concise et naturelle."
      }
    ]);
  }

  const history = conversationHistory.get(callSid);
  
  // Ajouter le message de l'utilisateur
  history.push({ role: "user", content: text });

  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.7,
    max_tokens: 100,
    messages: history,
  });

  const reply = r.choices[0].message.content.trim();
  
  // Ajouter la réponse de l'assistant
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
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    }
  );

  if (!r.ok) {
    throw new Error(`Deepgram TTS failed: ${r.status}`);
  }

  fs.writeFileSync(filePath, Buffer.from(await r.arrayBuffer()));
  return `${baseUrl()}/audio/${file}`;
}

/* =========================
   WS MEDIA STREAM avec Deepgram WebSocket STT
========================= */
wss.on("connection", (ws) => {
  console.log("📞 Nouvelle connexion WebSocket");
  
  let callSid = null;
  let deepgramWs = null;
  let isProcessing = false; // Empêcher les réponses multiples simultanées
  let streamSid = null;

  // Connexion à Deepgram WebSocket pour STT en temps réel
  function connectDeepgram() {
    // Simplification de l'URL pour éviter l'erreur 400
    const dgUrl = "wss://api.deepgram.com/v1/listen?model=nova-2&encoding=mulaw&sample_rate=8000&language=fr&punctuate=true&interim_results=false&smart_format=true&endpointing=300";
    
    deepgramWs = new WebSocket(dgUrl, {
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
      },
    });

    deepgramWs.on("open", () => {
      console.log("✅ Deepgram WebSocket connecté");
    });

    deepgramWs.on("message", async (data) => {
      try {
        const result = JSON.parse(data);
        
        // Vérifier si c'est une transcription finale
        if (result.type === "Results") {
          const transcript = result.channel.alternatives[0].transcript.trim();
          const isFinal = result.is_final;
          const speechFinal = result.speech_final;

          if (transcript) {
            console.log(`🎤 Transcription (${isFinal ? 'Finale' : 'Intermédiaire'}):`, transcript);
          }
          
          // On traite quand c'est speech_final (fin de phrase détectée)
          if (speechFinal && transcript.length > 1 && !isProcessing) {
            isProcessing = true;
            console.log("🧠 USER:", transcript);

            try {
              // Obtenir la réponse de GPT
              const reply = await askGPT(transcript, callSid);
              console.log("🤖 AGENT:", reply);

              // Générer l'audio TTS
              const audioUrl = await deepgramTTS(reply, callSid);

              // Envoyer l'audio à Twilio via TwiML
              await twilioClient.calls(callSid).update({
                twiml: `<Response><Play>${audioUrl}</Play></Response>`
              });

            } catch (err) {
              console.error("❌ Erreur lors du traitement:", err.message);
            } finally {
              isProcessing = false;
            }
          }
        }
      } catch (err) {
        console.error("❌ Erreur parsing Deepgram:", err.message);
      }
    });

    deepgramWs.on("error", (err) => {
      console.error("❌ Deepgram WebSocket error:", err.message);
    });

    deepgramWs.on("close", () => {
      console.log("🔌 Deepgram WebSocket fermé");
    });
  }

  // Gérer les messages de Twilio
  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.event === "start") {
        callSid = data.start.callSid;
        streamSid = data.start.streamSid;
        console.log("📞 Appel démarré:", callSid);
        
        // Connecter à Deepgram
        connectDeepgram();
      }

      if (data.event === "media" && deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        // Transférer l'audio à Deepgram pour transcription en temps réel
        const audioPayload = Buffer.from(data.media.payload, "base64");
        deepgramWs.send(audioPayload);
      }

      if (data.event === "stop") {
        console.log("📞 Appel terminé");
        
        // Nettoyer l'historique
        if (callSid) {
          conversationHistory.delete(callSid);
        }
        
        // Fermer la connexion Deepgram
        if (deepgramWs) {
          deepgramWs.close();
        }
      }
    } catch (err) {
      console.error("❌ Erreur WebSocket:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("🔌 WebSocket Twilio fermé");
    if (deepgramWs) {
      deepgramWs.close();
    }
  });

  ws.on("error", (err) => {
    console.error("❌ WebSocket Twilio error:", err.message);
  });
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ SERVEUR PRÊT");
  console.log("🌐 Webhook /voice =", `${baseUrl()}/voice`);
  console.log("🎤 WebSocket /ws =", `${baseUrl().replace("https", "wss")}/ws`);
});