import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentSurplusService } from './payment-surplus.service';
import { CreateSurplusHandlingDto } from './surplus-handling.dto';

describe('Payment surplus manual writes (no database)', () => {
  let rows: any[],
    payment: any,
    tx: any,
    prisma: any,
    service: PaymentSurplusService;
  const dto = {
    action: 'REFUND' as const,
    amount: '20.000001',
    note: 'Refund requested',
  };
  beforeEach(() => {
    rows = [];
    payment = {
      id: 'p',
      status: 'PAID',
      currency: 'VND',
      amount: 100,
      transactions: [{ amount: 140.000001, currency: 'VND' }],
      effectivePlanPriceSnapshot: new Prisma.Decimal(80),
      planCharacterLimitSnapshot: 1000,
      planDurationDaysSnapshot: 30,
    };
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'p' }]),
      payment: { findUnique: jest.fn(async () => payment) },
      paymentSurplusHandling: {
        findMany: jest.fn(async () => rows),
        findUnique: jest.fn(
          async ({ where }) =>
            rows.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null,
        ),
        findFirst: jest.fn(
          async ({ where }) =>
            rows.find(
              (r) => r.id === where.id && r.paymentId === where.paymentId,
            ) ?? null,
        ),
        create: jest.fn(async ({ data }) => {
          const r = { id: `h${rows.length}`, convertedSeconds: null, ...data };
          rows.push(r);
          return r;
        }),
        update: jest.fn(async ({ where, data }) => {
          const r = rows.find((r) => r.id === where.id);
          Object.assign(r, data);
          return r;
        }),
      },
    };
    prisma = {
      $transaction: jest.fn(async (cb) => cb(tx)),
      paymentSurplusHandling: tx.paymentSurplusHandling,
    };
    service = new PaymentSurplusService(prisma as PrismaService);
  });
  const create = (extra = {}, key = 'k') =>
    service.createHandling('p', key, { ...dto, ...extra }, 'admin');

  it('locks Payment first, reads and writes within ReadCommitted, serializes Decimal', async () => {
    const result = await create();
    expect(result.amount).toBe('20.000001');
    expect(result.effectivePlanPriceSnapshot).toBe('80');
    expect(rows[0]).toMatchObject({
      status: 'PENDING',
      currency: 'VND',
      createdById: 'admin',
    });
    expect(tx.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.payment.findUnique.mock.invocationCallOrder[0],
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
    });
  });
  it('rejects missing Payment', async () => {
    payment = null;
    await expect(create()).rejects.toBeInstanceOf(NotFoundException);
  });
  it.each(['PENDING', 'USER_CONFIRMED', 'CANCELLED'])(
    'rejects non-PAID %s',
    async (status) => {
      payment.status = status;
      await expect(create()).rejects.toBeInstanceOf(ConflictException);
      expect(tx.paymentSurplusHandling.create).not.toHaveBeenCalled();
    },
  );
  it.each(['QUOTA', 'DAYS'])('rejects unsupported %s', async (action) => {
    await expect(create({ action })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    '0',
    '-1',
    'NaN',
    'Infinity',
    '1e2',
    '0.0000001',
    '100000000000000',
    '',
  ])('rejects amount %s', async (amount) => {
    await expect(create({ amount })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('requires key, note and manual completion/cancellation evidence', async () => {
    await expect(create({}, '')).rejects.toBeInstanceOf(BadRequestException);
    await expect(create({ note: ' ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      create({ note: 'x\n[SURPLUS:CANCELLED] x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(() =>
      service.completeHandling('p', 'h', { confirmation: ' ' }, 'a'),
    ).toThrow(BadRequestException);
    expect(() => service.cancelHandling('p', 'h', { note: ' ' }, 'a')).toThrow(
      BadRequestException,
    );
  });
  it('reserves exact surplus, refuses excess and counts pending/completed only', async () => {
    await create({ amount: '40.000001' });
    await expect(create({ amount: '0.000001' }, 'next')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await service.cancelHandling(
      'p',
      'h0',
      { note: 'Cancelled reservation' },
      'a',
    );
    await create({ amount: '40.000001' }, 'replacement');
  });
  it('replays the original key without additional writes, including after completion', async () => {
    await create();
    await create({ amount: '20.0000010'.slice(0, -1) });
    await service.completeHandling(
      'p',
      'h0',
      { confirmation: 'Bank transfer confirmed', externalReference: 'bank-1' },
      'a',
    );
    expect((await create()).status).toBe('COMPLETED');
    expect(tx.paymentSurplusHandling.create).toHaveBeenCalledTimes(1);
  });
  it.each([{ amount: '21' }, { action: 'CREDIT' }, { note: 'Different' }])(
    'rejects key payload conflicts %p',
    async (extra) => {
      await create();
      await expect(create(extra)).rejects.toBeInstanceOf(ConflictException);
    },
  );
  it('rejects reuse by another actor or Payment', async () => {
    await create();
    await expect(
      service.createHandling('p', 'k', dto, 'other'),
    ).rejects.toBeInstanceOf(ConflictException);
    rows[0].paymentId = 'other-payment';
    await expect(create()).rejects.toBeInstanceOf(ConflictException);
  });
  it('handles a global unique-key race only after rollback', async () => {
    await create();
    const existing = rows[0];
    rows = [];
    tx.paymentSurplusHandling.create.mockRejectedValue({ code: 'P2002' });
    tx.paymentSurplusHandling.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing);
    expect((await create()).id).toBe(existing.id);
  });
  it('records CREDIT without a wallet or quota write; repeats preserve audit', async () => {
    await create({ action: 'CREDIT' });
    expect(rows[0].creditRemainingAmount.toString()).toBe('0');
    await service.completeHandling(
      'p',
      'h0',
      { confirmation: 'Credit recorded only' },
      'first',
    );
    expect(rows[0].creditRemainingAmount.toString()).toBe(dto.amount);
    const time = rows[0].completedAt;
    await service.completeHandling(
      'p',
      'h0',
      { confirmation: 'Retry' },
      'second',
    );
    expect(rows[0].completedById).toBe('first');
    expect(rows[0].completedAt).toBe(time);
    expect(tx.paymentSurplusHandling.update).toHaveBeenCalledTimes(1);
    await expect(
      service.cancelHandling('p', 'h0', { note: 'Cancel' }, 'a'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('cancel is repeatable, preserves reason and creator, cannot complete cancelled', async () => {
    await create();
    await service.cancelHandling('p', 'h0', { note: 'Mistake' }, 'first');
    await service.cancelHandling('p', 'h0', { note: 'Retry' }, 'second');
    expect(rows[0]).toMatchObject({
      createdById: 'admin',
      cancelledById: 'first',
      status: 'CANCELLED',
    });
    expect(rows[0].note).toContain('Mistake');
    expect((await create()).status).toBe('CANCELLED');
    await expect(
      service.completeHandling('p', 'h0', { confirmation: 'Done' }, 'a'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('rejects missing or wrong-payment handling and legacy QUOTA/DAYS transitions', async () => {
    await expect(
      service.completeHandling('p', 'absent', { confirmation: 'Done' }, 'a'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await create();
    rows[0].action = 'QUOTA';
    await expect(
      service.cancelHandling('p', 'h0', { note: 'Cancel' }, 'a'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('fails closed on currency mismatch and corrupt over-allocation', async () => {
    payment.transactions[0].currency = 'USD';
    await expect(create()).rejects.toBeInstanceOf(InternalServerErrorException);
    payment.transactions[0].currency = 'VND';
    await create();
    rows[0].amount = new Prisma.Decimal(500);
    await expect(
      service.completeHandling('p', 'h0', { confirmation: 'Done' }, 'a'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(tx.paymentSurplusHandling.update).not.toHaveBeenCalled();
  });
  it('propagates transaction failures without claiming success', async () => {
    tx.paymentSurplusHandling.create.mockRejectedValue(
      new Error('write failed'),
    );
    await expect(create()).rejects.toThrow('write failed');
  });
  it('serializes competing reservations using a simulated Payment lock', async () => {
    let queue = Promise.resolve();
    prisma.$transaction.mockImplementation((cb) => {
      const result = queue.then(() => cb(tx));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    const results = await Promise.allSettled([
      create({ amount: '30' }, 'first'),
      create({ amount: '30' }, 'second'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(rows).toHaveLength(1);
  });
  it('serializes complete versus cancel without replacing the first audit', async () => {
    await create();
    let queue = Promise.resolve();
    prisma.$transaction.mockImplementation((cb) => {
      const result = queue.then(() => cb(tx));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    const results = await Promise.allSettled([
      service.completeHandling(
        'p',
        'h0',
        { confirmation: 'Confirmed' },
        'first',
      ),
      service.cancelHandling('p', 'h0', { note: 'Cancel' }, 'second'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(rows[0].completedById).toBe('first');
    expect(rows[0].cancelledById).toBeUndefined();
  });
  it.each([NaN, Infinity, -1])(
    'refuses invalid legacy money %s',
    async (amount) => {
      payment.transactions[0].amount = amount;
      await expect(create()).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    },
  );
  it('DTO accepts only supported actions and decimal strings', async () => {
    expect(
      await validate(Object.assign(new CreateSurplusHandlingDto(), dto)),
    ).toHaveLength(0);
    expect(
      await validate(
        Object.assign(new CreateSurplusHandlingDto(), dto, {
          action: 'DAYS',
          amount: 20,
        }),
      ),
    ).not.toHaveLength(0);
  });
});
