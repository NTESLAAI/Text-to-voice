import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';

import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentTransactionService } from './payment-transaction.service';
import { SepaySignatureService } from './sepay-signature.service';
import { SepayWebhookService } from './sepay-webhook.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin/admin.guard';

describe('PaymentController - SePay webhook', () => {
  let app: INestApplication;

  const verifySignature = jest.fn();

  const paymentServiceMock = {};
  const recordBankTransaction = jest.fn();
  const paymentTransactionServiceMock = { recordBankTransaction };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: paymentServiceMock },
        {
          provide: PaymentTransactionService,
          useValue: paymentTransactionServiceMock,
        },
        {
          provide: SepaySignatureService,
          useValue: { verifySignature },
        },
        {
          provide: SepayWebhookService,
          useValue: {
            handleWebhook: jest.fn().mockResolvedValue({
              success: true,
            }),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );

    // Mô phỏng rawBody để kiểm thử Controller độc lập với cấu hình NestFactory.
    app.use(
      (
        req: Request & { rawBody?: Buffer },
        _res: Response,
        next: NextFunction,
      ) => {
        if (req.headers['x-skip-raw-body'] !== 'true') {
          req.rawBody = Buffer.from(JSON.stringify(req.body ?? {}));
        }
        next();
      },
    );

    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    verifySignature.mockReset();
    recordBankTransaction.mockReset();
  });

  const receipt = {
    receivingBankAccountId: 'd4508350-a842-4e57-9cfb-a38cd92e32f5',
    providerTransactionId: 'SYNTHETIC-RECEIPT',
    amount: 140,
    currency: 'VND',
    receivedAt: '2026-01-01T00:00:00.000Z',
  };

  it('keeps the production HTTP error envelope and hides raw server details', async () => {
    recordBankTransaction.mockRejectedValueOnce(
      new InternalServerErrorException({
        code: 'PAYMENT_ACTIVATION_FAILED',
        receiptStatus: 'MATCHED',
        activationStatus: 'FAILED',
        message: 'PRIVATE_SENTINEL',
      }),
    );
    const response = await request(app.getHttpServer())
      .post('/payment/admin/transactions')
      .send(receipt)
      .expect(500);
    expect(response.body).toMatchObject({
      statusCode: 500,
      code: 'PAYMENT_ACTIVATION_FAILED',
      receiptStatus: 'MATCHED',
      activationStatus: 'FAILED',
    });
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_SENTINEL');
  });

  it('passes a valid receipt DTO to the service once', async () => {
    recordBankTransaction.mockResolvedValue({ status: 'UNMATCHED' });
    await request(app.getHttpServer())
      .post('/payment/admin/transactions')
      .send(receipt)
      .expect(201)
      .expect({ status: 'UNMATCHED' });
    expect(recordBankTransaction).toHaveBeenCalledTimes(1);
    expect(recordBankTransaction).toHaveBeenCalledWith(receipt);
  });

  it.each([
    'verificationSource',
    'sourceVerifiedAt',
    'sourceVerifiedById',
    'policy',
    'unknownField',
  ])(
    'rejects extra receipt field %s before calling the service',
    async (field) => {
      await request(app.getHttpServer())
        .post('/payment/admin/transactions')
        .send({ ...receipt, [field]: 'SYNTHETIC' })
        .expect(400);
      expect(recordBankTransaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    { receivingBankAccountId: 'invalid' },
    { amount: 0 },
    { currency: 'USD' },
    { receivedAt: 'invalid' },
    { providerTransactionId: null },
  ])('rejects invalid receipt DTO %j', async (invalid) => {
    await request(app.getHttpServer())
      .post('/payment/admin/transactions')
      .send({ ...receipt, ...invalid })
      .expect(400);
    expect(recordBankTransaction).not.toHaveBeenCalled();
  });

  const validPayload = {
    id: 123456,
    gateway: 'Vietcombank',
    transactionDate: '2026-10-30 10:00:00',
    accountNumber: '123456789',
    subAccount: null,
    code: null,
    content: 'Thanh toan KH123456',
    transferType: 'in',
    transferAmount: 100000,
    accumulated: 100000,
    referenceCode: 'FT123456',
  };

  it('accepts a valid webhook and verifies its signature', async () => {
    verifySignature.mockReturnValue(undefined);

    await request(app.getHttpServer())
      .post('/payment/webhook/sepay')
      .set('x-sepay-signature', 'sha256=test')
      .set('x-sepay-timestamp', '1793354400')
      .send(validPayload)
      .expect(201)
      .expect({
        success: true,
      });

    expect(verifySignature).toHaveBeenCalledTimes(1);

    const [rawBody, signature, timestamp] = verifySignature.mock.calls[0];

    expect(Buffer.isBuffer(rawBody)).toBe(true);
    expect(signature).toBe('sha256=test');
    expect(timestamp).toBe('1793354400');
  });

  it('rejects a webhook when signature verification fails', async () => {
    verifySignature.mockImplementation(() => {
      throw new UnauthorizedException('Invalid SePay signature');
    });

    await request(app.getHttpServer())
      .post('/payment/webhook/sepay')
      .set('x-sepay-signature', 'sha256=invalid')
      .set('x-sepay-timestamp', '1793354400')
      .send(validPayload)
      .expect(401);
  });

  it('rejects a webhook when rawBody is missing', async () => {
    await request(app.getHttpServer())
      .post('/payment/webhook/sepay')
      .set('x-skip-raw-body', 'true')
      .set('x-sepay-signature', 'sha256=test')
      .set('x-sepay-timestamp', '1793354400')
      .send(validPayload)
      .expect(401);

    expect(verifySignature).not.toHaveBeenCalled();
  });

  it('rejects an invalid transferType before signature verification', async () => {
    const invalidPayload = {
      ...validPayload,
      transferType: 'unknown',
    };

    await request(app.getHttpServer())
      .post('/payment/webhook/sepay')
      .set('x-sepay-signature', 'sha256=test')
      .set('x-sepay-timestamp', '1793354400')
      .send(invalidPayload)
      .expect(400);

    expect(verifySignature).not.toHaveBeenCalled();
  });

  it('rejects a webhook when transaction ID is missing', async () => {
    const { id, ...invalidPayload } = validPayload;

    await request(app.getHttpServer())
      .post('/payment/webhook/sepay')
      .set('x-sepay-signature', 'sha256=test')
      .set('x-sepay-timestamp', '1793354400')
      .send(invalidPayload)
      .expect(400);

    expect(verifySignature).not.toHaveBeenCalled();
  });
});
