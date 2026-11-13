import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReceivingBankAccountService } from './receiving-bank-account.service';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentService } from './payment.service';
import { SepayWebhookDto } from './dto/sepay-webhook.dto';

@Injectable()
export class SepayWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentService: PaymentService,
    private readonly config: ConfigService = new ConfigService(),
  ) {
    this.accounts = new ReceivingBankAccountService(prisma);
  }

  private readonly accounts: ReceivingBankAccountService;

  private extractTransferCode(body: SepayWebhookDto): string | null {
    const pattern = /\b(?:KH|GH|NC)-[A-HJ-NP-Z2-9]{8}\b/i;

    const matches: string[] =
      `${body.code ?? ''} ${body.content}`.match(
        new RegExp(pattern.source, 'gi'),
      ) ?? [];
    const codes = [...new Set(matches.map((code) => code.toUpperCase()))];
    return codes.length === 1 ? codes[0] : null;
  }

  async handleWebhook(body: SepayWebhookDto) {
    // Chỉ ghi nhận giao dịch tiền vào.
    if (body.transferType.toLowerCase() !== 'in') {
      return { success: true };
    }

    const account = this.config
      .get<string>('BANK_TRANSFER_ACCOUNT_NUMBER')
      ?.trim();
    if (!account)
      throw new ServiceUnavailableException('SEPAY_ACCOUNT_NOT_CONFIGURED');
    if (body.accountNumber !== account)
      throw new UnauthorizedException('SEPAY_ACCOUNT_MISMATCH');
    const gateway = this.config.get<string>('SEPAY_WEBHOOK_GATEWAY')?.trim();
    if (!gateway)
      throw new ServiceUnavailableException('SEPAY_GATEWAY_NOT_CONFIGURED');
    if (body.gateway.trim().toLowerCase() !== gateway.toLowerCase())
      throw new UnauthorizedException('SEPAY_GATEWAY_MISMATCH');
    if (
      !Number.isSafeInteger(body.id) ||
      body.id < 1 ||
      !Number.isSafeInteger(body.transferAmount) ||
      body.transferAmount < 1
    ) {
      throw new BadRequestException('SEPAY_INVALID_TRANSACTION');
    }

    const mapped = await this.accounts.resolveSepay(
      this.config.get<string>('SEPAY_RECEIVING_BANK_ACCOUNT_ID'),
      body.accountNumber,
      body.gateway,
    );
    const providerTransactionId = String(body.id);

    // Idempotency: webhook gửi lại cùng transaction ID không tạo bản ghi mới.
    const existing = await this.prisma.paymentTransaction.findFirst({
      where: { provider: 'SEPAY', providerTransactionId },
    });

    if (existing) {
      await this.assertDuplicate(existing, body);
      return this.handleDuplicateTransaction(existing);
    }

    const transferCode = this.extractTransferCode(body);

    // Không có mã chuyển khoản hợp lệ: lưu giao dịch để Admin đối soát.
    if (!transferCode) {
      await this.createUnmatchedTransaction(body, providerTransactionId);
      return { success: true, matched: false };
    }

    let paymentId: string | null = null;

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.accounts.lock(tx, mapped.id, true);
        const payment = await tx.payment.findUnique({
          where: { transferCode },
          select: {
            id: true,
            status: true,
            currency: true,
            receivingBankAccountId: true,
          },
        });

        if (
          !payment ||
          payment.currency !== 'VND' ||
          (body.currency !== undefined && body.currency !== 'VND') ||
          !['PENDING', 'USER_CONFIRMED'].includes(payment.status) ||
          payment.receivingBankAccountId !== mapped.id
        ) {
          await tx.paymentTransaction.create({
            data: {
              receivingBankAccountId: mapped.id,
              bankReference: body.referenceCode || null,
              verificationSource: 'SEPAY_WEBHOOK',
              sourceVerifiedAt: new Date(),
              sourceVerifiedById: null,
              provider: 'SEPAY',
              providerTransactionId,
              amount: body.transferAmount,
              currency: body.currency ?? 'VND',
              status: 'UNMATCHED',
              reference: body.content,
              note: !payment
                ? 'SEPAY_PAYMENT_NOT_FOUND'
                : payment.currency !== 'VND' ||
                    (body.currency !== undefined && body.currency !== 'VND')
                  ? 'SEPAY_CURRENCY_MISMATCH'
                  : 'SEPAY_PAYMENT_NOT_PENDING',
              receivedAt: this.parseTransactionDate(body.transactionDate),
            },
          });
          return;
        }

        // Khóa Payment để các giao dịch cộng dồn cùng mã được tuần tự hóa.
        await tx.$queryRaw`
          SELECT "id"
          FROM "Payment"
          WHERE "id" = ${payment.id}
          FOR UPDATE
        `;

        const latestPayment = await tx.payment.findUnique({
          where: { id: payment.id },
          select: {
            id: true,
            status: true,
            currency: true,
            receivingBankAccountId: true,
          },
        });

        if (
          !latestPayment ||
          latestPayment.currency !== 'VND' ||
          !['PENDING', 'USER_CONFIRMED'].includes(latestPayment.status) ||
          latestPayment.receivingBankAccountId !== mapped.id
        ) {
          await tx.paymentTransaction.create({
            data: {
              receivingBankAccountId: mapped.id,
              bankReference: body.referenceCode || null,
              verificationSource: 'SEPAY_WEBHOOK',
              sourceVerifiedAt: new Date(),
              sourceVerifiedById: null,
              provider: 'SEPAY',
              providerTransactionId,
              amount: body.transferAmount,
              currency: body.currency ?? 'VND',
              status: 'UNMATCHED',
              reference: body.content,
              note: !latestPayment
                ? 'SEPAY_PAYMENT_NOT_FOUND'
                : latestPayment.currency !== 'VND'
                  ? 'SEPAY_CURRENCY_MISMATCH'
                  : 'SEPAY_PAYMENT_NOT_PENDING',
              receivedAt: this.parseTransactionDate(body.transactionDate),
            },
          });
          return;
        }

        await tx.paymentTransaction.create({
          data: {
            receivingBankAccountId: mapped.id,
            bankReference: body.referenceCode || null,
            verificationSource: 'SEPAY_WEBHOOK',
            sourceVerifiedAt: new Date(),
            sourceVerifiedById: null,
            paymentId: latestPayment.id,
            provider: 'SEPAY',
            providerTransactionId,
            amount: body.transferAmount,
            currency: 'VND',
            status: 'MATCHED',
            reference: body.content,
            note: `SePay gateway: ${body.gateway}`,
            receivedAt: this.parseTransactionDate(body.transactionDate),
            matchedAt: new Date(),
          },
        });

        paymentId = latestPayment.id;
      });
    } catch (error) {
      // Có thể hai webhook đồng thời cùng xử lý một transaction ID.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.paymentTransaction.findFirst({
          where: { provider: 'SEPAY', providerTransactionId },
        });

        if (existing) {
          await this.assertDuplicate(existing, body);
          return this.handleDuplicateTransaction(existing);
        }

        // P2002 nhưng không tìm thấy transaction cùng ID:
        // đây có thể là lỗi unique constraint khác, không được nuốt lỗi.
        throw error;
      }

      throw error;
    }

    // Gọi sau khi transaction ghi nhận tiền đã commit.
    // confirmPayment hiện tại xử lý cộng dồn và kích hoạt gói.
    if (paymentId) {
      await this.attemptConfirmation(paymentId);
    }

    return {
      success: true,
      matched: Boolean(paymentId),
    };
  }
  private async handleDuplicateTransaction(existing: {
    status: string;
    paymentId: string | null;
  }) {
    if (existing.status !== 'MATCHED' || !existing.paymentId) {
      return { success: true, duplicate: true };
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: existing.paymentId },
      select: { id: true, status: true },
    });

    if (!payment || payment.status === 'PAID') {
      return { success: true, duplicate: true };
    }

    if (!['PENDING', 'USER_CONFIRMED'].includes(payment.status)) {
      return { success: true, duplicate: true };
    }

    await this.attemptConfirmation(payment.id);

    return {
      success: true,
      duplicate: true,
      retried: true,
    };
  }
  private async createUnmatchedTransaction(
    body: SepayWebhookDto,
    providerTransactionId: string,
  ) {
    const mapped = await this.accounts.resolveSepay(
      this.config.get<string>('SEPAY_RECEIVING_BANK_ACCOUNT_ID'),
      body.accountNumber,
      body.gateway,
    );
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.accounts.lock(tx, mapped.id, true);
        return tx.paymentTransaction.create({
          data: {
            receivingBankAccountId: mapped.id,
            bankReference: body.referenceCode || null,
            verificationSource: 'SEPAY_WEBHOOK',
            sourceVerifiedAt: new Date(),
            sourceVerifiedById: null,
            provider: 'SEPAY',
            providerTransactionId,
            amount: body.transferAmount,
            currency: body.currency ?? 'VND',
            status: 'UNMATCHED',
            reference: body.content,
            note: 'SEPAY_REFERENCE_UNMATCHED_OR_AMBIGUOUS',
            receivedAt: this.parseTransactionDate(body.transactionDate),
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.paymentTransaction.findFirst({
          where: { provider: 'SEPAY', providerTransactionId },
        });
        if (!existing) throw error;
        await this.assertDuplicate(existing, body);
        return;
      }

      throw error;
    }
  }

  private parseTransactionDate(value: string): Date {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private async assertDuplicate(
    existing: {
      amount: number;
      currency: string;
      receivingBankAccountId: string | null;
    },
    body: SepayWebhookDto,
  ) {
    const mapped = await this.accounts.resolveSepay(
      this.config.get<string>('SEPAY_RECEIVING_BANK_ACCOUNT_ID'),
      body.accountNumber,
      body.gateway,
    );
    if (existing.receivingBankAccountId !== mapped.id)
      throw new ConflictException('SEPAY_LEGACY_OR_ACCOUNT_CONFLICT');
    if (
      existing.amount !== body.transferAmount ||
      existing.currency !== (body.currency ?? 'VND')
    ) {
      throw new ConflictException('SEPAY_DUPLICATE_CONFLICT');
    }
  }

  private async attemptConfirmation(paymentId: string) {
    try {
      await this.paymentService.confirmPayment(paymentId);
    } catch (error) {
      if (error instanceof BadRequestException) {
        const response = error.getResponse();
        if (
          typeof response === 'object' &&
          response !== null &&
          'code' in response &&
          response.code === 'PAYMENT_UNDERFUNDED'
        )
          return;
      }
      // A competing webhook may have completed activation under the Payment lock.
      const latest = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        select: { status: true },
      });
      if (latest?.status === 'PAID') return;
      throw error;
    }
  }
}
