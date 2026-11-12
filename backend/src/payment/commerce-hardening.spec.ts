/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
// Transaction delegates are isolated mock state machines, not PostgreSQL evidence.
import { Logger } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { SubscriptionExpiryService } from '../subscription/subscription-expiry.service';
import { AdminService } from '../admin/admin.service';
jest.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined }));

describe('Expired FREE purchase, quota and activation (mock)', () => {
  const target = {
    id: 'paid-plan',
    code: 'BASIC',
    name: 'mock-plan',
    price: 100,
    characterLimit: 173,
    durationDays: 9,
    currency: 'VND',
    isActive: true,
  };
  const free = () => ({
    id: 'free-sub',
    userId: 'u',
    planId: 'free',
    status: 'ACTIVE',
    startedAt: new Date(0),
    expiresAt: new Date(1),
    plan: { id: 'free', code: 'FREE', isActive: true },
    quotaLots: [{ charactersRemaining: 99 }],
  });
  let db: any;
  beforeEach(() => {
    db = {
      plan: { findUnique: jest.fn(async () => target) },
      promotion: { findFirst: jest.fn(async () => null) },
      payment: {
        create: jest.fn(async ({ data }) => ({
          ...data,
          id: 'p',
          plan: target,
        })),
        findUnique: jest.fn(),
        update: jest.fn(async ({ data }) => ({
          ...data,
          id: 'p',
          plan: target,
        })),
      },
      paymentTransaction: {
        aggregate: jest.fn(async () => ({ _sum: { amount: 110 } })),
      },
      subscription: {
        count: jest.fn(async () => 0),
        findFirst: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 1 })),
        create: jest.fn(async ({ data }) => ({
          ...data,
          id: 'paid-sub',
          plan: target,
        })),
      },
      quotaLot: { create: jest.fn(), update: jest.fn() },
      $queryRaw: jest.fn(),
    };
    db.$transaction = jest.fn(async (fn) => fn(db));
  });
  const pending = () => ({
    id: 'p',
    userId: 'u',
    planId: target.id,
    status: 'PENDING',
    paymentType: 'NEW_PURCHASE',
    plan: target,
    amount: 100,
    currency: 'VND',
  });
  it.each(['WEB', 'APPLE', 'GOOGLE'])(
    'active %s blocks a new Web order regardless of requested plan',
    async () => {
      db.subscription.count.mockResolvedValue(1);
      await expect(
        new PaymentService(db).createPayment('u', 'BASIC'),
      ).rejects.toThrow('ACTIVE_PAID_SUBSCRIPTION_EXISTS');
      expect(db.subscription.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          userId: 'u',
          status: 'ACTIVE',
          expiresAt: { gt: expect.any(Date) },
          plan: { code: { not: 'FREE' } },
        }),
      });
      expect(db.payment.create).not.toHaveBeenCalled();
    },
  );
  it('a paid entitlement acquired after order creation blocks bank activation without discarding the payment', async () => {
    db.payment.findUnique.mockResolvedValue(pending());
    db.subscription.count.mockResolvedValue(1);
    await expect(new PaymentService(db).confirmPayment('p')).rejects.toThrow(
      'ACTIVE_PAID_SUBSCRIPTION_EXISTS',
    );
    expect(db.payment.update).not.toHaveBeenCalled();
    expect(db.subscription.create).not.toHaveBeenCalled();
    expect(db.quotaLot.create).not.toHaveBeenCalled();
    const sql = db.$queryRaw.mock.calls.map((call) => call[0].join(' '));
    expect(sql[0]).toContain('"Payment"');
    expect(sql[1]).toContain('"User"');
  });
  it.each(['WEB', 'APPLE', 'GOOGLE'])(
    'expired %s allows a fresh Web purchase and activation without quota conversion',
    async (billingSource) => {
      const expired = {
        ...free(),
        plan: target,
        planId: target.id,
        billingSource,
        status: 'EXPIRED',
      };
      db.subscription.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(expired);
      await expect(
        new PaymentService(db).createPayment('u', 'BASIC'),
      ).resolves.toMatchObject({ paymentType: 'NEW_PURCHASE' });
      db.payment.findUnique.mockResolvedValue(pending());
      db.subscription.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(expired);
      await new PaymentService(db).confirmPayment('p');
      expect(db.subscription.create).toHaveBeenCalledTimes(1);
      expect(db.quotaLot.create).toHaveBeenCalledTimes(1);
      expect(db.quotaLot.update).not.toHaveBeenCalled();
    },
  );
  it.each(['ACTIVE', 'EXPIRED'])(
    'expired FREE %s may create paid order without issuing FREE quota',
    async (status) => {
      db.subscription.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...free(), status });
      const result = await new PaymentService(db).createPayment('u', 'BASIC');
      expect(result.paymentType).toBe('NEW_PURCHASE');
      expect(db.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planCharacterLimitSnapshot: 173,
            planDurationDaysSnapshot: 9,
          }),
        }),
      );
      expect(db.quotaLot.create).not.toHaveBeenCalled();
      expect(db.subscription.create).not.toHaveBeenCalled();
    },
  );
  it('expired paid history permits a fresh purchase without reviving old quota', async () => {
    db.subscription.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...free(), plan: target });
    await expect(
      new PaymentService(db).createPayment('u', 'BASIC'),
    ).resolves.toMatchObject({ paymentType: 'NEW_PURCHASE' });
    expect(db.quotaLot.create).not.toHaveBeenCalled();
  });
  it.each(['ACTIVE', 'EXPIRED'])(
    'activates paid order from expired FREE %s using plan data without rollover',
    async (status) => {
      db.payment.findUnique.mockResolvedValue(pending());
      db.subscription.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...free(), status });
      await new PaymentService(db).confirmPayment('p');
      expect(db.subscription.create).toHaveBeenCalledTimes(1);
      expect(db.quotaLot.create).toHaveBeenCalledTimes(1);
      expect(db.quotaLot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          charactersGranted: 173,
          charactersRemaining: 173,
          rolloverCount: 0,
        }),
      });
      expect(db.quotaLot.update).not.toHaveBeenCalled();
      const sql = db.$queryRaw.mock.calls.map((call) => call[0].join(' '));
      expect(sql[0]).toContain('"Payment"');
      expect(sql[1]).toContain('"User"');
    },
  );
  it('repeat activation never creates quota twice', async () => {
    db.payment.findUnique.mockResolvedValue(pending());
    db.subscription.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(free());
    await new PaymentService(db).confirmPayment('p');
    db.payment.findUnique.mockResolvedValue({ ...pending(), status: 'PAID' });
    await expect(new PaymentService(db).confirmPayment('p')).rejects.toThrow();
    expect(db.quotaLot.create).toHaveBeenCalledTimes(1);
    expect(db.subscription.create).toHaveBeenCalledTimes(1);
  });
  it('underpayment preserves pending order and creates no benefits', async () => {
    db.payment.findUnique.mockResolvedValue(pending());
    db.paymentTransaction.aggregate.mockResolvedValue({ _sum: { amount: 50 } });
    await expect(
      new PaymentService(db).confirmPayment('p'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PAYMENT_UNDERFUNDED' }),
    });
    expect(db.subscription.create).not.toHaveBeenCalled();
    expect(db.payment.update).not.toHaveBeenCalled();
  });
  it('second new-purchase after another activation is blocked by fresh paid entitlement', async () => {
    db.payment.findUnique.mockResolvedValue(pending());
    db.subscription.findFirst.mockResolvedValue({
      ...free(),
      id: 'paid-sub',
      plan: target,
      expiresAt: new Date(Date.now() + 10000),
    });
    await expect(new PaymentService(db).confirmPayment('p')).rejects.toThrow();
    expect(db.quotaLot.create).not.toHaveBeenCalled();
  });
  it('expired FREE is visible as expired, never as usable quota', async () => {
    db.subscription.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(free());
    await expect(
      new SubscriptionService(db).getMySubscription('u'),
    ).resolves.toMatchObject({
      plan: 'FREE',
      status: 'EXPIRED',
      renewalAvailable: false,
      rolloverCharacters: 0,
    });
    expect(db.subscription.create).not.toHaveBeenCalled();
  });
  it('subscription infrastructure errors are not disguised as expiry', async () => {
    db.subscription.findFirst.mockRejectedValue(new Error('MOCK_DB_FAILED'));
    await expect(
      new SubscriptionService(db).getMySubscription('u'),
    ).rejects.toThrow('MOCK_DB_FAILED');
    expect(db.subscription.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('Expiry uses same User lock and rechecks state (mock)', () => {
  afterEach(() => jest.restoreAllMocks());
  function fixture(otherActive = false) {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const sub = {
      id: 'old',
      userId: 'u',
      status: 'ACTIVE',
      expiresAt: new Date(0),
    };
    const tx: any = {
      $queryRaw: jest.fn(),
      subscription: {
        count: jest.fn(async () => 0),
        findUnique: jest.fn(async () => ({ ...sub })),
        update: jest.fn(async () => {
          sub.status = 'EXPIRED';
        }),
        findFirst: jest.fn(async () => (otherActive ? { id: 'new' } : null)),
        create: jest.fn(async ({ data }) => ({ ...data, id: 'free-sub' })),
      },
      plan: {
        findUnique: jest.fn(async () => ({
          id: 'free',
          isActive: true,
          durationDays: 11,
          characterLimit: 53,
          currency: 'VND',
        })),
      },
      quotaLot: { create: jest.fn() },
    };
    let queue = Promise.resolve();
    const db: any = {
      subscription: {
        count: jest.fn(async () => 0),
        findMany: jest.fn(async () => [{ ...sub }]),
      },
      $transaction: jest.fn((fn) => {
        const work = queue.then(() => fn(tx));
        queue = work.catch(() => undefined);
        return work;
      }),
    };
    return { tx, db, service: new SubscriptionExpiryService(db) };
  }
  it('concurrent cron snapshots produce at most one FREE grant under serialized transaction', async () => {
    const { service, tx } = fixture();
    await Promise.all([
      service.expireSubscriptionsAfterGracePeriod(),
      service.expireSubscriptionsAfterGracePeriod(),
    ]);
    expect(tx.subscription.create).toHaveBeenCalledTimes(1);
    expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
    expect(tx.quotaLot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ charactersGranted: 53 }),
    });
    expect(tx.$queryRaw.mock.calls[0][0].join(' ')).toContain('"User"');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.subscription.findUnique.mock.invocationCallOrder[0],
    );
  });
  it('payment already activated: cron does not grant FREE over active paid plan', async () => {
    const { service, tx, db } = fixture(true);
    await service.expireSubscriptionsAfterGracePeriod();
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(tx.quotaLot.create).not.toHaveBeenCalled();
    expect(db.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ plan: { code: { not: 'FREE' } } }),
      }),
    );
  });
});

it('admin can read bounded unmatched/received transactions without changing state', async () => {
  const findMany = jest.fn(async () => []);
  const db: any = { paymentTransaction: { findMany } };
  await new AdminService(db, {} as any, {} as any).getUnmatchedTransactions();
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      take: 100,
      where: { status: { in: ['UNMATCHED', 'RECEIVED'] } },
    }),
  );
});
it('admin can find older unmatched receipt by exact bank reference, bounded and read-only', async () => {
  const findMany = jest.fn(async () => []);
  const service = new AdminService(
    { paymentTransaction: { findMany } } as any,
    {} as any,
    {} as any,
  );
  await service.getUnmatchedTransactions(' mock-reference ');
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      take: 100,
      where: {
        status: { in: ['UNMATCHED', 'RECEIVED'] },
        providerTransactionId: 'mock-reference',
      },
    }),
  );
  findMany.mockClear();
  await expect(
    service.getUnmatchedTransactions('x'.repeat(129)),
  ).rejects.toThrow('INVALID_TRANSACTION_REFERENCE');
  expect(findMany).not.toHaveBeenCalled();
});
