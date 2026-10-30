import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { SepaySignatureService } from './sepay-signature.service';

describe('SepaySignatureService', () => {
  const secret = 'test-only-sepay-secret';
  const nowSeconds = 1_798_000_000;
  const timestamp = String(nowSeconds);
  const rawBody = Buffer.from(
    JSON.stringify({
      id: 12345,
      transferType: 'in',
      transferAmount: 100000,
      content: 'NAP30291',
    }),
  );

  let service: SepaySignatureService;

  const makeSignature = (
    body: Buffer,
    requestTimestamp = timestamp,
    signingSecret = secret,
  ) =>
    `sha256=${createHmac('sha256', signingSecret)
      .update(`${requestTimestamp}.`)
      .update(body)
      .digest('hex')}`;

  beforeEach(() => {
    const configService = {
      get: jest.fn().mockReturnValue(secret),
    } as unknown as ConfigService;

    service = new SepaySignatureService(configService);
  });

  it('accepts a valid signature and timestamp', () => {
    expect(() =>
      service.verifySignature(
        rawBody,
        makeSignature(rawBody),
        timestamp,
        nowSeconds,
      ),
    ).not.toThrow();
  });

  it('rejects a modified payload', () => {
    const signature = makeSignature(rawBody);
    const modifiedBody = Buffer.from(
      JSON.stringify({ id: 12345, transferAmount: 999999 }),
    );

    expect(() =>
      service.verifySignature(modifiedBody, signature, timestamp, nowSeconds),
    ).toThrow(UnauthorizedException);
  });

  it('rejects an invalid signature', () => {
    expect(() =>
      service.verifySignature(
        rawBody,
        `sha256=${'0'.repeat(64)}`,
        timestamp,
        nowSeconds,
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a timestamp older than five minutes', () => {
    const oldTimestamp = String(nowSeconds - 301);

    expect(() =>
      service.verifySignature(
        rawBody,
        makeSignature(rawBody, oldTimestamp),
        oldTimestamp,
        nowSeconds,
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects missing signature headers', () => {
    expect(() =>
      service.verifySignature(rawBody, undefined, timestamp, nowSeconds),
    ).toThrow(UnauthorizedException);
  });

  it('fails safely when the webhook secret is not configured', () => {
    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    const unconfiguredService = new SepaySignatureService(configService);

    expect(() =>
      unconfiguredService.verifySignature(
        rawBody,
        makeSignature(rawBody),
        timestamp,
        nowSeconds,
      ),
    ).toThrow(ServiceUnavailableException);
  });
});
