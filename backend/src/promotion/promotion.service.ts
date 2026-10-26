import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PromotionStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';

@Injectable()
export class PromotionService {
  constructor(private readonly prisma: PrismaService) {}

  async getAdminPromotions() {
    const now = new Date();

    const promotions = await this.prisma.promotion.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        planPrices: {
          include: {
            plan: {
              select: {
                id: true,
                code: true,
                name: true,
                price: true,
              },
            },
          },
        },
      },
    });

    return promotions.map((promotion) => {
      let effectiveStatus = promotion.status;

      if (
        promotion.status === PromotionStatus.ACTIVE &&
        promotion.endsAt <= now
      ) {
        effectiveStatus = PromotionStatus.ENDED;
      }

      return { ...promotion, effectiveStatus };
    });
  }

  async getAvailablePlans() {
    return this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        price: true,
        isActive: true,
      },
    });
  }

  async getActivePromotion() {
    const now = new Date();

    return this.prisma.promotion.findFirst({
      where: {
        status: PromotionStatus.ACTIVE,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        planPrices: {
          include: {
            plan: {
              select: {
                id: true,
                code: true,
                name: true,
                price: true,
              },
            },
          },
        },
      },
    });
  }

  async createPromotion(dto: CreatePromotionDto) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);

    this.validateDates(startsAt, endsAt);
    await this.validatePlanPrices(dto.planPrices);

    return this.prisma.promotion.create({
      data: {
        title: dto.title.trim(),
        message: dto.message.trim(),
        startsAt,
        endsAt,
        status: PromotionStatus.DRAFT,
        planPrices: {
          create: dto.planPrices.map((item) => ({
            planId: item.planId,
            promotionalPrice: item.promotionalPrice,
          })),
        },
      },
      include: {
        planPrices: {
          include: {
            plan: {
              select: {
                id: true,
                code: true,
                name: true,
                price: true,
              },
            },
          },
        },
      },
    });
  }

  async updatePromotion(id: string, dto: UpdatePromotionDto) {
    return this.prisma.$transaction(async (tx) => {
      // Đồng bộ tất cả thao tác thay đổi lịch và trạng thái khuyến mại.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(726314159, 1)`;

      const existing = await tx.promotion.findUnique({
        where: { id },
      });

      if (!existing) {
        throw new NotFoundException('Không tìm thấy chương trình khuyến mại');
      }

      const now = new Date();

      if (existing.status === PromotionStatus.ENDED || existing.endsAt <= now) {
        throw new BadRequestException(
          'Không thể sửa chương trình khuyến mại đã kết thúc',
        );
      }

      // Cho phép sửa chương trình ACTIVE nếu chưa bắt đầu.
      if (
        existing.status === PromotionStatus.ACTIVE &&
        existing.startsAt <= now
      ) {
        throw new BadRequestException(
          'Không thể sửa chương trình khuyến mại đang diễn ra',
        );
      }

      const startsAt =
        dto.startsAt !== undefined ? new Date(dto.startsAt) : existing.startsAt;

      const endsAt =
        dto.endsAt !== undefined ? new Date(dto.endsAt) : existing.endsAt;

      this.validateDates(startsAt, endsAt);

      if (dto.planPrices !== undefined) {
        await this.validatePlanPrices(dto.planPrices);
      }

      if (existing.status === PromotionStatus.ACTIVE) {
        const otherActive = await tx.promotion.findFirst({
          where: {
            id: { not: id },
            status: PromotionStatus.ACTIVE,
          },
          select: { id: true, title: true },
        });

        if (otherActive) {
          throw new ConflictException(
            `Đã có chương trình khuyến mại ACTIVE khác: "${otherActive.title}"`,
          );
        }
      }

      if (dto.planPrices !== undefined) {
        await tx.promotionPlanPrice.deleteMany({
          where: { promotionId: id },
        });
      }

      return tx.promotion.update({
        where: { id },
        data: {
          ...(dto.title !== undefined && { title: dto.title.trim() }),
          ...(dto.message !== undefined && { message: dto.message.trim() }),
          ...(dto.startsAt !== undefined && { startsAt }),
          ...(dto.endsAt !== undefined && { endsAt }),
          ...(dto.planPrices !== undefined && {
            planPrices: {
              create: dto.planPrices.map((item) => ({
                planId: item.planId,
                promotionalPrice: item.promotionalPrice,
              })),
            },
          }),
        },
        include: {
          planPrices: {
            include: {
              plan: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  price: true,
                },
              },
            },
          },
        },
      });
    });
  }

  async changeStatus(id: string, status: PromotionStatus) {
    return this.prisma.$transaction(async (tx) => {
      // Phải dùng cùng khóa với updatePromotion().
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(726314159, 1)`;

      const existing = await tx.promotion.findUnique({
        where: { id },
      });

      if (!existing) {
        throw new NotFoundException('Không tìm thấy chương trình khuyến mại');
      }

      const now = new Date();

      if (existing.status === PromotionStatus.ENDED || existing.endsAt <= now) {
        throw new BadRequestException(
          'Chương trình đã kết thúc và không thể thay đổi trạng thái',
        );
      }

      if (status === PromotionStatus.ACTIVE) {
        if (existing.endsAt <= now) {
          throw new BadRequestException(
            'Không thể kích hoạt chương trình đã hết thời gian',
          );
        }

        const otherActive = await tx.promotion.findFirst({
          where: {
            id: { not: id },
            status: PromotionStatus.ACTIVE,
          },
          select: { id: true, title: true },
        });

        if (otherActive) {
          throw new ConflictException(
            `Đã có chương trình khuyến mại ACTIVE khác: "${otherActive.title}"`,
          );
        }
      }

      return tx.promotion.update({
        where: { id },
        data: { status },
      });
    });
  }

  private validateDates(startsAt: Date, endsAt: Date) {
    if (
      Number.isNaN(startsAt.getTime()) ||
      Number.isNaN(endsAt.getTime()) ||
      endsAt <= startsAt
    ) {
      throw new BadRequestException(
        'Thời gian kết thúc phải sau thời gian bắt đầu',
      );
    }
  }

  private async validatePlanPrices(
    prices: { planId: string; promotionalPrice: number }[],
  ) {
    const planIds = prices.map((item) => item.planId);

    if (new Set(planIds).size !== planIds.length) {
      throw new BadRequestException(
        'Không được khai báo trùng gói cước trong một chương trình',
      );
    }

    const plans = await this.prisma.plan.findMany({
      where: { id: { in: planIds } },
      select: { id: true, name: true, price: true },
    });

    if (plans.length !== planIds.length) {
      throw new BadRequestException('Có gói cước không tồn tại hoặc đã bị xóa');
    }

    const planMap = new Map(plans.map((plan) => [plan.id, plan]));

    for (const item of prices) {
      const plan = planMap.get(item.planId);

      if (!plan) {
        throw new BadRequestException('Không tìm thấy gói cước');
      }

      if (
        !Number.isFinite(item.promotionalPrice) ||
        item.promotionalPrice < 0 ||
        item.promotionalPrice > plan.price
      ) {
        throw new BadRequestException(
          `Giá khuyến mại của gói "${plan.name}" phải từ 0 đến giá niêm yết`,
        );
      }
    }
  }
}
