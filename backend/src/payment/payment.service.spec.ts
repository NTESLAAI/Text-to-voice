import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PaymentService', () => {
  let service: PaymentService;

  const prismaMock = {
    plan: {
      findUnique: jest.fn(),
    },
    subscription: {
      findFirst: jest.fn(),
    },
    payment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    quotaLot: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should calculate credit from eligible remaining quota', async () => {
    const sourcePlan = {
      id: 'plan-basic',
      code: 'BASIC',
      name: 'Basic',
      price: 10000,
      characterLimit: 1000,
      durationDays: 30,
      currency: 'VND',
    };

    const targetPlan = {
      id: 'plan-pro',
      code: 'PRO',
      name: 'Pro',
      price: 20000,
      characterLimit: 5000,
      durationDays: 30,
      currency: 'VND',
      isActive: true,
    };

    prismaMock.plan.findUnique.mockResolvedValue(targetPlan);

    prismaMock.subscription.findFirst.mockResolvedValue({
      id: 'subscription-basic',
      planId: sourcePlan.id,
      plan: sourcePlan,
      quotaLots: [
        {
          id: 'lot-1',
          charactersRemaining: 300,
          rolloverCount: 0,
        },
        {
          id: 'lot-2',
          charactersRemaining: 200,
          rolloverCount: 0,
        },
      ],
    });

    prismaMock.payment.create.mockImplementation(
      async ({ data }: { data: Record<string, any> }) => ({
        id: 'payment-1',
        ...data,
        plan: targetPlan,
        createdAt: new Date(),
      }),
    );

    const result = await service.createPayment(
      'user-1',
      'PRO',
      'CONVERT_TO_CREDIT',
    );

    // 500 ký tự × (10.000 / 1.000) = 5.000 đồng.
    expect(result.creditAmount).toBe(5000);
    expect(result.amount).toBe(15000);
    expect(result.remainingCharacters).toBe(500);

    const createCall = prismaMock.payment.create.mock.calls[0][0];

    expect(createCall.data.paymentType).toBe('UPGRADE');
    expect(createCall.data.sourceSubscriptionId).toBe('subscription-basic');
    expect(createCall.data.sourcePlanPriceSnapshot).toBe(10000);
    expect(createCall.data.sourcePlanCharacterLimitSnapshot).toBe(1000);
  });

  it('should reject a paid-plan upgrade without an upgrade option', async () => {
    const sourcePlan = {
      id: 'plan-basic',
      code: 'BASIC',
      name: 'Basic',
      price: 10000,
      characterLimit: 1000,
      durationDays: 30,
    };

    prismaMock.plan.findUnique.mockResolvedValue({
      id: 'plan-pro',
      code: 'PRO',
      name: 'Pro',
      price: 20000,
      characterLimit: 5000,
      durationDays: 30,
      currency: 'VND',
      isActive: true,
    });

    prismaMock.subscription.findFirst.mockResolvedValue({
      id: 'subscription-basic',
      planId: sourcePlan.id,
      plan: sourcePlan,
      quotaLots: [],
    });

    await expect(service.createPayment('user-1', 'PRO')).rejects.toThrow(
      BadRequestException,
    );

    expect(prismaMock.payment.create).not.toHaveBeenCalled();
  });

  it('should transfer eligible quota during a paid-plan upgrade', async () => {
    const now = new Date();

    const sourcePlan = {
      id: 'plan-basic',
      code: 'BASIC',
      name: 'Basic',
      price: 10000,
      characterLimit: 1000,
      durationDays: 30,
    };

    const targetPlan = {
      id: 'plan-pro',
      code: 'PRO',
      name: 'Pro',
      price: 20000,
      characterLimit: 5000,
      durationDays: 30,
    };

    const sourceLot = {
      id: 'lot-basic-1',
      charactersRemaining: 300,
      rolloverCount: 0,
    };

    const activeSubscription = {
      id: 'subscription-basic',
      planId: sourcePlan.id,
      plan: sourcePlan,
      quotaLots: [sourceLot],
    };

    const payment = {
      id: 'payment-1',
      userId: 'user-1',
      planId: targetPlan.id,
      plan: targetPlan,
      amount: 20000,
      currency: 'VND',
      status: 'PENDING',
      paymentType: 'UPGRADE',
      upgradeOption: 'TRANSFER_QUOTA',
      creditAmount: null,
      sourceSubscriptionId: activeSubscription.id,
      sourcePlanPriceSnapshot: sourcePlan.price,
      sourcePlanCharacterLimitSnapshot: sourcePlan.characterLimit,
      planNameSnapshot: targetPlan.name,
      planPriceSnapshot: targetPlan.price,
      planDurationDaysSnapshot: targetPlan.durationDays,
      planCharacterLimitSnapshot: targetPlan.characterLimit,
    };

    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        update: jest.fn().mockResolvedValue({
          ...payment,
          status: 'PAID',
          paidAt: now,
        }),
      },
      subscription: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(activeSubscription)
          .mockResolvedValueOnce(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({
          id: 'subscription-pro',
          plan: targetPlan,
          status: 'ACTIVE',
          characterLimit: 5000,
          rolloverCharacters: 300,
          startedAt: now,
          expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        }),
      },
      quotaLot: {
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: any) => Promise<unknown>) => callback(tx),
    );

    const result = await service.confirmPayment('payment-1');
    const subscriptionQuery = tx.subscription.findFirst.mock.calls[0][0];

    expect(subscriptionQuery.include.quotaLots.where).toEqual({
      charactersRemaining: { gt: 0 },
      rolloverCount: 0,
      expiresAt: { gt: expect.any(Date) },
    });

    expect(tx.subscription.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'subscription-basic',
        userId: 'user-1',
        status: 'ACTIVE',
      },
      data: {
        status: 'EXPIRED',
      },
    });

    expect(tx.quotaLot.create).toHaveBeenCalledTimes(2);

    expect(tx.quotaLot.create).toHaveBeenNthCalledWith(2, {
      data: {
        subscriptionId: 'subscription-pro',
        sourceLotId: 'lot-basic-1',
        charactersGranted: 300,
        charactersRemaining: 300,
        rolloverCount: 1,
        expiresAt: expect.any(Date),
      },
    });

    expect(tx.quotaLot.update).toHaveBeenCalledWith({
      where: {
        id: 'lot-basic-1',
      },
      data: {
        charactersRemaining: 0,
        rolloverCount: 1,
      },
    });

    expect(tx.payment.update).toHaveBeenCalledWith({
      where: {
        id: 'payment-1',
      },
      data: {
        status: 'PAID',
        paidAt: expect.any(Date),
      },
    });

    expect(result.subscription.rolloverCharacters).toBe(300);
  });

  it('should exclude expired quota lots during an upgrade', async () => {
    const now = new Date();

    const sourcePlan = {
      id: 'plan-basic',
      code: 'BASIC',
      name: 'Basic',
      price: 10000,
      characterLimit: 1000,
      durationDays: 30,
    };

    const targetPlan = {
      id: 'plan-pro',
      code: 'PRO',
      name: 'Pro',
      price: 20000,
      characterLimit: 5000,
      durationDays: 30,
    };

    const validLot = {
      id: 'lot-valid',
      charactersRemaining: 300,
      rolloverCount: 0,
    };

    const activeSubscription = {
      id: 'subscription-basic',
      planId: sourcePlan.id,
      plan: sourcePlan,
      quotaLots: [validLot],
    };

    const payment = {
      id: 'payment-expired-test',
      userId: 'user-1',
      planId: targetPlan.id,
      plan: targetPlan,
      amount: 20000,
      currency: 'VND',
      status: 'PENDING',
      paymentType: 'UPGRADE',
      upgradeOption: 'TRANSFER_QUOTA',
      creditAmount: null,
      sourceSubscriptionId: activeSubscription.id,
      sourcePlanPriceSnapshot: sourcePlan.price,
      sourcePlanCharacterLimitSnapshot: sourcePlan.characterLimit,
      planNameSnapshot: targetPlan.name,
      planPriceSnapshot: targetPlan.price,
      planDurationDaysSnapshot: targetPlan.durationDays,
      planCharacterLimitSnapshot: targetPlan.characterLimit,
    };

    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        update: jest.fn().mockResolvedValue({
          ...payment,
          status: 'PAID',
          paidAt: now,
        }),
      },
      subscription: {
        findFirst: jest.fn().mockResolvedValue(activeSubscription),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({
          id: 'subscription-pro',
          plan: targetPlan,
          status: 'ACTIVE',
          characterLimit: 5000,
          rolloverCharacters: 300,
          startedAt: now,
          expiresAt: new Date(now.getTime() + 30 * 86400000),
        }),
      },
      quotaLot: {
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: any) => Promise<unknown>) => callback(tx),
    );

    await service.confirmPayment('payment-expired-test');

    const query = tx.subscription.findFirst.mock.calls[0][0];

    expect(query.include.quotaLots.where.expiresAt).toEqual({
      gt: expect.any(Date),
    });

    expect(tx.quotaLot.create).toHaveBeenNthCalledWith(2, {
      data: {
        subscriptionId: 'subscription-pro',
        sourceLotId: 'lot-valid',
        charactersGranted: 300,
        charactersRemaining: 300,
        rolloverCount: 1,
        expiresAt: expect.any(Date),
      },
    });
  });
  it('should exclude already rolled-over quota lots during an upgrade', async () => {
    const now = new Date();

    const sourcePlan = {
      id: 'plan-basic',
      code: 'BASIC',
      name: 'Basic',
      price: 10000,
      characterLimit: 1000,
      durationDays: 30,
    };

    const targetPlan = {
      id: 'plan-pro',
      code: 'PRO',
      name: 'Pro',
      price: 20000,
      characterLimit: 5000,
      durationDays: 30,
    };

    const validLot = {
      id: 'lot-valid',
      charactersRemaining: 200,
      rolloverCount: 0,
    };

    const activeSubscription = {
      id: 'subscription-basic',
      planId: sourcePlan.id,
      plan: sourcePlan,
      quotaLots: [validLot],
    };

    const payment = {
      id: 'payment-rollover-test',
      userId: 'user-1',
      planId: targetPlan.id,
      plan: targetPlan,
      amount: 20000,
      currency: 'VND',
      status: 'PENDING',
      paymentType: 'UPGRADE',
      upgradeOption: 'TRANSFER_QUOTA',
      creditAmount: null,
      sourceSubscriptionId: activeSubscription.id,
      sourcePlanPriceSnapshot: sourcePlan.price,
      sourcePlanCharacterLimitSnapshot: sourcePlan.characterLimit,
      planNameSnapshot: targetPlan.name,
      planPriceSnapshot: targetPlan.price,
      planDurationDaysSnapshot: targetPlan.durationDays,
      planCharacterLimitSnapshot: targetPlan.characterLimit,
    };

    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        update: jest.fn().mockResolvedValue({
          ...payment,
          status: 'PAID',
          paidAt: now,
        }),
      },
      subscription: {
        findFirst: jest.fn().mockResolvedValue(activeSubscription),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({
          id: 'subscription-pro',
          plan: targetPlan,
          status: 'ACTIVE',
          characterLimit: 5000,
          rolloverCharacters: 200,
          startedAt: now,
          expiresAt: new Date(now.getTime() + 30 * 86400000),
        }),
      },
      quotaLot: {
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: any) => Promise<unknown>) => callback(tx),
    );

    await service.confirmPayment('payment-rollover-test');

    const query = tx.subscription.findFirst.mock.calls[0][0];

    expect(query.include.quotaLots.where.rolloverCount).toBe(0);

    expect(tx.quotaLot.create).toHaveBeenNthCalledWith(2, {
      data: {
        subscriptionId: 'subscription-pro',
        sourceLotId: 'lot-valid',
        charactersGranted: 200,
        charactersRemaining: 200,
        rolloverCount: 1,
        expiresAt: expect.any(Date),
      },
    });
  });
});
