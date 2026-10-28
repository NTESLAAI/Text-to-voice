import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentService } from '../payment/payment.service';
import { UsersService } from '../users/users.service';
import { UpdatePlanDto } from './dto/update-plan.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentService: PaymentService,
    private readonly usersService: UsersService,
  ) {}

  async getPayments() {
    const payments = await this.prisma.payment.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
        plan: { select: { id: true, code: true, name: true } },
        transactions: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            provider: true,
            providerTransactionId: true,
            amount: true,
            currency: true,
            status: true,
            reference: true,
            note: true,
            receivedAt: true,
            matchedAt: true,
            createdAt: true,
          },
        },
      },
    });

    return payments.map((payment) => {
      const matchedTransactions = payment.transactions.filter(
        (transaction) => transaction.status === 'MATCHED',
      );

      const matchedAmount = matchedTransactions.reduce(
        (total, transaction) => total + transaction.amount,
        0,
      );

      const surplusAmount = Math.max(0, matchedAmount - payment.amount);

      return {
        ...payment,
        matchedAmount,
        surplusAmount,
      };
    });
  }

  async confirmPayment(paymentId: string) {
    return this.paymentService.confirmPayment(paymentId);
  }

  async getUsers() {
    return this.usersService.findAllForAdmin();
  }

  async getPlans() {
    return this.prisma.plan.findMany({
      orderBy: { createdAt: 'asc' },
    });
  }

  async updatePlan(planId: string, data: UpdatePlanDto) {
    const plan = await this.prisma.plan.findUnique({
      where: { id: planId },
      select: { id: true },
    });

    if (!plan) {
      throw new NotFoundException('Không tìm thấy gói dịch vụ');
    }

    return this.prisma.plan.update({
      where: { id: planId },
      data,
    });
  }
}
