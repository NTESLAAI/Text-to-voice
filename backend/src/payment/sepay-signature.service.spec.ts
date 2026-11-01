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

  const createService = (configuredSecret: string | undefined) => {
    const configService = {
      get: jest.fn().mockReturnValue(configuredSecret),
    } as unknown as ConfigService;

    return new SepaySignatureService(configService);
  };

  beforeEach(() => {
    service = createService(secret);
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

  it('rejects a timestamp more than five minutes in the future', () => {
    const futureTimestamp = String(nowSeconds + 301);

    expect(() =>
      service.verifySignature(
        rawBody,
        makeSignature(rawBody, futureTimestamp),
        futureTimestamp,
        nowSeconds,
      ),
    ).toThrow(UnauthorizedException);
  });

  it('accepts timestamps exactly at the five-minute boundary', () => {
    for (const boundaryTimestamp of [
      String(nowSeconds - 300),
      String(nowSeconds + 300),
    ]) {
      expect(() =>
        service.verifySignature(
          rawBody,
          makeSignature(rawBody, boundaryTimestamp),
          boundaryTimestamp,
          nowSeconds,
        ),
      ).not.toThrow();
    }
  });

  it.each(['', 'abc', '12.34', '-123', ' 123', '123 '])(
    'rejects malformed timestamp: "%s"',
    (malformedTimestamp) => {
      expect(() =>
        service.verifySignature(
          rawBody,
          makeSignature(rawBody, malformedTimestamp),
          malformedTimestamp,
          nowSeconds,
        ),
      ).toThrow(UnauthorizedException);
    },
  );

  it('rejects a timestamp outside the safe integer range', () => {
    const unsafeTimestamp = '9007199254740992';

    expect(() =>
      service.verifySignature(
        rawBody,
        makeSignature(rawBody, unsafeTimestamp),
        unsafeTimestamp,
        nowSeconds,
      ),
    ).toThrow(UnauthorizedException);
  });

  it.each([
    undefined,
    '',
    '0'.repeat(64),
    `sha256=${'0'.repeat(63)}`,
    `sha256=${'g'.repeat(64)}`,
    `SHA256=${'a'.repeat(64)}`,
    `sha256=${'a'.repeat(64)}extra`,
  ])('rejects malformed signature header: %s', (signatureHeader) => {
    expect(() =>
      service.verifySignature(rawBody, signatureHeader, timestamp, nowSeconds),
    ).toThrow(UnauthorizedException);
  });

  it('accepts a valid signature with uppercase hexadecimal characters', () => {
    const signature = makeSignature(rawBody).toUpperCase();
    const normalizedSignature = `sha256=${signature.slice('SHA256='.length)}`;

    expect(() =>
      service.verifySignature(
        rawBody,
        normalizedSignature,
        timestamp,
        nowSeconds,
      ),
    ).not.toThrow();
  });

  it('rejects missing timestamp header', () => {
    expect(() =>
      service.verifySignature(
        rawBody,
        makeSignature(rawBody),
        undefined,
        nowSeconds,
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a non-Buffer request body', () => {
    expect(() =>
      service.verifySignature(
        'not-a-buffer' as unknown as Buffer,
        makeSignature(rawBody),
        timestamp,
        nowSeconds,
      ),
    ).toThrow(UnauthorizedException);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])(
    'fails safely when the webhook secret is not configured: %s',
    (_label, configuredSecret) => {
      const unconfiguredService = createService(configuredSecret);

      expect(() =>
        unconfiguredService.verifySignature(
          rawBody,
          makeSignature(rawBody),
          timestamp,
          nowSeconds,
        ),
      ).toThrow(ServiceUnavailableException);
    },
  );
});
