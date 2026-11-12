import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateSurplusHandlingDto,
  CompleteSurplusHandlingDto,
  CancelSurplusHandlingDto,
} from './surplus-handling.dto';

@Injectable()
export class PaymentSurplusService {
  constructor(private readonly prisma: PrismaService) {}

  private text(value: string) {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 2000 ||
      value.includes('\n[SURPLUS:')
    ) {
      throw new BadRequestException('Nội dung xác nhận/ghi chú không hợp lệ.');
    }
    return value.trim();
  }

  private serialize(
    row: Awaited<
      ReturnType<
        Prisma.TransactionClient['paymentSurplusHandling']['findFirstOrThrow']
      >
    >,
  ) {
    return {
      ...row,
      amount: row.amount.toString(),
      creditRemainingAmount: row.creditRemainingAmount.toString(),
      effectivePlanPriceSnapshot:
        row.effectivePlanPriceSnapshot?.toString() ?? null,
      convertedSeconds: row.convertedSeconds?.toString() ?? null,
    };
  }

  private async locked<T>(
    paymentId: string,
    run: (
      tx: Prisma.TransactionClient,
      payment: Awaited<
        ReturnType<Prisma.TransactionClient['payment']['findUniqueOrThrow']>
      >,
    ) => Promise<T>,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`;
        const payment = await tx.payment.findUnique({
          where: { id: paymentId },
        });
        if (!payment) throw new NotFoundException('Không tìm thấy thanh toán.');
        if (payment.status !== 'PAID')
          throw new ConflictException('Chỉ xử lý tiền dư của Payment PAID.');
        return run(tx, payment);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async createHandling(
    paymentId: string,
    key: string,
    dto: CreateSurplusHandlingDto,
    actor: string,
  ) {
    if (
      !['REFUND', 'CREDIT'].includes(dto.action) ||
      typeof dto.amount !== 'string' ||
      !/^\d{1,14}(?:\.\d{1,6})?$/.test(dto.amount)
    ) {
      throw new BadRequestException(
        'Chỉ hỗ trợ REFUND/CREDIT và số tiền Decimal hợp lệ.',
      );
    }
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key))
      throw new BadRequestException('Idempotency-Key không hợp lệ.');
    const amount = new Prisma.Decimal(dto.amount);
    if (!amount.greaterThan(0))
      throw new BadRequestException('Số tiền phải lớn hơn 0.');
    const note = this.text(dto.note);
    const replay = (
      row: Awaited<
        ReturnType<
          Prisma.TransactionClient['paymentSurplusHandling']['findFirstOrThrow']
        >
      >,
    ) => {
      if (
        row.paymentId !== paymentId ||
        row.action !== dto.action ||
        !row.amount.equals(amount) ||
        row.note?.split('\n[SURPLUS:')[0] !== note ||
        row.createdById !== actor
      ) {
        throw new ConflictException(
          'Idempotency-Key đã được dùng với nội dung khác.',
        );
      }
      return this.serialize(row);
    };
    try {
      return await this.locked(paymentId, async (tx, payment) => {
        const existing = await tx.paymentSurplusHandling.findUnique({
          where: { idempotencyKey: key },
        });
        if (existing) return replay(existing);
        const surplus = await this.readSurplus(tx, paymentId);
        if (amount.greaterThan(surplus.availableSurplus))
          throw new ConflictException('Số tiền vượt tiền dư khả dụng.');
        const row = await tx.paymentSurplusHandling.create({
          data: {
            paymentId,
            action: dto.action,
            status: 'PENDING',
            amount,
            currency: payment.currency,
            idempotencyKey: key,
            note,
            createdById: actor,
            creditRemainingAmount: new Prisma.Decimal(0),
            effectivePlanPriceSnapshot: payment.effectivePlanPriceSnapshot,
            planCharacterLimitSnapshot:
              payment.planCharacterLimitSnapshot &&
              payment.planCharacterLimitSnapshot > 0
                ? payment.planCharacterLimitSnapshot
                : null,
            planDurationDaysSnapshot:
              payment.planDurationDaysSnapshot &&
              payment.planDurationDaysSnapshot > 0
                ? payment.planDurationDaysSnapshot
                : null,
          },
        });
        return this.serialize(row);
      });
    } catch (error) {
      // Resolve a global key race only after the failed transaction rolled back.
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.paymentSurplusHandling.findUnique({
          where: { idempotencyKey: key },
        });
        if (existing) return replay(existing);
      }
      throw error;
    }
  }

  completeHandling(
    paymentId: string,
    id: string,
    dto: CompleteSurplusHandlingDto,
    actor: string,
  ) {
    const confirmation = this.text(dto.confirmation);
    if (
      dto.externalReference !== undefined &&
      (typeof dto.externalReference !== 'string' ||
        !dto.externalReference.trim() ||
        dto.externalReference.length > 200)
    )
      throw new BadRequestException('Mã xác nhận không hợp lệ.');
    return this.transition(
      paymentId,
      id,
      'COMPLETED',
      confirmation,
      actor,
      dto.externalReference?.trim(),
    );
  }

  cancelHandling(
    paymentId: string,
    id: string,
    dto: CancelSurplusHandlingDto,
    actor: string,
  ) {
    return this.transition(
      paymentId,
      id,
      'CANCELLED',
      this.text(dto.note),
      actor,
    );
  }

  private transition(
    paymentId: string,
    id: string,
    status: 'COMPLETED' | 'CANCELLED',
    note: string,
    actor: string,
    reference?: string,
  ) {
    return this.locked(paymentId, async (tx) => {
      const row = await tx.paymentSurplusHandling.findFirst({
        where: { id, paymentId },
      });
      if (!row) throw new NotFoundException('Không tìm thấy khoản xử lý.');
      if (row.action !== 'REFUND' && row.action !== 'CREDIT')
        throw new ConflictException('Chưa hỗ trợ QUOTA/DAYS.');
      if (row.status === status) return this.serialize(row);
      if (row.status !== 'PENDING')
        throw new ConflictException(
          'Không thể đổi trạng thái khoản đã kết thúc.',
        );
      if (status === 'COMPLETED') await this.readSurplus(tx, paymentId);
      // Cancelling remains possible to release a reservation even if data is over-allocated.
      const now = new Date();
      const updated = await tx.paymentSurplusHandling.update({
        where: { id },
        data: {
          status,
          note: `${row.note ?? ''}\n[SURPLUS:${status}] ${note}`,
          ...(status === 'COMPLETED'
            ? {
                completedById: actor,
                completedAt: now,
                externalReference: reference ?? null,
                creditRemainingAmount:
                  row.action === 'CREDIT' ? row.amount : new Prisma.Decimal(0),
              }
            : {
                cancelledById: actor,
                cancelledAt: now,
                creditRemainingAmount: new Prisma.Decimal(0),
              }),
        },
      });
      return this.serialize(updated);
    });
  }

  async getSurplus(paymentId: string) {
    return this.prisma.$transaction((tx) => this.readSurplus(tx, paymentId), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }
  private async readSurplus(tx: Prisma.TransactionClient, paymentId: string) {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        amount: true,
        currency: true,
        transactions: {
          where: { status: 'MATCHED' },
          select: { amount: true, currency: true },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Không tìm thấy giao dịch thanh toán.');
    }
    const paymentAmount = new Prisma.Decimal(payment.amount.toString());
    if (
      !paymentAmount.isFinite() ||
      paymentAmount.isNegative() ||
      payment.transactions.some((row) => {
        const amount = new Prisma.Decimal(row.amount.toString());
        return !amount.isFinite() || amount.isNegative();
      })
    ) {
      throw new InternalServerErrorException(
        'Lỗi dữ liệu: số tiền thanh toán không hợp lệ.',
      );
    }
    if (payment.transactions.some((row) => row.currency !== payment.currency)) {
      throw new InternalServerErrorException(
        'Lỗi dữ liệu: giao dịch MATCHED sai loại tiền tệ.',
      );
    }

    const history = await tx.paymentSurplusHandling.findMany({
      where: { paymentId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const allocations = history.filter(
      (row) => row.status === 'PENDING' || row.status === 'COMPLETED',
    );
    if (
      allocations.some(
        (row) => !row.amount.isFinite() || !row.amount.greaterThan(0),
      )
    ) {
      throw new InternalServerErrorException(
        'Lỗi dữ liệu: số tiền phân bổ không hợp lệ.',
      );
    }
    if (allocations.some((row) => row.currency !== payment.currency)) {
      throw new InternalServerErrorException(
        'Lỗi dữ liệu: phân bổ tiền dư sai loại tiền tệ.',
      );
    }

    const totalMatched = payment.transactions.reduce(
      (total, row) => total.plus(new Prisma.Decimal(row.amount.toString())),
      new Prisma.Decimal(0),
    );
    const totalSurplus = Prisma.Decimal.max(
      0,
      totalMatched.minus(new Prisma.Decimal(payment.amount.toString())),
    );
    const allocatedAmount = allocations.reduce(
      (total, row) => total.plus(row.amount),
      new Prisma.Decimal(0),
    );
    if (allocatedAmount.greaterThan(totalSurplus)) {
      throw new InternalServerErrorException(
        'Lỗi dữ liệu: số tiền đã phân bổ vượt tổng tiền dư.',
      );
    }
    const availableSurplus = totalSurplus.minus(allocatedAmount);

    return {
      paymentId: payment.id,
      currency: payment.currency,
      totalMatched: totalMatched.toString(),
      totalSurplus: totalSurplus.toString(),
      allocatedAmount: allocatedAmount.toString(),
      availableSurplus: availableSurplus.toString(),
      history: history.map((row) => ({
        ...row,
        amount: row.amount.toString(),
        creditRemainingAmount: row.creditRemainingAmount.toString(),
        effectivePlanPriceSnapshot:
          row.effectivePlanPriceSnapshot?.toString() ?? null,
        convertedSeconds: row.convertedSeconds?.toString() ?? null,
      })),
    };
  }
}
