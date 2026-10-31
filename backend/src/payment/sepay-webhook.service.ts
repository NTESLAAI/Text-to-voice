import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentService } from './payment.service';
import { SepayWebhookDto } from './dto/sepay-webhook.dto';

@Injectable()
export class SepayWebhookService {
  private readonly logger = new Logger(SepayWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentService: PaymentService,
  ) {}

  private extractTransferCode(body: SepayWebhookDto): string | null {
    const pattern = /\b(?:KH|GH|NC)-[A-HJ-NP-Z2-9]{8}\b/i;

    const explicitCode = body.code?.match(pattern)?.[0];
    if (explicitCode) {
      return explicitCode.toUpperCase();
    }

    const contentCode = body.content.match(pattern)?.[0];
    return contentCode ? contentCode.toUpperCase() : null;
  }

  async handleWebhook(body: SepayWebhookDto) {
    // Chỉ ghi nhận giao dịch tiền vào.
    if (body.transferType.toLowerCase() !== 'in') {
      return { success: true };
    }

    const providerTransactionId = String(body.id);

    // Idempotency: webhook gửi lại cùng transaction ID không tạo bản ghi mới.
    const existing = await this.prisma.paymentTransaction.findUnique({
      where: {
        provider_providerTransactionId: {
          provider: 'SEPAY',
          providerTransactionId,
        },
      },
    });

    if (existing) {
      return { success: true, duplicate: true };
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
        const payment = await tx.payment.findUnique({
          where: { transferCode },
          select: {
            id: true,
            status: true,
            currency: true,
          },
        });

        if (
          !payment ||
          !['PENDING', 'USER_CONFIRMED'].includes(payment.status)
        ) {
          await tx.paymentTransaction.create({
            data: {
              provider: 'SEPAY',
              providerTransactionId,
              amount: body.transferAmount,
              currency: payment?.currency ?? 'VND',
              status: 'UNMATCHED',
              reference: body.content,
              note: `SePay gateway: ${body.gateway}; mã không khớp Payment đang chờ`,
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
          select: { id: true, status: true, currency: true },
        });

        if (
          !latestPayment ||
          !['PENDING', 'USER_CONFIRMED'].includes(latestPayment.status)
        ) {
          await tx.paymentTransaction.create({
            data: {
              provider: 'SEPAY',
              providerTransactionId,
              amount: body.transferAmount,
              currency: payment.currency,
              status: 'UNMATCHED',
              reference: body.content,
              note: 'Payment không còn ở trạng thái chờ',
              receivedAt: this.parseTransactionDate(body.transactionDate),
            },
          });
          return;
        }

        await tx.paymentTransaction.create({
          data: {
            paymentId: latestPayment.id,
            provider: 'SEPAY',
            providerTransactionId,
            amount: body.transferAmount,
            currency: latestPayment.currency,
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
        return { success: true, duplicate: true };
      }

      throw error;
    }

    // Gọi sau khi transaction ghi nhận tiền đã commit.
    // confirmPayment hiện tại xử lý cộng dồn và kích hoạt gói.
    if (paymentId) {
      await this.paymentService.confirmPayment(paymentId);
    }

    return {
      success: true,
      matched: Boolean(paymentId),
    };
  }

  private async createUnmatchedTransaction(
    body: SepayWebhookDto,
    providerTransactionId: string,
  ) {
    try {
      await this.prisma.paymentTransaction.create({
        data: {
          provider: 'SEPAY',
          providerTransactionId,
          amount: body.transferAmount,
          currency: 'VND',
          status: 'UNMATCHED',
          reference: body.content,
          note: `SePay gateway: ${body.gateway}; chưa xác định mã Payment`,
          receivedAt: this.parseTransactionDate(body.transactionDate),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return;
      }

      throw error;
    }
  }

  private parseTransactionDate(value: string): Date {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }
}