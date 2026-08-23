require('dotenv').config();

const fs = require('fs');

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;

  const response = await fetch(
    'https://openrouter.ai/api/v1/audio/speech',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3.1-flash-tts-preview',
        input:
          'Read this sentence naturally in English: "Hello, this is a test of the Text-to-Voice system."',
        voice: 'Zephyr',
        response_format: 'pcm',
      }),
    },
  );

  console.log('HTTP status:', response.status);

  if (!response.ok) {
    console.error('TTS ERROR:');
    console.error(await response.text());
    process.exit(1);
  }

  const audio = Buffer.from(await response.arrayBuffer());

  fs.writeFileSync('test-gemini-tts.pcm', audio);

  console.log('TTS SUCCESS');
  console.log('Saved: test-gemini-tts.pcm');
  console.log('Size:', audio.length, 'bytes');
}

main().catch((error) => {
  console.error('TTS ERROR:', error);
  process.exit(1);
});