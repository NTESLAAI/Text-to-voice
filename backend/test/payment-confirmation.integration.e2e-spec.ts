import 'dotenv/config';

import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentService } from '../src/payment/payment.service';

describe('Payment confirmation integration safety', () => {
  let prisma: PrismaService | undefined;
  let paymentService: PaymentService | undefined;
  let originalDatabaseUrl: string | undefined;

  let testUserId: string | undefined;
  let testFreePlanId: string | undefined;

  beforeAll(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;

    if (!originalDatabaseUrl) {
      throw new Error('Thiếu DATABASE_URL. Dừng kiểm thử.');
    }

    // Chỉ kết nối database kiểm thử.
    const testUrl = new URL(originalDatabaseUrl);
    testUrl.pathname = '/text_to_voice_test';
    process.env.DATABASE_URL = testUrl.toString();

    prisma = new PrismaService();

    try {
      await prisma.$connect();

      const rows = await prisma.$queryRaw<
        Array<{ database_name: string }>
      >`SELECT current_database() AS database_name`;

      if (rows[0]?.database_name !== 'text_to_voice_test') {
        throw new Error('Sai database kiểm thử. Dừng ngay, không ghi dữ liệu.');
      }

      paymentService = new PaymentService(prisma);
    } catch (error) {
      await prisma.$disconnect().catch(() => undefined);
      prisma = undefined;
      process.env.DATABASE_URL = originalDatabaseUrl;
      throw error;
    }
  });

  afterAll(async () => {
    try {
      if (!prisma) {
        return;
      }

      const rows = await prisma.$queryRaw<
        Array<{ database_name: string }>
      >`SELECT current_database() AS database_name`;

      if (rows[0]?.database_name !== 'text_to_voice_test') {
        throw new Error('Sai database khi dọn dữ liệu. Không thực hiện xóa.');
      }

      // Chỉ xóa User do chính bài test này tạo.
      // Các quan hệ có onDelete: Cascade sẽ được dọn theo.
      if (testUserId) {
        await prisma.user.deleteMany({
          where: { id: testUserId },
        });

        testUserId = undefined;
      }

      // Chỉ xóa Plan FREE nếu chính bài test này tạo ra.
      // Không xóa Plan FREE có sẵn trong database.
      if (testFreePlanId) {
        const planReferences = await prisma.$queryRaw<
          Array<{
            subscriptions: bigint;
            payments: bigint;
          }>
        >`
        SELECT
          (
            SELECT COUNT(*) FROM "Subscription"
            WHERE "planId" = ${testFreePlanId}
          ) AS subscriptions,
          (
            SELECT COUNT(*) FROM "Payment"
            WHERE "planId" = ${testFreePlanId}
          ) AS payments
      `;

        const references = planReferences[0];

        if (
          references &&
          Number(references.subscriptions) === 0 &&
          Number(references.payments) === 0
        ) {
          await prisma.plan.deleteMany({
            where: { id: testFreePlanId },
          });
        } else {
          throw new Error(
            'Plan FREE tạm còn dữ liệu tham chiếu. Không xóa Plan.',
          );
        }

        testFreePlanId = undefined;
      }
    } finally {
      if (prisma) {
        await prisma.$disconnect();
        prisma = undefined;
      }

      paymentService = undefined;

      if (originalDatabaseUrl !== undefined) {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });

  it('từ chối xác nhận Payment lần thứ hai mà không tạo dữ liệu trùng', async () => {
    if (!prisma || !paymentService) {
      throw new Error('Prisma hoặc PaymentService chưa được khởi tạo.');
    }

    // Xác minh database ngay trước khi tạo fixture.
    const dbRows = await prisma.$queryRaw<
      Array<{ database_name: string }>
    >`SELECT current_database() AS database_name`;

    expect(dbRows[0]?.database_name).toBe('text_to_voice_test');

    let freePlan = await prisma.plan.findUnique({
      where: { code: 'FREE' },
    });

    if (!freePlan) {
      freePlan = await prisma.plan.create({
        data: {
          code: 'FREE',
          name: 'Test Free Temporary',
          price: 0,
          currency: 'VND',
          durationDays: 30,
          characterLimit: 50,
          isActive: true,
        },
      });

      testFreePlanId = freePlan.id;
    }

    if (!freePlan.isActive) {
      throw new Error(
        'Plan FREE tồn tại nhưng không hoạt động. Dừng kiểm thử.',
      );
    }

    const paidPlan = await prisma.plan.findUnique({
      where: { code: 'TEST_BASIC' },
    });

    if (!paidPlan || !paidPlan.isActive) {
      throw new Error('Không tìm thấy Plan TEST_BASIC đang hoạt động.');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Tạo User riêng, không sử dụng fixture hiện có.
    const user = await prisma.user.create({
      data: {
        email: `payment-confirm-${randomUUID()}@example.test`,
        name: 'Payment confirmation integration test',
      },
    });

    testUserId = user.id;

    const freeSubscription = await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: freePlan.id,
        startedAt: now,
        expiresAt,
        status: 'ACTIVE',
        characterLimit: freePlan.characterLimit,
        rolloverCharacters: 0,
        pricePaid: 0,
        currency: freePlan.currency,
      },
    });

    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        planId: paidPlan.id,
        planNameSnapshot: paidPlan.name,
        planPriceSnapshot: paidPlan.price,
        planDurationDaysSnapshot: paidPlan.durationDays,
        planCharacterLimitSnapshot: paidPlan.characterLimit,
        amount: paidPlan.price,
        currency: paidPlan.currency,
        status: 'PENDING',
        provider: 'BANK_TRANSFER',
        paymentType: 'NEW_PURCHASE',
        transferCode: `KH-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
      },
    });

    const beforeSubscriptionCount = await prisma.subscription.count({
      where: { userId: user.id },
    });

    const beforeQuotaLotCount = await prisma.quotaLot.count({
      where: { subscription: { userId: user.id } },
    });

    // Lần xác nhận đầu tiên phải thành công.
    const firstResult = await paymentService.confirmPayment(payment.id);

    if (!firstResult.payment) {
      throw new Error(
        'Kết quả xác nhận thanh toán không có thuộc tính payment.',
      );
    }

    const firstPayment = firstResult.payment;

    expect(firstPayment.status).toBe('PAID');

    const subscriptionAfterFirst = await prisma.subscription.findMany({
      where: { userId: user.id },
    });

    const quotaLotsAfterFirst = await prisma.quotaLot.findMany({
      where: { subscription: { userId: user.id } },
    });

    expect(subscriptionAfterFirst).toHaveLength(beforeSubscriptionCount + 1);
    expect(quotaLotsAfterFirst).toHaveLength(beforeQuotaLotCount + 1);

    // Lần thứ hai phải bị từ chối.
    await expect(paymentService.confirmPayment(payment.id)).rejects.toThrow();

    const paymentAfterSecond = await prisma.payment.findUnique({
      where: { id: payment.id },
    });

    const subscriptionsAfterSecond = await prisma.subscription.findMany({
      where: { userId: user.id },
    });

    const quotaLotsAfterSecond = await prisma.quotaLot.findMany({
      where: { subscription: { userId: user.id } },
    });

    expect(paymentAfterSecond?.status).toBe('PAID');
    expect(subscriptionsAfterSecond).toHaveLength(
      subscriptionAfterFirst.length,
    );
    expect(quotaLotsAfterSecond).toHaveLength(quotaLotsAfterFirst.length);

    // Subscription Free cũ đã kết thúc.
    const oldFreeSubscription = await prisma.subscription.findUnique({
      where: { id: freeSubscription.id },
    });

    expect(oldFreeSubscription?.status).toBe('EXPIRED');
  }, 30000);

  it('giữ nguyên giá khuyến mại đã chốt khi xác nhận sau khi khuyến mại hết hạn', async () => {
    if (!prisma || !paymentService) {
      throw new Error('Prisma hoặc PaymentService chưa được khởi tạo.');
    }

    const dbRows = await prisma.$queryRaw<
      Array<{ database_name: string }>
    >`SELECT current_database() AS database_name`;

    expect(dbRows[0]?.database_name).toBe('text_to_voice_test');

    const freePlan = await prisma.plan.findUnique({
      where: { code: 'FREE' },
    });
    const paidPlan = await prisma.plan.findUnique({
      where: { code: 'TEST_BASIC' },
    });

    if (!freePlan?.isActive || !paidPlan?.isActive) {
      throw new Error('Thiếu Plan FREE hoặc TEST_BASIC đang hoạt động.');
    }

    let userId: string | undefined;
    let promotionId: string | undefined;

    try {
      const now = new Date();
      const promoPrice = Math.round(paidPlan.price * 0.8);

      const user = await prisma.user.create({
        data: {
          email: `promo-expired-${randomUUID()}@example.test`,
          name: 'Promotion expiry integration test',
        },
      });
      userId = user.id;

      await prisma.subscription.create({
        data: {
          userId: user.id,
          planId: freePlan.id,
          startedAt: now,
          expiresAt: new Date(now.getTime() + 7 * 86400000),
          status: 'ACTIVE',
          characterLimit: freePlan.characterLimit,
          rolloverCharacters: 0,
          pricePaid: 0,
          currency: freePlan.currency,
        },
      });

      const promotion = await prisma.promotion.create({
        data: {
          title: 'Integration test promotion',
          message: 'Test snapshot price',
          startsAt: new Date(now.getTime() - 60000),
          endsAt: new Date(now.getTime() + 3600000),
          status: 'ACTIVE',
          planPrices: {
            create: {
              planId: paidPlan.id,
              promotionalPrice: promoPrice,
            },
          },
        },
      });
      promotionId = promotion.id;

      const payment = await prisma.payment.create({
        data: {
          userId: user.id,
          planId: paidPlan.id,
          planNameSnapshot: paidPlan.name,
          planPriceSnapshot: paidPlan.price,
          planDurationDaysSnapshot: paidPlan.durationDays,
          planCharacterLimitSnapshot: paidPlan.characterLimit,
          promotionIdSnapshot: promotion.id,
          promotionTitleSnapshot: promotion.title,
          promotionPriceSnapshot: promoPrice,
          discountAmountSnapshot: paidPlan.price - promoPrice,
          amount: promoPrice,
          currency: paidPlan.currency,
          status: 'PENDING',
          provider: 'BANK_TRANSFER',
          paymentType: 'NEW_PURCHASE',
          transferCode: `KH-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
        },
      });

      // Cho khuyến mại hết hạn sau khi giao dịch đã được tạo.
      await prisma.promotion.update({
        where: { id: promotion.id },
        data: {
          status: 'ENDED',
          endsAt: new Date(now.getTime() - 1000),
        },
      });

      const result = await paymentService.confirmPayment(payment.id);

      expect(result.payment).toMatchObject({
        id: payment.id,
        status: 'PAID',
        amount: promoPrice,
      });

      const savedPayment = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });

      expect(savedPayment).toMatchObject({
        amount: promoPrice,
        planPriceSnapshot: paidPlan.price,
        promotionIdSnapshot: promotion.id,
        promotionTitleSnapshot: promotion.title,
        promotionPriceSnapshot: promoPrice,
        discountAmountSnapshot: paidPlan.price - promoPrice,
      });

      const newSubscription = await prisma.subscription.findFirstOrThrow({
        where: {
          userId: user.id,
          planId: paidPlan.id,
          status: 'ACTIVE',
        },
      });

      expect(newSubscription.pricePaid).toBe(promoPrice);
    } finally {
      // Chỉ xóa dữ liệu được tạo riêng cho bài test này.
      if (userId) {
        await prisma.user.deleteMany({ where: { id: userId } });
      }

      if (promotionId) {
        await prisma.promotion.deleteMany({
          where: { id: promotionId },
        });
      }
    }
  }, 30000);

  it('chỉ cho phép một trong hai Payment cùng người dùng sử dụng khuyến mại', async () => {
    if (!prisma || !paymentService) {
      throw new Error('Prisma hoặc PaymentService chưa được khởi tạo.');
    }

    const dbRows = await prisma.$queryRaw<
      Array<{ database_name: string }>
    >`SELECT current_database() AS database_name`;

    expect(dbRows[0]?.database_name).toBe('text_to_voice_test');

    const freePlan = await prisma.plan.findUnique({
      where: { code: 'FREE' },
    });
    const paidPlan = await prisma.plan.findUnique({
      where: { code: 'TEST_BASIC' },
    });

    if (!freePlan?.isActive || !paidPlan?.isActive) {
      throw new Error('Thiếu Plan FREE hoặc TEST_BASIC đang hoạt động.');
    }

    let userId: string | undefined;
    let promotionId: string | undefined;

    try {
      const now = new Date();
      const promoPrice = Math.round(paidPlan.price * 0.8);

      const user = await prisma.user.create({
        data: {
          email: `promo-duplicate-${randomUUID()}@example.test`,
          name: 'Duplicate promotion payment integration test',
        },
      });
      userId = user.id;

      await prisma.subscription.create({
        data: {
          userId: user.id,
          planId: freePlan.id,
          startedAt: now,
          expiresAt: new Date(now.getTime() + 7 * 86400000),
          status: 'ACTIVE',
          characterLimit: freePlan.characterLimit,
          rolloverCharacters: 0,
          pricePaid: 0,
          currency: freePlan.currency,
        },
      });

      const promotion = await prisma.promotion.create({
        data: {
          title: 'Duplicate redemption integration test',
          message: 'Only one payment may redeem this promotion',
          startsAt: new Date(now.getTime() - 60000),
          endsAt: new Date(now.getTime() + 3600000),
          status: 'ACTIVE',
          planPrices: {
            create: {
              planId: paidPlan.id,
              promotionalPrice: promoPrice,
            },
          },
        },
      });
      promotionId = promotion.id;

      const createPayment = () =>
        prisma!.payment.create({
          data: {
            userId: user.id,
            planId: paidPlan.id,
            planNameSnapshot: paidPlan.name,
            planPriceSnapshot: paidPlan.price,
            planDurationDaysSnapshot: paidPlan.durationDays,
            planCharacterLimitSnapshot: paidPlan.characterLimit,
            promotionIdSnapshot: promotion.id,
            promotionTitleSnapshot: promotion.title,
            promotionPriceSnapshot: promoPrice,
            discountAmountSnapshot: paidPlan.price - promoPrice,
            amount: promoPrice,
            currency: paidPlan.currency,
            status: 'PENDING',
            provider: 'BANK_TRANSFER',
            paymentType: 'NEW_PURCHASE',
            transferCode: `KH-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
          },
        });

      const payment1 = await createPayment();
      const payment2 = await createPayment();

      const beforeSubscriptionCount = await prisma.subscription.count({
        where: { userId: user.id },
      });
      const beforeQuotaLotCount = await prisma.quotaLot.count({
        where: { subscription: { userId: user.id } },
      });

      const firstResult = await paymentService.confirmPayment(payment1.id);

      const firstPayment =
        'payment' in firstResult ? firstResult.payment : undefined;

      if (firstPayment) {
        expect(firstPayment.status).toBe('PAID');
      } else if ('status' in firstResult) {
        expect(firstResult.status).toBe('PAID');
      } else {
        throw new Error('Kết quả xác nhận thanh toán không có trạng thái.');
      }

      await expect(
        paymentService.confirmPayment(payment2.id),
      ).rejects.toThrow();

      const savedPayment1 = await prisma.payment.findUniqueOrThrow({
        where: { id: payment1.id },
      });
      const savedPayment2 = await prisma.payment.findUniqueOrThrow({
        where: { id: payment2.id },
      });

      expect(savedPayment1.status).toBe('PAID');
      expect(savedPayment2.status).not.toBe('PAID');

      expect(savedPayment1).toMatchObject({
        promotionIdSnapshot: promotion.id,
        promotionPriceSnapshot: promoPrice,
        amount: promoPrice,
      });
      expect(savedPayment2).toMatchObject({
        promotionIdSnapshot: promotion.id,
        promotionPriceSnapshot: promoPrice,
        amount: promoPrice,
      });

      const redemptions = await prisma.promotionRedemption.findMany({
        where: {
          userId: user.id,
          promotionId: promotion.id,
        },
      });
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0].paymentId).toBe(payment1.id);

      const afterSubscriptionCount = await prisma.subscription.count({
        where: { userId: user.id },
      });
      const afterQuotaLotCount = await prisma.quotaLot.count({
        where: { subscription: { userId: user.id } },
      });

      expect(afterSubscriptionCount).toBe(beforeSubscriptionCount + 1);
      expect(afterQuotaLotCount).toBe(beforeQuotaLotCount + 1);
    } finally {
      if (userId) {
        await prisma.promotionRedemption.deleteMany({
          where: { userId },
        });

        await prisma.user.deleteMany({
          where: { id: userId },
        });
      }

      if (promotionId) {
        await prisma.promotion.deleteMany({
          where: { id: promotionId },
        });
      }
    }
  }, 30000);
});
