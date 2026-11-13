// Pure mocks: no Prisma client, database, credentials or external requests.
import { ReceivingBankAccountService } from './receiving-bank-account.service';
import { CreateBankTransactionDto } from './dto/create-bank-transaction.dto';
import { validate } from 'class-validator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('ReceivingBankAccount policy (mock only)', () => {
  const at = new Date('2026-11-13T00:00:00Z');
  const manual: any = {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'synthetic',
    bankCode: 'mockbank',
    accountNumber: '000123',
    accountName: 'Synthetic',
    currency: 'VND',
    policy: 'MANUAL_ALLOWED',
    isActive: true,
    deactivatedAt: null,
  };
  const sepay = { ...manual, policy: 'SEPAY_PRIMARY' };
  const receipt: any = {
    provider: 'BANK_TRANSFER',
    providerTransactionId: '12345',
    status: 'MATCHED',
    matchedAt: at,
    receivingBankAccountId: manual.id,
    currency: 'VND',
    amount: 10,
    verificationSource: 'MANUAL_ADMIN',
    sourceVerifiedAt: at,
    sourceVerifiedById: 'admin',
    verificationReference: 'synthetic-statement-row',
  };
  let tx: any, db: any, service: ReceivingBankAccountService;
  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn(async () => [manual]),
      paymentTransaction: { findFirst: jest.fn(async () => null) },
      payment: {
        findUnique: jest.fn(),
        create: jest.fn(async ({ data }) => ({
          ...data,
          id: 'p',
          plan: { code: 'BASIC' },
        })),
      },
    };
    db = {
      receivingBankAccount: { findUnique: jest.fn(async () => sepay) },
      $transaction: jest.fn(async (fn) => fn(tx)),
    };
    service = new ReceivingBankAccountService(db);
  });
  it('locks account FOR SHARE and refuses UNKNOWN', async () => {
    await expect(service.lock(tx, null, true)).rejects.toThrow(
      'RECEIVING_ACCOUNT_UNKNOWN',
    );
    await service.lock(tx, manual.id, true);
    expect(tx.$queryRaw.mock.calls[0][0].join('?')).toContain('FOR SHARE');
  });
  it('refuses incoming funds on inactive but permits examination of prior evidence', async () => {
    tx.$queryRaw.mockResolvedValue([
      { ...manual, isActive: false, deactivatedAt: at },
    ]);
    await expect(service.lock(tx, manual.id, true)).rejects.toThrow(
      'BANK_ACCOUNT_INACTIVE',
    );
    await expect(service.lock(tx, manual.id)).resolves.toBeDefined();
  });
  it('MANUAL_ALLOWED remains usable alongside SEPAY_PRIMARY', () => {
    expect(() => service.manual(manual)).not.toThrow();
    expect(() => service.manual(sepay)).toThrow(
      'SEPAY_PRIMARY_MANUAL_RECEIPT_REFUSED',
    );
  });
  it.each([undefined, 'wrong'])('refuses SePay mapping %s', async (id) => {
    if (id) db.receivingBankAccount.findUnique.mockResolvedValue(null);
    await expect(
      service.resolveSepay(id, '000123', 'mockbank'),
    ).rejects.toThrow('SEPAY_ACCOUNT_MAPPING_UNVERIFIED');
  });
  it('requires exact configured account and gateway, preserving leading zero', async () => {
    await expect(
      service.resolveSepay(sepay.id, '000123', 'MockBank'),
    ).resolves.toEqual(sepay);
    await expect(
      service.resolveSepay(sepay.id, '123', 'MockBank'),
    ).rejects.toThrow();
  });
  it('accepts manual evidence and authenticated SePay evidence only for their policies', () => {
    expect(service.verified(receipt, manual, manual.id, 'VND')).toBe(true);
    expect(
      service.verified(
        {
          ...receipt,
          provider: 'SEPAY',
          verificationSource: 'SEPAY_WEBHOOK',
          sourceVerifiedById: null,
        },
        sepay,
        sepay.id,
        'VND',
      ),
    ).toBe(true);
    expect(service.verified(receipt, sepay, sepay.id, 'VND')).toBe(false);
  });
  it.each([
    { receivingBankAccountId: null },
    { verificationSource: null },
    { sourceVerifiedAt: null },
    { sourceVerifiedById: null },
    { currency: 'USD' },
    { amount: NaN },
    { amount: 0 },
    { provider: 'UNKNOWN' },
  ])('fails closed missing or conflicting proof %p', (changes) =>
    expect(
      service.verified({ ...receipt, ...changes }, manual, manual.id, 'VND'),
    ).toBe(false),
  );
  it('cutoff permits prior committed evidence, not evidence after deactivation', () => {
    const a = { ...manual, isActive: false, deactivatedAt: at };
    expect(service.verified(receipt, a, manual.id, 'VND')).toBe(true);
    expect(
      service.verified(
        { ...receipt, sourceVerifiedAt: new Date(at.getTime() + 1) },
        a,
        manual.id,
        'VND',
      ),
    ).toBe(false);
    expect(
      service.verified(
        receipt,
        { ...a, deactivatedAt: null },
        manual.id,
        'VND',
      ),
    ).toBe(false);
  });
  it('invalid inactive cutoff cannot certify source evidence', () => {
    expect(
      service.verified(
        receipt,
        { ...manual, isActive: false, deactivatedAt: new Date('invalid') },
        manual.id,
        'VND',
      ),
    ).toBe(false);
  });
  it('advisory lock precedes legacy lookup; collision requires review', async () => {
    tx.paymentTransaction.findFirst.mockResolvedValueOnce({ id: 'legacy' });
    await expect(
      service.manualKey(tx, manual.id, 'same-bank-id'),
    ).rejects.toThrow('LEGACY_RECEIPT_REVIEW_REQUIRED');
    expect(tx.$queryRaw.mock.calls[0][0].join('?')).toContain(
      'pg_advisory_xact_lock',
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.paymentTransaction.findFirst.mock.invocationCallOrder[0],
    );
    expect(tx.paymentTransaction.findFirst).toHaveBeenCalledTimes(1);
  });
  it('same external ID on another known manual account has a distinct lookup scope', async () => {
    await service.manualKey(tx, manual.id, 'same-id');
    await service.manualKey(tx, 'another-account', 'same-id');
    expect(tx.paymentTransaction.findFirst).toHaveBeenCalledWith({
      where: {
        provider: 'BANK_TRANSFER',
        providerTransactionId: 'same-id',
        receivingBankAccountId: 'another-account',
      },
    });
  });
  it('direct activation rejects even one unverified MATCHED source', async () => {
    tx.payment.findUnique.mockResolvedValue({
      receivingBankAccountId: manual.id,
      currency: 'VND',
      transactions: [
        { ...receipt, receivingBankAccount: manual },
        { ...receipt, receivingBankAccount: manual, sourceVerifiedAt: null },
      ],
    });
    await expect(service.assertPaymentSources(tx, 'p')).rejects.toThrow(
      'PAYMENT_SOURCE_UNVERIFIED',
    );
  });
  it('legacy Payment cannot be certified from amount alone', async () => {
    tx.payment.findUnique.mockResolvedValue({
      receivingBankAccountId: null,
      transactions: [],
    });
    await expect(service.assertPaymentSources(tx, 'legacy')).rejects.toThrow(
      'PAYMENT_SOURCE_UNVERIFIED',
    );
  });
  it('new Payment binds the configured account inside the transaction', async () => {
    const previous = process.env.RECEIVING_BANK_ACCOUNT_ID;
    process.env.RECEIVING_BANK_ACCOUNT_ID = manual.id;
    try {
      const result = await service.createPayment({
        userId: 'u',
        planId: 'plan',
        status: 'PENDING',
        provider: 'BANK_TRANSFER',
        amount: 10,
        currency: 'VND',
      });
      expect(result.receivingBankAccount.id).toBe(manual.id);
      expect(tx.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ receivingBankAccountId: manual.id }),
        include: { plan: true },
      });
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.payment.create.mock.invocationCallOrder[0],
      );
    } finally {
      if (previous === undefined) delete process.env.RECEIVING_BANK_ACCOUNT_ID;
      else process.env.RECEIVING_BANK_ACCOUNT_ID = previous;
    }
  });
  it('missing account configuration refuses Payment creation before writes', async () => {
    const previous = process.env.RECEIVING_BANK_ACCOUNT_ID;
    delete process.env.RECEIVING_BANK_ACCOUNT_ID;
    try {
      await expect(
        service.createPayment({
          userId: 'u',
          planId: 'plan',
          status: 'PENDING',
          provider: 'BANK_TRANSFER',
          amount: 10,
          currency: 'VND',
        }),
      ).rejects.toThrow('RECEIVING_ACCOUNT_NOT_CONFIGURED');
      expect(tx.payment.create).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined)
        process.env.RECEIVING_BANK_ACCOUNT_ID = previous;
    }
  });
  it('deactivation takes exclusive lock; repeating inactive does not rewrite cutoff', async () => {
    tx.receivingBankAccount = {
      update: jest.fn(async () => ({
        ...manual,
        isActive: false,
        deactivatedAt: at,
      })),
    };
    await service.deactivate(manual.id);
    expect(tx.$queryRaw.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(tx.receivingBankAccount.update).toHaveBeenCalledTimes(1);
    tx.$queryRaw.mockResolvedValue([
      { ...manual, isActive: false, deactivatedAt: at },
    ]);
    await service.deactivate(manual.id);
    expect(tx.receivingBankAccount.update).toHaveBeenCalledTimes(1);
  });
  it('DTO rejects missing account ID; proof is not part of client contract', async () => {
    expect(
      (
        await validate(
          Object.assign(new CreateBankTransactionDto(), {
            providerTransactionId: 'x',
            amount: 10,
            receivedAt: at.toISOString(),
          }),
        )
      ).some((e) => e.property === 'receivingBankAccountId'),
    ).toBe(true);
    const dto = Object.assign(new CreateBankTransactionDto(), {
      receivingBankAccountId: manual.id,
      providerTransactionId: 'x',
      amount: 10,
      receivedAt: at.toISOString(),
      verificationSource: 'MANUAL_ADMIN',
    });
    expect(
      (
        await validate(dto, { whitelist: true, forbidNonWhitelisted: true })
      ).some((e) => e.property === 'verificationSource'),
    ).toBe(true);
  });
  it('SQL contract keeps provider and legacy indexes, fences and no data backfill', () => {
    const root = join(__dirname, '../../prisma/migrations');
    const a = readFileSync(
      join(root, '20261113000000_add_receiving_bank_account/migration.sql'),
      'utf8',
    );
    const b = readFileSync(
      join(root, '20261113010000_enforce_receiving_bank_policy/migration.sql'),
      'utf8',
    );
    expect(a).not.toMatch(/\bUPDATE\s+"(?:Payment|PaymentTransaction)"\s+SET/i);
    expect(a).not.toMatch(/INSERT\s+INTO\s+"ReceivingBankAccount"/i);
    expect(b.indexOf('CREATE UNIQUE INDEX')).toBeLessThan(
      b.indexOf('DROP INDEX'),
    );
    for (const code of [
      'LEGACY_RECEIPT_REVIEW_REQUIRED',
      'BANK_ACCOUNT_INACTIVE',
      'BANK_POLICY_REFUSED',
      'PAYMENT_SOURCE_UNVERIFIED',
      'SURPLUS_SOURCE_UNVERIFIED',
      'RECEIPT_IMMUTABLE',
    ])
      expect(b).toContain(code);
    expect(b).toContain('pg_advisory_xact_lock');
    expect(b).toContain('FOR SHARE');
    expect(b).toContain('FOR UPDATE');
    expect(b).not.toContain('SECURITY DEFINER');
  });
});
