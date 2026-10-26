import 'dotenv/config';

import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentService } from '../src/payment/payment.service';

describe('Quota rollover integration: T1 → T2 → T3', () => {
  let prisma: PrismaService | undefined;
  let paymentService: PaymentService | undefined;
  let originalDatabaseUrl: string | undefined;
  let testUserId: string | undefined;

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
      if (!prisma) return;
      const rows = await prisma.$queryRaw<
        Array<{ database_name: string }>
      >`SELECT current_database() AS database_name`;
      if (rows[0]?.database_name !== 'text_to_voice_test') {
        throw new Error('Sai database khi dọn dữ liệu. Không thực hiện xóa.');
      }
      // Chỉ xóa User riêng do bài test này tạo; các quan hệ Cascade sẽ dọn theo.
      if (testUserId) {
        await prisma.user.deleteMany({ where: { id: testUserId } });
        testUserId = undefined;
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

  it(
    'chỉ rollover quota gốc một lần qua T1 → T2 → T3',
    async () => {
      if (!prisma || !paymentService) {
        throw new Error('Prisma hoặc PaymentService chưa được khởi tạo.');
      }

      const dbRows = await prisma.$queryRaw<
        Array<{ database_name: string }>
      >`SELECT current_database() AS database_name`;
      expect(dbRows[0]?.database_name).toBe('text_to_voice_test');

      const plan = await prisma.plan.findUnique({ where: { code: 'TEST_BASIC' } });
      if (!plan || !plan.isActive) {
        throw new Error('Không tìm thấy Plan TEST_BASIC đang hoạt động.');
      }

      const user = await prisma.user.create({
        data: {
          email: `quota-rollover-${randomUUID()}@example.test`,
          name: 'Quota rollover integration test',
        },
      });
      testUserId = user.id;

      // T1 đã hết hạn nhưng vẫn nằm trong cửa sổ gia hạn 24 giờ.
      const now = new Date();
      const t1ExpiresAt = new Date(now.getTime() - 60_000);
      const t1 = await prisma.subscription.create({
        data: {
          userId: user.id,
          planId: plan.id,
          startedAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
          expiresAt: t1ExpiresAt,
          status: 'ACTIVE',
          characterLimit: plan.characterLimit,
          rolloverCharacters: 0,
          pricePaid: plan.price,
          currency: plan.currency,
        },
      });

      const t1BaseLot = await prisma.quotaLot.create({
        data: {
          subscriptionId: t1.id,
          sourceLotId: null,
          charactersGranted: 100,
          charactersRemaining: 40,
          rolloverCount: 0,
          expiresAt: t1ExpiresAt,
        },
      });

      // Gia hạn lần 1: T1 → T2.
      const paymentT2 = await paymentService.createPayment(user.id, 'TEST_BASIC');
      expect(paymentT2.paymentType).toBe('RENEWAL');
      await paymentService.confirmPayment(paymentT2.id);

      const t1LotAfterRenewal = await prisma.quotaLot.findUniqueOrThrow({
        where: { id: t1BaseLot.id },
      });
      expect(t1LotAfterRenewal.charactersRemaining).toBe(0);
      expect(t1LotAfterRenewal.rolloverCount).toBe(1);

      const t2 = await prisma.subscription.findFirstOrThrow({
        where: { userId: user.id, planId: plan.id, status: 'ACTIVE' },
        orderBy: { startedAt: 'desc' },
      });
      const t2Lots = await prisma.quotaLot.findMany({
        where: { subscriptionId: t2.id },
        orderBy: { createdAt: 'asc' },
      });
      const t2BaseLot = t2Lots.find((lot) => lot.sourceLotId === null);
      const t2RolloverFromT1 = t2Lots.find(
        (lot) => lot.sourceLotId === t1BaseLot.id,
      );

      expect(t2BaseLot).toBeDefined();
      expect(t2BaseLot?.rolloverCount).toBe(0);
      expect(t2BaseLot?.charactersRemaining).toBe(plan.characterLimit);
      expect(t2RolloverFromT1).toBeDefined();
      expect(t2RolloverFromT1?.charactersGranted).toBe(40);
      expect(t2RolloverFromT1?.charactersRemaining).toBe(40);
      expect(t2RolloverFromT1?.rolloverCount).toBe(1);

      // Mô phỏng T2 hết hạn; chỉ sửa các bản ghi của User riêng trong bài test.
      const t2ExpiresAt = new Date(Date.now() - 60_000);
      await prisma.subscription.update({
        where: { id: t2.id },
        data: { expiresAt: t2ExpiresAt },
      });
      await prisma.quotaLot.updateMany({
        where: { subscriptionId: t2.id },
        data: { expiresAt: t2ExpiresAt },
      });

      // Gia hạn lần 2: T2 → T3.
      const paymentT3 = await paymentService.createPayment(user.id, 'TEST_BASIC');
      expect(paymentT3.paymentType).toBe('RENEWAL');
      await paymentService.confirmPayment(paymentT3.id);

      const t2LotsAfterRenewal = await prisma.quotaLot.findMany({
        where: { subscriptionId: t2.id },
      });
      const t2BaseLotAfterRenewal = t2LotsAfterRenewal.find(
        (lot) => lot.id === t2BaseLot?.id,
      );
      const t2RolloverLotAfterRenewal = t2LotsAfterRenewal.find(
        (lot) => lot.id === t2RolloverFromT1?.id,
      );

      // Quota gốc của T2 được rollover sang T3.
      expect(t2BaseLotAfterRenewal?.charactersRemaining).toBe(0);
      expect(t2BaseLotAfterRenewal?.rolloverCount).toBe(1);

      // Quota nhận từ T1 không được rollover tiếp sang T3.
      expect(t2RolloverLotAfterRenewal?.charactersRemaining).toBe(40);
      expect(t2RolloverLotAfterRenewal?.rolloverCount).toBe(1);

      const t3 = await prisma.subscription.findFirstOrThrow({
        where: { userId: user.id, planId: plan.id, status: 'ACTIVE' },
        orderBy: { startedAt: 'desc' },
      });
      const t3Lots = await prisma.quotaLot.findMany({
        where: { subscriptionId: t3.id },
      });
      const t3BaseLot = t3Lots.find((lot) => lot.sourceLotId === null);
      const t3RolloverFromT2Base = t3Lots.find(
        (lot) => lot.sourceLotId === t2BaseLot?.id,
      );
      const t3RolloverFromT1DerivedLot = t3Lots.find(
        (lot) => lot.sourceLotId === t2RolloverFromT1?.id,
      );

      expect(t3BaseLot).toBeDefined();
      expect(t3BaseLot?.charactersRemaining).toBe(plan.characterLimit);
      expect(t3BaseLot?.rolloverCount).toBe(0);
      expect(t3RolloverFromT2Base).toBeDefined();
      expect(t3RolloverFromT2Base?.charactersGranted).toBe(plan.characterLimit);
      expect(t3RolloverFromT2Base?.charactersRemaining).toBe(plan.characterLimit);
      expect(t3RolloverFromT2Base?.rolloverCount).toBe(1);
      // Không tạo lot T3 có nguồn là lot rollover T1 → T2.
      expect(t3RolloverFromT1DerivedLot).toBeUndefined();
    },
    30000,
  );
});
