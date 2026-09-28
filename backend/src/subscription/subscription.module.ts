import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SubscriptionService } from './subscription.service';
import { SubscriptionExpiryService } from './subscription-expiry.service';
import { SubscriptionController } from './subscription.controller';

@Module({
  imports: [PrismaModule],
  providers: [SubscriptionService, SubscriptionExpiryService],
  exports: [SubscriptionService],
  controllers: [SubscriptionController],
})
export class SubscriptionModule {}