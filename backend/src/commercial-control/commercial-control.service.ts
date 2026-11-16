import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CommercialControlService {
  constructor(private readonly configService: ConfigService) {}

  isPaymentsEnabled(): boolean {
    return (
      this.configService.get<string>('PAYMENTS_ENABLED')?.trim() === 'true'
    );
  }

  assertPaymentsEnabled(): void {
    if (!this.isPaymentsEnabled()) {
      throw new ServiceUnavailableException('PAYMENTS_DISABLED');
    }
  }
}
