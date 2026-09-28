import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SubscriptionExpiryService {
  private readonly logger = new Logger(SubscriptionExpiryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Kiểm tra các subscription trả phí đã hết thời gian
   * chuyển tiếp 24 giờ và đưa tài khoản về Free.
   *
   * Không xử lý subscription Free.
   * Không rollover quota sau khi đã quá 24 giờ.
   */
  @Cron('0 * * * *')
  async expireSubscriptionsAfterGracePeriod() {
    const now = new Date();

    const expiredSubscriptions = await this.prisma.subscription.findMany({
      where: {
        status: 'ACTIVE',
        plan: {
          code: {
            not: 'FREE',
          },
        },
        expiresAt: {
          lt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        },
      },
      include: {
        plan: true,
      },
    });

    for (const subscription of expiredSubscriptions) {
      await this.prisma.$transaction(async (tx) => {
        const currentSubscription = await tx.subscription.findUnique({
          where: {
            id: subscription.id,
          },
        });

        if (
          !currentSubscription ||
          currentSubscription.status !== 'ACTIVE' ||
          currentSubscription.expiresAt >=
            new Date(now.getTime() - 24 * 60 * 60 * 1000)
        ) {
          return;
        }

        await tx.subscription.update({
          where: {
            id: currentSubscription.id,
          },
          data: {
            status: 'EXPIRED',
          },
        });

        const freePlan = await tx.plan.findUnique({
          where: {
            code: 'FREE',
          },
        });

        if (!freePlan || !freePlan.isActive) {
          throw new Error('Free plan không tồn tại hoặc không hoạt động.');
        }

        const freeSubscription = await tx.subscription.create({
          data: {
            userId: currentSubscription.userId,
            planId: freePlan.id,
            startedAt: now,
            expiresAt: new Date(
              now.getTime() + freePlan.durationDays * 24 * 60 * 60 * 1000,
            ),
            status: 'ACTIVE',
            characterLimit: freePlan.characterLimit,
            rolloverCharacters: 0,
            pricePaid: 0,
            currency: freePlan.currency,
          },
        });

        await tx.quotaLot.create({
          data: {
            subscriptionId: freeSubscription.id,
            sourceLotId: null,
            charactersGranted: freePlan.characterLimit,
            charactersRemaining: freePlan.characterLimit,
            rolloverCount: 0,
            expiresAt: freeSubscription.expiresAt,
          },
        });
      });

      this.logger.log(
        `Subscription ${subscription.id} hết thời gian chuyển tiếp 24 giờ. Tài khoản ${subscription.userId} đã trở về Free.`,
      );
    }
  }
}
