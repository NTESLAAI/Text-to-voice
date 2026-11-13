import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Prisma,
  ReceivingBankAccount,
  PaymentTransaction,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Receipt = Pick<
  PaymentTransaction,
  | 'provider'
  | 'receivingBankAccountId'
  | 'currency'
  | 'amount'
  | 'verificationSource'
  | 'sourceVerifiedAt'
  | 'sourceVerifiedById'
  | 'providerTransactionId'
  | 'status'
  | 'matchedAt'
  | 'verificationReference'
>;
@Injectable()
export class ReceivingBankAccountService {
  constructor(private readonly prisma: PrismaService) {}

  // Not exposed as public CRUD. Real account creation/activation is a separately
  // approved operational step. Deactivation is atomic and never reactivates.
  async deactivate(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        ReceivingBankAccount[]
      >`SELECT * FROM "ReceivingBankAccount" WHERE id=${id} FOR UPDATE`;
      const account = rows[0];
      if (!account) throw new ConflictException('RECEIVING_ACCOUNT_UNKNOWN');
      if (!account.isActive) return account;
      return tx.receivingBankAccount.update({
        where: { id },
        data: { isActive: false },
      });
    });
  }

  async lock(
    tx: Prisma.TransactionClient,
    id: string | null | undefined,
    incoming = false,
  ) {
    if (!id) throw new ConflictException('RECEIVING_ACCOUNT_UNKNOWN');
    const rows = await tx.$queryRaw<
      ReceivingBankAccount[]
    >`SELECT * FROM "ReceivingBankAccount" WHERE id=${id} FOR SHARE`;
    const account = rows[0];
    if (!account) throw new ConflictException('RECEIVING_ACCOUNT_UNKNOWN');
    if (incoming && !account.isActive)
      throw new ConflictException('BANK_ACCOUNT_INACTIVE');
    return account;
  }
  manual(account: ReceivingBankAccount) {
    if (account.policy !== 'MANUAL_ALLOWED')
      throw new ConflictException('SEPAY_PRIMARY_MANUAL_RECEIPT_REFUSED');
  }
  sepay(
    account: ReceivingBankAccount,
    accountNumber: string | undefined,
    gateway: string | undefined,
  ) {
    if (
      account.policy !== 'SEPAY_PRIMARY' ||
      !accountNumber ||
      !gateway ||
      account.accountNumber !== accountNumber.trim() ||
      account.bankCode !== gateway.trim().toLowerCase()
    )
      throw new ServiceUnavailableException('SEPAY_ACCOUNT_MAPPING_UNVERIFIED');
  }
  async resolveSepay(id: string | undefined, number: string, gateway: string) {
    if (!id)
      throw new ServiceUnavailableException('SEPAY_ACCOUNT_MAPPING_UNVERIFIED');
    const account = await this.prisma.receivingBankAccount.findUnique({
      where: { id },
    });
    if (!account)
      throw new ServiceUnavailableException('SEPAY_ACCOUNT_MAPPING_UNVERIFIED');
    this.sepay(account, number, gateway);
    return account;
  }
  async createPayment(data: Prisma.PaymentUncheckedCreateInput) {
    const id = process.env.RECEIVING_BANK_ACCOUNT_ID;
    if (!id)
      throw new ServiceUnavailableException('RECEIVING_ACCOUNT_NOT_CONFIGURED');
    return this.prisma.$transaction(
      async (tx) => {
        const account = await this.lock(tx, id, true);
        if (account.currency !== data.currency)
          throw new ConflictException('RECEIVING_ACCOUNT_CURRENCY_MISMATCH');
        if (account.policy === 'SEPAY_PRIMARY') {
          if (process.env.SEPAY_RECEIVING_BANK_ACCOUNT_ID !== id)
            throw new ServiceUnavailableException(
              'SEPAY_ACCOUNT_MAPPING_UNVERIFIED',
            );
          this.sepay(
            account,
            process.env.BANK_TRANSFER_ACCOUNT_NUMBER,
            process.env.SEPAY_WEBHOOK_GATEWAY,
          );
        }
        const payment = await tx.payment.create({
          data: { ...data, receivingBankAccountId: account.id },
          include: { plan: true },
        });
        return { ...payment, receivingBankAccount: account };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
  verified(
    receipt: Receipt,
    account: ReceivingBankAccount | null | undefined,
    paymentAccountId: string | null | undefined,
    currency: string,
  ) {
    if (
      !receipt.providerTransactionId ||
      receipt.providerTransactionId !== receipt.providerTransactionId.trim()
    )
      return false;
    if (
      receipt.provider === 'SEPAY' &&
      (!/^[1-9]\d*$/.test(receipt.providerTransactionId) ||
        !Number.isSafeInteger(Number(receipt.providerTransactionId)))
    )
      return false;
    if (
      receipt.status === 'MATCHED' &&
      (!(receipt.matchedAt instanceof Date) ||
        !Number.isFinite(receipt.matchedAt.getTime()))
    )
      return false;
    if (
      !account ||
      !paymentAccountId ||
      receipt.receivingBankAccountId !== paymentAccountId ||
      account.id !== paymentAccountId ||
      receipt.currency !== currency ||
      account.currency !== currency ||
      !Number.isFinite(receipt.amount) ||
      receipt.amount <= 0 ||
      !(receipt.sourceVerifiedAt instanceof Date) ||
      !Number.isFinite(receipt.sourceVerifiedAt.getTime())
    )
      return false;
    if (
      !account.isActive &&
      (!(account.deactivatedAt instanceof Date) ||
        !Number.isFinite(account.deactivatedAt.getTime()) ||
        receipt.sourceVerifiedAt > account.deactivatedAt)
    )
      return false;
    return (
      (receipt.provider === 'SEPAY' &&
        account.policy === 'SEPAY_PRIMARY' &&
        receipt.verificationSource === 'SEPAY_WEBHOOK' &&
        receipt.sourceVerifiedById === null) ||
      (receipt.provider === 'BANK_TRANSFER' &&
        account.policy === 'MANUAL_ALLOWED' &&
        receipt.verificationSource === 'MANUAL_ADMIN' &&
        Boolean(receipt.sourceVerifiedById) &&
        Boolean(receipt.verificationReference?.trim()))
    );
  }
  async assertPaymentSources(tx: Prisma.TransactionClient, paymentId: string) {
    const p = await tx.payment.findUnique({
      where: { id: paymentId },
      include: {
        transactions: {
          where: { status: 'MATCHED' },
          include: { receivingBankAccount: true },
        },
      },
    });
    if (
      !p?.receivingBankAccountId ||
      p.transactions.some(
        (r) =>
          !this.verified(
            r,
            r.receivingBankAccount,
            p.receivingBankAccountId,
            p.currency,
          ),
      )
    )
      throw new ConflictException('PAYMENT_SOURCE_UNVERIFIED');
  }
  async manualKey(
    tx: Prisma.TransactionClient,
    accountId: string,
    key: string,
  ) {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'BANK_TRANSFER:' + key},0))`;
    const legacy = await tx.paymentTransaction.findFirst({
      where: {
        provider: 'BANK_TRANSFER',
        providerTransactionId: key,
        receivingBankAccountId: null,
      },
      select: { id: true },
    });
    if (legacy) throw new ConflictException('LEGACY_RECEIPT_REVIEW_REQUIRED');
    return tx.paymentTransaction.findFirst({
      where: {
        provider: 'BANK_TRANSFER',
        providerTransactionId: key,
        receivingBankAccountId: accountId,
      },
    });
  }
}
