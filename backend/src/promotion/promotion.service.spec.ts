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
    $executeRaw: jest.fn(),
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

  it('should reject updating an ENDED promotion', async () => {
    const now = new Date();

    txMock.promotion.findUnique.mockResolvedValue({
      id: 'promotion-ended',
      status: PromotionStatus.ENDED,
      startsAt: new Date(now.getTime() - 2 * 24 * 60 * 60_000),
      endsAt: new Date(now.getTime() - 24 * 60 * 60_000),
    });

    await expect(
      service.updatePromotion('promotion-ended', { title: 'Updated title' }),
    ).rejects.toThrow();

    expect(txMock.promotion.update).not.toHaveBeenCalled();
  });

  it('should reject updating an ACTIVE promotion that has already started', async () => {
    const now = new Date();

    txMock.promotion.findUnique.mockResolvedValue({
      id: 'promotion-running',
      status: PromotionStatus.ACTIVE,
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 60 * 60_000),
    });

    await expect(
      service.updatePromotion('promotion-running', { title: 'Updated title' }),
    ).rejects.toThrow();

    expect(txMock.promotion.update).not.toHaveBeenCalled();
  });

  it('should allow updating a valid DRAFT promotion', async () => {
    const now = new Date();
    const promotion = {
      id: 'promotion-draft',
      status: PromotionStatus.DRAFT,
      startsAt: new Date(now.getTime() + 60 * 60_000),
      endsAt: new Date(now.getTime() + 24 * 60 * 60_000),
    };

    txMock.promotion.findUnique.mockResolvedValue(promotion);
    txMock.promotion.update.mockResolvedValue({
      ...promotion,
      title: 'Updated title',
    });

    await service.updatePromotion('promotion-draft', {
      title: 'Updated title',
    });

    expect(txMock.promotion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'promotion-draft' },
        data: expect.objectContaining({ title: 'Updated title' }),
      }),
    );
  });

  it('should reject an invalid promotional price above list price', async () => {
    const now = new Date();
    const promotion = {
      id: 'promotion-draft',
      status: PromotionStatus.DRAFT,
      startsAt: new Date(now.getTime() + 60 * 60_000),
      endsAt: new Date(now.getTime() + 24 * 60 * 60_000),
    };

    txMock.promotion.findUnique.mockResolvedValue(promotion);
    prismaMock.plan.findMany.mockResolvedValue([
      { id: 'plan-basic', name: 'Basic', price: 100_000 },
    ]);

    await expect(
      service.updatePromotion('promotion-draft', {
        planPrices: [{ planId: 'plan-basic', promotionalPrice: 120_000 }],
      }),
    ).rejects.toThrow();

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
