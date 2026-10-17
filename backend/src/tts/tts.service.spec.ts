jest.mock('./providers/openrouter-tts.provider', () => ({
  OpenRouterTtsProvider: class MockOpenRouterTtsProvider {},
}));
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';

import { TtsService } from './tts.service';
import { PrismaService } from '../prisma/prisma.service';
import { AudioService } from '../audio/audio.service';
import { OpenRouterTtsProvider } from './providers/openrouter-tts.provider';

describe('TtsService', () => {
  let service: TtsService;

  let prismaMock: {
    subscription: {
      findFirst: jest.Mock;
    };
    quotaLot: {
      findMany: jest.Mock;
      update: jest.Mock;
    };
  };

  let audioServiceMock: Record<string, jest.Mock>;
  let ttsProviderMock: Record<string, jest.Mock>;

  const makeSubscription = (overrides: Record<string, any> = {}) => ({
    id: 'subscription-1',
    userId: 'user-1',
    status: 'ACTIVE',
    characterLimit: 1000,
    rolloverCharacters: 0,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2027-01-01T00:00:00Z'),
    plan: {
      code: 'PRO',
      isActive: true,
    },
    ...overrides,
  });

  const makeLot = (
    id: string,
    charactersGranted: number,
    charactersRemaining: number,
    expiresAt = new Date('2026-12-01T00:00:00Z'),
    createdAt = new Date('2026-01-01T00:00:00Z'),
  ) => ({
    id,
    charactersGranted,
    charactersRemaining,
    expiresAt,
    createdAt,
  });

  beforeEach(async () => {
    prismaMock = {
      subscription: {
        findFirst: jest.fn(),
      },
      quotaLot: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    audioServiceMock = {
      saveAudio: jest.fn(),
    };

    ttsProviderMock = {
      synthesize: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TtsService,
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
        {
          provide: AudioService,
          useValue: audioServiceMock,
        },
        {
          provide: OpenRouterTtsProvider,
          useValue: ttsProviderMock,
        },
      ],
    }).compile();

    service = module.get<TtsService>(TtsService);
  });

  describe('initialization', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });
  });

  describe('checkCharacterQuota', () => {
    const checkQuota = (userId: string, characters: number) =>
      (service as any).checkCharacterQuota(userId, characters);

    it('should reject when no active subscription exists', async () => {
      prismaMock.subscription.findFirst.mockResolvedValue(null);

      await expect(checkQuota('user-1', 10)).rejects.toThrow(
        'Tài khoản chưa có gói sử dụng đang hoạt động.',
      );

      expect(prismaMock.quotaLot.findMany).not.toHaveBeenCalled();
    });

    it('should reject when the plan is inactive', async () => {
      prismaMock.subscription.findFirst.mockResolvedValue(
        makeSubscription({
          plan: {
            code: 'PRO',
            isActive: false,
          },
        }),
      );

      await expect(checkQuota('user-1', 10)).rejects.toThrow(
        'Gói sử dụng hiện không còn hoạt động.',
      );

      expect(prismaMock.quotaLot.findMany).not.toHaveBeenCalled();
    });

    it('should query only unexpired quota lots in expiry order', async () => {
      prismaMock.subscription.findFirst.mockResolvedValue(makeSubscription());

      prismaMock.quotaLot.findMany.mockResolvedValue([
        makeLot('lot-1', 100, 60),
        makeLot('lot-2', 200, 100),
      ]);

      await checkQuota('user-1', 50);

      expect(prismaMock.quotaLot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            subscriptionId: 'subscription-1',
            expiresAt: expect.objectContaining({
              gt: expect.any(Date),
            }),
          }),
          orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
        }),
      );
    });

    it('should return quota information when the quota is sufficient', async () => {
      prismaMock.subscription.findFirst.mockResolvedValue(makeSubscription());

      prismaMock.quotaLot.findMany.mockResolvedValue([
        makeLot('lot-1', 100, 60),
        makeLot('lot-2', 200, 100),
      ]);

      const result = await checkQuota('user-1', 50);

      expect(result).toMatchObject({
        subscription: expect.objectContaining({
          id: 'subscription-1',
        }),
        plan: {
          code: 'PRO',
          isActive: true,
        },
        characterLimit: 1000,
        rolloverCharacters: 0,
        totalQuota: 300,
        usedCharacters: 140,
        remainingCharacters: 160,
      });
    });

    it('should reject when the requested characters exceed remaining quota', async () => {
      prismaMock.subscription.findFirst.mockResolvedValue(makeSubscription());

      prismaMock.quotaLot.findMany.mockResolvedValue([
        makeLot('lot-1', 100, 40),
      ]);

      await expect(checkQuota('user-1', 41)).rejects.toThrow(
        BadRequestException,
      );

      await expect(checkQuota('user-1', 41)).rejects.toThrow(
        'Bạn chỉ còn 40 ký tự trong chu kỳ sử dụng.',
      );
    });

    it('should count only the quota lots returned by the unexpired-lot query', async () => {
      prismaMock.subscription.findFirst.mockResolvedValue(makeSubscription());

      // Mô phỏng kết quả DB: lot hết hạn đã bị loại khỏi truy vấn.
      prismaMock.quotaLot.findMany.mockResolvedValue([
        makeLot('valid-lot', 100, 50),
      ]);

      const result = await checkQuota('user-1', 50);

      expect(result.remainingCharacters).toBe(50);
      expect(result.totalQuota).toBe(100);
    });
  });

  describe('allocateQuotaLots', () => {
    const allocateQuota = (
      tx: any,
      subscriptionId: string,
      characters: number,
    ) => (service as any).allocateQuotaLots(tx, subscriptionId, characters);

    const makeTransaction = () => ({
      $queryRaw: jest.fn(),
      quotaLot: {
        update: jest.fn().mockResolvedValue({}),
      },
    });

    it('should return an empty array for zero or negative characters', async () => {
      const tx = makeTransaction();

      await expect(allocateQuota(tx, 'subscription-1', 0)).resolves.toEqual([]);

      await expect(allocateQuota(tx, 'subscription-1', -5)).resolves.toEqual(
        [],
      );

      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.quotaLot.update).not.toHaveBeenCalled();
    });

    it('should allocate quota in the order returned by the locked SQL query', async () => {
      const tx = makeTransaction();

      tx.$queryRaw.mockResolvedValue([
        {
          id: 'earlier-expiry',
          charactersRemaining: 30,
        },
        {
          id: 'later-expiry',
          charactersRemaining: 50,
        },
      ]);

      const result = await allocateQuota(tx, 'subscription-1', 60);

      expect(result).toEqual([
        {
          quotaLotId: 'earlier-expiry',
          characters: 30,
        },
        {
          quotaLotId: 'later-expiry',
          characters: 30,
        },
      ]);

      expect(tx.quotaLot.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'earlier-expiry' },
        data: { charactersRemaining: 0 },
      });

      expect(tx.quotaLot.update).toHaveBeenNthCalledWith(2, {
        where: { id: 'later-expiry' },
        data: { charactersRemaining: 20 },
      });
    });

    it('should reject when locked quota is insufficient', async () => {
      const tx = makeTransaction();

      tx.$queryRaw.mockResolvedValue([
        {
          id: 'lot-1',
          charactersRemaining: 20,
        },
      ]);

      await expect(allocateQuota(tx, 'subscription-1', 30)).rejects.toThrow(
        'Bạn chỉ còn 20 ký tự trong chu kỳ sử dụng.',
      );

      expect(tx.quotaLot.update).not.toHaveBeenCalled();
    });

    it('should not allocate more than the requested characters', async () => {
      const tx = makeTransaction();

      tx.$queryRaw.mockResolvedValue([
        {
          id: 'lot-1',
          charactersRemaining: 100,
        },
        {
          id: 'lot-2',
          charactersRemaining: 200,
        },
      ]);

      const result = await allocateQuota(tx, 'subscription-1', 25);

      expect(result).toEqual([
        {
          quotaLotId: 'lot-1',
          characters: 25,
        },
      ]);

      expect(tx.quotaLot.update).toHaveBeenCalledTimes(1);
      expect(tx.quotaLot.update).toHaveBeenCalledWith({
        where: { id: 'lot-1' },
        data: { charactersRemaining: 75 },
      });
    });

    it('should lock quota lots before checking and updating their balances', async () => {
      const tx = makeTransaction();

      tx.$queryRaw.mockResolvedValue([
        {
          id: 'lot-1',
          charactersRemaining: 50,
        },
      ]);

      await allocateQuota(tx, 'subscription-1', 10);

      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);

      const queryParts = tx.$queryRaw.mock.calls[0][0];
      const sql = Array.from(queryParts).join(' ');

      expect(sql).toContain('FOR UPDATE');
      expect(sql).toContain('"charactersRemaining" > 0');
      expect(sql).toContain('"expiresAt" > NOW()');
      expect(sql).toContain('"expiresAt" ASC');
    });

    it('should reject if quota decreases after the preliminary check', async () => {
      // Mô phỏng: checkCharacterQuota đã thấy 100 ký tự,
      // nhưng trước khi phân bổ, giao dịch chỉ còn 20.
      prismaMock.subscription.findFirst.mockResolvedValue(makeSubscription());

      prismaMock.quotaLot.findMany.mockResolvedValue([
        makeLot('lot-1', 100, 100),
      ]);

      const preliminaryQuota = await (service as any).checkCharacterQuota(
        'user-1',
        30,
      );

      expect(preliminaryQuota.remainingCharacters).toBe(100);

      const tx = makeTransaction();

      tx.$queryRaw.mockResolvedValue([
        {
          id: 'lot-1',
          charactersRemaining: 20,
        },
      ]);

      await expect(allocateQuota(tx, 'subscription-1', 30)).rejects.toThrow(
        'Bạn chỉ còn 20 ký tự trong chu kỳ sử dụng.',
      );

      expect(tx.quotaLot.update).not.toHaveBeenCalled();
    });
  });
});
