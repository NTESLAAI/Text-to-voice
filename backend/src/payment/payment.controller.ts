import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  BadRequestException,
  ValidationPipe,
  createParamDecorator,
  ExecutionContext,
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
import { VerifyBankReceiptDto } from './dto/verify-bank-receipt.dto';

// Preserve the original body until this endpoint's strict DTO validation runs.
// The global pipe intentionally does not validate custom parameter decorators.
const ReceiptBody = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<Request>().body,
);

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
  recordBankTransaction(
    @ReceiptBody(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        validateCustomDecorators: true,
      }),
    )
    body: CreateBankTransactionDto,
  ) {
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
  confirmTransactionReceived(
    @Param('id') transactionId: string,
    @Req() req: { user: { userId: string } },
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    body: VerifyBankReceiptDto,
  ) {
    return this.paymentTransactionService.confirmTransactionReceived(
      transactionId,
      req.user.userId,
      body.evidenceReference,
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

    // SePay test webhook: xác thực chữ ký nhưng không xử lý giao dịch.
    if (body.id === 0 && body.code === 'SEPAYTEST') {
      return { success: true, test: true };
    }

    // Giao dịch thật phải có ID hợp lệ.
    if (body.id < 1) {
      throw new BadRequestException('Invalid SePay transaction id');
    }

    return this.sepayWebhookService.handleWebhook(body);
  }
}
