import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ReceivingBankAccountService } from './receiving-bank-account.service';
import type { PaymentTransaction } from '../../generated/prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateBankTransactionDto } from './dto/create-bank-transaction.dto';
import { LinkBankTransactionDto } from './dto/link-bank-transaction.dto';
import { PaymentService } from './payment.service';

@Injectable()
export class PaymentTransactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentService: PaymentService,
  ) {
    this.accounts = new ReceivingBankAccountService(prisma);
  }

  private readonly accounts: ReceivingBankAccountService;

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

    return this.prisma.$transaction(
      async (tx) => {
        const account = await this.accounts.lock(
          tx,
          dto.receivingBankAccountId,
          true,
        );
        this.accounts.manual(account);
        if ((dto.currency ?? 'VND') !== account.currency)
          throw new ConflictException('RECEIVING_ACCOUNT_CURRENCY_MISMATCH');
        const existing = await this.accounts.manualKey(
          tx,
          account.id,
          providerTransactionId,
        );
        if (existing) {
          if (
            existing.amount !== dto.amount ||
            existing.currency !== (dto.currency ?? 'VND') ||
            existing.reference !== (dto.reference?.trim() || null) ||
            existing.note !== (dto.note?.trim() || null) ||
            existing.receivedAt?.getTime() !== receivedAt.getTime()
          )
            throw new ConflictException('BANK_RECEIPT_DUPLICATE_CONFLICT');
          return existing;
        }
        return tx.paymentTransaction.create({
          data: {
            provider,
            providerTransactionId,
            receivingBankAccountId: account.id,
            amount: dto.amount,
            currency: dto.currency ?? 'VND',
            reference: dto.reference?.trim() || null,
            note: dto.note?.trim() || null,
            receivedAt,
            status: 'UNMATCHED',
          },
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  async linkBankTransaction(
    transactionId: string,
    dto: LinkBankTransactionDto,
  ) {
    const current = await this.prisma.paymentTransaction.findUnique({
      where: { id: transactionId },
      select: { receivingBankAccountId: true },
    });
    return this.prisma.$transaction(async (tx) => {
      await this.accounts.lock(tx, current?.receivingBankAccountId);
      // Khóa đơn thanh toán trước để đồng bộ với luồng xác nhận/hủy đơn.
      const payments = await tx.$queryRaw<
        {
          id: string;
          status: string;
          currency: string;
          receivingBankAccountId: string | null;
        }[]
      >`
        SELECT "id", "status", "currency", "receivingBankAccountId"
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
          receivingBankAccountId: string | null;
        }[]
      >`
        SELECT "id", "paymentId", "status", "currency", "receivingBankAccountId"
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

      if (transaction.receivingBankAccountId !== payment.receivingBankAccountId)
        throw new ConflictException('RECEIVING_ACCOUNT_MISMATCH');
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
  async confirmTransactionReceived(
    transactionId: string,
    actor: string,
    evidenceReference?: string,
  ) {
    // Đọc paymentId để xác định đơn cần khóa trước.
    const current = await this.prisma.paymentTransaction.findUnique({
      where: { id: transactionId },
      select: {
        id: true,
        provider: true,
        paymentId: true,
        receivingBankAccountId: true,
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
      if (!actor) throw new ConflictException('RECEIPT_VERIFIER_REQUIRED');
      if (!['SEPAY', 'BANK_TRANSFER'].includes(current.provider))
        throw new ConflictException('BANK_PROVIDER_UNSUPPORTED');
      const account = await this.accounts.lock(
        tx,
        current.receivingBankAccountId,
        current.provider !== 'SEPAY',
      );
      if (current.provider !== 'SEPAY') {
        this.accounts.manual(account);
        if (
          typeof evidenceReference !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(evidenceReference)
        )
          throw new BadRequestException('MANUAL_EVIDENCE_REFERENCE_REQUIRED');
      }
      // Khóa đơn trước, thống nhất thứ tự khóa với các luồng thanh toán.
      const payments = await tx.$queryRaw<
        {
          id: string;
          status: string;
          receivingBankAccountId: string | null;
          currency: string;
        }[]
      >`
        SELECT "id", "status", "receivingBankAccountId", "currency"
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

      const transactions = await tx.$queryRaw<PaymentTransaction[]>`
        SELECT *
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

      if (current.provider === 'SEPAY') {
        if (
          !this.accounts.verified(
            transaction,
            account,
            payment.receivingBankAccountId,
            payment.currency,
          )
        )
          throw new ConflictException('RECEIPT_SOURCE_VERIFICATION_REQUIRED');
        return tx.paymentTransaction.update({
          where: { id: transactionId },
          data: { status: 'RECEIVED' },
        });
      }
      return tx.paymentTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'RECEIVED',
          verificationSource: 'MANUAL_ADMIN',
          sourceVerifiedAt: new Date(),
          sourceVerifiedById: actor,
          verificationReference: evidenceReference,
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
        receivingBankAccountId: true,
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

    const outcome = await this.prisma.$transaction(async (tx) => {
      const account = await this.accounts.lock(
        tx,
        current.receivingBankAccountId,
      );
      // Khóa đơn thanh toán trước để đồng bộ với các luồng thanh toán.
      const payments = await tx.$queryRaw<
        {
          id: string;
          status: string;
          currency: string;
          receivingBankAccountId: string | null;
        }[]
      >`
        SELECT "id", "status", "currency", "receivingBankAccountId"
        FROM "Payment"
        WHERE "id" = ${current.paymentId}
        FOR UPDATE
      `;

      if (!payments[0]) {
        throw new BadRequestException('Không tìm thấy đơn thanh toán.');
      }
      if (!['PENDING', 'USER_CONFIRMED', 'PAID'].includes(payments[0].status)) {
        throw new ConflictException('PAYMENT_NOT_RECONCILABLE');
      }

      // Khóa giao dịch ngân hàng sau khi đã khóa đơn thanh toán.
      const transactions = await tx.$queryRaw<PaymentTransaction[]>`
        SELECT *
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

      if (
        !this.accounts.verified(
          transaction,
          account,
          payments[0].receivingBankAccountId,
          payments[0].currency,
        )
      )
        throw new ConflictException('RECEIPT_SOURCE_VERIFICATION_REQUIRED');
      if (transaction.status === 'MATCHED') {
        return { receipt: transaction, replayed: true };
      }

      if (transaction.status !== 'RECEIVED') {
        throw new ConflictException(
          'Chỉ có thể đối soát giao dịch đã được xác nhận nhận tiền (RECEIVED).',
        );
      }

      const receipt = await tx.paymentTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'MATCHED',
          matchedAt: new Date(),
        },
      });
      return { receipt, replayed: false };
    });

    // Receipt commit survives activation failure. Retry never recreates a receipt.
    try {
      const paymentConfirmation = await this.paymentService.confirmPayment(
        current.paymentId,
        true,
      );
      return {
        ...outcome.receipt,
        replayed: outcome.replayed,
        activationStatus:
          'activationStatus' in paymentConfirmation
            ? paymentConfirmation.activationStatus
            : 'ACTIVATED',
        paymentConfirmation,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        const response = error.getResponse();
        if (
          typeof response === 'object' &&
          response !== null &&
          'code' in response &&
          response.code === 'PAYMENT_UNDERFUNDED'
        ) {
          return {
            ...outcome.receipt,
            replayed: outcome.replayed,
            activationStatus: 'AWAITING_FUNDS',
            paymentConfirmation: null,
          };
        }
      }
      throw new InternalServerErrorException({
        code: 'PAYMENT_ACTIVATION_FAILED',
        receiptStatus: 'MATCHED',
        activationStatus: 'FAILED',
      });
    }
  }
}
