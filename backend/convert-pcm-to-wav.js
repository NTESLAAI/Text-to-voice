const fs = require('fs');

const inputFile = 'test-gemini-tts.pcm';
const outputFile = 'test-gemini-tts.wav';

const sampleRate = 24000;
const channels = 1;
const bitsPerSample = 16;

const pcm = fs.readFileSync(inputFile);

const byteRate = sampleRate * channels * bitsPerSample / 8;
const blockAlign = channels * bitsPerSample / 8;

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

fs.writeFileSync(
  outputFile,
  Buffer.concat([header, pcm]),
);

console.log('WAV SUCCESS');
console.log(`Saved: ${outputFile}`);
console.log(`Size: ${pcm.length + 44} bytes`);