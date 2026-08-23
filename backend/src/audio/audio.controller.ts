import {
  Controller,
  Delete,
  Get,
  Param,
} from '@nestjs/common';

import { AudioService } from './audio.service';

@Controller('audio')
export class AudioController {
  constructor(
    private readonly audioService: AudioService,
  ) {}

  @Get('project/:projectId')
  findByProject(
    @Param('projectId') projectId: string,
  ) {
    return this.audioService.findByProject(projectId);
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
  ) {
    return this.audioService.findOne(id);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
  ) {
    return this.audioService.remove(id);
  }
}