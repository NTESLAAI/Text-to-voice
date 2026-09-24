import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { PaymentService } from './payment.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { AdminGuard } from '../auth/guards/admin/admin.guard';

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @UseGuards(JwtAuthGuard)
  @Post('create')
  createPayment(@Req() req: any, @Body() body: CreatePaymentDto) {
    return this.paymentService.createPayment(req.user.userId, body.planCode);
  }
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post(':id/confirm')
  confirmPayment(@Param('id') paymentId: string) {
    return this.paymentService.confirmPayment(paymentId);
  }
}
