/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
// Actual bank-policy and transaction services; only database delegates are mocked.
import { PaymentTransactionService } from './payment-transaction.service';
import { PaymentService } from './payment.service';
import { CommercialControlService } from '../commercial-control/commercial-control.service';

describe('Receiving-account service boundary (no database)', () => {
  const at = new Date('2026-11-13T00:00:00Z');
  let account: any,
    tx: any,
    db: any,
    payment: any,
    service: PaymentTransactionService;
  const dto = {
    receivingBankAccountId: '11111111-1111-4111-8111-111111111111',
    providerTransactionId: 'bank-123',
    amount: 10,
    currency: 'VND',
    receivedAt: at.toISOString(),
    note: 'Synthetic statement',
    reference: 'Synthetic transfer',
  };
  beforeEach(() => {
    account = {
      id: dto.receivingBankAccountId,
      policy: 'MANUAL_ALLOWED',
      isActive: true,
      currency: 'VND',
      deactivatedAt: null,
    };
    tx = {
      $queryRaw: jest.fn(async () => [account]),
      paymentTransaction: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }) => ({ id: 'r', ...data })),
        update: jest.fn(async ({ data }) => ({ id: 'r', ...data })),
      },
    };
    db = {
      $transaction: jest.fn(async (fn) => fn(tx)),
      paymentTransaction: {
        findUnique: jest.fn(async () => ({
          id: 'r',
          provider: 'BANK_TRANSFER',
          paymentId: 'p',
          receivingBankAccountId: account.id,
        })),
      },
    };
    payment = {
      confirmPayment: jest.fn(async () => ({
        status: 'PAID',
        activationStatus: 'ALREADY_ACTIVATED',
      })),
    };
    service = new PaymentTransactionService(
      db,
      payment as unknown as PaymentService,
    );
  });
  it('MANUAL_ALLOWED writes a bound UNMATCHED receipt, never verification proof from DTO', async () => {
    const result = await service.recordBankTransaction(dto);
    expect(result.status).toBe('UNMATCHED');
    expect(result.receivingBankAccountId).toBe(account.id);
    expect(result.verificationSource).toBeUndefined();
    expect(payment.confirmPayment).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.calls[0][0].join('?')).toContain('FOR SHARE');
    expect(tx.$queryRaw.mock.calls[1][0].join('?')).toContain(
      'pg_advisory_xact_lock',
    );
  });
  it('SEPAY_PRIMARY rejects manual recording before receipt creation', async () => {
    account.policy = 'SEPAY_PRIMARY';
    await expect(service.recordBankTransaction(dto)).rejects.toThrow(
      'SEPAY_PRIMARY_MANUAL_RECEIPT_REFUSED',
    );
    expect(tx.paymentTransaction.create).not.toHaveBeenCalled();
  });
  it('inactive rejects a new manual receipt', async () => {
    account.isActive = false;
    account.deactivatedAt = at;
    await expect(service.recordBankTransaction(dto)).rejects.toThrow(
      'BANK_ACCOUNT_INACTIVE',
    );
    expect(tx.paymentTransaction.create).not.toHaveBeenCalled();
  });
  it('legacy collision is review-required, not auto-linked or counted', async () => {
    tx.paymentTransaction.findFirst.mockResolvedValueOnce({ id: 'legacy' });
    await expect(service.recordBankTransaction(dto)).rejects.toThrow(
      'LEGACY_RECEIPT_REVIEW_REQUIRED',
    );
    expect(tx.paymentTransaction.create).not.toHaveBeenCalled();
  });
  it('identical manual replay returns the existing record without writes; conflicting data fails', async () => {
    const row = {
      id: 'r',
      amount: dto.amount,
      currency: 'VND',
      reference: dto.reference,
      note: dto.note,
      receivedAt: at,
    };
    tx.paymentTransaction.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row);
    expect(await service.recordBankTransaction(dto)).toBe(row);
    expect(tx.paymentTransaction.create).not.toHaveBeenCalled();
    tx.paymentTransaction.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row);
    await expect(
      service.recordBankTransaction({ ...dto, amount: 11 }),
    ).rejects.toThrow('BANK_RECEIPT_DUPLICATE_CONFLICT');
  });
  it('manual confirmation stores actor from caller and mandatory evidence reference', async () => {
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([account])
      .mockResolvedValueOnce([{ id: 'p', status: 'PENDING' }])
      .mockResolvedValueOnce([
        { id: 'r', paymentId: 'p', status: 'UNMATCHED' },
      ]);
    await service.confirmTransactionReceived(
      'r',
      'verified-admin',
      'statement-row-1',
    );
    expect(tx.paymentTransaction.update).toHaveBeenCalledWith({
      where: { id: 'r' },
      data: {
        status: 'RECEIVED',
        verificationSource: 'MANUAL_ADMIN',
        sourceVerifiedAt: expect.any(Date),
        sourceVerifiedById: 'verified-admin',
        verificationReference: 'statement-row-1',
      },
    });
    expect(payment.confirmPayment).not.toHaveBeenCalled();
  });
  it('receipt verified before inactive can replay without re-stamping its source or audit', async () => {
    account.isActive = false;
    account.deactivatedAt = new Date(at.getTime() + 1);
    const receipt = {
      id: 'r',
      paymentId: 'p',
      receivingBankAccountId: account.id,
      provider: 'BANK_TRANSFER',
      providerTransactionId: 'bank-123',
      currency: 'VND',
      amount: 10,
      status: 'MATCHED',
      matchedAt: at,
      sourceVerifiedAt: at,
      sourceVerifiedById: 'admin',
      verificationReference: 'statement-row-1',
      verificationSource: 'MANUAL_ADMIN',
    };
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([account])
      .mockResolvedValueOnce([
        {
          id: 'p',
          status: 'PAID',
          currency: 'VND',
          receivingBankAccountId: account.id,
        },
      ])
      .mockResolvedValueOnce([receipt]);
    const r = await service.reconcileBankTransaction('r');
    expect(r.activationStatus).toBe('ALREADY_ACTIVATED');
    expect(r.matchedAt).toBe(at);
    expect(tx.paymentTransaction.update).not.toHaveBeenCalled();
    expect(payment.confirmPayment).toHaveBeenCalledWith('p', true);
  });
  it('a note alone never qualifies manual MATCHED for replay', async () => {
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([account])
      .mockResolvedValueOnce([
        {
          id: 'p',
          status: 'PENDING',
          currency: 'VND',
          receivingBankAccountId: account.id,
        },
      ])
      .mockResolvedValueOnce([
        {
          ...dto,
          provider: 'BANK_TRANSFER',
          status: 'MATCHED',
          paymentId: 'p',
          note: 'verified',
          matchedAt: at,
        },
      ]);
    await expect(service.reconcileBankTransaction('r')).rejects.toThrow(
      'RECEIPT_SOURCE_VERIFICATION_REQUIRED',
    );
    expect(payment.confirmPayment).not.toHaveBeenCalled();
  });
  it('authenticated SePay UNMATCHED can be confirmed after inactive without replacing source evidence', async () => {
    account.policy = 'SEPAY_PRIMARY';
    account.isActive = false;
    account.deactivatedAt = new Date(at.getTime() + 1);
    db.paymentTransaction.findUnique.mockResolvedValue({
      id: 'r',
      provider: 'SEPAY',
      paymentId: 'p',
      receivingBankAccountId: account.id,
    });
    const row = {
      id: 'r',
      paymentId: 'p',
      receivingBankAccountId: account.id,
      provider: 'SEPAY',
      providerTransactionId: '12345',
      amount: 10,
      currency: 'VND',
      status: 'UNMATCHED',
      matchedAt: null,
      verificationSource: 'SEPAY_WEBHOOK',
      sourceVerifiedAt: at,
      sourceVerifiedById: null,
      verificationReference: null,
    };
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([account])
      .mockResolvedValueOnce([
        {
          id: 'p',
          status: 'PENDING',
          currency: 'VND',
          receivingBankAccountId: account.id,
        },
      ])
      .mockResolvedValueOnce([row]);
    await service.confirmTransactionReceived('r', 'admin');
    expect(tx.paymentTransaction.update).toHaveBeenCalledWith({
      where: { id: 'r' },
      data: { status: 'RECEIVED' },
    });
  });
  it('SePay confirmation does not manufacture missing proof', async () => {
    account.policy = 'SEPAY_PRIMARY';
    db.paymentTransaction.findUnique.mockResolvedValue({
      id: 'r',
      provider: 'SEPAY',
      paymentId: 'p',
      receivingBankAccountId: account.id,
    });
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([account])
      .mockResolvedValueOnce([
        {
          id: 'p',
          status: 'PENDING',
          currency: 'VND',
          receivingBankAccountId: account.id,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'r',
          provider: 'SEPAY',
          paymentId: 'p',
          status: 'UNMATCHED',
          receivingBankAccountId: account.id,
        },
      ]);
    await expect(
      service.confirmTransactionReceived('r', 'admin'),
    ).rejects.toThrow('RECEIPT_SOURCE_VERIFICATION_REQUIRED');
    expect(tx.paymentTransaction.update).not.toHaveBeenCalled();
  });
});

describe('Direct confirmation legacy source guard (mock only)', () => {
  it.each(['PENDING', 'USER_CONFIRMED'])(
    'rejects legacy %s before summing or activating',
    async (status) => {
      const tx: any = {
        $queryRaw: jest.fn(async () => []),
        payment: {
          findUnique: jest.fn(async () => ({
            id: 'legacy',
            provider: 'BANK_TRANSFER',
            receivingBankAccountId: null,
            status,
            amount: 100,
          })),
        },
        paymentTransaction: { aggregate: jest.fn() },
        subscription: { create: jest.fn() },
      };
      const db: any = { $transaction: jest.fn(async (fn) => fn(tx)) };

      const commercialControlMock = {
        assertPaymentsEnabled: jest.fn(),
        isPaymentsEnabled: jest.fn().mockReturnValue(true),
      } as unknown as CommercialControlService;

      await expect(
        new PaymentService(db, commercialControlMock).confirmPayment('legacy'),
      ).rejects.toMatchObject({
        status: 409,
        message: 'RECEIVING_ACCOUNT_UNKNOWN',
      });
      expect(tx.paymentTransaction.aggregate).not.toHaveBeenCalled();
      expect(tx.subscription.create).not.toHaveBeenCalled();
    },
  );
});
