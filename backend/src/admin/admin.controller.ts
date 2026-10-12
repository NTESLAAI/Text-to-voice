import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin/admin.guard';
import { UpdatePlanDto } from './dto/update-plan.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('payments')
  async getPayments() {
    return this.adminService.getPayments();
  }

  @Get('users')
  async getUsers() {
    return this.adminService.getUsers();
  }

  @Get('plans')
  async getPlans() {
    return this.adminService.getPlans();
  }

  @Patch('plans/:id')
  async updatePlan(
    @Param('id') id: string,
    @Body() data: UpdatePlanDto,
  ) {
    return this.adminService.updatePlan(id, data);
  }

  @Post('payments/:id/confirm')
  async confirmPayment(@Param('id') id: string) {
    return this.adminService.confirmPayment(id);
  }
}