import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
} from '@nestjs/common';
import { OpenRouter } from '@openrouter/sdk';

import {
  VoiceCharacter,
  VoiceEmotion,
  VoiceRegion,
  VoiceStyle,
  VoiceTone,
} from '../config/voice-profiles';

import { VoiceDirectorService } from '../voice-director.service';

export interface TtsRequest {
  projectId: string;
  text: string;
  language: 'vi' | 'en';
  preset?: string;
  region: VoiceRegion;
  character: VoiceCharacter;
  tone: VoiceTone;
  emotion: VoiceEmotion;
  style: VoiceStyle;
  speed: number;
}

@Injectable()
export class OpenRouterTtsProvider {
  private readonly client: OpenRouter;

  constructor(private readonly voiceDirector: VoiceDirectorService) {
    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is not configured');
    }

    this.client = new OpenRouter({
      apiKey,
    });
  }

  async synthesize(
    request: TtsRequest,
    signal: AbortSignal = AbortSignal.timeout(120000),
  ): Promise<Buffer> {
    if (signal.aborted) throw new GatewayTimeoutException('AI_REQUEST_TIMEOUT');
    const input = this.buildInput(request);

    const voice =
      request.character === 'adult_male'
        ? 'Charon'
        : request.character === 'boy'
          ? 'Achernar'
          : request.character === 'girl'
            ? 'Achird'
            : 'Zephyr';

    const stream = await this.client.tts
      .createSpeech(
        {
          speechRequest: {
            model: 'google/gemini-3.1-flash-tts-preview',
            input,
            voice,
            responseFormat: 'pcm',
          },
        },
        { signal, retries: { strategy: 'none' } },
      )
      .catch(() => {
        if (signal.aborted)
          throw new GatewayTimeoutException('AI_REQUEST_TIMEOUT');
        throw new BadGatewayException('AI_PROVIDER_FAILED');
      });

    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= reader.cancel().catch(() => undefined);
      return cancellation;
    };
    const abort = () => {
      void cancel();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024 * 1024) {
          await cancel();
          throw new Error('AI_AUDIO_SIZE_LIMIT_EXCEEDED');
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch {
      void cancel();
      if (signal.aborted)
        throw new GatewayTimeoutException('AI_REQUEST_TIMEOUT');
      throw new BadGatewayException('AI_STREAM_FAILED');
    } finally {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) void cancel();
      await cancellation;
      reader.releaseLock();
    }
  }

  private buildInput(request: TtsRequest): string {
    const direction =
      request.character &&
      request.tone &&
      request.emotion &&
      request.style &&
      request.speed
        ? this.voiceDirector.createDirection({
            region: request.region,
            character: request.character,
            tone: request.tone,
            emotion: request.emotion,
            style: request.style,
            speed: request.speed,
            language: request.language === 'vi' ? 'Vietnamese' : 'English',
          })
        : null;

    if (request.language === 'vi') {
      if (direction) {
        return [
          direction.instruction,
          `Speak at approximately ${direction.speed}x normal speaking pace.`,
          `Đọc hoàn toàn bằng tiếng Việt.`,
          `Nội dung cần đọc: "${request.text}"`,
        ].join(' ');
      }

      return `Hãy đọc câu sau hoàn toàn bằng tiếng Việt, với phát âm tiếng Việt tự nhiên, không chuyển sang tiếng Anh: "${request.text}"`;
    }

    if (direction) {
      return [
        direction.instruction,
        `Speak at approximately ${direction.speed}x normal speaking pace.`,
        `Read entirely in English.`,
        `Text to read: "${request.text}"`,
      ].join(' ');
    }

    return `Read the following text naturally in English: "${request.text}"`;
  }
}
