require('dotenv').config();

const { OpenRouter } = require('@openrouter/sdk');
const fs = require('fs');

async function main() {
  const client = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
  });

  console.log('API key loaded:', !!process.env.OPENROUTER_API_KEY);
  console.log('API key length:', process.env.OPENROUTER_API_KEY?.length || 0);

  const stream = await client.tts.createSpeech({
    speechRequest: {
      model: 'google/gemini-3.1-flash-tts-preview',
      input: 'Xin chào! Đây là bài kiểm tra Text to Voice bằng tiếng Việt.',
      voice: 'Zephyr',
      responseFormat: 'mp3',
    },
  });

  const reader = stream.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    chunks.push(Buffer.from(value));
  }

  const audio = Buffer.concat(chunks);

  fs.writeFileSync('test-gemini-tts.mp3', audio);

  console.log('TTS SUCCESS');
  console.log('Saved: test-gemini-tts.mp3');
  console.log('Size:', audio.length, 'bytes');
}

main().catch((error) => {
  console.error('TTS ERROR');
  console.error(error);
  process.exit(1);
});