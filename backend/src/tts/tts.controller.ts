import {
  Body,
  Controller,
  Get,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { TtsService } from './tts.service';
import { SynthesizeSpeechDto } from './dto/synthesize-speech.dto';
import { VOICE_PRESETS } from './config/voice-profiles';

@Controller('tts')
export class TtsController {
  constructor(
    private readonly ttsService: TtsService,
  ) {}

  @Get('presets')
  getPresets() {
    return Object.entries(VOICE_PRESETS).map(
      ([id, preset]) => ({
        id,
        ...preset,
      }),
    );
  }
  
  @Post('synthesize')
  async synthesize(
    @Body() dto: SynthesizeSpeechDto,
    @Res() res: Response,
  ): Promise<void> {

console.log('========== TTS REQUEST ==========');
console.log(dto);
console.log('=================================');

    const result = await this.ttsService.synthesize(dto);

res.set({
  'Content-Type': 'audio/wav',
  'Content-Length': result.audio.length.toString(),
  'Content-Disposition': 'inline; filename="speech.wav"',
});

res.send(result.audio);
  }
}