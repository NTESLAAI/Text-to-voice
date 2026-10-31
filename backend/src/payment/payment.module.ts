import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentTransactionService } from './payment-transaction.service';
import { SepaySignatureService } from './sepay-signature.service';
import { SepayWebhookService } from './sepay-webhook.service';

@Module({
  imports: [PrismaModule],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    PaymentTransactionService,
    SepaySignatureService,
    SepayWebhookService,
  ],
  exports: [PaymentService, PaymentTransactionService],
})
export class PaymentModule {}
