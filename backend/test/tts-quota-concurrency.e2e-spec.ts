jest.mock('../src/tts/providers/openrouter-tts.provider', () => ({
  OpenRouterTtsProvider: class MockOpenRouterTtsProvider {},
}));
import 'dotenv/config';

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { basename, join } from 'path';

import { AudioService } from '../src/audio/audio.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TtsService } from '../src/tts/tts.service';
import type { TtsRequest } from '../src/tts/providers/openrouter-tts.provider';

describe('TTS quota concurrency integration', () => {
  let prisma: PrismaService | undefined;
  let originalDatabaseUrl: string | undefined;

  let testUserId: string | undefined;
  let testProjectId: string | undefined;
  let testSubscriptionId: string | undefined;

  beforeAll(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;

    if (!originalDatabaseUrl) {
      throw new Error('Thiếu DATABASE_URL. Dừng kiểm thử.');
    }

    // Chỉ đổi tên database, không in thông tin kết nối.
    const testUrl = new URL(originalDatabaseUrl);
    testUrl.pathname = '/text_to_voice_test';
    process.env.DATABASE_URL = testUrl.toString();

    prisma = new PrismaService();

    try {
      await prisma.$connect();

      // Bắt buộc xác minh DB trước mọi thao tác ghi.
      const dbRows = await prisma.$queryRaw<Array<{ database_name: string }>>`
        SELECT current_database() AS database_name
      `;

      if (dbRows[0]?.database_name !== 'text_to_voice_test') {
        throw new Error('Sai database. Dừng kiểm thử, không được ghi dữ liệu.');
      }
    } catch (error) {
      await prisma.$disconnect().catch(() => undefined);
      prisma = undefined;
      process.env.DATABASE_URL = originalDatabaseUrl;
      throw error;
    }
  });

  afterAll(async () => {
    if (prisma) {
      try {
        // Chỉ dọn file Audio thuộc Project do test này tạo.
        if (testProjectId) {
          const audioRows = await prisma.audio.findMany({
            where: { projectId: testProjectId },
            select: { fileUrl: true },
          });

          for (const audio of audioRows) {
            if (!audio.fileUrl?.startsWith('/uploads/audio/')) {
              continue;
            }

            const fileName = basename(audio.fileUrl);

            // Chỉ chấp nhận tên WAV dạng UUID.
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

        // Xóa đúng User riêng của test.
        // Các quan hệ cascade sẽ dọn Project, Subscription,
        // QuotaLot, Audio, Usage và UsageQuotaAllocation liên quan.
        if (testUserId) {
          await prisma.user.deleteMany({
            where: { id: testUserId },
          });
        }
      } finally {
        await prisma.$disconnect();
        prisma = undefined;
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    } else if (originalDatabaseUrl) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('chỉ cho phép một trong hai yêu cầu 60 ký tự sử dụng quota 100 ký tự', async () => {
    if (!prisma) {
      throw new Error('Prisma chưa kết nối.');
    }

    // Kiểm tra lại ngay trước khi tạo fixture.
    const dbRows = await prisma.$queryRaw<Array<{ database_name: string }>>`
        SELECT current_database() AS database_name
      `;

    if (dbRows[0]?.database_name !== 'text_to_voice_test') {
      throw new Error('Sai database kiểm thử. Dừng ngay.');
    }

    const plan = await prisma.plan.findUnique({
      where: { code: 'TEST_BASIC' },
    });

    if (!plan || !plan.isActive) {
      throw new Error(
        'Không tìm thấy Plan TEST_BASIC đang hoạt động trong DB test.',
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

    // Fixture hoàn toàn riêng, không dùng User/Subscription có sẵn.
    const user = await prisma.user.create({
      data: {
        email: `tts-race-${randomUUID()}@example.test`,
        name: 'TTS concurrency integration test',
      },
    });
    testUserId = user.id;

    const project = await prisma.project.create({
      data: {
        name: 'TTS quota concurrency test',
        userId: user.id,
      },
    });
    testProjectId = project.id;

    const subscription = await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        startedAt: now,
        expiresAt,
        status: 'ACTIVE',
        characterLimit: 100,
        rolloverCharacters: 0,
        pricePaid: plan.price,
        currency: plan.currency,
      },
    });
    testSubscriptionId = subscription.id;

    const lot = await prisma.quotaLot.create({
      data: {
        subscriptionId: subscription.id,
        charactersGranted: 100,
        charactersRemaining: 100,
        rolloverCount: 0,
        expiresAt,
      },
    });

    // Buộc cả hai yêu cầu vượt qua bước kiểm tra quota
    // và cùng đến provider trước khi cho phép tiếp tục.
    let providerCalls = 0;
    let releaseProviderGate!: () => void;

    const providerGate = new Promise<void>((resolve) => {
      releaseProviderGate = resolve;
    });

    const providerMock = {
      synthesize: jest.fn(async (_request: TtsRequest) => {
        providerCalls += 1;

        if (providerCalls === 2) {
          releaseProviderGate();
        }

        await providerGate;

        return Buffer.alloc(480);
      }),
    } as any;

    const audioService = new AudioService(prisma);
    const ttsService = new TtsService(prisma, audioService, providerMock);

    const request = {
      projectId: project.id,
      text: 'a'.repeat(60),
      language: 'en',
      region: 'test',
      character: 'test',
      tone: 'test',
      emotion: 'test',
      style: 'test',
      speed: 1,
    } as unknown as TtsRequest;

    const results = await Promise.allSettled([
      ttsService.synthesize(request, user.id),
      ttsService.synthesize(request, user.id),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(providerMock.synthesize).toHaveBeenCalledTimes(2);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const remainingLot = await prisma.quotaLot.findUnique({
      where: { id: lot.id },
    });

    expect(remainingLot?.charactersRemaining).toBe(40);

    const usages = await prisma.usage.findMany({
      where: {
        userId: user.id,
        subscriptionId: subscription.id,
        type: 'tts',
      },
      include: {
        quotaAllocations: true,
      },
    });

    expect(usages).toHaveLength(1);
    expect(usages[0].characters).toBe(60);
    expect(
      usages[0].quotaAllocations.reduce(
        (sum, allocation) => sum + allocation.characters,
        0,
      ),
    ).toBe(60);

    const audios = await prisma.audio.findMany({
      where: { projectId: project.id },
    });

    expect(audios).toHaveLength(1);
    expect(audios[0].characters).toBe(60);
  }, 30000);
});
