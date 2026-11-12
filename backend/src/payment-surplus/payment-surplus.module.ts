import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentSurplusController } from './payment-surplus.controller';
import { PaymentSurplusService } from './payment-surplus.service';

@Module({
  imports: [PrismaModule],
  controllers: [PaymentSurplusController],
  providers: [PaymentSurplusService],
})
export class PaymentSurplusModule {}
