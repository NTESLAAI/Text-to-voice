import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { AudioModule } from '../audio/audio.module';
import { TtsController } from './tts.controller';
import { TtsService } from './tts.service';
import { OpenRouterTtsProvider } from './providers/openrouter-tts.provider';

import { VoiceDirectorService } from './voice-director.service';

@Module({
  imports: [PrismaModule, AudioModule],
  controllers: [TtsController],
  providers: [
  TtsService,
  OpenRouterTtsProvider,
  VoiceDirectorService,
],
  exports: [TtsService],
})
export class TtsModule {}
