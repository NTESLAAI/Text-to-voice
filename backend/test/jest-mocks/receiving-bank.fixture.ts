/* Dependency isolation for pre-existing business unit tests only.
 * Real policy behavior is exercised in receiving-bank-account.service.spec.ts.
 * Never loaded by production or PostgreSQL acceptance runners. */
import { ReceivingBankAccountService } from '../../src/payment/receiving-bank-account.service';
export const bankFixture: any = {
  id: 'bank-fixture',
  code: 'synthetic',
  bankCode: 'mock-bank',
  accountNumber: '000123',
  accountName: 'Synthetic',
  currency: 'VND',
  policy: 'SEPAY_PRIMARY',
  isActive: true,
  deactivatedAt: null,
};
export const sourceFixture = {
  verificationReference: null,
  providerTransactionId: '12345',
  status: 'MATCHED',
  matchedAt: new Date('2026-11-13T00:00:00Z'),
  receivingBankAccountId: 'bank-fixture',
  receivingBankAccount: bankFixture,
  provider: 'SEPAY',
  verificationSource: 'SEPAY_WEBHOOK',
  sourceVerifiedAt: new Date('2026-11-13T00:00:00Z'),
  sourceVerifiedById: null,
};
export function isolateBankPolicy() {
  jest
    .spyOn(ReceivingBankAccountService.prototype, 'lock')
    .mockResolvedValue(bankFixture);
  jest
    .spyOn(ReceivingBankAccountService.prototype, 'resolveSepay')
    .mockResolvedValue(bankFixture);
  jest
    .spyOn(ReceivingBankAccountService.prototype, 'manual')
    .mockImplementation(() => {});
  jest
    .spyOn(ReceivingBankAccountService.prototype, 'assertPaymentSources')
    .mockResolvedValue(undefined);
  jest
    .spyOn(ReceivingBankAccountService.prototype, 'createPayment')
    .mockImplementation(async function (this: any, data: any) {
      return {
        ...(await this.prisma.payment.create({
          data,
          include: { plan: true },
        })),
        receivingBankAccount: bankFixture,
      };
    });
}
