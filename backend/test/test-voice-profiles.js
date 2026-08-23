require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { OpenRouter } = require('@openrouter/sdk');

const client = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

const OUTPUT_DIR = path.join(
  process.cwd(),
  'test',
  'voice-results',
);

const TEST_TEXT =
  'Xin chào. Hôm nay tôi muốn kể cho bạn nghe một câu chuyện nhỏ. Có những điều tưởng như rất bình thường, nhưng lại khiến chúng ta nhớ mãi.';

const tests = [
  {
    name: '01-adult-male',
    prompt:
      'Speak naturally as an adult Vietnamese male. Use a natural neutral tone. Conversational delivery. Avoid sounding robotic or monotonous.',
  },
  {
    name: '02-adult-female',
    prompt:
      'Speak naturally as an adult Vietnamese female. Use a natural neutral tone. Conversational delivery. Avoid sounding robotic or monotonous.',
  },
  {
    name: '03-elderly-male',
    prompt:
      'Speak naturally as an elderly Vietnamese male. Use a mature, warm and slightly deep vocal character. Conversational delivery with natural pauses. Avoid sounding robotic or exaggerated.',
  },
  {
    name: '04-elderly-female',
    prompt:
      'Speak naturally as an elderly Vietnamese female. Use a mature, warm and gentle vocal character. Conversational delivery with natural pauses. Avoid sounding robotic or exaggerated.',
  },
  {
    name: '05-young-boy',
    prompt:
      'Speak naturally as a young Vietnamese boy. Use a youthful, bright and natural vocal character. Conversational delivery. Avoid sounding robotic or exaggerated.',
  },
  {
    name: '06-young-girl',
    prompt:
      'Speak naturally as a young Vietnamese girl. Use a youthful, bright and natural vocal character. Conversational delivery. Avoid sounding robotic or exaggerated.',
  },

  {
    name: '07-female-natural',
    prompt:
      'Speak naturally in Vietnamese as an adult female. Use a neutral conversational style with realistic pauses and natural intonation.',
  },
  {
    name: '08-female-storytelling',
    prompt:
      'Speak naturally in Vietnamese as an adult female narrator. Use expressive storytelling with natural pacing, realistic pauses and varied intonation. Avoid sounding robotic.',
  },
  {
    name: '09-female-warm-storytelling',
    prompt:
      'Speak naturally in Vietnamese as an adult female narrator. Use a warm, gentle and emotionally engaging voice. Deliver it as expressive storytelling with natural pauses, realistic rhythm and varied intonation. Avoid sounding robotic.',
  },
  {
    name: '10-female-sad-storytelling',
    prompt:
      'Speak naturally in Vietnamese as an adult female narrator. Use a subtle sad and emotionally restrained tone. Deliver it as expressive storytelling with natural pauses and varied intonation. Avoid exaggeration and robotic delivery.',
  },
  {
    name: '11-female-happy-conversation',
    prompt:
      'Speak naturally in Vietnamese as an adult female. Sound genuinely happy, friendly and positive. Use natural conversational delivery with realistic pauses and varied intonation.',
  },
];

function pcmToWav(pcm) {
  const sampleRate = 24000;
  const channels = 1;
  const bitsPerSample = 16;

  const byteRate =
    sampleRate *
    channels *
    bitsPerSample / 8;

  const blockAlign =
    channels *
    bitsPerSample / 8;

  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);

  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

async function generate(test) {
  const input = [
    test.prompt,
    'Read entirely in Vietnamese.',
    `Text to read: "${TEST_TEXT}"`,
  ].join(' ');

  const stream = await client.tts.createSpeech({
    speechRequest: {
      model:
        'google/gemini-3.1-flash-tts-preview',
      input,
      voice: 'Zephyr',
      responseFormat: 'pcm',
    },
  });

  const reader = stream.getReader();
  const chunks = [];

  while (true) {
    const { done, value } =
      await reader.read();

    if (done) {
      break;
    }

    chunks.push(Buffer.from(value));
  }

  const pcm = Buffer.concat(chunks);
  const wav = pcmToWav(pcm);

  const filePath = path.join(
    OUTPUT_DIR,
    `${test.name}.wav`,
  );

  fs.writeFileSync(filePath, wav);

  console.log(
    `✓ ${test.name} -> ${filePath}`,
  );
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, {
    recursive: true,
  });

  console.log(
    `Generating ${tests.length} voice tests...`,
  );

  for (const test of tests) {
    try {
      await generate(test);
    } catch (error) {
      console.error(
        `✗ ${test.name}`,
        error?.message || error,
      );
    }
  }

  console.log('Test completed.');
}

main();