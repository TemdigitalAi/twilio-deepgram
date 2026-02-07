const WebSocket = require("ws");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

function createDeepgramSTT(apiKey, onTranscript) {
  const dgUrl =
    "wss://api.deepgram.com/v1/listen" +
    "?model=nova-2" +
    "&encoding=mulaw" +
    "&sample_rate=8000" +
    "&language=en-US" +
    "&punctuate=true" +
    "&interim_results=true" +
    "&endpointing=300";

  const dgWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  dgWs.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.type === "Results") {
      const transcript = data.channel.alternatives[0].transcript.trim();
      if (transcript && onTranscript) {
        onTranscript(transcript, data.speech_final);
      }
    }
  });

  return dgWs;
}

async function deepgramTTS(text, audioDir, callSid, baseUrl) {
  const filename = `${callSid}-${Date.now()}.wav`;
  const filepath = `${audioDir}/${filename}`;

  const r = await fetch(
    "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=wav",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    }
  );

  if (!r.ok) throw new Error("Deepgram TTS failed");

  require("fs").writeFileSync(filepath, Buffer.from(await r.arrayBuffer()));
  return `${baseUrl}/audio/${filename}`;
}

module.exports = {
  createDeepgramSTT,
  deepgramTTS,
};
