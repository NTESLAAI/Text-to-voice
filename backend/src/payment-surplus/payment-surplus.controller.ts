import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CreateSurplusHandlingDto,
  CompleteSurplusHandlingDto,
  CancelSurplusHandlingDto,
} from './surplus-handling.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin/admin.guard';
import { PaymentSurplusService } from './payment-surplus.service';

@Controller('admin/payments')
@UseGuards(JwtAuthGuard, AdminGuard)
export class PaymentSurplusController {
  constructor(private readonly surplusService: PaymentSurplusService) {}

  @Get(':paymentId/surplus')
  getSurplus(@Param('paymentId') paymentId: string) {
    return this.surplusService.getSurplus(paymentId);
  }

  @Post(':paymentId/surplus/handlings')
  create(
    @Param('paymentId') paymentId: string,
    @Headers('idempotency-key') key: string,
    @Body() dto: CreateSurplusHandlingDto,
    @Req() req: { user: { userId: string } },
  ) {
    return this.surplusService.createHandling(
      paymentId,
      key,
      dto,
      req.user.userId,
    );
  }

  @Post(':paymentId/surplus/handlings/:id/complete')
  complete(
    @Param('paymentId') paymentId: string,
    @Param('id') id: string,
    @Body() dto: CompleteSurplusHandlingDto,
    @Req() req: { user: { userId: string } },
  ) {
    return this.surplusService.completeHandling(
      paymentId,
      id,
      dto,
      req.user.userId,
    );
  }

  @Post(':paymentId/surplus/handlings/:id/cancel')
  cancel(
    @Param('paymentId') paymentId: string,
    @Param('id') id: string,
    @Body() dto: CancelSurplusHandlingDto,
    @Req() req: { user: { userId: string } },
  ) {
    return this.surplusService.cancelHandling(
      paymentId,
      id,
      dto,
      req.user.userId,
    );
  }
}
