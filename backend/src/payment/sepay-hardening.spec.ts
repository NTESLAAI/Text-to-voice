/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
// Isolated ledger/transaction fixtures; never instantiate a Prisma client.
import { BadRequestException } from '@nestjs/common';
import { SepayWebhookService } from './sepay-webhook.service';
import { Prisma } from '../../generated/prisma/client';

describe('SePay receipt validation and recoverability (mock)', () => {
  let db: any, tx: any, payment: any, service: SepayWebhookService;
  const body = () => ({
    id: 123,
    transferAmount: 100000,
    accountNumber: 'mock-bank-account',
    transferType: 'in',
    code: 'KH-ABCDEFGH',
    content: 'KH-ABCDEFGH',
    gateway: 'mock-bank',
    accumulated: 100000,
    transactionDate: '2026-11-06T10:00:00+07:00',
  });
  beforeEach(() => {
    tx = {
      payment: {
        findUnique: jest.fn(async () => ({
          id: 'p',
          status: 'PENDING',
          currency: 'VND',
        })),
      },
      paymentTransaction: { create: jest.fn() },
      $queryRaw: jest.fn(),
    };
    db = {
      paymentTransaction: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(),
      },
      payment: { findUnique: jest.fn(async () => ({ status: 'PENDING' })) },
      $transaction: jest.fn(async (fn) => fn(tx)),
    };
    payment = { confirmPayment: jest.fn() };
    service = new SepayWebhookService(db, payment, {
      get: (key) =>
        key === 'BANK_TRANSFER_ACCOUNT_NUMBER'
          ? 'mock-bank-account'
          : 'mock-bank',
    } as any);
  });
  it.each(['wrong-account', ''])(
    'rejects account mismatch %s before ledger access',
    async (accountNumber) => {
      await expect(
        service.handleWebhook({ ...body(), accountNumber }),
      ).rejects.toThrow('SEPAY_ACCOUNT_MISMATCH');
      expect(db.paymentTransaction.findUnique).not.toHaveBeenCalled();
    },
  );
  it('missing receiving account configuration fails closed', async () => {
    service = new SepayWebhookService(db, payment, {
      get: () => undefined,
    } as any);
    await expect(service.handleWebhook(body())).rejects.toThrow(
      'SEPAY_ACCOUNT_NOT_CONFIGURED',
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('gateway mismatch fails before ledger access', async () => {
    await expect(
      service.handleWebhook({ ...body(), gateway: 'other-bank' }),
    ).rejects.toThrow('SEPAY_GATEWAY_MISMATCH');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('missing gateway configuration fails closed', async () => {
    service = new SepayWebhookService(db, payment, {
      get: (key) =>
        key === 'BANK_TRANSFER_ACCOUNT_NUMBER'
          ? 'mock-bank-account'
          : undefined,
    } as any);
    await expect(service.handleWebhook(body())).rejects.toThrow(
      'SEPAY_GATEWAY_NOT_CONFIGURED',
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN])(
    'rejects unsafe amount %s',
    async (transferAmount) => {
      await expect(
        service.handleWebhook({ ...body(), transferAmount }),
      ).rejects.toThrow('SEPAY_INVALID_TRANSACTION');
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it('ambiguous order codes are recorded unmatched for manual reconciliation', async () => {
    await service.handleWebhook({
      ...body(),
      content: 'KH-ABCDEFGH NC-ABCDEFGH',
    });
    expect(db.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'UNMATCHED', currency: 'VND' }),
    });
    expect(payment.confirmPayment).not.toHaveBeenCalled();
  });
  it.each(['USD', 'EUR'])(
    'does not infer %s from a Payment for a VND bank receipt',
    async (currency) => {
      tx.payment.findUnique.mockResolvedValue({
        id: 'p',
        status: 'PENDING',
        currency,
      });
      await service.handleWebhook(body());
      expect(tx.paymentTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'UNMATCHED', currency: 'VND' }),
      });
      expect(payment.confirmPayment).not.toHaveBeenCalled();
    },
  );
  it('explicit foreign currency is retained unmatched, not relabeled VND', async () => {
    await service.handleWebhook({ ...body(), currency: 'USD' });
    expect(tx.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'UNMATCHED', currency: 'USD' }),
    });
    expect(payment.confirmPayment).not.toHaveBeenCalled();
  });
  it('currency changed while waiting for lock remains unmatched', async () => {
    tx.payment.findUnique
      .mockResolvedValueOnce({ id: 'p', status: 'PENDING', currency: 'VND' })
      .mockResolvedValueOnce({ id: 'p', status: 'PENDING', currency: 'USD' });
    await service.handleWebhook(body());
    expect(payment.confirmPayment).not.toHaveBeenCalled();
  });
  it('underpayment remains MATCHED and retryable without activation or HTTP error', async () => {
    payment.confirmPayment.mockRejectedValue(
      new BadRequestException({ code: 'PAYMENT_UNDERFUNDED' }),
    );
    await expect(service.handleWebhook(body())).resolves.toEqual({
      success: true,
      matched: true,
    });
    expect(tx.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ paymentId: 'p', status: 'MATCHED' }),
    });
  });
  it('activation failure preserves committed receipt and propagates for retry', async () => {
    payment.confirmPayment.mockRejectedValue(
      new Error('MOCK_ACTIVATION_FAILED'),
    );
    await expect(service.handleWebhook(body())).rejects.toThrow(
      'MOCK_ACTIVATION_FAILED',
    );
    expect(tx.paymentTransaction.create).toHaveBeenCalledTimes(1);
    db.paymentTransaction.findUnique.mockResolvedValue({
      amount: 100000,
      currency: 'VND',
      status: 'MATCHED',
      paymentId: 'p',
    });
    db.payment.findUnique.mockResolvedValue({ id: 'p', status: 'PENDING' });
    payment.confirmPayment.mockResolvedValue(undefined);
    await service.handleWebhook(body());
    expect(tx.paymentTransaction.create).toHaveBeenCalledTimes(1);
    expect(payment.confirmPayment).toHaveBeenCalledTimes(2);
  });
  it('competing activation already PAID is an idempotent success', async () => {
    payment.confirmPayment.mockRejectedValue(
      new BadRequestException('not pending'),
    );
    db.payment.findUnique.mockResolvedValue({ status: 'PAID' });
    await expect(service.handleWebhook(body())).resolves.toEqual({
      success: true,
      matched: true,
    });
  });
  it.each(['CANCELLED', 'PAID'])(
    'late receipt for %s is unmatched, never grants benefits again',
    async (status) => {
      tx.payment.findUnique.mockResolvedValue({
        id: 'p',
        status,
        currency: 'VND',
      });
      await service.handleWebhook(body());
      expect(payment.confirmPayment).not.toHaveBeenCalled();
      expect(tx.paymentTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'UNMATCHED' }),
      });
    },
  );
  it('conflicting duplicate never changes original ledger', async () => {
    db.paymentTransaction.findUnique.mockResolvedValue({
      amount: 1,
      currency: 'VND',
      status: 'MATCHED',
      paymentId: 'p',
    });
    await expect(service.handleWebhook(body())).rejects.toThrow(
      'SEPAY_DUPLICATE_CONFLICT',
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('unmatched P2002 without actual duplicate is not swallowed', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('mock', {
      code: 'P2002',
      clientVersion: 'mock',
    });
    db.paymentTransaction.create.mockRejectedValue(error);
    await expect(
      service.handleWebhook({ ...body(), code: '', content: '' }),
    ).rejects.toBe(error);
  });
});
