import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { PromotionStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PromotionService } from './promotion.service';

describe('PromotionService', () => {
  let service: PromotionService;

  const prismaMock = {
    promotion: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    plan: {
      findMany: jest.fn(),
    },
    promotionPlanPrice: {
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const txMock = {
    $queryRaw: jest.fn(),
    promotion: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    promotionPlanPrice: {
      deleteMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: typeof txMock) => Promise<unknown>) =>
        callback(txMock),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromotionService,
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
      ],
    }).compile();

    service = module.get<PromotionService>(PromotionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should reject activation when another ACTIVE promotion overlaps', async () => {
    const now = new Date();

    txMock.promotion.findUnique.mockResolvedValue({
      id: 'promotion-new',
      title: 'Promotion mới',
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 60 * 60_000),
      status: PromotionStatus.DRAFT,
    });

    txMock.promotion.findFirst.mockResolvedValue({
      id: 'promotion-existing',
      title: 'Promotion đang chạy',
    });

    await expect(
      service.changeStatus('promotion-new', PromotionStatus.ACTIVE),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(txMock.promotion.update).not.toHaveBeenCalled();
  });

  it('should reject activation when another ACTIVE promotion has a different time range', async () => {
    const now = new Date();

    txMock.promotion.findUnique.mockResolvedValue({
      id: 'promotion-new',
      title: 'Promotion mới',
      startsAt: new Date(now.getTime() + 2 * 24 * 60 * 60_000),
      endsAt: new Date(now.getTime() + 3 * 24 * 60 * 60_000),
      status: PromotionStatus.DRAFT,
    });

    txMock.promotion.findFirst.mockResolvedValue({
      id: 'promotion-existing',
      title: 'Promotion đang chạy',
    });

    await expect(
      service.changeStatus('promotion-new', PromotionStatus.ACTIVE),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(txMock.promotion.findFirst).toHaveBeenCalledWith({
      where: {
        id: { not: 'promotion-new' },
        status: PromotionStatus.ACTIVE,
      },
      select: { id: true, title: true },
    });

    expect(txMock.promotion.update).not.toHaveBeenCalled();
  });

  it('should activate when no other ACTIVE promotion overlaps', async () => {
    const now = new Date();

    const promotion = {
      id: 'promotion-new',
      title: 'Promotion mới',
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 60 * 60_000),
      status: PromotionStatus.DRAFT,
    };

    txMock.promotion.findUnique.mockResolvedValue(promotion);
    txMock.promotion.findFirst.mockResolvedValue(null);
    txMock.promotion.update.mockResolvedValue({
      ...promotion,
      status: PromotionStatus.ACTIVE,
    });

    const result = await service.changeStatus(
      'promotion-new',
      PromotionStatus.ACTIVE,
    );

    expect(txMock.promotion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { not: 'promotion-new' },
          status: PromotionStatus.ACTIVE,
        },
        select: { id: true, title: true },
      }),
    );

    expect(txMock.promotion.update).toHaveBeenCalledWith({
      where: { id: 'promotion-new' },
      data: { status: PromotionStatus.ACTIVE },
    });

    expect(result.status).toBe(PromotionStatus.ACTIVE);
  });
});
