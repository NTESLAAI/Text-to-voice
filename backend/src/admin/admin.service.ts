import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentService } from '../payment/payment.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentService: PaymentService,
    private readonly usersService: UsersService,
  ) {}

  async getPayments() {
    return this.prisma.payment.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
        plan: { select: { id: true, code: true, name: true } },
      },
    });
  }

  async confirmPayment(paymentId: string) {
    return this.paymentService.confirmPayment(paymentId);
  }

  async getUsers() {
    return this.usersService.findAllForAdmin();
  }
}
