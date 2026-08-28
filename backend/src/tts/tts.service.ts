import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';

import { PrismaService } from '../prisma/prisma.service';
import { AudioService } from '../audio/audio.service';
import {
  OpenRouterTtsProvider,
  TtsRequest,
} from './providers/openrouter-tts.provider';

import { VOICE_PRESETS } from './config/voice-profiles';

@Injectable()
export class TtsService {
  private readonly sampleRate=24000;
  private readonly channels=1;
  private readonly bitsPerSample=16;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audioService: AudioService,
    private readonly ttsProvider: OpenRouterTtsProvider,
  ) { }

  async synthesize(request: TtsRequest) {

    const preset=request.preset
      ? VOICE_PRESETS[request.preset]
      :null;

    const ttsRequest: TtsRequest=preset
      ? {
        ...request,
        region: preset.region,
        character: preset.character,
        tone: preset.tone,
        emotion: preset.emotion,
        style: preset.style,
        speed: request.speed,
      }
      :request;

    // 1. Kiểm tra Project
    const project=await this.prisma.project.findUnique({
      where: {
        id: request.projectId,
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // 2. Sinh PCM từ OpenRouter
    const pcm=await this.ttsProvider.synthesize(ttsRequest);

    // 3. Chuyển PCM → WAV
    const audioBuffer=this.pcmToWav(pcm);

    // 4. Tính metadata
    const characters=request.text.length;

    const duration=
      pcm.length/
      (this.sampleRate*
        this.channels*
        (this.bitsPerSample/8));

    // 5. Tạo tên file duy nhất
    const fileName=`${randomUUID()}.wav`;

    const uploadDir=join(
      process.cwd(),
      'uploads',
      'audio',
    );

    const filePath=join(
      uploadDir,
      fileName,
    );

    // 6. Đảm bảo thư mục tồn tại
    await fs.mkdir(uploadDir, {
      recursive: true,
    });

    // 7. Lưu file WAV
    await fs.writeFile(
      filePath,
      audioBuffer,
    );

    // 8. URL tương đối để frontend sử dụng
    const fileUrl=`/uploads/audio/${fileName}`;

    // 9. Lưu metadata vào PostgreSQL
    try {
      const audio=await this.prisma.audio.create({
        data: {
          projectId: request.projectId,
          text: request.text,
          language: request.language,
          voice: 'Zephyr',
          character: ttsRequest.character,
          tone: ttsRequest.tone,
          emotion: ttsRequest.emotion,
          style: ttsRequest.style,
          speed: ttsRequest.speed,
          provider: 'openrouter',
          model: 'google/gemini-3.1-flash-tts-preview',
          fileUrl,
          format: 'wav',
          characters,
          duration,
        },
      });

      await this.audioService.removeProjectAudioExceedingLimit(
        request.projectId,
      );

      return {
      id: audio.id,
      projectId: audio.projectId,
      text: audio.text,
      language: audio.language,
      voice: audio.voice,
      speed: audio.speed,
      provider: audio.provider,
      model: audio.model,
      fileUrl: audio.fileUrl,
      format: audio.format,
      characters: audio.characters,
      duration: audio.duration,
        audio: audioBuffer,
      };
    } catch (error) {
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        console.error(
          'Failed to clean up WAV after Audio record creation failed:',
          { filePath, cleanupError },
        );
      }

      throw error;
    }
  }

  private pcmToWav(pcm: Buffer): Buffer {
    const byteRate=
      this.sampleRate*
      this.channels*
      this.bitsPerSample/8;

    const blockAlign=
      this.channels*
      this.bitsPerSample/8;

    const header=Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36+pcm.length, 4);
    header.write('WAVE', 8);

    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(this.channels, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(this.bitsPerSample, 34);

    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);

    return Buffer.concat([
      header,
      pcm,
    ]);
  }
}
