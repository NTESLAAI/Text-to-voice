import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin/admin.guard';

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('payments')
  async getPayments() {
    return this.adminService.getPayments();
  }

  @Post('payments/:id/confirm')
  async confirmPayment(@Param('id') id: string) {
    return this.adminService.confirmPayment(id);
  }
}
