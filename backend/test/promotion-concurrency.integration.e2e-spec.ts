import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { PromotionStatus } from '../generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { PromotionService } from '../src/promotion/promotion.service';

describe('Promotion concurrency integration', () => {
  let prisma: PrismaService;
  let service: PromotionService;
  let originalDatabaseUrl: string | undefined;

  beforeAll(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;

    if (!originalDatabaseUrl) {
      throw new Error('DATABASE_URL is not configured');
    }

    const testDatabaseUrl = new URL(originalDatabaseUrl);
    testDatabaseUrl.pathname = '/text_to_voice_test';
    process.env.DATABASE_URL = testDatabaseUrl.toString();

    prisma = new PrismaService();

    try {
      await prisma.$connect();

      const rows = await prisma.$queryRaw<
        Array<{ current_database: string }>
      >`SELECT current_database()`;

      if (rows[0]?.current_database !== 'text_to_voice_test') {
        throw new Error(`Unsafe test database: ${rows[0]?.current_database}`);
      }

      service = new PromotionService(prisma);
    } catch (error) {
      await prisma.$disconnect();
      process.env.DATABASE_URL = originalDatabaseUrl;
      throw error;
    }
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await prisma.$disconnect();
      }
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });

  it('allows only one promotion to become ACTIVE when two activations race', async () => {
    const ids: string[] = [];

    try {
      const now = new Date();
      const startsAt = new Date(now.getTime() - 60_000);
      const endsAt = new Date(now.getTime() + 60 * 60 * 1000);

      const first = await prisma.promotion.create({
        data: {
          title: `Concurrency test A ${randomUUID()}`,
          message: 'E2E concurrency test',
          startsAt,
          endsAt,
          status: PromotionStatus.DRAFT,
        },
      });
      ids.push(first.id);

      const second = await prisma.promotion.create({
        data: {
          title: `Concurrency test B ${randomUUID()}`,
          message: 'E2E concurrency test',
          startsAt,
          endsAt,
          status: PromotionStatus.DRAFT,
        },
      });
      ids.push(second.id);

      const results = await Promise.allSettled([
        service.changeStatus(first.id, PromotionStatus.ACTIVE),
        service.changeStatus(second.id, PromotionStatus.ACTIVE),
      ]);

      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      if (rejected[0].status === 'rejected') {
        expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      }

      const finalPromotions = await prisma.promotion.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true },
      });

      expect(
        finalPromotions.filter(
          (promotion) => promotion.status === PromotionStatus.ACTIVE,
        ),
      ).toHaveLength(1);

      expect(
        finalPromotions.filter(
          (promotion) => promotion.status === PromotionStatus.DRAFT,
        ),
      ).toHaveLength(1);
    } finally {
      if (ids.length > 0) {
        const rows = await prisma.$queryRaw<
          Array<{ current_database: string }>
        >`SELECT current_database()`;

        if (rows[0]?.current_database !== 'text_to_voice_test') {
          throw new Error(
            'Refusing to clean up promotions outside text_to_voice_test',
          );
        }

        await prisma.promotion.deleteMany({
          where: { id: { in: ids } },
        });
      }
    }
  });
});
