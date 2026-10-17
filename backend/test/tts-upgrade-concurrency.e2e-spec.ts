
jest.mock('../src/tts/providers/openrouter-tts.provider', () => ({
  OpenRouterTtsProvider: class MockOpenRouterTtsProvider {},
}));

import 'dotenv/config';

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { basename, join } from 'path';

import { AudioService } from '../src/audio/audio.service';
import { PaymentService } from '../src/payment/payment.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TtsService } from '../src/tts/tts.service';
import type { TtsRequest } from '../src/tts/providers/openrouter-tts.provider';

describe('TTS and CONVERT_TO_CREDIT concurrency integration', () => {
  let prisma: PrismaService | undefined;
  let originalDatabaseUrl: string | undefined;
  let testUserId: string | undefined;
  let testProjectId: string | undefined;

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
        throw new Error('Sai database. Dừng kiểm thử.');
      }
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
        throw new Error('Sai database khi dọn dữ liệu. Không xóa.');
      }

      if (testProjectId) {
        const audios = await prisma.audio.findMany({
          where: { projectId: testProjectId },
          select: { fileUrl: true },
        });

        for (const audio of audios) {
          if (!audio.fileUrl?.startsWith('/uploads/audio/')) continue;

          const fileName = basename(audio.fileUrl);

          if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/i.test(
              fileName,
            )
          ) {
            continue;
          }

          try {
            await fs.unlink(
              join(process.cwd(), 'uploads', 'audio', fileName),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error;
            }
          }
        }
      }

      if (testUserId) {
        await prisma.user.deleteMany({
          where: { id: testUserId },
        });
        testUserId = undefined;
      }
    } finally {
      if (prisma) {
        await prisma.$disconnect();
        prisma = undefined;
      }

      if (originalDatabaseUrl !== undefined) {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });

  it('không cho TTS sử dụng quota cũ sau khi quota đã quy đổi thành credit', async () => {
    if (!prisma) throw new Error('Prisma chưa kết nối.');

    const dbRows = await prisma.$queryRaw<
      Array<{ database_name: string }>
    >`SELECT current_database() AS database_name`;

    if (dbRows[0]?.database_name !== 'text_to_voice_test') {
      throw new Error('Sai database. Dừng kiểm thử.');
    }

    const [sourcePlan, targetPlan] = await Promise.all([
      prisma.plan.findUnique({ where: { code: 'TEST_BASIC' } }),
      prisma.plan.findUnique({ where: { code: 'TEST_PRO' } }),
    ]);

    if (
      !sourcePlan?.isActive ||
      !targetPlan?.isActive ||
      sourcePlan.characterLimit <= 0 ||
      targetPlan.price <= sourcePlan.price
    ) {
      throw new Error('Các Plan kiểm thử không hợp lệ.');
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + 7 * 24 * 60 * 60 * 1000,
    );

    const user = await prisma.user.create({
      data: {
        email: `upgrade-race-${randomUUID()}@example.test`,
        name: 'TTS upgrade concurrency test',
      },
    });
    testUserId = user.id;

    const project = await prisma.project.create({
      data: {
        name: 'TTS upgrade concurrency test',
        userId: user.id,
      },
    });
    testProjectId = project.id;

    const oldSubscription = await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: sourcePlan.id,
        startedAt: now,
        expiresAt,
        status: 'ACTIVE',
        characterLimit: sourcePlan.characterLimit,
        rolloverCharacters: 0,
        pricePaid: sourcePlan.price,
        currency: sourcePlan.currency,
      },
    });

    const oldLot = await prisma.quotaLot.create({
      data: {
        subscriptionId: oldSubscription.id,
        charactersGranted: 50,
        charactersRemaining: 50,
        rolloverCount: 0,
        expiresAt,
      },
    });

    const creditAmount = Math.round(
      50 * (sourcePlan.price / sourcePlan.characterLimit),
    );

    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        planId: targetPlan.id,
        planNameSnapshot: targetPlan.name,
        planPriceSnapshot: targetPlan.price,
        planDurationDaysSnapshot: targetPlan.durationDays,
        planCharacterLimitSnapshot: targetPlan.characterLimit,
        sourceSubscriptionId: oldSubscription.id,
        sourcePlanPriceSnapshot: sourcePlan.price,
        sourcePlanCharacterLimitSnapshot: sourcePlan.characterLimit,
        amount: Math.round(targetPlan.price - creditAmount),
        currency: targetPlan.currency,
        status: 'PENDING',
        provider: 'BANK_TRANSFER',
        paymentType: 'UPGRADE',
        upgradeOption: 'CONVERT_TO_CREDIT',
        creditAmount,
        transferCode: `KH-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
      },
    });

    let providerEntered!: () => void;
    let releaseProvider!: () => void;

    const enteredGate = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });

    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });

    const providerMock = {
      synthesize: jest.fn(async (_request: TtsRequest) => {
        providerEntered();
        await providerGate;
        return Buffer.alloc(480);
      }),
    } as any;

    const ttsService = new TtsService(
      prisma,
      new AudioService(prisma),
      providerMock,
    );

    const paymentService = new PaymentService(prisma);

    const request = {
      projectId: project.id,
      text: 'a'.repeat(10),
      language: 'en',
      region: 'test',
      character: 'test',
      tone: 'test',
      emotion: 'test',
      style: 'test',
      speed: 1,
    } as unknown as TtsRequest;

    let ttsPromise: Promise<unknown> | undefined;

    try {
      // TTS kiểm tra quota và dừng tại provider giả lập.
      ttsPromise = ttsService.synthesize(request, user.id);
      await enteredGate;

      // Nâng cấp trong lúc TTS đang chờ.
      const result = await paymentService.confirmPayment(payment.id);
      expect(result.payment?.status).toBe('PAID');

      // Cho TTS tiếp tục sau khi nâng cấp đã commit.
      releaseProvider();

      // Kỳ vọng an toàn: TTS phải bị từ chối, không dùng quota đã quy đổi.
      await expect(ttsPromise).rejects.toThrow();

      const [subscriptionAfter, lotAfter, paymentAfter, usages, audios] =
        await Promise.all([
          prisma.subscription.findUnique({
            where: { id: oldSubscription.id },
          }),
          prisma.quotaLot.findUnique({ where: { id: oldLot.id } }),
          prisma.payment.findUnique({ where: { id: payment.id } }),
          prisma.usage.findMany({
            where: {
              userId: user.id,
              subscriptionId: oldSubscription.id,
              type: 'tts',
            },
          }),
          prisma.audio.findMany({
            where: { projectId: project.id },
          }),
        ]);

      expect(subscriptionAfter?.status).toBe('EXPIRED');
      expect(paymentAfter?.status).toBe('PAID');
      expect(lotAfter?.charactersRemaining).toBe(0);
      expect(usages).toHaveLength(0);
      expect(audios).toHaveLength(0);
    } finally {
      // Không để provider giả lập bị treo nếu một bước kiểm tra lỗi.
      releaseProvider();

      if (ttsPromise) {
        await ttsPromise.catch(() => undefined);
      }
    }
  }, 30000);
});
