import { Module } from '@nestjs/common';
import { CommercialControlService } from './commercial-control.service';

@Module({
  providers: [CommercialControlService],
  exports: [CommercialControlService],
})
export class CommercialControlModule {}
