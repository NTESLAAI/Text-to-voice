import { Injectable } from '@nestjs/common';
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
  language: 'vi'|'en';
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

  constructor(
    private readonly voiceDirector: VoiceDirectorService,
  ) {
    const apiKey=process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is not configured');
    }

    this.client=new OpenRouter({
      apiKey,
    });
  }

  async synthesize(request: TtsRequest): Promise<Buffer> {
    const input=this.buildInput(request);

    console.log('========== TTS INPUT ==========');
    console.log(input);
    console.log('================================');

    const voice=
      request.character==='adult_male'
        ? 'Charon'
        :request.character==='boy'
          ? 'Achernar'
          :request.character==='girl'
            ? 'Achird'
            :'Zephyr';

    const stream=await this.client.tts.createSpeech({
      speechRequest: {
        model: 'google/gemini-3.1-flash-tts-preview',
        input,
        voice,
        responseFormat: 'pcm',
      },
    });

    const reader=stream.getReader();
    const chunks: Buffer[]=[];

    while (true) {
      const { done, value }=await reader.read();

      if (done) {
        break;
      }

      chunks.push(Buffer.from(value));
    }

    return Buffer.concat(chunks);
  }

  private buildInput(request: TtsRequest): string {
    const direction=
      request.character&&
        request.tone&&
        request.emotion&&
        request.style&&
        request.speed
        ? this.voiceDirector.createDirection({
          region: request.region,
          character: request.character,
          tone: request.tone,
          emotion: request.emotion,
          style: request.style,
          speed: request.speed,
          language:
            request.language==='vi'
              ? 'Vietnamese'
              :'English',
        })
        :null;

    if (request.language==='vi') {
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