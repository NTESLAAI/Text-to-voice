import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaymentService {
  constructor(private readonly prisma: PrismaService) {}

  async createPayment(userId: string, planCode: string) {
    const normalizedPlanCode = planCode.trim().toUpperCase();

    const plan = await this.prisma.plan.findUnique({
      where: {
        code: normalizedPlanCode,
      },
    });

    if (!plan || !plan.isActive) {
      throw new NotFoundException(
        'Gói sử dụng không tồn tại hoặc không còn hoạt động.',
      );
    }

    if (plan.code === 'FREE') {
      throw new BadRequestException('Không thể tạo thanh toán cho gói Free.');
    }

    const activeSubscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        startedAt: {
          lte: new Date(),
        },
        expiresAt: {
          gt: new Date(),
        },
      },
      include: {
        plan: true,
      },
      orderBy: {
        expiresAt: 'desc',
      },
    });

    if (!activeSubscription) {
      throw new BadRequestException(
        'Tài khoản chưa có gói sử dụng đang hoạt động.',
      );
    }

    if (plan.id === activeSubscription.planId) {
      throw new BadRequestException('Bạn đang sử dụng gói này.');
    }

    if (plan.price <= activeSubscription.plan.price) {
      throw new BadRequestException(
        'Chỉ có thể thanh toán để nâng cấp lên gói có mức giá cao hơn.',
      );
    }

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        planId: plan.id,
        amount: plan.price,
        currency: plan.currency,
        status: 'PENDING',
        provider: 'BANK_TRANSFER',
      },
      include: {
        plan: true,
      },
    });

    return {
      id: payment.id,
      plan: payment.plan.code,
      planName: payment.plan.name,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      provider: payment.provider,
      bankName: process.env.BANK_TRANSFER_BANK_NAME,
      accountNumber: process.env.BANK_TRANSFER_ACCOUNT_NUMBER,
      accountName: process.env.BANK_TRANSFER_ACCOUNT_NAME,
      createdAt: payment.createdAt,
    };
  }
  async confirmPayment(paymentId: string) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: {
          id: paymentId,
        },
        include: {
          plan: true,
        },
      });

      if (!payment) {
        throw new NotFoundException('Không tìm thấy giao dịch thanh toán.');
      }

      if (payment.status !== 'PENDING') {
        throw new BadRequestException(
          'Giao dịch không ở trạng thái chờ thanh toán.',
        );
      }

      const activeSubscription = await tx.subscription.findFirst({
        where: {
          userId: payment.userId,
          status: 'ACTIVE',
          startedAt: {
            lte: new Date(),
          },
          expiresAt: {
            gt: new Date(),
          },
        },
        include: {
          plan: true,
        },
        orderBy: {
          expiresAt: 'desc',
        },
      });

      if (!activeSubscription) {
        throw new BadRequestException(
          'Tài khoản không có gói sử dụng đang hoạt động.',
        );
      }

      if (payment.plan.price <= activeSubscription.plan.price) {
        throw new BadRequestException(
          'Giao dịch không phải là nâng cấp lên gói có mức giá cao hơn.',
        );
      }

      const usageAggregate = await tx.usage.aggregate({
        where: {
          subscriptionId: activeSubscription.id,
        },
        _sum: {
          characters: true,
        },
      });

      const usedCharacters = usageAggregate._sum.characters ?? 0;

      const previousRemaining = Math.max(
        0,
        activeSubscription.characterLimit +
          activeSubscription.rolloverCharacters -
          usedCharacters,
      );

      const now = new Date();

      await tx.subscription.update({
        where: {
          id: activeSubscription.id,
        },
        data: {
          status: 'EXPIRED',
        },
      });

      const newSubscription = await tx.subscription.create({
        data: {
          userId: payment.userId,
          planId: payment.planId,
          startedAt: now,
          expiresAt: new Date(
            now.getTime() + payment.plan.durationDays * 24 * 60 * 60 * 1000,
          ),
          status: 'ACTIVE',
          characterLimit: payment.plan.characterLimit + previousRemaining,
          rolloverCharacters: previousRemaining,
          pricePaid: payment.amount,
          currency: payment.currency,
        },
        include: {
          plan: true,
        },
      });

      const updatedPayment = await tx.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          status: 'PAID',
          paidAt: now,
        },
      });

      return {
        payment: {
          id: updatedPayment.id,
          status: updatedPayment.status,
          paidAt: updatedPayment.paidAt,
          amount: updatedPayment.amount,
          currency: updatedPayment.currency,
        },
        subscription: {
          id: newSubscription.id,
          plan: newSubscription.plan.code,
          planName: newSubscription.plan.name,
          characterLimit: newSubscription.characterLimit,
          rolloverCharacters: newSubscription.rolloverCharacters,
          startedAt: newSubscription.startedAt,
          expiresAt: newSubscription.expiresAt,
        },
        previousRemaining,
      };
    });
  }
}
