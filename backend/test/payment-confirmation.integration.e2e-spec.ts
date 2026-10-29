import 'dotenv/config';

import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentService } from '../src/payment/payment.service';
import { PaymentTransactionService } from '../src/payment/payment-transaction.service';

describe('Payment confirmation integration safety', () => {
  let prisma: PrismaService | undefined;
  let paymentService: PaymentService | undefined;
  let paymentTransactionService: PaymentTransactionService | undefined;
  let originalDatabaseUrl: string | undefined;

  let testUserId: string | undefined;
  let testFreePlanId: string | undefined;

  // Tạo giao dịch MATCHED qua đúng luồng nghiệp vụ, không tự cập nhật trạng thái bằng SQL.
  async function createMatchedBankTransaction(
    paymentId: string,
    amount: number,
    currency = 'VND',
  ) {
    if (!paymentTransactionService) {
      throw new Error('PaymentTransactionService chưa được khởi tạo.');
    }

    const transaction = await paymentTransactionService.recordBankTransaction({
      providerTransactionId: `IT-${randomUUID()}`,
      amount,
      currency,
      receivedAt: new Date().toISOString(),
      reference: `Integration test ${paymentId}`,
      note: 'Giao dịch do bài test tích hợp tạo',
    });

    await paymentTransactionService.linkBankTransaction(transaction.id, {
      paymentId,
    });
    await paymentTransactionService.confirmTransactionReceived(transaction.id);
    return paymentTransactionService.reconcileBankTransaction(transaction.id);
  }

  async function createLinkedBankTransaction(
    paymentId: string,
    amount: number,
    currency = 'VND',
  ) {
    if (!paymentTransactionService) {
      throw new Error('PaymentTransactionService chưa được khởi tạo.');
    }

    const transaction = await paymentTransactionService.recordBankTransaction({
      providerTransactionId: `IT-${randomUUID()}`,
      amount,
      currency,
      receivedAt: new Date().toISOString(),
      reference: `Integration test ${paymentId}`,
      note: 'Giao dịch do bài test tích hợp tạo',
    });

    await paymentTransactionService.linkBankTransaction(transaction.id, {
      paymentId,
    });
    return transaction;
  }

  async function cleanupTestUser(userId: string) {
    if (!prisma) {
      return;
    }

    const rows = await prisma.$queryRaw<
      Array<{ database_name: string }>
    >`SELECT current_database() AS database_name`;
    if (rows[0]?.database_name !== 'text_to_voice_test') {
      throw new Error(
        'Sai database khi dọn dữ liệu test. Không thực hiện xóa.',
      );
    }

    const payments = await prisma.payment.findMany({
      where: { userId },
      select: { id: true },
    });
    const paymentIds = payments.map((payment) => payment.id);

    // PaymentTransaction có onDelete: Restrict, nên xóa giao dịch test trước Payment/User.
    if (paymentIds.length > 0) {
      await prisma.paymentTransaction.deleteMany({
        where: { paymentId: { in: paymentIds } },
      });
    }

    await prisma.user.deleteMany({
      where: { id: userId },
    });
  }

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
      paymentTransactionService = new PaymentTransactionService(prisma);
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
        await cleanupTestUser(testUserId);

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
      paymentTransactionService = undefined;

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

    if (payment.amount < 2) {
      throw new Error(
        'TEST_BASIC cần có giá lớn hơn 1 VND để kiểm tra nhiều giao dịch.',
      );
    }

    const firstTransferAmount = Math.floor(payment.amount / 2);
    const secondTransferAmount = payment.amount - firstTransferAmount;
    await createMatchedBankTransaction(
      payment.id,
      firstTransferAmount,
      payment.currency,
    );
    await createMatchedBankTransaction(
      payment.id,
      secondTransferAmount,
      payment.currency,
    );

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

      await createMatchedBankTransaction(
        payment.id,
        payment.amount,
        payment.currency,
      );

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
        await cleanupTestUser(userId);
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

      await createMatchedBankTransaction(
        payment1.id,
        payment1.amount,
        payment1.currency,
      );
      await createMatchedBankTransaction(
        payment2.id,
        payment2.amount,
        payment2.currency,
      );

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

        await cleanupTestUser(userId);
      }

      if (promotionId) {
        await prisma.promotion.deleteMany({
          where: { id: promotionId },
        });
      }
    }
  }, 30000);

  it('từ chối xác nhận khi tổng hai giao dịch MATCHED vẫn thiếu tiền', async () => {
    if (!prisma || !paymentService) {
      throw new Error('Prisma hoặc PaymentService chưa được khởi tạo.');
    }

    const dbRows = await prisma.$queryRaw<
      Array<{ database_name: string }>
    >`SELECT current_database() AS database_name`;
    expect(dbRows[0]?.database_name).toBe('text_to_voice_test');

    const paidPlan = await prisma.plan.findUnique({
      where: { code: 'TEST_BASIC' },
    });
    if (!paidPlan?.isActive || paidPlan.price <= 2) {
      throw new Error(
        'Cần Plan TEST_BASIC đang hoạt động với giá lớn hơn 2 VND.',
      );
    }

    let userId: string | undefined;
    try {
      const user = await prisma.user.create({
        data: {
          email: `payment-underpaid-${randomUUID()}@example.test`,
          name: 'Underpaid integration test',
        },
      });
      userId = user.id;

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

      const totalMatched = payment.amount - 1;
      const firstAmount = Math.floor(totalMatched / 2);
      const secondAmount = totalMatched - firstAmount;
      await createMatchedBankTransaction(
        payment.id,
        firstAmount,
        payment.currency,
      );
      await createMatchedBankTransaction(
        payment.id,
        secondAmount,
        payment.currency,
      );

      await expect(paymentService.confirmPayment(payment.id)).rejects.toThrow(
        /Chưa nhận đủ tiền thanh toán/,
      );

      const savedPayment = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(savedPayment.status).toBe('PENDING');

      const matched = await prisma.paymentTransaction.aggregate({
        where: { paymentId: payment.id, status: 'MATCHED' },
        _sum: { amount: true },
      });
      expect(matched._sum.amount).toBe(totalMatched);
    } finally {
      if (userId) {
        await cleanupTestUser(userId);
      }
    }
  }, 30000);

  it('không tính giao dịch UNMATCHED hoặc RECEIVED vào tổng tiền xác nhận', async () => {
    if (!prisma || !paymentService || !paymentTransactionService) {
      throw new Error('Các service thanh toán chưa được khởi tạo.');
    }

    const dbRows = await prisma.$queryRaw<
      Array<{ database_name: string }>
    >`SELECT current_database() AS database_name`;
    expect(dbRows[0]?.database_name).toBe('text_to_voice_test');

    const paidPlan = await prisma.plan.findUnique({
      where: { code: 'TEST_BASIC' },
    });
    if (!paidPlan?.isActive || paidPlan.price <= 0) {
      throw new Error('Cần Plan TEST_BASIC đang hoạt động với giá lớn hơn 0.');
    }

    let userId: string | undefined;
    try {
      const user = await prisma.user.create({
        data: {
          email: `payment-unmatched-${randomUUID()}@example.test`,
          name: 'Unmatched transaction integration test',
        },
      });
      userId = user.id;

      const createPayment = (transferCode: string) =>
        prisma!.payment.create({
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
            transferCode,
          },
        });

      const receivedPayment = await createPayment(
        `KH-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
      );
      const receivedTransaction = await createLinkedBankTransaction(
        receivedPayment.id,
        receivedPayment.amount,
        receivedPayment.currency,
      );
      await paymentTransactionService.confirmTransactionReceived(
        receivedTransaction.id,
      );

      await expect(
        paymentService.confirmPayment(receivedPayment.id),
      ).rejects.toThrow(/Chưa nhận đủ tiền thanh toán/);

      const unmatchedPayment = await createPayment(
        `KH-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
      );
      await createLinkedBankTransaction(
        unmatchedPayment.id,
        unmatchedPayment.amount,
        unmatchedPayment.currency,
      );

      await expect(
        paymentService.confirmPayment(unmatchedPayment.id),
      ).rejects.toThrow(/Chưa nhận đủ tiền thanh toán/);

      const savedReceivedPayment = await prisma.payment.findUniqueOrThrow({
        where: { id: receivedPayment.id },
      });
      const savedUnmatchedPayment = await prisma.payment.findUniqueOrThrow({
        where: { id: unmatchedPayment.id },
      });
      expect(savedReceivedPayment.status).toBe('PENDING');
      expect(savedUnmatchedPayment.status).toBe('PENDING');
    } finally {
      if (userId) {
        await cleanupTestUser(userId);
      }
    }
  }, 30000);
});
