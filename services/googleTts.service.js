const fs = require("fs");
const path = require("path");
const textToSpeech = require("@google-cloud/text-to-speech");

const client = new textToSpeech.TextToSpeechClient();

async function googleTTS(text, audioDir, callSid, baseUrl) {
  const filename = `${callSid}-${Date.now()}.wav`;
  const filepath = path.join(audioDir, filename);

  const request = {
    input: { text },
    voice: {
      languageCode: "en-US",
      name: "en-US-Neural2-F",
    },
    audioConfig: {
      audioEncoding: "MULAW",
      sampleRateHertz: 8000,
      speakingRate: 1.05,
    },
  };

  const [response] = await client.synthesizeSpeech(request);
  fs.writeFileSync(filepath, response.audioContent, "binary");

  return `${baseUrl}/audio/${filename}`;
}

module.exports = { googleTTS };
