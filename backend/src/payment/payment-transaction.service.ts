import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreateBankTransactionDto } from './dto/create-bank-transaction.dto';
import { LinkBankTransactionDto } from './dto/link-bank-transaction.dto';

@Injectable()
export class PaymentTransactionService {
  constructor(private readonly prisma: PrismaService) {}

  async recordBankTransaction(dto: CreateBankTransactionDto) {
    const provider = 'BANK_TRANSFER';
    const providerTransactionId = dto.providerTransactionId.trim();

    if (!providerTransactionId) {
      throw new BadRequestException(
        'Mã giao dịch ngân hàng không được để trống.',
      );
    }

    if (!Number.isFinite(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException('Số tiền giao dịch phải lớn hơn 0.');
    }

    const receivedAt = new Date(dto.receivedAt);

    if (Number.isNaN(receivedAt.getTime())) {
      throw new BadRequestException('Thời điểm nhận tiền không hợp lệ.');
    }

    const existing = await this.prisma.paymentTransaction.findUnique({
      where: {
        provider_providerTransactionId: {
          provider,
          providerTransactionId,
        },
      },
    });

    if (existing) {
      throw new ConflictException(
        'Mã giao dịch ngân hàng này đã được ghi nhận.',
      );
    }

    try {
      return await this.prisma.paymentTransaction.create({
        data: {
          provider,
          providerTransactionId,
          amount: dto.amount,
          currency: dto.currency ?? 'VND',
          reference: dto.reference?.trim() || null,
          note: dto.note?.trim() || null,
          receivedAt,
          status: 'UNMATCHED',
        },
      });
    } catch (error) {
      // Bảo vệ cả trường hợp hai Admin nhập cùng giao dịch đồng thời.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Mã giao dịch ngân hàng này đã được ghi nhận.',
        );
      }

      throw error;
    }
  }
  async linkBankTransaction(
    transactionId: string,
    dto: LinkBankTransactionDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Khóa đơn thanh toán trước để đồng bộ với luồng xác nhận/hủy đơn.
      const payments = await tx.$queryRaw<
        { id: string; status: string; currency: string }[]
      >`
        SELECT "id", "status", "currency"
        FROM "Payment"
        WHERE "id" = ${dto.paymentId}
        FOR UPDATE
      `;

      const payment = payments[0];

      if (!payment) {
        throw new BadRequestException('Không tìm thấy đơn thanh toán.');
      }

      if (!['PENDING', 'USER_CONFIRMED'].includes(payment.status)) {
        throw new ConflictException(
          'Chỉ có thể liên kết giao dịch với đơn thanh toán đang chờ xử lý.',
        );
      }

      // Khóa giao dịch để tránh hai Admin liên kết cùng một giao dịch.
      const transactions = await tx.$queryRaw<
        {
          id: string;
          paymentId: string | null;
          status: string;
          currency: string;
        }[]
      >`
        SELECT "id", "paymentId", "status", "currency"
        FROM "PaymentTransaction"
        WHERE "id" = ${transactionId}
        FOR UPDATE
      `;

      const transaction = transactions[0];

      if (!transaction) {
        throw new BadRequestException('Không tìm thấy giao dịch ngân hàng.');
      }

      if (transaction.paymentId) {
        throw new ConflictException(
          'Giao dịch ngân hàng đã được liên kết với một đơn thanh toán.',
        );
      }

      if (transaction.status !== 'UNMATCHED') {
        throw new ConflictException(
          'Chỉ có thể liên kết giao dịch đang ở trạng thái UNMATCHED.',
        );
      }

      if (transaction.currency !== payment.currency) {
        throw new BadRequestException(
          'Loại tiền của giao dịch không khớp với đơn thanh toán.',
        );
      }

      return tx.paymentTransaction.update({
        where: { id: transactionId },
        data: {
          paymentId: payment.id,
          // Chưa xác nhận nhận tiền; trạng thái vẫn là UNMATCHED.
        },
      });
    });
  }
  async confirmTransactionReceived(transactionId: string) {
    // Đọc paymentId để xác định đơn cần khóa trước.
    const current = await this.prisma.paymentTransaction.findUnique({
      where: { id: transactionId },
      select: {
        id: true,
        paymentId: true,
      },
    });

    if (!current) {
      throw new BadRequestException('Không tìm thấy giao dịch ngân hàng.');
    }

    if (!current.paymentId) {
      throw new ConflictException(
        'Cần liên kết giao dịch với đơn thanh toán trước khi xác nhận nhận tiền.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Khóa đơn trước, thống nhất thứ tự khóa với các luồng thanh toán.
      const payments = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT "id", "status"
        FROM "Payment"
        WHERE "id" = ${current.paymentId}
        FOR UPDATE
      `;

      const payment = payments[0];

      if (!payment) {
        throw new BadRequestException('Không tìm thấy đơn thanh toán.');
      }

      if (!['PENDING', 'USER_CONFIRMED'].includes(payment.status)) {
        throw new ConflictException(
          'Chỉ có thể xác nhận nhận tiền cho đơn thanh toán đang chờ xử lý.',
        );
      }

      const transactions = await tx.$queryRaw<
        {
          id: string;
          paymentId: string | null;
          status: string;
        }[]
      >`
        SELECT "id", "paymentId", "status"
        FROM "PaymentTransaction"
        WHERE "id" = ${transactionId}
        FOR UPDATE
      `;

      const transaction = transactions[0];

      if (!transaction) {
        throw new BadRequestException('Không tìm thấy giao dịch ngân hàng.');
      }

      if (transaction.paymentId !== current.paymentId) {
        throw new ConflictException(
          'Giao dịch đã thay đổi đơn thanh toán. Vui lòng kiểm tra lại.',
        );
      }

      if (transaction.status !== 'UNMATCHED') {
        throw new ConflictException(
          'Chỉ có thể xác nhận nhận tiền cho giao dịch đang ở trạng thái UNMATCHED.',
        );
      }

      return tx.paymentTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'RECEIVED',
        },
      });
    });
  }
  async reconcileBankTransaction(transactionId: string) {
    // Đọc paymentId để xác định đơn thanh toán cần khóa trước.
    const current = await this.prisma.paymentTransaction.findUnique({
      where: { id: transactionId },
      select: {
        id: true,
        paymentId: true,
      },
    });

    if (!current) {
      throw new BadRequestException('Không tìm thấy giao dịch ngân hàng.');
    }

    if (!current.paymentId) {
      throw new ConflictException(
        'Cần liên kết giao dịch với đơn thanh toán trước khi đối soát.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Khóa đơn thanh toán trước để đồng bộ với các luồng thanh toán.
      const payments = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT "id", "status"
        FROM "Payment"
        WHERE "id" = ${current.paymentId}
        FOR UPDATE
      `;

      if (!payments[0]) {
        throw new BadRequestException('Không tìm thấy đơn thanh toán.');
      }

      // Khóa giao dịch ngân hàng sau khi đã khóa đơn thanh toán.
      const transactions = await tx.$queryRaw<
        {
          id: string;
          paymentId: string | null;
          status: string;
        }[]
      >`
        SELECT "id", "paymentId", "status"
        FROM "PaymentTransaction"
        WHERE "id" = ${transactionId}
        FOR UPDATE
      `;

      const transaction = transactions[0];

      if (!transaction) {
        throw new BadRequestException('Không tìm thấy giao dịch ngân hàng.');
      }

      if (transaction.paymentId !== current.paymentId) {
        throw new ConflictException(
          'Giao dịch đã thay đổi đơn thanh toán. Vui lòng kiểm tra lại.',
        );
      }

      if (transaction.status !== 'RECEIVED') {
        throw new ConflictException(
          'Chỉ có thể đối soát giao dịch đã được xác nhận nhận tiền (RECEIVED).',
        );
      }

      return tx.paymentTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'MATCHED',
          matchedAt: new Date(),
        },
      });
    });
  }
}
