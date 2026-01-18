require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@deepgram/sdk');

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

const AUDIO_FILE = './test-audio.wav'; // or .mp3

async function transcribe() {
  const audio = fs.readFileSync(AUDIO_FILE);

  const response = await deepgram.listen.prerecorded(
    {
      buffer: audio,
      mimetype: 'audio/wav',
    },
    {
      model: 'nova',
      punctuate: true,
    }
  );

  const transcript = response.results.channels[0].alternatives[0].transcript;
  console.log('📝 Transcription:', transcript);
}

transcribe().catch(console.error);
