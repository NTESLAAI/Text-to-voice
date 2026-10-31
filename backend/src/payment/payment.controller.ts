import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';
import { SepayWebhookDto } from './dto/sepay-webhook.dto';
import { SepaySignatureService } from './sepay-signature.service';
import { SepayWebhookService } from './sepay-webhook.service';

import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin/admin.guard';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { CreateBankTransactionDto } from './dto/create-bank-transaction.dto';
import { LinkBankTransactionDto } from './dto/link-bank-transaction.dto';
import { PaymentService } from './payment.service';
import { PaymentTransactionService } from './payment-transaction.service';

@Controller('payment')
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly paymentTransactionService: PaymentTransactionService,
    private readonly sepaySignatureService: SepaySignatureService,
    private readonly sepayWebhookService: SepayWebhookService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('create')
  createPayment(@Req() req: any, @Body() body: CreatePaymentDto) {
    return this.paymentService.createPayment(
      req.user.userId,
      body.planCode,
      body.upgradeOption,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/confirm-user')
  confirmPaymentByUser(@Req() req: any, @Param('id') paymentId: string) {
    return this.paymentService.confirmPaymentByUser(req.user.userId, paymentId);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/cancel')
  cancelPayment(@Req() req: any, @Param('id') paymentId: string) {
    return this.paymentService.cancelPayment(req.user.userId, paymentId);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post(':id/confirm')
  confirmPayment(@Param('id') paymentId: string) {
    return this.paymentService.confirmPayment(paymentId);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('admin/transactions')
  recordBankTransaction(@Body() body: CreateBankTransactionDto) {
    return this.paymentTransactionService.recordBankTransaction(body);
  }
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('admin/transactions/:id/link')
  linkBankTransaction(
    @Param('id') transactionId: string,
    @Body() body: LinkBankTransactionDto,
  ) {
    return this.paymentTransactionService.linkBankTransaction(
      transactionId,
      body,
    );
  }
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('admin/transactions/:id/confirm-received')
  confirmTransactionReceived(@Param('id') transactionId: string) {
    return this.paymentTransactionService.confirmTransactionReceived(
      transactionId,
    );
  }
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('admin/transactions/:id/reconcile')
  reconcileBankTransaction(@Param('id') transactionId: string) {
    return this.paymentTransactionService.reconcileBankTransaction(
      transactionId,
    );
  }
  @Post('webhook/sepay')
  async handleSepayWebhook(
    @Body() body: SepayWebhookDto,
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-sepay-signature') signature: string,
    @Headers('x-sepay-timestamp') timestamp: string,
  ) {
    if (!req.rawBody) {
      throw new UnauthorizedException('Missing raw request body');
    }

    this.sepaySignatureService.verifySignature(
      req.rawBody,
      signature,
      timestamp,
    );

    return this.sepayWebhookService.handleWebhook(body);
  }
}
