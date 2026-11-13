import {
  isolateBankPolicy,
  sourceFixture,
} from '../../test/jest-mocks/receiving-bank.fixture';
import { Prisma } from '../../generated/prisma/client';
import { SepayWebhookService } from './sepay-webhook.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentService } from './payment.service';
import { SepayWebhookDto } from './dto/sepay-webhook.dto';
import { ConfigService } from '@nestjs/config';

describe('SepayWebhookService', () => {
  let service: SepayWebhookService;

  let prisma: {
    paymentTransaction: {
      findFirst: jest.Mock;
      create: jest.Mock;
    };
    payment: {
      findUnique: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  let tx: {
    payment: {
      findUnique: jest.Mock;
    };
    paymentTransaction: {
      create: jest.Mock;
    };
    $queryRaw: jest.Mock;
  };

  let paymentService: {
    confirmPayment: jest.Mock;
  };

  const validCode = 'KH-ABCDEFGH';

  const makeBody = (
    overrides: Partial<SepayWebhookDto> = {},
  ): SepayWebhookDto =>
    ({
      id: 12345,
      transferType: 'in',
      transferAmount: 100000,
      code: validCode,
      content: `Thanh toan ${validCode}`,
      gateway: 'Vietcombank',
      accountNumber: 'mock-test-account',
      transactionDate: '2026-10-31T10:00:00+07:00',
      ...overrides,
    }) as SepayWebhookDto;

  beforeEach(() => {
    isolateBankPolicy();
    tx = {
      payment: {
        findUnique: jest.fn(),
      },
      paymentTransaction: {
        create: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    prisma = {
      paymentTransaction: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      payment: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };

    paymentService = {
      confirmPayment: jest.fn().mockResolvedValue(undefined),
    };

    service = new SepayWebhookService(
      prisma as unknown as PrismaService,
      paymentService as unknown as PaymentService,
      {
        get: (key: string) =>
          key === 'BANK_TRANSFER_ACCOUNT_NUMBER'
            ? 'mock-test-account'
            : 'Vietcombank',
      } as unknown as ConfigService,
    );
  });

  it('ignores outgoing transfers', async () => {
    const result = await service.handleWebhook(
      makeBody({ transferType: 'out' }),
    );

    expect(result).toEqual({ success: true });
    expect(prisma.paymentTransaction.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns duplicate without retry when existing transaction is unmatched', async () => {
    prisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'tx-1',
      amount: 100000,
      currency: 'VND',
      status: 'UNMATCHED',
      receivingBankAccountId: 'bank-fixture',
      paymentId: null,
    });

    const result = await service.handleWebhook(makeBody());

    expect(result).toEqual({ success: true, duplicate: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(paymentService.confirmPayment).not.toHaveBeenCalled();
  });

  it('stores incoming transfer as unmatched when no transfer code exists', async () => {
    const result = await service.handleWebhook(
      makeBody({
        code: '',
        content: 'No payment reference',
      }),
    );

    expect(result).toEqual({ success: true, matched: false });
    expect(tx.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: 'SEPAY',
        providerTransactionId: '12345',
        status: 'UNMATCHED',
        receivingBankAccountId: 'bank-fixture',
        currency: 'VND',
      }),
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('stores transaction as unmatched when payment is not found', async () => {
    tx.payment.findUnique.mockResolvedValue(null);

    const result = await service.handleWebhook(makeBody());

    expect(result).toEqual({ success: true, matched: false });
    expect(tx.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: 'SEPAY',
        providerTransactionId: '12345',
        status: 'UNMATCHED',
        receivingBankAccountId: 'bank-fixture',
        currency: 'VND',
      }),
    });
    expect(paymentService.confirmPayment).not.toHaveBeenCalled();
  });

  it('stores transaction as unmatched when payment is not pending', async () => {
    tx.payment.findUnique.mockResolvedValue({
      id: 'payment-1',
      status: 'PAID',
      currency: 'VND',
    });

    const result = await service.handleWebhook(makeBody());

    expect(result).toEqual({ success: true, matched: false });
    expect(tx.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'UNMATCHED',
        receivingBankAccountId: 'bank-fixture',
        note: 'SEPAY_PAYMENT_NOT_PENDING',
      }),
    });
    expect(paymentService.confirmPayment).not.toHaveBeenCalled();
  });

  it('matches a valid payment and confirms it after transaction', async () => {
    tx.payment.findUnique
      .mockResolvedValueOnce({
        id: 'payment-1',
        status: 'PENDING',
        receivingBankAccountId: 'bank-fixture',
        currency: 'VND',
      })
      .mockResolvedValueOnce({
        id: 'payment-1',
        status: 'PENDING',
        receivingBankAccountId: 'bank-fixture',
        currency: 'VND',
      });

    const result = await service.handleWebhook(makeBody());

    expect(result).toEqual({ success: true, matched: true });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: 'payment-1',
        provider: 'SEPAY',
        providerTransactionId: '12345',
        status: 'MATCHED',
        receivingBankAccountId: 'bank-fixture',
        currency: 'VND',
      }),
    });
    expect(paymentService.confirmPayment).toHaveBeenCalledWith('payment-1');
  });

  it('stores as unmatched if payment status changes before processing', async () => {
    tx.payment.findUnique
      .mockResolvedValueOnce({
        id: 'payment-1',
        status: 'PENDING',
        receivingBankAccountId: 'bank-fixture',
        currency: 'VND',
      })
      .mockResolvedValueOnce({
        id: 'payment-1',
        status: 'PAID',
        currency: 'VND',
      });

    const result = await service.handleWebhook(makeBody());

    expect(result).toEqual({ success: true, matched: false });
    expect(tx.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'UNMATCHED',
        receivingBankAccountId: 'bank-fixture',
        note: 'SEPAY_PAYMENT_NOT_PENDING',
      }),
    });
    expect(paymentService.confirmPayment).not.toHaveBeenCalled();
  });

  it('returns duplicate when transaction creation raises P2002', async () => {
    const duplicateError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: 'test',
      },
    );

    prisma.$transaction.mockRejectedValue(duplicateError);
    prisma.paymentTransaction.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'tx-duplicate',
        amount: 100000,
        currency: 'VND',
        status: 'UNMATCHED',
        receivingBankAccountId: 'bank-fixture',
        paymentId: null,
      });

    const result = await service.handleWebhook(makeBody());

    expect(result).toEqual({ success: true, duplicate: true });
    expect(prisma.paymentTransaction.findFirst).toHaveBeenCalledTimes(2);
    expect(paymentService.confirmPayment).not.toHaveBeenCalled();
  });

  it('rethrows the original P2002 when no duplicate transaction exists', async () => {
    const originalError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: 'test' },
    );
    prisma.$transaction.mockRejectedValue(originalError);
    prisma.paymentTransaction.findFirst.mockResolvedValue(null);

    await expect(service.handleWebhook(makeBody())).rejects.toBe(originalError);
    expect(prisma.paymentTransaction.findFirst).toHaveBeenCalledTimes(2);
    expect(paymentService.confirmPayment).not.toHaveBeenCalled();
  });

  it('rethrows unexpected transaction errors', async () => {
    const error = new Error('Unexpected database error');
    prisma.$transaction.mockRejectedValue(error);

    await expect(service.handleWebhook(makeBody())).rejects.toThrow(
      'Unexpected database error',
    );
  });

  it('extracts transfer code from content when code field is absent', async () => {
    tx.payment.findUnique
      .mockResolvedValueOnce({
        id: 'payment-1',
        status: 'USER_CONFIRMED',
        receivingBankAccountId: 'bank-fixture',
        currency: 'VND',
      })
      .mockResolvedValueOnce({
        id: 'payment-1',
        status: 'USER_CONFIRMED',
        receivingBankAccountId: 'bank-fixture',
        currency: 'VND',
      });

    const result = await service.handleWebhook(
      makeBody({
        code: '',
        content: `Payment ${validCode}`,
      }),
    );

    expect(result).toEqual({ success: true, matched: true });
    expect(tx.payment.findUnique).toHaveBeenCalledWith({
      where: { transferCode: validCode },
      select: {
        id: true,
        status: true,
        currency: true,
        receivingBankAccountId: true,
      },
    });
  });
  it('retries confirmation when transaction creation raises P2002 and matched transaction exists', async () => {
    const duplicateError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: 'test',
      },
    );

    prisma.$transaction.mockRejectedValue(duplicateError);

    prisma.paymentTransaction.findFirst
      .mockResolvedValueOnce(null) // initial idempotency lookup
      .mockResolvedValueOnce({
        id: 'tx-1',
        amount: 100000,
        currency: 'VND',
        status: 'MATCHED',
        receivingBankAccountId: 'bank-fixture',
        paymentId: 'payment-1',
      }); // lookup after P2002

    prisma.payment.findUnique.mockResolvedValue({
      id: 'payment-1',
      status: 'PENDING',
      receivingBankAccountId: 'bank-fixture',
    });

    const result = await service.handleWebhook(makeBody());

    expect(result).toEqual({
      success: true,
      duplicate: true,
      retried: true,
    });

    expect(prisma.paymentTransaction.findFirst).toHaveBeenCalledTimes(2);
    expect(paymentService.confirmPayment).toHaveBeenCalledTimes(1);
    expect(paymentService.confirmPayment).toHaveBeenCalledWith('payment-1');
  });

  it('does not retry confirmation when matched payment is already paid', async () => {
    prisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'tx-1',
      amount: 100000,
      currency: 'VND',
      status: 'MATCHED',
      receivingBankAccountId: 'bank-fixture',
      paymentId: 'payment-1',
    });
    prisma.payment.findUnique.mockResolvedValue({
      id: 'payment-1',
      status: 'PAID',
    });

    const result = await service.handleWebhook(makeBody());

    expect(result).toEqual({ success: true, duplicate: true });
    expect(paymentService.confirmPayment).not.toHaveBeenCalled();
  });

  it('does not retry when matched transaction payment is not pending', async () => {
    prisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'tx-1',
      amount: 100000,
      currency: 'VND',
      status: 'MATCHED',
      receivingBankAccountId: 'bank-fixture',
      paymentId: 'payment-1',
    });
    prisma.payment.findUnique.mockResolvedValue({
      id: 'payment-1',
      status: 'CANCELLED',
    });

    const result = await service.handleWebhook(makeBody());

    expect(result).toEqual({ success: true, duplicate: true });
    expect(paymentService.confirmPayment).not.toHaveBeenCalled();
  });
});
