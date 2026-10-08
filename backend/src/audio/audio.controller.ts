import { Controller, Delete, Get, Param, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { AudioService } from './audio.service';

@Controller('audio')
@UseGuards(JwtAuthGuard)
export class AudioController {
  constructor(private readonly audioService: AudioService) {}

  @Get('project/:projectId')
  findByProject(@Param('projectId') projectId: string, @Req() req: any) {
    return this.audioService.findByProject(projectId, req.user.userId);
  }

  @Get('file/:id')
  getFile(@Param('id') id: string, @Req() req: any) {
    return this.audioService.getFile(id, req.user.userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.audioService.findOne(id, req.user.userId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.audioService.remove(id, req.user.userId);
  }
}
