import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentSurplusService } from './payment-surplus.service';

describe('PaymentSurplusService', () => {
  const tx = {
    payment: { findUnique: jest.fn() },
    paymentSurplusHandling: { findMany: jest.fn() },
  };
  const prisma = { $transaction: jest.fn() };
  const service = new PaymentSurplusService(prisma as unknown as PrismaService);
  const handling = (status: string, amount: string, extra = {}) => ({
    id: `handling-${status}`,
    paymentId: 'payment-1',
    action: 'REFUND',
    status,
    amount: new Prisma.Decimal(amount),
    currency: 'VND',
    idempotencyKey: `key-${status}`,
    creditRemainingAmount: new Prisma.Decimal(0),
    effectivePlanPriceSnapshot: null,
    planCharacterLimitSnapshot: null,
    planDurationDaysSnapshot: null,
    convertedCharacters: null,
    convertedSeconds: null,
    note: null,
    externalReference: null,
    createdById: 'admin-1',
    completedById: null,
    cancelledById: null,
    createdAt: new Date('2026-11-03T00:00:00Z'),
    updatedAt: new Date('2026-11-03T00:00:00Z'),
    completedAt: null,
    cancelledAt: null,
    ...extra,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    tx.payment.findUnique.mockResolvedValue({
      id: 'payment-1',
      amount: 100,
      currency: 'VND',
      transactions: [{ amount: 140, currency: 'VND' }],
    });
    tx.paymentSurplusHandling.findMany.mockResolvedValue([]);
  });

  it('reads MATCHED transactions in a RepeatableRead snapshot', async () => {
    const result = await service.getSurplus('payment-1');
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(tx.payment.findUnique).toHaveBeenCalledWith({
      where: { id: 'payment-1' },
      select: {
        id: true,
        amount: true,
        currency: true,
        receivingBankAccountId: true,
        transactions: {
          where: { status: 'MATCHED' },
          select: {
            amount: true,
            currency: true,
            provider: true,
            providerTransactionId: true,
            status: true,
            matchedAt: true,
            receivingBankAccountId: true,
            receivingBankAccount: true,
            verificationSource: true,
            sourceVerifiedAt: true,
            sourceVerifiedById: true,
            verificationReference: true,
          },
        },
      },
    });
    expect(result).toMatchObject({
      totalMatched: '140',
      totalSurplus: '40',
      allocatedAmount: '0',
      availableSurplus: '40',
      history: [],
    });
    expect(tx.paymentSurplusHandling.findMany).toHaveBeenCalledWith({
      where: { paymentId: 'payment-1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('adds fractional amounts without floating-point arithmetic', async () => {
    tx.payment.findUnique.mockResolvedValue({
      id: 'payment-1',
      amount: 0.1,
      currency: 'VND',
      transactions: [
        { amount: 0.1, currency: 'VND' },
        { amount: 0.2, currency: 'VND' },
      ],
    });
    tx.paymentSurplusHandling.findMany.mockResolvedValue([
      handling('PENDING', '0.1'),
    ]);
    expect(await service.getSurplus('payment-1')).toMatchObject({
      totalMatched: '0.3',
      totalSurplus: '0.2',
      allocatedAmount: '0.1',
      availableSurplus: '0.1',
    });
  });

  it.each([
    ['PENDING', '12'],
    ['COMPLETED', '12'],
    ['CANCELLED', '0'],
  ])('handles allocation status %s', async (status, expected) => {
    tx.paymentSurplusHandling.findMany.mockResolvedValue([
      handling(status, '12'),
    ]);
    const result = await service.getSurplus('payment-1');
    expect(result.allocatedAmount).toBe(expected);
    expect(result.history).toHaveLength(1);
  });

  it('combines pending and completed allocations, retaining cancelled history', async () => {
    tx.paymentSurplusHandling.findMany.mockResolvedValue([
      handling('PENDING', '10'),
      handling('COMPLETED', '15'),
      handling('CANCELLED', '100'),
    ]);
    expect(await service.getSurplus('payment-1')).toMatchObject({
      allocatedAmount: '25',
      availableSurplus: '15',
    });
  });

  it.each([0, 80, 100])(
    'returns zero surplus for matched total %s',
    async (amount) => {
      tx.payment.findUnique.mockResolvedValue({
        id: 'payment-1',
        amount: 100,
        currency: 'VND',
        transactions: amount ? [{ amount, currency: 'VND' }] : [],
      });
      expect(await service.getSurplus('payment-1')).toMatchObject({
        totalSurplus: '0',
        availableSurplus: '0',
      });
    },
  );

  it('allows allocating exactly the surplus', async () => {
    tx.paymentSurplusHandling.findMany.mockResolvedValue([
      handling('PENDING', '40'),
    ]);
    expect((await service.getSurplus('payment-1')).availableSurplus).toBe('0');
  });

  it('reports data corruption instead of hiding over-allocation', async () => {
    tx.paymentSurplusHandling.findMany.mockResolvedValue([
      handling('COMPLETED', '40.000001'),
    ]);
    await expect(service.getSurplus('payment-1')).rejects.toThrow(
      'Lỗi dữ liệu: số tiền đã phân bổ vượt tổng tiền dư.',
    );
  });

  it('rejects any MATCHED transaction with another currency', async () => {
    tx.payment.findUnique.mockResolvedValue({
      id: 'payment-1',
      amount: 100,
      currency: 'VND',
      transactions: [
        { amount: 140, currency: 'VND' },
        { amount: 1, currency: 'USD' },
      ],
    });
    await expect(service.getSurplus('payment-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(tx.paymentSurplusHandling.findMany).not.toHaveBeenCalled();
  });

  it('rejects allocations with another currency', async () => {
    tx.paymentSurplusHandling.findMany.mockResolvedValue([
      handling('PENDING', '1', { currency: 'USD' }),
    ]);
    await expect(service.getSurplus('payment-1')).rejects.toThrow(
      'Lỗi dữ liệu: phân bổ tiền dư sai loại tiền tệ.',
    );
  });

  it('returns 404 without reading history when payment is missing', async () => {
    tx.payment.findUnique.mockResolvedValue(null);
    await expect(service.getSurplus('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.paymentSurplusHandling.findMany).not.toHaveBeenCalled();
  });

  it('serializes history Decimal and BigInt fields without losing precision', async () => {
    tx.paymentSurplusHandling.findMany.mockResolvedValue([
      handling('COMPLETED', '1.123456', {
        action: 'DAYS',
        convertedSeconds: 9007199254740993n,
        effectivePlanPriceSnapshot: new Prisma.Decimal('123.456789'),
      }),
    ]);
    const result = await service.getSurplus('payment-1');
    expect(result.history[0]).toMatchObject({
      amount: '1.123456',
      creditRemainingAmount: '0',
      effectivePlanPriceSnapshot: '123.456789',
      convertedSeconds: '9007199254740993',
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
