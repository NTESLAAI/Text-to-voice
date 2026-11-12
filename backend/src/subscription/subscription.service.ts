import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SubscriptionService {
  constructor(private readonly prisma: PrismaService) {}

  async getAvailablePlans() {
    return this.prisma.plan.findMany({
      where: {
        isActive: true,
      },
      select: {
        id: true,
        code: true,
        name: true,
        price: true,
        currency: true,
        durationDays: true,
        characterLimit: true,
        isActive: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

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

  async getMySubscription(userId: string, role?: string) {
    if (role === 'ADMIN') {
      return {
        id: null,
        plan: 'ADMIN',
        planName: 'Admin - Không giới hạn',
        price: 0,
        currency: 'VND',
        startedAt: null,
        expiresAt: null,
        status: 'ACTIVE',
        characterLimit: null,
        rolloverCharacters: 0,
        renewalAvailable: false,
        renewalExpiresAt: null,
        unlimited: true,
      };
    }
    try {
      const subscription = await this.getActiveSubscription(userId);

      return {
        id: subscription.id,
        plan: subscription.plan.code,
        planName: subscription.plan.name,
        billingSource: subscription.billingSource,
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
      // Catalog/network errors must not be disguised as an expired account.
      if (!(error instanceof BadRequestException)) throw error;
      const now = new Date();
      const renewalWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const renewalSubscription = await this.prisma.subscription.findFirst({
        where: {
          userId,
          status: 'ACTIVE',
          billingSource: 'WEB',
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
        const latest = await this.prisma.subscription.findFirst({
          where: { userId },
          include: { plan: true },
          orderBy: { startedAt: 'desc' },
        });
        if (latest && latest.billingSource !== 'WEB' && latest.billingSource && (latest.expiresAt <= now || latest.status !== 'ACTIVE')) {
          return { id: latest.id, billingSource: latest.billingSource, plan: latest.plan.code, planName: latest.plan.name, price: latest.plan.price, currency: latest.currency, startedAt: latest.startedAt, expiresAt: latest.expiresAt, status: 'EXPIRED', characterLimit: latest.characterLimit, rolloverCharacters: 0, renewalAvailable: false, renewalExpiresAt: null };
        }
        if (
          latest?.plan.code === 'FREE' &&
          latest.expiresAt <= now &&
          ['ACTIVE', 'EXPIRED'].includes(latest.status)
        ) {
          return {
            id: latest.id,
            plan: latest.plan.code,
            planName: latest.plan.name,
            price: latest.plan.price,
            currency: latest.currency,
            startedAt: latest.startedAt,
            expiresAt: latest.expiresAt,
            status: 'EXPIRED',
            characterLimit: latest.characterLimit,
            rolloverCharacters: 0,
            renewalAvailable: false,
            renewalExpiresAt: null,
          };
        }
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
