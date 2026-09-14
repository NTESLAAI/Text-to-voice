import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async getMySubscription(userId: string) {
    const subscription =
      await this.prisma.subscription.findFirst({
        where: {
          userId,
          status: 'ACTIVE',
        },
        include: {
          plan: true,
        },
        orderBy: {
          expiresAt: 'desc',
        },
      });

    if (!subscription) {
      throw new NotFoundException(
        'Tài khoản chưa có gói sử dụng.',
      );
    }

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
      rolloverCharacters:
        subscription.rolloverCharacters,
    };
  }
}