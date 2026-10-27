import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentTransactionService } from './payment-transaction.service';

@Module({
  imports: [PrismaModule],
  controllers: [PaymentController],
  providers: [PaymentService, PaymentTransactionService],
  exports: [PaymentService, PaymentTransactionService],
})
export class PaymentModule {}
