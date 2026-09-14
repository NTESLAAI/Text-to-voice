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
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) { }
  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMyProject(@Req() req: any) {
    return this.projectsService.getOrCreateForUser(
      req.user.userId,
    );
  }

  @Post()
  create(
    @Body()
    body: {
      name: string;
      userId: string;
    },
  ) {
    return this.projectsService.create(body);
  }

  @Get()
  findAll() {
    return this.projectsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.projectsService.findOne(id);
  }
}