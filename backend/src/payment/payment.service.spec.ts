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
    promotion: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    subscription: {
      count: jest.fn(async () => 0),
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
    prismaMock.promotion.findFirst.mockResolvedValue(null);
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

  afterEach(() => {
    // Applies to renewal, new purchase and upgrades, including credit deduction.
    for (const [args] of prismaMock.payment.create.mock.calls) {
      const data = args.data;
      expect(data.effectivePlanPriceSnapshot.toString()).toBe(
        String(data.promotionPriceSnapshot ?? data.planPriceSnapshot),
      );
    }
  });

  it('should apply active promotion price to a new Free-to-Paid purchase', async () => {
    const targetPlan = {
      id: 'plan-basic',
      code: 'BASIC',
      name: 'Basic',
      price: 10000,
      characterLimit: 1000,
      durationDays: 30,
      currency: 'VND',
      isActive: true,
    };

    const promotion = {
      id: 'promotion-1',
      title: 'Khuyến mại tháng 10',
      planPrices: [{ planId: targetPlan.id, promotionalPrice: 7000 }],
    };

    prismaMock.plan.findUnique.mockResolvedValue(targetPlan);
    prismaMock.promotion.findFirst.mockResolvedValue(promotion);

    prismaMock.subscription.findFirst.mockResolvedValue({
      id: 'subscription-free',
      planId: 'plan-free',
      plan: {
        id: 'plan-free',
        code: 'FREE',
        name: 'Free',
        price: 0,
        characterLimit: 50,
        durationDays: 30,
      },
      quotaLots: [],
    });

    prismaMock.payment.create.mockImplementation(
      async ({ data }: { data: Record<string, any> }) => ({
        id: 'payment-promo-1',
        ...data,
        plan: targetPlan,
        createdAt: data.createdAt,
      }),
    );

    const result = await service.createPayment('user-1', 'BASIC');

    expect(result.amount).toBe(7000);

    const createCall = prismaMock.payment.create.mock.calls[0][0];

    expect(createCall.data).toMatchObject({
      amount: 7000,
      planPriceSnapshot: 10000,
      promotionIdSnapshot: 'promotion-1',
      promotionTitleSnapshot: 'Khuyến mại tháng 10',
      promotionPriceSnapshot: 7000,
      discountAmountSnapshot: 3000,
      paymentType: 'NEW_PURCHASE',
    });

    expect(prismaMock.promotion.findFirst).toHaveBeenCalledWith({
      where: {
        status: 'ACTIVE',
        startsAt: { lte: expect.any(Date) },
        endsAt: { gt: expect.any(Date) },
        redemptions: {
          none: { userId: 'user-1' },
        },
        planPrices: {
          some: { planId: 'plan-basic' },
        },
      },
      include: {
        planPrices: {
          where: { planId: 'plan-basic' },
        },
      },
    });
  });

  it('should apply active promotion price to a renewal payment', async () => {
    const now = new Date();

    const targetPlan = {
      id: 'plan-basic',
      code: 'BASIC',
      name: 'Basic',
      price: 10000,
      characterLimit: 1000,
      durationDays: 30,
      currency: 'VND',
      isActive: true,
    };

    const promotion = {
      id: 'promotion-renewal',
      title: 'Khuyến mại gia hạn',
      planPrices: [{ planId: targetPlan.id, promotionalPrice: 7000 }],
    };

    prismaMock.plan.findUnique.mockResolvedValue(targetPlan);
    prismaMock.promotion.findFirst.mockResolvedValue(promotion);

    prismaMock.subscription.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'subscription-expired',
        userId: 'user-1',
        planId: targetPlan.id,
        plan: targetPlan,
        expiresAt: new Date(now.getTime() - 60 * 60 * 1000),
        quotaLots: [],
      });

    prismaMock.payment.create.mockImplementation(
      async ({ data }: { data: Record<string, any> }) => ({
        id: 'payment-renewal-promo',
        ...data,
        plan: targetPlan,
      }),
    );

    const result = await service.createPayment('user-1', 'BASIC');

    expect(result.amount).toBe(7000);
    expect(result.paymentType).toBe('RENEWAL');

    const createCall = prismaMock.payment.create.mock.calls[0][0];

    expect(createCall.data).toMatchObject({
      amount: 7000,
      planPriceSnapshot: 10000,
      promotionIdSnapshot: 'promotion-renewal',
      promotionTitleSnapshot: 'Khuyến mại gia hạn',
      promotionPriceSnapshot: 7000,
      discountAmountSnapshot: 3000,
      paymentType: 'RENEWAL',
    });

    expect(createCall.data.createdAt).toEqual(expect.any(Date));
  });

  it('policy A refuses legacy scenario: should apply promotion price before deducting quota credit on upgrade', async () => {
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

    const promotion = {
      id: 'promotion-credit',
      title: 'Khuyến mại Pro',
      planPrices: [{ planId: 'plan-pro', promotionalPrice: 15000 }],
    };

    prismaMock.plan.findUnique.mockResolvedValue(targetPlan);
    prismaMock.promotion.findFirst.mockResolvedValue(promotion);

    prismaMock.subscription.findFirst.mockResolvedValue({
      id: 'subscription-basic',
      planId: 'plan-basic',
      plan: {
        id: 'plan-basic',
        code: 'BASIC',
        name: 'Basic',
        price: 10000,
        characterLimit: 1000,
        durationDays: 30,
      },
      quotaLots: [
        {
          id: 'lot-basic-1',
          charactersRemaining: 300,
          rolloverCount: 0,
        },
        {
          id: 'lot-basic-2',
          charactersRemaining: 200,
          rolloverCount: 0,
        },
      ],
    });

    prismaMock.payment.create.mockImplementation(
      async ({ data }: { data: Record<string, any> }) => ({
        id: 'payment-credit-promo',
        ...data,
        plan: targetPlan,
      }),
    );

    await expect(
      service.createPayment('user-1', 'PRO', 'CONVERT_TO_CREDIT'),
    ).rejects.toThrow('ACTIVE_PAID_SUBSCRIPTION_EXISTS');
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(prismaMock.quotaLot.create).not.toHaveBeenCalled();
  });

  it('policy A refuses legacy scenario: should calculate credit from eligible remaining quota', async () => {
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

    await expect(
      service.createPayment('user-1', 'PRO', 'CONVERT_TO_CREDIT'),
    ).rejects.toThrow('ACTIVE_PAID_SUBSCRIPTION_EXISTS');
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(prismaMock.quotaLot.create).not.toHaveBeenCalled();
  });

  it('policy A refuses legacy scenario: should reject a paid-plan upgrade without an upgrade option', async () => {
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

  it('should confirm Free-to-Paid payment when matched transactions exceed the order amount', async () => {
    const now = new Date();

    const freePlan = {
      id: 'plan-free',
      code: 'FREE',
      name: 'Free',
      price: 0,
      characterLimit: 50,
      durationDays: 30,
    };

    const paidPlan = {
      id: 'plan-basic',
      code: 'BASIC',
      name: 'Basic',
      price: 10000,
      characterLimit: 1000,
      durationDays: 30,
      currency: 'VND',
    };

    const payment = {
      id: 'payment-overpaid',
      userId: 'user-1',
      planId: paidPlan.id,
      plan: paidPlan,
      amount: 10000,
      currency: 'VND',
      status: 'PENDING',
      paymentType: 'NEW_PURCHASE',
      planNameSnapshot: paidPlan.name,
      planPriceSnapshot: paidPlan.price,
      planDurationDaysSnapshot: paidPlan.durationDays,
      planCharacterLimitSnapshot: paidPlan.characterLimit,
    };

    const activeFreeSubscription = {
      id: 'subscription-free',
      userId: 'user-1',
      planId: freePlan.id,
      plan: freePlan,
      quotaLots: [],
    };

    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      paymentTransaction: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: { amount: 12000 },
        }),
      },
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        update: jest.fn().mockResolvedValue({
          ...payment,
          status: 'PAID',
          paidAt: now,
        }),
      },
      subscription: {
        count: jest.fn(async () => 0),
        findFirst: jest.fn().mockResolvedValue(activeFreeSubscription),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({
          id: 'subscription-basic',
          plan: paidPlan,
          status: 'ACTIVE',
          characterLimit: 1000,
          rolloverCharacters: 0,
          startedAt: now,
          expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        }),
      },
      quotaLot: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: any) => Promise<unknown>) => callback(tx),
    );

    const result = await service.confirmPayment(payment.id);

    expect(tx.paymentTransaction.aggregate).toHaveBeenCalledWith({
      where: {
        paymentId: payment.id,
        status: 'MATCHED',
      },
      _sum: { amount: true },
    });

    expect(tx.subscription.updateMany).toHaveBeenCalledWith({
      where: {
        id: activeFreeSubscription.id,
        userId: payment.userId,
        status: 'ACTIVE',
      },
      data: {
        status: 'EXPIRED',
      },
    });

    expect(tx.subscription.create).toHaveBeenCalledWith({
      data: {
        userId: payment.userId,
        planId: payment.planId,
        startedAt: expect.any(Date),
        expiresAt: expect.any(Date),
        status: 'ACTIVE',
        characterLimit: 1000,
        rolloverCharacters: 0,
        pricePaid: 10000,
        currency: 'VND',
      },
      include: {
        plan: true,
      },
    });

    expect(tx.quotaLot.create).toHaveBeenCalledWith({
      data: {
        subscriptionId: 'subscription-basic',
        charactersGranted: 1000,
        charactersRemaining: 1000,
        rolloverCount: 0,
        expiresAt: expect.any(Date),
      },
    });

    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: payment.id },
      data: {
        status: 'PAID',
        paidAt: expect.any(Date),
      },
    });

    expect(result).toMatchObject({
      payment: {
        status: 'PAID',
      },
      subscription: { plan: 'BASIC' },
    });
    expect(tx.payment.update.mock.calls[0][0].data).not.toHaveProperty(
      'creditAmount',
    );
  });

  it('should confirm payment when multiple matched transactions cover the order amount', async () => {
    const now = new Date();

    const freePlan = {
      id: 'plan-free',
      code: 'FREE',
      name: 'Free',
      price: 0,
      characterLimit: 50,
      durationDays: 30,
    };

    const paidPlan = {
      id: 'plan-basic',
      code: 'BASIC',
      name: 'Basic',
      price: 10000,
      characterLimit: 1000,
      durationDays: 30,
      currency: 'VND',
    };

    const payment = {
      id: 'payment-split',
      userId: 'user-1',
      planId: paidPlan.id,
      plan: paidPlan,
      amount: 10000,
      currency: 'VND',
      status: 'PENDING',
      paymentType: 'NEW_PURCHASE',
      planNameSnapshot: paidPlan.name,
      planPriceSnapshot: paidPlan.price,
      planDurationDaysSnapshot: paidPlan.durationDays,
      planCharacterLimitSnapshot: paidPlan.characterLimit,
    };

    const activeFreeSubscription = {
      id: 'subscription-free',
      userId: 'user-1',
      planId: freePlan.id,
      plan: freePlan,
      quotaLots: [],
    };

    // Hai giao dịch MATCHED: 4.000 + 6.000 = 10.000 VND.
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      paymentTransaction: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: { amount: 10000 },
        }),
      },
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        update: jest.fn().mockResolvedValue({
          ...payment,
          status: 'PAID',
          paidAt: now,
        }),
      },
      subscription: {
        count: jest.fn(async () => 0),
        findFirst: jest.fn().mockResolvedValue(activeFreeSubscription),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({
          id: 'subscription-basic',
          plan: paidPlan,
          status: 'ACTIVE',
          characterLimit: 1000,
          rolloverCharacters: 0,
          startedAt: now,
          expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        }),
      },
      quotaLot: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: any) => Promise<unknown>) => callback(tx),
    );

    const result = await service.confirmPayment(payment.id);

    expect(tx.paymentTransaction.aggregate).toHaveBeenCalledWith({
      where: {
        paymentId: payment.id,
        status: 'MATCHED',
      },
      _sum: { amount: true },
    });

    expect(tx.subscription.create).toHaveBeenCalled();
    expect(tx.quotaLot.create).toHaveBeenCalled();
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: payment.id },
      data: {
        status: 'PAID',
        paidAt: expect.any(Date),
      },
    });

    expect(result).toMatchObject({
      payment: {
        status: 'PAID',
      },
      subscription: { plan: 'BASIC' },
    });
  });

  it('should reject payment confirmation when matched transactions are insufficient', async () => {
    const payment = {
      id: 'payment-underpaid',
      userId: 'user-1',
      planId: 'plan-basic',
      plan: {
        id: 'plan-basic',
        code: 'BASIC',
        name: 'Basic',
        price: 10000,
        characterLimit: 1000,
        durationDays: 30,
        currency: 'VND',
      },
      amount: 10000,
      currency: 'VND',
      status: 'PENDING',
      paymentType: 'NEW_PURCHASE',
      planNameSnapshot: 'Basic',
      planPriceSnapshot: 10000,
      planDurationDaysSnapshot: 30,
      planCharacterLimitSnapshot: 1000,
    };

    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      paymentTransaction: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: { amount: 5000 },
        }),
      },
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        update: jest.fn(),
      },
      subscription: {
        count: jest.fn(async () => 0),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      quotaLot: {
        create: jest.fn(),
      },
    };

    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: any) => Promise<unknown>) => callback(tx),
    );

    await expect(service.confirmPayment('payment-underpaid')).rejects.toThrow(
      BadRequestException,
    );

    expect(tx.paymentTransaction.aggregate).toHaveBeenCalledWith({
      where: {
        paymentId: 'payment-underpaid',
        status: 'MATCHED',
      },
      _sum: { amount: true },
    });

    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(tx.quotaLot.create).not.toHaveBeenCalled();
  });

  it('should reject Free-to-Paid confirmation when the Free subscription was already processed', async () => {
    const now = new Date();

    const freePlan = {
      id: 'plan-free',
      code: 'FREE',
      name: 'Free',
      price: 0,
      characterLimit: 50,
      durationDays: 30,
    };

    const paidPlan = {
      id: 'plan-basic',
      code: 'BASIC',
      name: 'Basic',
      price: 10000,
      characterLimit: 1000,
      durationDays: 30,
      currency: 'VND',
    };

    const payment = {
      id: 'payment-free-to-paid',
      userId: 'user-1',
      planId: paidPlan.id,
      plan: paidPlan,
      amount: paidPlan.price,
      currency: 'VND',
      status: 'PENDING',
      paymentType: 'NEW_PURCHASE',
      planNameSnapshot: paidPlan.name,
      planPriceSnapshot: paidPlan.price,
      planDurationDaysSnapshot: paidPlan.durationDays,
      planCharacterLimitSnapshot: paidPlan.characterLimit,
    };

    const activeFreeSubscription = {
      id: 'subscription-free',
      userId: 'user-1',
      planId: freePlan.id,
      plan: freePlan,
      quotaLots: [],
    };

    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      paymentTransaction: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: { amount: 10000 },
        }),
      },
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        update: jest.fn(),
      },
      subscription: {
        count: jest.fn(async () => 0),
        findFirst: jest.fn().mockResolvedValue(activeFreeSubscription),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(),
      },
      quotaLot: {
        create: jest.fn(),
      },
    };

    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: any) => Promise<unknown>) => callback(tx),
    );

    await expect(
      service.confirmPayment('payment-free-to-paid'),
    ).rejects.toThrow(BadRequestException);

    expect(tx.subscription.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'subscription-free',
        userId: 'user-1',
        status: 'ACTIVE',
      },
      data: {
        status: 'EXPIRED',
      },
    });

    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(tx.quotaLot.create).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
  });

  it('policy A refuses legacy scenario: should apply active promotion price to a TRANSFER_QUOTA upgrade', async () => {
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

    const promotion = {
      id: 'promotion-upgrade',
      title: 'Khuyến mại nâng cấp',
      planPrices: [{ planId: targetPlan.id, promotionalPrice: 15000 }],
    };

    prismaMock.plan.findUnique.mockResolvedValue(targetPlan);
    prismaMock.promotion.findFirst.mockResolvedValue(promotion);

    prismaMock.subscription.findFirst.mockResolvedValue({
      id: 'subscription-basic',
      planId: 'plan-basic',
      plan: {
        id: 'plan-basic',
        code: 'BASIC',
        name: 'Basic',
        price: 10000,
        characterLimit: 1000,
        durationDays: 30,
      },
      quotaLots: [
        {
          id: 'lot-basic',
          charactersRemaining: 300,
          rolloverCount: 0,
        },
      ],
    });

    prismaMock.payment.create.mockImplementation(
      async ({ data }: { data: Record<string, any> }) => ({
        id: 'payment-upgrade-promo',
        ...data,
        plan: targetPlan,
      }),
    );

    await expect(
      service.createPayment('user-1', 'PRO', 'TRANSFER_QUOTA'),
    ).rejects.toThrow('ACTIVE_PAID_SUBSCRIPTION_EXISTS');
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(prismaMock.quotaLot.create).not.toHaveBeenCalled();
  });

  it('policy A refuses legacy scenario: should transfer eligible quota during a paid-plan upgrade', async () => {
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
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([]) // Khóa bản ghi Payment
        .mockResolvedValueOnce([]) // Khóa User
        .mockResolvedValueOnce([
          {
            id: 'lot-basic-1',
            charactersRemaining: 300,
            rolloverCount: 0,
          },
        ]),
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        update: jest.fn().mockResolvedValue({
          ...payment,
          status: 'PAID',
          paidAt: now,
        }),
      },
      subscription: {
        count: jest.fn(async () => 0),
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
      paymentTransaction: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: { amount: 20000 },
        }),
      },
    };

    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: any) => Promise<unknown>) => callback(tx),
    );

    await expect(service.confirmPayment('payment-1')).rejects.toThrow(
      'ACTIVE_PAID_SUBSCRIPTION_EXISTS',
    );
    expect(prismaMock.payment.create).not.toHaveBeenCalled();
    expect(prismaMock.quotaLot.create).not.toHaveBeenCalled();
  });

  it('policy A refuses legacy scenario: should exclude expired quota lots during an upgrade', async () => {
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
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([]) // Khóa bản ghi Payment
        .mockResolvedValueOnce([]) // Khóa User
        .mockResolvedValueOnce([
          {
            id: 'lot-valid',
            charactersRemaining: 300,
            rolloverCount: 0,
          },
        ]),

      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        update: jest.fn().mockResolvedValue({
          ...payment,
          status: 'PAID',
          paidAt: now,
        }),
      },
      subscription: {
        count: jest.fn(async () => 0),
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
      paymentTransaction: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: { amount: 20000 },
        }),
      },
    };

    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: any) => Promise<unknown>) => callback(tx),
    );

    await expect(
      service.confirmPayment('payment-expired-test'),
    ).rejects.toThrow('ACTIVE_PAID_SUBSCRIPTION_EXISTS');
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(tx.quotaLot.create).not.toHaveBeenCalled();
  });
  it('policy A refuses legacy scenario: should exclude already rolled-over quota lots during an upgrade', async () => {
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
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([]) // Khóa bản ghi Payment
        .mockResolvedValueOnce([]) // Khóa User
        .mockResolvedValueOnce([
          {
            id: 'lot-valid',
            charactersRemaining: 200,
            rolloverCount: 0,
          },
        ]),
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        update: jest.fn().mockResolvedValue({
          ...payment,
          status: 'PAID',
          paidAt: now,
        }),
      },
      subscription: {
        count: jest.fn(async () => 0),
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
      paymentTransaction: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: { amount: 20000 },
        }),
      },
    };

    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: any) => Promise<unknown>) => callback(tx),
    );

    await expect(
      service.confirmPayment('payment-rollover-test'),
    ).rejects.toThrow('ACTIVE_PAID_SUBSCRIPTION_EXISTS');
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(tx.quotaLot.create).not.toHaveBeenCalled();
  });

  describe('cancelPayment', () => {
    const payment = {
      id: 'payment-cancel-1',
      userId: 'user-1',
      status: 'PENDING',
    };

    const createTransactionMock = (
      receivedTransaction: { id: string; status?: string } | null = null,
      ownerId = 'user-1',
    ) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        payment: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce({
              ...payment,
              userId: ownerId,
            })
            .mockResolvedValueOnce({
              ...payment,
              status: 'CANCELLED',
              userId: ownerId,
            }),
          update: jest.fn().mockResolvedValue({
            ...payment,
            status: 'CANCELLED',
          }),
        },
        paymentTransaction: {
          findFirst: jest.fn().mockResolvedValue(receivedTransaction),
        },
      };

      prismaMock.$transaction.mockImplementation(
        async (callback: (tx: any) => Promise<unknown>) => callback(tx),
      );

      return tx;
    };

    it('should cancel a pending payment without received transactions', async () => {
      const tx = createTransactionMock(null);

      const result = await service.cancelPayment('user-1', payment.id);

      expect(tx.paymentTransaction.findFirst).toHaveBeenCalledWith({
        where: {
          paymentId: payment.id,
          status: {
            in: ['RECEIVED', 'MATCHED'],
          },
        },
        select: { id: true },
      });

      expect(tx.payment.update).toHaveBeenCalledWith({
        where: { id: payment.id },
        data: { status: 'CANCELLED' },
      });

      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        status: 'CANCELLED',
      });
    });

    it.each(['RECEIVED', 'MATCHED'])(
      'should reject cancellation when a transaction is %s',
      async (status) => {
        const tx = createTransactionMock({
          id: 'transaction-1',
          status,
        });

        await expect(
          service.cancelPayment('user-1', payment.id),
        ).rejects.toThrow(BadRequestException);

        expect(tx.payment.update).not.toHaveBeenCalled();
      },
    );

    it('should reject cancellation by a different user', async () => {
      const tx = createTransactionMock(null, 'another-user');

      await expect(service.cancelPayment('user-1', payment.id)).rejects.toThrow(
        BadRequestException,
      );

      expect(tx.paymentTransaction.findFirst).not.toHaveBeenCalled();
      expect(tx.payment.update).not.toHaveBeenCalled();
    });
  });
});
