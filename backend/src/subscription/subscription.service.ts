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
    try {
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
        renewalAvailable: false,
        renewalExpiresAt: null,
      };
    } catch (error) {
      const now = new Date();
      const renewalWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const renewalSubscription = await this.prisma.subscription.findFirst({
        where: {
          userId,
          status: 'ACTIVE',
          plan: {
            code: {
              not: 'FREE',
            },
          },
          expiresAt: {
            gte: renewalWindowStart,
            lte: now,
          },
        },
        include: {
          plan: true,
        },
        orderBy: {
          expiresAt: 'desc',
        },
      });

      if (!renewalSubscription) {
        throw error;
      }

      return {
        id: renewalSubscription.id,
        plan: renewalSubscription.plan.code,
        planName: renewalSubscription.plan.name,
        price: renewalSubscription.plan.price,
        currency: renewalSubscription.currency,
        startedAt: renewalSubscription.startedAt,
        expiresAt: renewalSubscription.expiresAt,
        status: renewalSubscription.status,
        characterLimit: renewalSubscription.characterLimit,
        rolloverCharacters: renewalSubscription.rolloverCharacters,
        renewalAvailable: true,
        renewalExpiresAt: new Date(
          renewalSubscription.expiresAt.getTime() + 24 * 60 * 60 * 1000,
        ),
      };
    }
  }
}
