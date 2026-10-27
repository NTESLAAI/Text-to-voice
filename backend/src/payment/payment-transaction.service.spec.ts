import { ConflictException, BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import { PaymentTransactionService } from './payment-transaction.service';
import { LinkBankTransactionDto } from './dto/link-bank-transaction.dto';

describe('PaymentTransactionService', () => {
  let service: PaymentTransactionService;

  const tx = {
    $queryRaw: jest.fn(),
    paymentTransaction: {
      update: jest.fn(),
    },
  };

  const prisma = {
    paymentTransaction: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const validDto = {
    providerTransactionId: 'BANK-TX-001',
    amount: 500000,
    currency: 'VND',
    reference: 'Thanh toan don hang',
    note: 'Sao ke ngan hang',
    receivedAt: '2026-10-26T09:00:00.000Z',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      (callback: (transaction: typeof tx) => unknown) => callback(tx),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentTransactionService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
      ],
    }).compile();

    service = module.get<PaymentTransactionService>(PaymentTransactionService);
  });

  it('records a new bank transaction as UNMATCHED', async () => {
    prisma.paymentTransaction.findUnique.mockResolvedValue(null);
    prisma.paymentTransaction.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'transaction-001', ...data }),
    );

    const result = await service.recordBankTransaction(validDto);

    expect(prisma.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: 'BANK_TRANSFER',
        providerTransactionId: 'BANK-TX-001',
        amount: 500000,
        currency: 'VND',
        status: 'UNMATCHED',
      }),
    });
    expect(result.status).toBe('UNMATCHED');
  });

  it('rejects a duplicate bank transaction ID', async () => {
    prisma.paymentTransaction.findUnique.mockResolvedValue({
      id: 'transaction-existing',
    });

    await expect(
      service.recordBankTransaction(validDto),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.paymentTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects a blank bank transaction ID', async () => {
    await expect(
      service.recordBankTransaction({
        ...validDto,
        providerTransactionId: '   ',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-positive amount', async () => {
    await expect(
      service.recordBankTransaction({
        ...validDto,
        amount: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a duplicate created concurrently', async () => {
    prisma.paymentTransaction.findUnique.mockResolvedValue(null);

    prisma.paymentTransaction.create.mockRejectedValue({
      code: 'P2002',
    });

    await expect(
      service.recordBankTransaction(validDto),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  describe('linkBankTransaction', () => {
    const linkDto: LinkBankTransactionDto = {
      paymentId: 'payment-001',
    };

    const payment = {
      id: 'payment-001',
      status: 'PENDING',
      currency: 'VND',
    };

    const transaction = {
      id: 'transaction-001',
      paymentId: null,
      status: 'UNMATCHED',
      currency: 'VND',
    };

    beforeEach(() => {
      tx.$queryRaw
        .mockResolvedValueOnce([payment])
        .mockResolvedValueOnce([transaction]);

      tx.paymentTransaction.update.mockResolvedValue({
        ...transaction,
        paymentId: linkDto.paymentId,
      });
    });

    it('links a transaction without changing its UNMATCHED status', async () => {
      const result = await service.linkBankTransaction(
        'transaction-001',
        linkDto,
      );

      expect(tx.paymentTransaction.update).toHaveBeenCalledWith({
        where: { id: 'transaction-001' },
        data: { paymentId: 'payment-001' },
      });
      expect(result.paymentId).toBe('payment-001');
      expect(result.status).toBe('UNMATCHED');
    });

    it('rejects when the payment does not exist', async () => {
      tx.$queryRaw.mockReset().mockResolvedValueOnce([]);

      await expect(
        service.linkBankTransaction('transaction-001', linkDto),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.paymentTransaction.update).not.toHaveBeenCalled();
    });

    it.each(['PAID', 'CANCELLED'])(
      'rejects a payment with status %s',
      async (status) => {
        tx.$queryRaw
          .mockReset()
          .mockResolvedValueOnce([{ ...payment, status }]);

        await expect(
          service.linkBankTransaction('transaction-001', linkDto),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(tx.paymentTransaction.update).not.toHaveBeenCalled();
      },
    );

    it('rejects a transaction already linked to a payment', async () => {
      tx.$queryRaw
        .mockReset()
        .mockResolvedValueOnce([payment])
        .mockResolvedValueOnce([
          { ...transaction, paymentId: 'payment-other' },
        ]);

      await expect(
        service.linkBankTransaction('transaction-001', linkDto),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(tx.paymentTransaction.update).not.toHaveBeenCalled();
    });

    it('rejects a currency mismatch', async () => {
      tx.$queryRaw
        .mockReset()
        .mockResolvedValueOnce([payment])
        .mockResolvedValueOnce([{ ...transaction, currency: 'USD' }]);

      await expect(
        service.linkBankTransaction('transaction-001', linkDto),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.paymentTransaction.update).not.toHaveBeenCalled();
    });

    it('rejects a transaction not in UNMATCHED status', async () => {
      tx.$queryRaw
        .mockReset()
        .mockResolvedValueOnce([payment])
        .mockResolvedValueOnce([{ ...transaction, status: 'RECEIVED' }]);

      await expect(
        service.linkBankTransaction('transaction-001', linkDto),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(tx.paymentTransaction.update).not.toHaveBeenCalled();
    });
  });
  describe('confirmTransactionReceived', () => {
    const transaction = {
      id: 'transaction-001',
      paymentId: 'payment-001',
      status: 'UNMATCHED',
    };

    beforeEach(() => {
      prisma.paymentTransaction.findUnique.mockResolvedValue({
        id: transaction.id,
        paymentId: transaction.paymentId,
      });

      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'payment-001', status: 'PENDING' }])
        .mockResolvedValueOnce([transaction]);

      tx.paymentTransaction.update.mockResolvedValue({
        ...transaction,
        status: 'RECEIVED',
      });
    });

    it('confirms receipt without activating the payment', async () => {
      const result =
        await service.confirmTransactionReceived('transaction-001');

      expect(tx.paymentTransaction.update).toHaveBeenCalledWith({
        where: { id: 'transaction-001' },
        data: { status: 'RECEIVED' },
      });

      expect(result.status).toBe('RECEIVED');
    });

    it('rejects when the transaction does not exist', async () => {
      prisma.paymentTransaction.findUnique.mockResolvedValue(null);

      await expect(
        service.confirmTransactionReceived('transaction-missing'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects when the transaction is not linked to a payment', async () => {
      prisma.paymentTransaction.findUnique.mockResolvedValue({
        id: 'transaction-001',
        paymentId: null,
      });

      await expect(
        service.confirmTransactionReceived('transaction-001'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
    it.each(['CANCELLED', 'PAID'])(
      'rejects when the payment status is %s',
      async (paymentStatus) => {
        tx.$queryRaw
          .mockReset()
          .mockResolvedValueOnce([
            { id: 'payment-001', status: paymentStatus },
          ]);

        await expect(
          service.confirmTransactionReceived('transaction-001'),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(tx.paymentTransaction.update).not.toHaveBeenCalled();
      },
    );
    it('rejects when the transaction is not UNMATCHED', async () => {
      tx.$queryRaw
        .mockReset()
        .mockResolvedValueOnce([{ id: 'payment-001', status: 'PENDING' }])
        .mockResolvedValueOnce([{ ...transaction, status: 'RECEIVED' }]);

      await expect(
        service.confirmTransactionReceived('transaction-001'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(tx.paymentTransaction.update).not.toHaveBeenCalled();
    });
  });

  describe('reconcileBankTransaction', () => {
    const transaction = {
      id: 'transaction-001',
      paymentId: 'payment-001',
      status: 'RECEIVED',
    };

    beforeEach(() => {
      prisma.paymentTransaction.findUnique.mockResolvedValue({
        id: transaction.id,
        paymentId: transaction.paymentId,
      });

      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'payment-001', status: 'PENDING' }])
        .mockResolvedValueOnce([transaction]);

      tx.paymentTransaction.update.mockResolvedValue({
        ...transaction,
        status: 'MATCHED',
        matchedAt: new Date('2026-10-27T00:00:00.000Z'),
      });
    });

    it('reconciles a RECEIVED transaction as MATCHED without activating payment', async () => {
      const result = await service.reconcileBankTransaction('transaction-001');

      expect(tx.paymentTransaction.update).toHaveBeenCalledWith({
        where: { id: 'transaction-001' },
        data: {
          status: 'MATCHED',
          matchedAt: expect.any(Date),
        },
      });

      expect(result.status).toBe('MATCHED');
    });

    it('rejects when the transaction does not exist', async () => {
      prisma.paymentTransaction.findUnique.mockResolvedValue(null);

      await expect(
        service.reconcileBankTransaction('transaction-missing'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects when the transaction is not linked to a payment', async () => {
      prisma.paymentTransaction.findUnique.mockResolvedValue({
        id: 'transaction-001',
        paymentId: null,
      });

      await expect(
        service.reconcileBankTransaction('transaction-001'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects when the payment does not exist', async () => {
      tx.$queryRaw.mockReset().mockResolvedValueOnce([]);

      await expect(
        service.reconcileBankTransaction('transaction-001'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.paymentTransaction.update).not.toHaveBeenCalled();
    });

    it('rejects when the transaction is not RECEIVED', async () => {
      tx.$queryRaw
        .mockReset()
        .mockResolvedValueOnce([{ id: 'payment-001', status: 'PENDING' }])
        .mockResolvedValueOnce([{ ...transaction, status: 'UNMATCHED' }]);

      await expect(
        service.reconcileBankTransaction('transaction-001'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(tx.paymentTransaction.update).not.toHaveBeenCalled();
    });
  });
});
