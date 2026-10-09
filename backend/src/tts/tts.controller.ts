import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { TtsService } from './tts.service';
import { SynthesizeSpeechDto } from './dto/synthesize-speech.dto';
import { SynthesizeDialogueDto } from './dto/synthesize-dialogue.dto';
import { VOICE_PRESETS } from './config/voice-profiles';
import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';

@Controller('tts')
export class TtsController {
  constructor(private readonly ttsService: TtsService) {}

  @Get('presets')
  getPresets() {
    return Object.entries(VOICE_PRESETS).map(([id, preset]) => ({
      id,
      ...preset,
    }));
  }

  @UseGuards(JwtAuthGuard)
  @Get('usage/me')
  async getMyUsage(@Req() req: any) {
    return this.ttsService.getMyUsage(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('usage/project/:projectId')
  async getProjectUsage(
    @Param('projectId') projectId: string,
    @Req() req: any,
  ) {
    return this.ttsService.getProjectUsage(projectId, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('synthesize')
  async synthesize(
    @Body() dto: SynthesizeSpeechDto,
    @Req() req: any,
    @Res() res: Response,
  ): Promise<void> {
    
    const result = await this.ttsService.synthesize(dto, req.user.userId);

    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': result.audio.length.toString(),
      'Content-Disposition': 'inline; filename="speech.wav"',
    });

    res.send(result.audio);
  }

  @UseGuards(JwtAuthGuard)
  @Post('dialogue')
  async synthesizeDialogue(
    @Body() dto: SynthesizeDialogueDto,
    @Req() req: any,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.ttsService.synthesizeDialogue(
      dto,
      req.user.userId,
    );

    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': result.audio.length.toString(),
      'Content-Disposition': 'inline; filename="dialogue.wav"',
    });

    res.send(result.audio);
  }

  @UseGuards(JwtAuthGuard)
  @Get('dialogue/project/:projectId')
  async getDialogueHistory(
    @Param('projectId') projectId: string,
    @Req() req: any,
  ) {
    return this.ttsService.getDialogueHistory(projectId, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('dialogue/file/:id')
  async getDialogueFile(
    @Param('id') id: string,
    @Req() req: any,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.ttsService.getDialogueFile(id, req.user.userId);

    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': result.audio.length.toString(),
      'Content-Disposition': 'inline; filename="dialogue.wav"',
    });

    res.send(result.audio);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('dialogue/:id')
  async deleteDialogue(@Param('id') id: string, @Req() req: any) {
    await this.ttsService.deleteDialogue(id, req.user.userId);

    return {
      success: true,
    };
  }
}
