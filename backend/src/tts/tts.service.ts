import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';

import { PrismaService } from '../prisma/prisma.service';
import { characterCountRules } from './character-count';
import { AudioService } from '../audio/audio.service';
import {
  OpenRouterTtsProvider,
  TtsRequest,
} from './providers/openrouter-tts.provider';

import { VOICE_PRESETS, VOICE_PROFILES } from './config/voice-profiles';
import {
  DialogueSpeakerDto,
  SynthesizeDialogueDto,
} from './dto/synthesize-dialogue.dto';

@Injectable()
export class TtsService {
  private readonly sampleRate = 24000;
  private readonly channels = 1;
  private readonly bitsPerSample = 16;
  private readonly dialoguePauseMilliseconds = 350;
  private readonly maxDialogueCharacters = 10000;
  private countBillableCharacters(text: string, language: string): number {
    const normalizedText = text.normalize('NFC');
    const rule = characterCountRules[language];

    let spokenText = normalizedText;

    if (rule?.expandAbbreviations) {
      const abbreviations = Object.entries(rule.expandAbbreviations).sort(
        ([a], [b]) => b.length - a.length,
      );

      for (const [abbreviation, expansion] of abbreviations) {
        const escaped = abbreviation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        spokenText = spokenText.replace(
          new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'),
          expansion,
        );
      }
    }

    return [...spokenText].filter((char) => /[\p{L}\p{N}]/u.test(char)).length;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly audioService: AudioService,
    private readonly ttsProvider: OpenRouterTtsProvider,
  ) {}

  async synthesize(request: TtsRequest) {
    const preset = request.preset ? VOICE_PRESETS[request.preset] : null;

    const ttsRequest: TtsRequest = preset
      ? {
          ...request,
          region: preset.region,
          character: preset.character,
          tone: preset.tone,
          emotion: preset.emotion,
          style: preset.style,
          speed: request.speed,
        }
      : request;

    // 1. Kiá»ƒm tra Project
    const project = await this.prisma.project.findUnique({
      where: {
        id: request.projectId,
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }
    const characters = this.countBillableCharacters(
      request.text,
      request.language,
    );

    const quota = await this.checkCharacterQuota(project.userId, characters);

    // 2. Sinh PCM tá»« OpenRouter
    const pcm = await this.ttsProvider.synthesize(ttsRequest);

    // 3. Chuyá»ƒn PCM â†’ WAV
    const audioBuffer = this.pcmToWav(pcm);

    // 4. TÃ­nh metadata

    const duration =
      pcm.length / (this.sampleRate * this.channels * (this.bitsPerSample / 8));

    // 5. Táº¡o tÃªn file duy nháº¥t
    const fileName = `${randomUUID()}.wav`;

    const uploadDir = join(process.cwd(), 'uploads', 'audio');

    const filePath = join(uploadDir, fileName);

    // 6. Äáº£m báº£o thÆ° má»¥c tá»“n táº¡i
    await fs.mkdir(uploadDir, {
      recursive: true,
    });

    // 7. LÆ°u file WAV
    await fs.writeFile(filePath, audioBuffer);

    // 8. URL tÆ°Æ¡ng Ä‘á»‘i Ä‘á»ƒ frontend sá»­ dá»¥ng
    const fileUrl = `/uploads/audio/${fileName}`;

    // 9. LÆ°u metadata vÃ o PostgreSQL
    try {
      const audio = await this.prisma.audio.create({
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

      await this.prisma.usage.create({
        data: {
          userId: project.userId,
          subscriptionId: quota.subscription.id,
          characters,
          type: 'tts',
          referenceId: audio.id,
        },
      });

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

  async synthesizeDialogue(request: SynthesizeDialogueDto) {
    const project = await this.prisma.project.findUnique({
      where: {
        id: request.projectId,
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const speakerA = this.validateDialogueSpeaker('A', request.speakerA);
    const speakerB = this.validateDialogueSpeaker('B', request.speakerB);
    const speakers = {
      A: speakerA,
      B: speakerB,
    };

    const characters = request.turns.reduce(
      (total, turn) =>
        total + this.countBillableCharacters(turn.text, request.language),
      0,
    );

    if (characters > this.maxDialogueCharacters) {
      throw new BadRequestException(
        `Dialogue must not exceed ${this.maxDialogueCharacters} characters`,
      );
    }
    const quota = await this.checkCharacterQuota(project.userId, characters);
    const pcmParts: Buffer[] = [];
    const pause = this.createDialoguePause();

    for (const [index, turn] of request.turns.entries()) {
      const speaker = speakers[turn.speaker];

      const pcm = await this.ttsProvider.synthesize({
        projectId: request.projectId,
        text: turn.text,
        language: request.language,
        character: speaker.character,
        region: speaker.region,
        tone: 'neutral',
        emotion: 'natural',
        style: turn.style,
        speed: request.speed ?? 1,
      });

      pcmParts.push(pcm);

      if (index < request.turns.length - 1) {
        pcmParts.push(pause);
      }
    }

    const pcm = Buffer.concat(pcmParts);
    const audioBuffer = this.pcmToWav(pcm);
    const duration =
      pcm.length / (this.sampleRate * this.channels * (this.bitsPerSample / 8));
    const fileName = `${randomUUID()}.wav`;
    const uploadDir = join(process.cwd(), 'uploads', 'dialogues');
    const filePath = join(uploadDir, fileName);
    const fileUrl = `/uploads/dialogues/${fileName}`;

    await fs.mkdir(uploadDir, {
      recursive: true,
    });
    await fs.writeFile(filePath, audioBuffer);

    try {
      const dialogue = await this.prisma.dialogue.create({
        data: {
          projectId: request.projectId,
          language: request.language,
          fileUrl,
          format: 'wav',
          characters,
          duration,
          provider: 'openrouter',
          model: 'google/gemini-3.1-flash-tts-preview',
          speakers: {
            create: [speakerA, speakerB],
          },
          turns: {
            create: request.turns.map((turn, index) => ({
              order: index + 1,
              speaker: turn.speaker,
              text: turn.text,
              style: turn.style,
            })),
          },
        },
      });

      await this.prisma.usage.create({
        data: {
          userId: project.userId,
          subscriptionId: quota.subscription.id,
          characters,
          type: 'dialogue',
          referenceId: dialogue.id,
        },
      });

      return {
        id: dialogue.id,
        projectId: dialogue.projectId,
        fileUrl: dialogue.fileUrl,
        format: dialogue.format,
        characters: dialogue.characters,
        duration: dialogue.duration,
        audio: audioBuffer,
      };
    } catch (error) {
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        console.error(
          'Failed to clean up WAV after Dialogue creation failed:',
          { filePath, cleanupError },
        );
      }

      throw error;
    }
  }
  async getDialogueHistory(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: {
        id: projectId,
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return this.prisma.dialogue.findMany({
      where: {
        projectId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        speakers: {
          orderBy: {
            role: 'asc',
          },
        },
        turns: {
          orderBy: {
            order: 'asc',
          },
        },
      },
    });
  }

  async deleteDialogue(id: string) {
    const dialogue = await this.prisma.dialogue.findUnique({
      where: {
        id,
      },
    });

    if (!dialogue) {
      throw new NotFoundException('Dialogue not found');
    }

    if (dialogue.fileUrl) {
      const fileName = dialogue.fileUrl.split('/').pop();

      if (fileName) {
        const filePath = join(process.cwd(), 'uploads', 'dialogues', fileName);

        try {
          await fs.unlink(filePath);
        } catch (error) {
          console.warn(
            'Dialogue audio file could not be deleted:',
            filePath,
            error,
          );
        }
      }
    }

    await this.prisma.dialogue.delete({
      where: {
        id,
      },
    });
  }

  async getProjectUsage(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException('KhÃ´ng tÃ¬m tháº¥y project.');
    }

    const now = new Date();

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId: project.userId,
        status: 'ACTIVE',
        startedAt: { lte: now },
        expiresAt: { gt: now },
      },
      include: { plan: true },
      orderBy: { expiresAt: 'desc' },
    });

    if (!subscription) {
      throw new BadRequestException(
        'TÃ i khoáº£n chÆ°a cÃ³ gÃ³i sá»­ dá»¥ng Ä‘ang hoáº¡t Ä‘á»™ng.',
      );
    }

    if (!subscription.plan.isActive) {
      throw new BadRequestException(
        'GÃ³i sá»­ dá»¥ng hiá»‡n khÃ´ng cÃ²n hoáº¡t Ä‘á»™ng.',
      );
    }

    const usage = await this.prisma.usage.aggregate({
      where: {
        userId: project.userId,
        subscriptionId: subscription.id,
      },
      _sum: {
        characters: true,
      },
    });

    const usedCharacters = usage._sum.characters ?? 0;

    const characterLimit = subscription.characterLimit;
    const rolloverCharacters = subscription.rolloverCharacters;

    const totalQuota = characterLimit + rolloverCharacters;

    return {
      plan: subscription.plan.code,
      characterLimit,
      rolloverCharacters,
      totalQuota,
      usedCharacters,
      remainingCharacters: Math.max(totalQuota - usedCharacters, 0),
    };
  }
  async getMyUsage(userId: string) {
    const now = new Date();

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        startedAt: { lte: now },
        expiresAt: { gt: now },
      },
      include: { plan: true },
      orderBy: { expiresAt: 'desc' },
    });

    if (!subscription) {
      throw new BadRequestException(
        'Tài khoản chưa có gói sử dụng đang hoạt động.',
      );
    }

    if (!subscription.plan.isActive) {
      throw new BadRequestException('Gói sử dụng hiện không còn hoạt động.');
    }

    const usage = await this.prisma.usage.aggregate({
      where: {
        userId,
        subscriptionId: subscription.id,
      },
      _sum: {
        characters: true,
      },
    });

    const usedCharacters = usage._sum.characters ?? 0;

    const characterLimit = subscription.characterLimit;
    const rolloverCharacters = subscription.rolloverCharacters;
    const totalQuota = characterLimit + rolloverCharacters;

    return {
      plan: subscription.plan.code,
      characterLimit,
      rolloverCharacters,
      totalQuota,
      usedCharacters,
      remainingCharacters: Math.max(totalQuota - usedCharacters, 0),
    };
  }

  private async checkCharacterQuota(userId: string, characters: number) {
    const now = new Date();

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        startedAt: {
          lte: now,
        },
        expiresAt: {
          gt: now,
        },
      },
      include: {
        plan: true,
      },
      orderBy: {
        expiresAt: 'desc',
      },
    });

    if (!subscription) {
      throw new BadRequestException(
        'TÃ i khoáº£n chÆ°a cÃ³ gÃ³i sá»­ dá»¥ng Ä‘ang hoáº¡t Ä‘á»™ng.',
      );
    }

    if (!subscription.plan.isActive) {
      throw new BadRequestException(
        'GÃ³i sá»­ dá»¥ng hiá»‡n khÃ´ng cÃ²n hoáº¡t Ä‘á»™ng.',
      );
    }

    const usage = await this.prisma.usage.aggregate({
      where: {
        userId,
        subscriptionId: subscription.id,
      },
      _sum: {
        characters: true,
      },
    });

    const usedCharacters = usage._sum.characters ?? 0;

    const characterLimit = subscription.characterLimit;
    const rolloverCharacters = subscription.rolloverCharacters;

    const totalQuota = characterLimit + rolloverCharacters;

    const remainingCharacters = totalQuota - usedCharacters;

    if (characters > remainingCharacters) {
      throw new BadRequestException(
        `Báº¡n chá»‰ cÃ²n ${Math.max(remainingCharacters, 0).toLocaleString(
          'vi-VN',
        )} kÃ½ tá»± trong chu ká»³ sá»­ dá»¥ng.`,
      );
    }

    return {
      subscription,
      plan: subscription.plan,
      characterLimit,
      rolloverCharacters,
      totalQuota,
      usedCharacters,
      remainingCharacters,
    };
  }

  private validateDialogueSpeaker(
    role: 'A' | 'B',
    speaker: DialogueSpeakerDto,
  ) {
    const profile = VOICE_PROFILES[speaker.character];

    if (!profile || profile.gender !== speaker.gender) {
      throw new BadRequestException(
        `Speaker ${role} gender does not match its character`,
      );
    }

    return {
      role,
      gender: speaker.gender,
      age: profile.age,
      character: speaker.character,
      region: speaker.region,
    };
  }

  private createDialoguePause(): Buffer {
    const bytesPerMillisecond =
      (this.sampleRate * this.channels * (this.bitsPerSample / 8)) / 1000;

    return Buffer.alloc(
      Math.round(bytesPerMillisecond * this.dialoguePauseMilliseconds),
    );
  }

  private pcmToWav(pcm: Buffer): Buffer {
    const byteRate = (this.sampleRate * this.channels * this.bitsPerSample) / 8;

    const blockAlign = (this.channels * this.bitsPerSample) / 8;

    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
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

    return Buffer.concat([header, pcm]);
  }
}
