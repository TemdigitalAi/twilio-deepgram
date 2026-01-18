require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@deepgram/sdk');

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// Change le fichier si besoin
const AUDIO_FILE = path.join(__dirname, 'test-audio.wav');

async function transcribe() {
  try {
    if (!fs.existsSync(AUDIO_FILE)) {
      throw new Error('Audio file not found');
    }

    const audio = fs.readFileSync(AUDIO_FILE);

    const response = await deepgram.listen.prerecorded(
      {
        buffer: audio,
        mimetype: 'audio/wav',
      },
      {
        model: 'nova-3',
        language: 'en-US',
        punctuate: true,
        smart_format: true,
      }
    );

    const transcript =
      response.results?.channels?.[0]?.alternatives?.[0]?.transcript;

    console.log('📝 Transcription:', transcript || '[EMPTY]');
  } catch (err) {
    console.error('❌ Deepgram test error:', err.message);
  }
}

transcribe();
