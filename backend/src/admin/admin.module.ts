import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { PaymentModule } from '../payment/payment.module';
import { UsersModule } from '../users/users.module';
import { PaymentSurplusModule } from '../payment-surplus/payment-surplus.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [PrismaModule, PaymentModule, UsersModule, PaymentSurplusModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
