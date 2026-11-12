import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StoreSettings } from './store-settings.service';
import { AppleStoreService } from './apple-store.service';
import { GoogleStoreService } from './google-store.service';
import { StoreBillingService } from './store-billing.service';
import { StoreBillingController } from './store-billing.controller';
@Module({
  imports: [PrismaModule],
  providers: [
    StoreSettings,
    AppleStoreService,
    GoogleStoreService,
    StoreBillingService,
  ],
  controllers: [StoreBillingController],
})
export class StoreBillingModule {}
