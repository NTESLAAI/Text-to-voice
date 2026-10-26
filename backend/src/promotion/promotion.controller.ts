import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin/admin.guard';
import { PromotionStatus } from '../../generated/prisma/client';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';
import { PromotionService } from './promotion.service';
import { ChangePromotionStatusDto } from './dto/change-promotion-status.dto';

@Controller('admin/promotions')
@UseGuards(JwtAuthGuard, AdminGuard)
export class PromotionController {
  constructor(private readonly promotionService: PromotionService) {}

  @Get()
  getPromotions() {
    return this.promotionService.getAdminPromotions();
  }

  @Get('plans')
  getAvailablePlans() {
    return this.promotionService.getAvailablePlans();
  }

  @Post()
  createPromotion(@Body() dto: CreatePromotionDto) {
    return this.promotionService.createPromotion(dto);
  }

  @Patch(':id')
  updatePromotion(@Param('id') id: string, @Body() dto: UpdatePromotionDto) {
    return this.promotionService.updatePromotion(id, dto);
  }

  @Patch(':id/status')
  changeStatus(@Param('id') id: string, @Body() dto: ChangePromotionStatusDto) {
    return this.promotionService.changeStatus(id, dto.status);
  }
}
