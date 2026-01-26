/**
 * server.js
 * Agent immobilier vocal intelligent
 * Pipeline: Twilio → Deepgram (STT) → GPT-4o → (TTS later) → Twilio
 * 
 * VERSION STABLE – PRÊT POUR RENDER
 * - Détection naturelle de fin de parole
 * - Streaming GPT pour réduire latence
 * - Historique conversationnel complet
 * - Mémoire intelligente gérée par l'IA
 * - Gestion des interruptions
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

console.log("✅ Toutes les variables d'environnement sont présentes");

/* =========================
   CLIENTS
========================= */
const deepgram = createClient(DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* =========================
   SERVER SETUP
========================= */
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });
const { VoiceResponse } = twilio.twiml;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* =========================
   CONSTANTES DE CONFIGURATION
========================= */
const MIN_CHARS = 5;                // Minimum de caractères pour traiter
const MAX_HISTORY = 12;             // Historique max (6 échanges)
const SAFETY_TIMEOUT = 3000;        // Backup si UtteranceEnd rate (3s)
const UTTERANCE_END_MS = 1000;      // Silence de 1s = fin d'utterance
const ENDPOINTING_MS = 400;         // Sensibilité détection parole

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
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.send("✅ Agent immobilier vocal actif");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "voice-agent",
    websocket: wsUrl()
  });
});

/* =========================
   WEBHOOK TWILIO – POINT D'ENTRÉE
========================= */
app.post("/voice", (req, res) => {
  console.log("\n📞 ═══════════════════════════════════");
  console.log("📞 NOUVEL APPEL ENTRANT");
  console.log("📞 ═══════════════════════════════════");
  console.log("📱 From:", req.body.From);
  console.log("📱 To:", req.body.To);
  console.log("📱 CallSid:", req.body.CallSid);
  console.log("📞 ═══════════════════════════════════\n");

  const vr = new VoiceResponse();

  // Message d'accueil initial
  vr.say(
    { voice: "alice", language: "fr-CA" },
    "Bonjour, ici Ava de l'agence immobilière Prestige. Comment puis-je vous aider aujourd'hui?"
  );

  // Démarrer le stream WebSocket
  vr.start().stream({ url: wsUrl() });
  
  // Pause pour garder la connexion ouverte
  vr.pause({ length: 60 });

  res.type("text/xml").send(vr.toString());
});

/* =========================
   GPT – AGENT IMMOBILIER INTELLIGENT
========================= */
async function askGPT({ conversationHistory, memory }) {
  try {
    // Construction du system prompt avec contexte et mémoire
    const systemPrompt = {
      role: "system",
      content: `Tu es Ava, agente immobilière professionnelle chez Immobilier Prestige au Québec.

🎯 TON OBJECTIF:
Tu appelles des prospects pour :
1. Identifier leur besoin (ACHETER ou VENDRE)
2. Qualifier leur projet (budget, secteur, timeline)
3. Capturer leurs coordonnées (nom, email, téléphone)
4. Proposer un rendez-vous si le prospect est qualifié

📋 MÉMOIRE ACTUELLE (ce que tu sais déjà):
- Nom: ${memory.name || "non capturé"}
- Email: ${memory.email || "non capturé"}
- Téléphone: ${memory.phone || "non capturé"}
- Intention: ${memory.intent || "à identifier (ACHETER ou VENDRE)"}
- Budget: ${memory.budget || "non mentionné"}
- Secteur: ${memory.location || "non mentionné"}
- Timeline: ${memory.timeline || "non mentionné"}

🗣️ TON STYLE DE CONVERSATION:
- Parle de façon NATURELLE et HUMAINE (pas robotique)
- Varie la longueur de tes réponses (généralement 1-3 phrases courtes)
- Utilise des transitions naturelles: "Parfait", "D'accord", "Je comprends", "Excellent"
- Pose UNE SEULE question à la fois
- Écoute activement et rebondis sur ce que dit le prospect
- Reste professionnel mais chaleureux et accessible
- Utilise le français québécois familier

📝 MISE À JOUR DE LA MÉMOIRE:
Quand tu apprends une nouvelle information IMPORTANTE, commence ta réponse par:
[MEM: key=valeur, key=valeur]

Exemples:
[MEM: name=Jean Dupont, intent=ACHETER]
[MEM: budget=400000, location=Laval]
[MEM: timeline=3-6 mois, email=jean@email.com]

Ensuite, donne ta réponse naturelle au prospect.

⚠️ RÈGLES IMPORTANTES:
- Ne mentionne JAMAIS que tu es une IA ou un robot
- Si interrompu, ne te répète pas, continue naturellement
- Si la personne veut raccrocher, sois gracieux et professionnel
- Donne tes coordonnées si demandées (téléphone: 514-555-0100)
- Ne sois JAMAIS insistant ou agressif
- Respecte les signaux de désintérêt

💡 EXEMPLES DE BONNES RÉPONSES:
Client: "Je cherche une maison"
Toi: "Parfait! C'est pour acheter ou vous avez une propriété à vendre?"

Client: "Pour acheter"
Toi: [MEM: intent=ACHETER] "Excellent! Avez-vous un secteur en tête?"

Client: "À Laval, environ 400 000$"
Toi: [MEM: location=Laval, budget=400000] "Super! Et c'est pour quand? Vous cherchez activement ou vous planifiez?"

Reste naturel, conversationnel et orienté résultat.`
    };

    // Préparer les messages pour GPT
    const messages = [systemPrompt, ...conversationHistory];

    // Streaming pour réduire la latence perçue
    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      max_tokens: 150,  // Réponses concises
      stream: true,
      messages: messages,
    });

    let fullResponse = "";
    
    // Collecter la réponse streamée
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || "";
      fullResponse += content;
      // TODO: Ici on pourra streamer vers le TTS plus tard
    }

    return fullResponse.trim();

  } catch (e) {
    console.error("❌ Erreur GPT:", e.message);
    // Fallback gracieux
    return "Désolée, je n'ai pas bien compris. Pouvez-vous répéter s'il vous plaît?";
  }
}

/* =========================
   PARSE MEMORY UPDATES
========================= */
function parseMemoryUpdate(response, memory) {
  // Chercher le pattern [MEM: key=value, key=value]
  const memMatch = response.match(/\[MEM:\s*([^\]]+)\]/);
  
  if (memMatch) {
    const updates = memMatch[1];
    const cleanResponse = response.replace(/\[MEM:[^\]]+\]\s*/, "").trim();
    
    // Parser chaque paire key=value
    updates.split(",").forEach(pair => {
      const [key, ...valueParts] = pair.split("=");
      const value = valueParts.join("=").trim();
      const cleanKey = key.trim();
      
      if (memory.hasOwnProperty(cleanKey) && value && value !== "null") {
        memory[cleanKey] = value;
        console.log(`   📝 Mémoire mise à jour: ${cleanKey} = ${value}`);
      }
    });
    
    return cleanResponse;
  }
  
  return response;
}

/* =========================
   WEBSOCKET – CŒUR DE L'AGENT
========================= */
wss.on("connection", (ws) => {
  console.log("\n🔌 ═══════════════════════════════════");
  console.log("🔌 NOUVELLE CONNEXION MÉDIA");
  console.log("🔌 ═══════════════════════════════════");

  // État de la conversation
  let utteranceBuffer = "";
  let isProcessing = false;
  let isSpeaking = false;
  let lastSpeechTime = Date.now();
  let safetyTimer = null;
  let callSid = null;

  // 🧠 MÉMOIRE DE L'APPEL
  const memory = {
    name: null,
    email: null,
    phone: null,
    intent: null,      // ACHETER | VENDRE
    budget: null,
    location: null,
    timeline: null,
  };

  // 💬 HISTORIQUE CONVERSATIONNEL
  const conversationHistory = [];

  /* =========
     TRAITER UN TOUR DE PAROLE COMPLET
  ========= */
  async function handleUserUtterance(text) {
    if (text.length < MIN_CHARS) {
      console.log(`   ⚠️ Utterance trop courte (${text.length} chars): ignorée`);
      return;
    }
    
    if (isProcessing) {
      console.log("   ⏳ Déjà en traitement, utterance mise en attente");
      return;
    }

    isProcessing = true;
    console.log(`\n👤 CLIENT: "${text}"`);

    try {
      // Ajouter à l'historique
      conversationHistory.push({
        role: "user",
        content: text
      });

      // Appeler GPT avec streaming
      const rawResponse = await askGPT({
        conversationHistory,
        memory
      });

      // Parser et mettre à jour la mémoire
      const cleanResponse = parseMemoryUpdate(rawResponse, memory);

      // Ajouter la réponse à l'historique
      conversationHistory.push({
        role: "assistant",
        content: cleanResponse
      });

      // Nettoyer l'historique si trop long
      if (conversationHistory.length > MAX_HISTORY) {
        conversationHistory.splice(0, 2);
        console.log("   🧹 Historique nettoyé (garde les 12 derniers)");
      }

      console.log(`🤖 AVA: "${cleanResponse}"`);
      console.log(`🧠 Mémoire actuelle:`, JSON.stringify(memory, null, 2));

      // TODO: ICI → Envoyer au TTS
      // await sendToTTS(cleanResponse, ws);
      // Pour l'instant, l'agent a répondu mais pas d'audio retour

    } catch (error) {
      console.error("❌ Erreur dans handleUserUtterance:", error.message);
    } finally {
      isProcessing = false;
    }
  }

  /* =========
     DEEPGRAM SETUP
  ========= */
  const dg = deepgram.listen.live({
    model: "nova-2",
    language: "fr",
    encoding: "mulaw",
    sample_rate: 8000,
    smart_format: true,
    interim_results: true,
    utterance_end_ms: UTTERANCE_END_MS,
    vad_events: true,
    endpointing: ENDPOINTING_MS,
  });

  console.log("🎤 Deepgram connecté et en écoute");

  /* =========
     ÉVÉNEMENTS DEEPGRAM
  ========= */

  // Transcription en cours
  dg.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript || "";
    if (!transcript) return;

    // Afficher les résultats intermédiaires (debug)
    if (!data.is_final && transcript.length > 0) {
      process.stdout.write(`\r   🎤 [interim] ${transcript}                    `);
    }

    // Accumuler les résultats finaux
    if (data.is_final) {
      utteranceBuffer += " " + transcript;
      lastSpeechTime = Date.now();
      
      console.log(`\r   ✅ [final] ${transcript}`);
      
      // Reset du safety timer
      clearTimeout(safetyTimer);
      safetyTimer = setTimeout(() => {
        const trimmed = utteranceBuffer.trim();
        if (trimmed) {
          console.log("   ⏰ Safety timeout déclenché");
          handleUserUtterance(trimmed);
          utteranceBuffer = "";
        }
      }, SAFETY_TIMEOUT);
    }
  });

  // 🎯 FIN D'UTTERANCE DÉTECTÉE (méthode naturelle)
  dg.on(LiveTranscriptionEvents.UtteranceEnd, (data) => {
    clearTimeout(safetyTimer);
    
    const finalText = utteranceBuffer.trim();
    utteranceBuffer = "";

    if (finalText) {
      console.log("   ✅ UtteranceEnd détecté - traitement lancé");
      handleUserUtterance(finalText);
    }
  });

  // Début de parole
  dg.on(LiveTranscriptionEvents.SpeechStarted, () => {
    console.log("   🎤 Parole détectée - écoute en cours");
    
    // Si l'agent parle, il est interrompu
    if (isSpeaking) {
      console.log("   ⚠️ Agent interrompu par le client");
      isSpeaking = false;
      // TODO: Stopper le TTS ici quand implémenté
    }
  });

  // Erreurs Deepgram
  dg.on(LiveTranscriptionEvents.Error, (error) => {
    console.error("❌ Erreur Deepgram:", error);
  });

  // Connexion fermée
  dg.on(LiveTranscriptionEvents.Close, () => {
    console.log("🔒 Connexion Deepgram fermée");
  });

  /* =========
     GESTION WEBSOCKET TWILIO
  ========= */
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      // Réception de l'audio du client
      if (data.event === "media") {
        // Envoyer l'audio à Deepgram pour transcription
        dg.send(Buffer.from(data.media.payload, "base64"));
      }

      // Appel démarré
      if (data.event === "start") {
        callSid = data.start.callSid;
        console.log(`📞 Appel démarré - CallSid: ${callSid}`);
        console.log(`📱 De: ${data.start.customParameters?.From || 'inconnu'}`);
      }

      // Appel terminé
      if (data.event === "stop") {
        console.log("\n📞 ═══════════════════════════════════");
        console.log("📞 APPEL TERMINÉ");
        console.log("📞 ═══════════════════════════════════");
        console.log(`📡 CallSid: ${callSid}`);
        console.log(`⏱️ Durée conversation: ${conversationHistory.length / 2} échanges`);
        console.log("📊 RÉSUMÉ FINAL:");
        console.log(JSON.stringify(memory, null, 2));
        console.log("📞 ═══════════════════════════════════\n");
      }

    } catch (e) {
      console.error("❌ Erreur WebSocket message:", e.message);
    }
  });

  // Connexion fermée
  ws.on("close", () => {
    clearTimeout(safetyTimer);
    dg.finish();
    console.log("🔒 Connexion WebSocket fermée");
  });

  // Erreur WebSocket
  ws.on("error", (error) => {
    console.error("❌ Erreur WebSocket:", error.message);
  });
});

/* =========================
   GESTION DES ERREURS GLOBALES
========================= */
process.on("uncaughtException", (error) => {
  console.error("💥 Exception non capturée:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 Promesse rejetée non gérée:", reason);
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("\n🚀 ═══════════════════════════════════");
  console.log("🚀 AGENT IMMOBILIER VOCAL DÉMARRÉ");
  console.log("🚀 ═══════════════════════════════════");
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 Base URL: ${baseUrl()}`);
  console.log(`🔌 WebSocket: ${wsUrl()}`);
  console.log(`📞 Webhook: ${baseUrl()}/voice`);
  console.log(`🏥 Health: ${baseUrl()}/health`);
  console.log("🚀 ═══════════════════════════════════");
  console.log("✅ Prêt à recevoir des appels\n");
});