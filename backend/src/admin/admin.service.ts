import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentService } from '../payment/payment.service';
import { UsersService } from '../users/users.service';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { ReceivingBankAccountService } from '../payment/receiving-bank-account.service';
import { Prisma } from '../../generated/prisma/client';

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
        receivingBankAccount: true,
        surplusHandlings: { select: { amount: true, status: true } },
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
            receivingBankAccountId: true,
            receivingBankAccount: true,
            verificationSource: true,
            sourceVerifiedAt: true,
            sourceVerifiedById: true,
            verificationReference: true,
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
      const accounts = new ReceivingBankAccountService(this.prisma);
      const verified =
        Boolean(payment.receivingBankAccountId) &&
        matchedTransactions.every((r) =>
          accounts.verified(
            r,
            r.receivingBankAccount,
            payment.receivingBankAccountId,
            payment.currency,
          ),
        );
      const allocated = (payment.surplusHandlings ?? [])
        .filter((h) => h.status === 'PENDING' || h.status === 'COMPLETED')
        .reduce((sum, h) => sum.plus(h.amount), new Prisma.Decimal(0));
      const decimalMatched = matchedTransactions.reduce(
        (sum, r) => sum.plus(r.amount.toString()),
        new Prisma.Decimal(0),
      );
      const available = Prisma.Decimal.max(
        0,
        decimalMatched.minus(payment.amount.toString()),
      ).minus(allocated);

      return {
        ...payment,
        receivingBankAccount: this.accountView(payment.receivingBankAccount),
        transactions: payment.transactions.map((r) => ({
          ...r,
          receivingBankAccount: this.accountView(r.receivingBankAccount),
        })),
        spendabilityStatus:
          verified && available.greaterThanOrEqualTo(0)
            ? 'VERIFIED'
            : 'UNKNOWN',
        spendableAmount:
          verified && available.greaterThanOrEqualTo(0)
            ? available.toString()
            : null,
        matchedAmount,
        surplusAmount,
      };
    });
  }

  private accountView(
    a:
      | {
          id: string;
          code: string;
          bankCode: string;
          accountNumber: string;
          policy: string;
          isActive: boolean;
        }
      | null
      | undefined,
  ) {
    return a
      ? {
          id: a.id,
          code: a.code,
          bankCode: a.bankCode,
          accountNumberMasked: '***' + a.accountNumber.slice(-4),
          policy: a.policy,
          isActive: a.isActive,
        }
      : null;
  }

  async getReceivingBankAccounts() {
    const accounts = await this.prisma.receivingBankAccount.findMany({
      orderBy: { code: 'asc' },
      take: 100,
    });
    return accounts.map((a) => this.accountView(a));
  }

  async confirmPayment(paymentId: string) {
    return this.paymentService.confirmPayment(paymentId);
  }

  async getUnmatchedTransactions(reference?: string) {
    if (
      reference !== undefined &&
      (typeof reference !== 'string' || reference.length > 128)
    )
      throw new BadRequestException('INVALID_TRANSACTION_REFERENCE');
    const value = reference?.trim();
    return this.prisma.paymentTransaction.findMany({
      where: {
        OR: [
          { status: { in: ['UNMATCHED', 'RECEIVED'] } },
          {
            status: 'MATCHED',
            payment: { status: { in: ['PENDING', 'USER_CONFIRMED'] } },
          },
        ],
        ...(value ? { providerTransactionId: value } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        paymentId: true,
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
    });
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
