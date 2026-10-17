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
});
