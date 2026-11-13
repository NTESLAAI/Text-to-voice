import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

describe('Production error contract (no database)', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  function render(error: unknown) {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(error, host);
    return {
      status: response.status.mock.calls[0][0],
      body: response.json.mock.calls[0][0],
    };
  }
  it('preserves committed receipt and failed activation diagnostics without exception details', () => {
    const r = render(
      new InternalServerErrorException({
        code: 'PAYMENT_ACTIVATION_FAILED',
        receiptStatus: 'MATCHED',
        activationStatus: 'FAILED',
        message: 'PRIVATE_SENTINEL',
        stack: 'PRIVATE_SENTINEL',
        token: 'PRIVATE_SENTINEL',
      }),
    );
    expect(r.status).toBe(500);
    expect(r.body).toEqual({
      statusCode: 500,
      message: expect.any(String),
      code: 'PAYMENT_ACTIVATION_FAILED',
      receiptStatus: 'MATCHED',
      activationStatus: 'FAILED',
    });
    expect(JSON.stringify(r)).not.toContain('PRIVATE_SENTINEL');
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_SENTINEL');
  });
  it('preserves underfunded code and existing message', () => {
    expect(
      render(
        new BadRequestException({
          code: 'PAYMENT_UNDERFUNDED',
          message: 'Insufficient funds',
          extra: 'PRIVATE_SENTINEL',
        }),
      ).body,
    ).toEqual({
      statusCode: 400,
      code: 'PAYMENT_UNDERFUNDED',
      message: 'Insufficient funds',
    });
  });
  it.each([400, 401, 403, 409, 429])(
    'preserves HTTP %s used by Web and Mobile',
    (status) => {
      expect(render(new HttpException('SAFE_MESSAGE', status))).toEqual({
        status,
        body: { statusCode: status, message: 'SAFE_MESSAGE' },
      });
    },
  );
  it('preserves validation messages as the existing string contract', () => {
    expect(
      render(
        new BadRequestException({
          message: ['Invalid field', 'Missing field'],
        }),
      ).body.message,
    ).toBe('Invalid field, Missing field');
  });
  it.each([
    new Error('PRIVATE_SENTINEL'),
    new InternalServerErrorException('PRIVATE_SENTINEL'),
    new HttpException(
      { code: 'PRIVATE_SENTINEL', detail: 'PRIVATE_SENTINEL' },
      503,
    ),
  ])('hides unexpected server errors', (error) => {
    const r = render(error);
    expect(JSON.stringify(r)).not.toContain('PRIVATE_SENTINEL');
    expect(r.body).not.toHaveProperty('code');
  });
  it('rejects unknown enum values and extra fields', () => {
    const r = render(
      new InternalServerErrorException({
        code: 'PAYMENT_ACTIVATION_FAILED',
        receiptStatus: 'PRIVATE_SENTINEL',
        activationStatus: 'PRIVATE_SENTINEL',
        password: 'PRIVATE_SENTINEL',
      }),
    );
    expect(r.body.code).toBe('PAYMENT_ACTIVATION_FAILED');
    expect(r.body).not.toHaveProperty('receiptStatus');
    expect(r.body).not.toHaveProperty('activationStatus');
    expect(JSON.stringify(r)).not.toContain('PRIVATE_SENTINEL');
  });
  it('does not promote an activation error to success', () => {
    expect(
      render(
        new HttpException(
          { code: 'PAYMENT_ACTIVATION_FAILED', activationStatus: 'ACTIVATED' },
          400,
        ),
      ).body,
    ).not.toHaveProperty('activationStatus');
  });
});
