import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SubscriptionService {
  constructor(private readonly prisma: PrismaService) {}

  async getActiveSubscription(userId: string) {
    const now = new Date();

    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        startedAt: {
          lte: now,
        },
        expiresAt: {
          gt: now,
        },
      },
      include: {
        plan: true,
      },
      orderBy: {
        expiresAt: 'desc',
      },
    });

    if (!subscription) {
      throw new BadRequestException(
        'Tài khoản chưa có gói sử dụng đang hoạt động.',
      );
    }

    if (!subscription.plan.isActive) {
      throw new BadRequestException('Gói sử dụng hiện không còn hoạt động.');
    }

    return subscription;
  }

  async getMySubscription(userId: string) {
    const subscription = await this.getActiveSubscription(userId);

    return {
      id: subscription.id,
      plan: subscription.plan.code,
      planName: subscription.plan.name,
      price: subscription.plan.price,
      currency: subscription.currency,
      startedAt: subscription.startedAt,
      expiresAt: subscription.expiresAt,
      status: subscription.status,
      characterLimit: subscription.characterLimit,
      rolloverCharacters: subscription.rolloverCharacters,
    };
  }
  async upgradeSubscription(userId: string, planCode: string) {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();

      const currentSubscription = await tx.subscription.findFirst({
        where: {
          userId,
          status: 'ACTIVE',
          startedAt: {
            lte: now,
          },
          expiresAt: {
            gt: now,
          },
        },
        include: {
          plan: true,
        },
        orderBy: {
          expiresAt: 'desc',
        },
      });

      if (!currentSubscription) {
        throw new BadRequestException(
          'Tài khoản chưa có gói sử dụng đang hoạt động.',
        );
      }

      if (!currentSubscription.plan.isActive) {
        throw new BadRequestException('Gói sử dụng hiện không còn hoạt động.');
      }

      const targetPlan = await tx.plan.findUnique({
        where: {
          code: planCode.trim().toUpperCase(),
        },
      });

      if (!targetPlan || !targetPlan.isActive) {
        throw new NotFoundException(
          'Gói sử dụng không tồn tại hoặc không còn hoạt động.',
        );
      }

      if (targetPlan.id === currentSubscription.planId) {
        throw new BadRequestException('Bạn đang sử dụng gói này.');
      }

      if (targetPlan.price <= currentSubscription.plan.price) {
        throw new BadRequestException(
          'Chỉ có thể nâng cấp lên gói có mức giá cao hơn.',
        );
      }

      const usage = await tx.usage.aggregate({
        where: {
          userId,
          subscriptionId: currentSubscription.id,
        },
        _sum: {
          characters: true,
        },
      });

      const usedCharacters = usage._sum.characters ?? 0;

      const currentTotalQuota =
        currentSubscription.characterLimit +
        currentSubscription.rolloverCharacters;

      const remainingCharacters = Math.max(
        currentTotalQuota - usedCharacters,
        0,
      );

      const expiresAt = new Date(now);
      expiresAt.setDate(expiresAt.getDate() + targetPlan.durationDays);

      await tx.subscription.update({
        where: {
          id: currentSubscription.id,
        },
        data: {
          status: 'EXPIRED',
        },
      });

      const newSubscription = await tx.subscription.create({
        data: {
          userId,
          planId: targetPlan.id,
          startedAt: now,
          expiresAt,
          status: 'ACTIVE',
          characterLimit: targetPlan.characterLimit,
          rolloverCharacters: remainingCharacters,
          pricePaid: targetPlan.price,
          currency: targetPlan.currency,
        },
        include: {
          plan: true,
        },
      });

      return {
        id: newSubscription.id,
        plan: newSubscription.plan.code,
        planName: newSubscription.plan.name,
        price: newSubscription.plan.price,
        currency: newSubscription.currency,
        startedAt: newSubscription.startedAt,
        expiresAt: newSubscription.expiresAt,
        status: newSubscription.status,
        characterLimit: newSubscription.characterLimit,
        rolloverCharacters: newSubscription.rolloverCharacters,
        totalQuota:
          newSubscription.characterLimit + newSubscription.rolloverCharacters,
        previousPlan: currentSubscription.plan.code,
        previousRemainingCharacters: remainingCharacters,
      };
    });
  }
}
