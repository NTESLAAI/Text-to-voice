import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { ProjectsService } from './projects.service';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get('me')
  getMyProject(@Req() req: any) {
    return this.projectsService.getOrCreateForUser(req.user.userId);
  }

  @Post()
  create(
    @Body()
    body: {
      name: string;
    },
    @Req() req: any,
  ) {
    return this.projectsService.create({
      name: body.name,
      userId: req.user.userId,
    });
  }

  @Get()
  findAll(@Req() req: any) {
    return this.projectsService.findAll(req.user.userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.projectsService.findOne(id, req.user.userId);
  }
}
