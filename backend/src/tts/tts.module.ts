import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { TtsController } from './tts.controller';
import { TtsService } from './tts.service';
import { OpenRouterTtsProvider } from './providers/openrouter-tts.provider';

import { VoiceDirectorService } from './voice-director.service';

@Module({
  imports: [PrismaModule],
  controllers: [TtsController],
  providers: [
  TtsService,
  OpenRouterTtsProvider,
  VoiceDirectorService,
],
  exports: [TtsService],
})
export class TtsModule {}