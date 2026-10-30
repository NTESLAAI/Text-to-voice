import {
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

@Injectable()
export class SepaySignatureService {
  private readonly maxTimestampDifferenceSeconds = 300;

  constructor(private readonly configService: ConfigService) {}

  verifySignature(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    timestampHeader: string | undefined,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): void {
    const secret = this.configService
      .get<string>('SEPAY_WEBHOOK_SECRET')
      ?.trim();

    if (!secret) {
      throw new ServiceUnavailableException(
        'SePay webhook is not configured',
      );
    }

    if (
      !Buffer.isBuffer(rawBody) ||
      !signatureHeader ||
      !timestampHeader
    ) {
      throw new UnauthorizedException('Invalid SePay signature headers');
    }

    if (!/^\d+$/.test(timestampHeader)) {
      throw new UnauthorizedException('Invalid SePay timestamp');
    }

    const timestamp = Number(timestampHeader);

    if (
      !Number.isSafeInteger(timestamp) ||
      Math.abs(nowSeconds - timestamp) >
        this.maxTimestampDifferenceSeconds
    ) {
      throw new UnauthorizedException('Expired SePay webhook');
    }

    const match = /^sha256=([a-fA-F0-9]{64})$/.exec(
      signatureHeader,
    );

    if (!match) {
      throw new UnauthorizedException('Invalid SePay signature format');
    }

    const expected = createHmac('sha256', secret)
      .update(`${timestampHeader}.`)
      .update(rawBody)
      .digest();

    const received = Buffer.from(match[1], 'hex');

    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      throw new UnauthorizedException('Invalid SePay signature');
    }
  }
}
