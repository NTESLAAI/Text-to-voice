import 'dotenv/config';

import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentService } from '../src/payment/payment.service';
import { SepayWebhookService } from '../src/payment/sepay-webhook.service';
import { SepayWebhookDto } from '../src/payment/dto/sepay-webhook.dto';

describe('SePay webhook retry integration', () => {
  let prisma: PrismaService | undefined;
  let paymentService: PaymentService | undefined;
  let webhookService: SepayWebhookService | undefined;
  let originalDatabaseUrl: string | undefined;
  let testUserId: string | undefined;
  let testFreePlanId: string | undefined;

  beforeAll(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    if (!originalDatabaseUrl) {
      throw new Error('Thiếu DATABASE_URL. Dừng kiểm thử.');
    }

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
      webhookService = new SepayWebhookService(prisma, paymentService);
    } catch (error) {
      await prisma.$disconnect().catch(() => undefined);
      prisma = undefined;
      process.env.DATABASE_URL = originalDatabaseUrl;
      throw error;
    }
  });

  afterAll(async () => {
    try {
      if (!prisma) return;

      const rows = await prisma.$queryRaw<
        Array<{ database_name: string }>
      >`SELECT current_database() AS database_name`;
      if (rows[0]?.database_name !== 'text_to_voice_test') {
        throw new Error('Sai database khi dọn dữ liệu. Không thực hiện xóa.');
      }

      if (testUserId) {
        const payments = await prisma.payment.findMany({
          where: { userId: testUserId },
          select: { id: true },
        });
        const paymentIds = payments.map((p) => p.id);
        if (paymentIds.length) {
          await prisma.paymentTransaction.deleteMany({
            where: { paymentId: { in: paymentIds } },
          });
        }
        await prisma.user.deleteMany({ where: { id: testUserId } });
        testUserId = undefined;
      }

      if (testFreePlanId) {
        const references = await prisma.$queryRaw<
          Array<{ subscriptions: bigint; payments: bigint }>
        >`
          SELECT
            (SELECT COUNT(*) FROM "Subscription" WHERE "planId" = ${testFreePlanId}) AS subscriptions,
            (SELECT COUNT(*) FROM "Payment" WHERE "planId" = ${testFreePlanId}) AS payments
        `;
        const row = references[0];
        if (
          row &&
          Number(row.subscriptions) === 0 &&
          Number(row.payments) === 0
        ) {
          await prisma.plan.deleteMany({ where: { id: testFreePlanId } });
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
      webhookService = undefined;
      if (originalDatabaseUrl !== undefined) {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });

  it('retry cùng webhook sau lỗi confirm sẽ PAID đúng một lần', async () => {
    if (!prisma || !paymentService || !webhookService) {
      throw new Error('Prisma hoặc service chưa được khởi tạo.');
    }

    const dbRows = await prisma.$queryRaw<
      Array<{ database_name: string }>
    >`SELECT current_database() AS database_name`;
    expect(dbRows[0]?.database_name).toBe('text_to_voice_test');

    let freePlan = await prisma.plan.findUnique({ where: { code: 'FREE' } });
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
    if (!paidPlan?.isActive) {
      throw new Error('Không tìm thấy Plan TEST_BASIC đang hoạt động.');
    }

    const now = new Date();
    const user = await prisma.user.create({
      data: {
        email: `sepay-retry-${randomUUID()}@example.test`,
        name: 'SePay retry integration test',
      },
    });
    testUserId = user.id;

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

    const transferCode = `KH-${Array.from(
      { length: 8 },
      () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)],
    ).join('')}`;
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
        transferCode,
      },
    });

    const body: SepayWebhookDto = {
      id: Date.now(),
      gateway: 'TEST_BANK',
      transactionDate: new Date().toISOString(),
      accountNumber: 'TEST_ACCOUNT',
      code: transferCode,
      content: `Thanh toan ${transferCode}`,
      transferType: 'in',
      transferAmount: payment.amount,
      accumulated: payment.amount,
      referenceCode: `IT-${randomUUID()}`,
    };

    const beforeSubscriptions = await prisma.subscription.count({
      where: { userId: user.id },
    });
    const beforeQuotaLots = await prisma.quotaLot.count({
      where: { subscription: { userId: user.id } },
    });

    // Giả lập lỗi sau khi webhook đã commit PaymentTransaction MATCHED.
    const confirmSpy = jest.spyOn(paymentService, 'confirmPayment');
    confirmSpy.mockImplementationOnce(async () => {
      throw new Error('Simulated transient confirmation failure');
    });

    await expect(webhookService.handleWebhook(body)).rejects.toThrow(
      'Simulated transient confirmation failure',
    );

    const savedTransaction = await prisma.paymentTransaction.findUnique({
      where: {
        provider_providerTransactionId: {
          provider: 'SEPAY',
          providerTransactionId: String(body.id),
        },
      },
    });
    expect(savedTransaction).toMatchObject({
      paymentId: payment.id,
      status: 'MATCHED',
      amount: payment.amount,
    });

    const paymentAfterFailure = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(paymentAfterFailure.status).toBe('PENDING');

    // Cùng webhook gửi lại: duplicate path phải gọi confirmPayment lần nữa.
    const retryResult = await webhookService.handleWebhook(body);
    expect(retryResult).toMatchObject({
      success: true,
      duplicate: true,
      retried: true,
    });

    const paidPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(paidPayment.status).toBe('PAID');

    const subscriptionCountAfterRetry = await prisma.subscription.count({
      where: { userId: user.id },
    });
    const quotaLotCountAfterRetry = await prisma.quotaLot.count({
      where: { subscription: { userId: user.id } },
    });
    expect(subscriptionCountAfterRetry).toBe(beforeSubscriptions + 1);
    expect(quotaLotCountAfterRetry).toBe(beforeQuotaLots + 1);

    // Gửi lần thứ ba: đã PAID nên duplicate không kích hoạt confirm nữa.
    const callsAfterSuccessfulRetry = confirmSpy.mock.calls.length;
    const duplicateResult = await webhookService.handleWebhook(body);
    expect(duplicateResult).toMatchObject({ success: true, duplicate: true });
    expect(confirmSpy).toHaveBeenCalledTimes(callsAfterSuccessfulRetry);

    const finalTransactionCount = await prisma.paymentTransaction.count({
      where: {
        provider: 'SEPAY',
        providerTransactionId: String(body.id),
      },
    });
    const finalSubscriptionCount = await prisma.subscription.count({
      where: { userId: user.id },
    });
    const finalQuotaLotCount = await prisma.quotaLot.count({
      where: { subscription: { userId: user.id } },
    });

    expect(finalTransactionCount).toBe(1);
    expect(finalSubscriptionCount).toBe(beforeSubscriptions + 1);
    expect(finalQuotaLotCount).toBe(beforeQuotaLots + 1);

    confirmSpy.mockRestore();
  }, 30000);
});
