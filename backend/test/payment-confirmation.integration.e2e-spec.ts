import { randomInt, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { Plan } from '../generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentService } from '../src/payment/payment.service';
import { CommercialControlService } from '../src/commercial-control/commercial-control.service';
import { PaymentTransactionService } from '../src/payment/payment-transaction.service';
import { createStopGate, parseManifest, validateUrl, verifyIdentity, type PaymentIdentity, type PaymentManifest } from './payment-confirmation.guard';

// No dotenv, application-URL fallback, cleanup, or automatic execution approval.
// This file is prepared only; real execution requires separate operator approval.
describe('Payment confirmation integration safety', () => {
  const expectedDatabase = 'text_to_voice_payment_it';
  let prisma: PrismaService | undefined;
  let paymentService: PaymentService | undefined;
  let transactions: PaymentTransactionService | undefined;
  let originalDatabaseUrl: string | undefined;
  let environmentCaptured = false;
  let manifest: PaymentManifest;
  const gate = createStopGate();
  function scenario(name: string, body: () => Promise<void>, timeout: number) {
    it(name, () => gate.run(body), timeout);
  }
  let freePlan: Plan;
  let paidPlan: Plan;
  let bankId: string;
  let adminId: string;

  function db(): PrismaService {
    if (!prisma) throw new Error('PAYMENT_IT_NOT_INITIALIZED');
    return prisma;
  }
  function payments(): PaymentService {
    if (!paymentService) throw new Error('PAYMENT_IT_NOT_INITIALIZED');
    return paymentService;
  }
  function receipts(): PaymentTransactionService {
    if (!transactions) throw new Error('PAYMENT_IT_NOT_INITIALIZED');
    return transactions;
  }
  async function assertDatabase(): Promise<void> {
    const rows = await db().$queryRaw<PaymentIdentity[]>`
      SELECT current_database() AS database_name, current_schema() AS schema_name,
             host(inet_server_addr()) AS server_host, inet_server_port() AS server_port,
             (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster_id,
             current_setting('data_directory') AS directory,
             current_setting('server_version_num')::int AS version,
             (extract(epoch FROM current_setting('statement_timeout')::interval)*1000)::int AS statement_ms,
             (extract(epoch FROM current_setting('lock_timeout')::interval)*1000)::int AS lock_ms,
             (extract(epoch FROM current_setting('idle_in_transaction_session_timeout')::interval)*1000)::int AS idle_ms,
             (extract(epoch FROM current_setting('transaction_timeout')::interval)*1000)::int AS transaction_ms,
             d.oid::text AS database_oid, d.datdba::text AS owner_oid,
             (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname = current_user) AS role_oid,
             current_user::text AS role_name, session_user::text AS session_role,
             pg_catalog.shobj_description(d.oid, 'pg_database') AS marker
      FROM pg_catalog.pg_database d WHERE d.datname = current_database()
    `;
    verifyIdentity(rows, manifest);
  }
  // Guard every fixture mutation and every service entrypoint that can write.
  // The same bound Prisma client is used throughout; never switch databases.
  async function write<T>(operation: () => Promise<T>): Promise<T> {
    return gate.write(assertDatabase, operation);
  }
  function restoreEnvironment(): void {
    if (!environmentCaptured) return;
    if (originalDatabaseUrl === undefined)
      Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
  function transferCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return (
      'KH-' +
      Array.from(
        { length: 8 },
        () => alphabet[randomInt(alphabet.length)],
      ).join('')
    );
  }

  beforeAll(() => gate.run(async () => {
    // An explicit execution marker is an extra guard, not operator authorization.
    if (process.env.PAYMENT_IT_WRITE_APPROVAL !== expectedDatabase)
      throw new Error('PAYMENT_IT_EXPLICIT_WRITE_APPROVAL_REQUIRED');
    const raw = process.env.PAYMENT_IT_DATABASE_URL;
    if (!raw) throw new Error('PAYMENT_IT_EXPLICIT_URL_REQUIRED');
    manifest = parseManifest(process.env.PAYMENT_IT_IDENTITY_MANIFEST);
    const guardedUrl = validateUrl(raw, manifest);
    if (process.env.DATABASE_URL || Object.keys(process.env).some(k => k.startsWith('PG')))
      throw new Error('PAYMENT_IT_INHERITED_CONFIGURATION_REFUSED');
    originalDatabaseUrl = process.env.DATABASE_URL;
    environmentCaptured = true;
    process.env.DATABASE_URL = guardedUrl;
    try {
      // Test-only query extension also gates queries inside a service transaction.
      // A COMMIT already submitted is still uncertain; it is never called rollback.
      prisma = new PrismaService().$extends({
        name: 'payment-it-stop-gate',
        query: {
          $allOperations({ args, query }) {
            gate.check();
            return query(args);
          },
        },
      }) as unknown as PrismaService;
      await db().$connect();
      await assertDatabase();
      const free = await db().plan.findUnique({ where: { code: 'FREE' } });
      const paid = await db().plan.findUnique({
        where: { code: 'TEST_BASIC' },
      });
      if (
        !free?.isActive ||
        !paid?.isActive ||
        free.currency !== 'VND' ||
        paid.currency !== 'VND' ||
        paid.price <= 2 ||
        free.durationDays <= 0 ||
        paid.durationDays <= 0 ||
        free.characterLimit <= 0 ||
        paid.characterLimit <= 0
      )
        throw new Error('PAYMENT_IT_PLAN_PREREQUISITES_REQUIRED');
      freePlan = free;
      paidPlan = paid;
      // Explicit synthetic configuration of the REAL control service, not a spy
      // disabling its assertion. No PAYMENTS_ENABLED environment mutation.
      const control = new CommercialControlService(
        new ConfigService({ PAYMENTS_ENABLED: 'true' }),
      );
      paymentService = new PaymentService(db(), control);
      transactions = new PaymentTransactionService(db(), payments());
      const fixture = await write(() =>
        db().$transaction(async (tx) => {
          const admin = await tx.user.create({
            data: {
              email: 'payment-it-admin-' + randomUUID() + '@example.invalid',
              role: 'ADMIN',
            },
          });
          const bank = await tx.receivingBankAccount.create({
            data: {
              id: randomUUID(),
              code: 'payment-it-' + randomUUID(),
              bankCode: 'synthetic-bank',
              accountNumber: '000' + String(randomInt(100000000, 999999999)),
              accountName: 'Synthetic integration account',
              currency: 'VND',
              policy: 'MANUAL_ALLOWED',
              isActive: false,
            },
          });
          await tx.receivingBankAccount.update({
            where: { id: bank.id },
            data: { isActive: true },
          });
          return { adminId: admin.id, bankId: bank.id };
        }),
      );
      adminId = fixture.adminId;
      bankId = fixture.bankId;
    } catch {
      gate.stop();
      await prisma?.$disconnect().catch(() => undefined);
      prisma = undefined;
      paymentService = undefined;
      transactions = undefined;
      restoreEnvironment();
      throw new Error('PAYMENT_IT_CONNECTION_OR_PREFLIGHT_FAILED');
    }
  }), 30000);

  afterAll(async () => {
    // Never disconnect or call the outcome a rollback while a write is pending.
    // Timeout remains UNKNOWN even when promises later settle successfully.
    try {
      await gate.settle();
    } finally {
      // Closing an idle pool is not evidence that a timed-out write rolled back.
      // Preserve pending sessions for explicit investigation; never terminate them.
      if (gate.status().pending === 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            prisma?.$disconnect(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PAYMENT_IT_CLOSE_UNKNOWN')), 3000); }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      }
      prisma = undefined;
      paymentService = undefined;
      transactions = undefined;
      restoreEnvironment();
    }
    // Preserve all synthetic records, including failed activation receipts.
  }, 15000);

  async function userFixture() {
    return write(() =>
      db().$transaction(async (tx) => {
        const now = new Date();
        const expiresAt = new Date(
          now.getTime() + freePlan.durationDays * 86400000,
        );
        const user = await tx.user.create({
          data: {
            email: 'payment-it-' + randomUUID() + '@example.invalid',
            name: 'Synthetic payment integration user',
          },
        });
        await tx.subscription.create({
          data: {
            userId: user.id,
            planId: freePlan.id,
            startedAt: now,
            expiresAt,
            status: 'ACTIVE',
            characterLimit: freePlan.characterLimit,
            rolloverCharacters: 0,
            pricePaid: freePlan.price,
            currency: freePlan.currency,
            quotaLots: {
              create: {
                charactersGranted: freePlan.characterLimit,
                charactersRemaining: freePlan.characterLimit,
                expiresAt,
              },
            },
          },
        });
        return user;
      }),
    );
  }
  async function promotionFixture() {
    const promotionalPrice = Math.round(paidPlan.price * 0.8);
    if (promotionalPrice <= 0 || promotionalPrice >= paidPlan.price)
      throw new Error('PAYMENT_IT_PROMOTION_PREREQUISITES_REQUIRED');
    return write(() =>
      db().promotion.create({
        data: {
          title: 'Synthetic promotion ' + randomUUID(),
          message: 'Synthetic snapshot test',
          startsAt: new Date(Date.now() - 60000),
          endsAt: new Date(Date.now() + 3600000),
          status: 'ACTIVE',
          planPrices: { create: { planId: paidPlan.id, promotionalPrice } },
        },
        include: { planPrices: true },
      }),
    );
  }
  type PromotionFixture = Awaited<ReturnType<typeof promotionFixture>>;
  async function paymentFixture(userId: string, promotion?: PromotionFixture) {
    const amount = promotion?.planPrices[0].promotionalPrice ?? paidPlan.price;
    return write(() =>
      db().payment.create({
        data: {
          userId,
          planId: paidPlan.id,
          receivingBankAccountId: bankId,
          planNameSnapshot: paidPlan.name,
          planPriceSnapshot: paidPlan.price,
          planDurationDaysSnapshot: paidPlan.durationDays,
          planCharacterLimitSnapshot: paidPlan.characterLimit,
          promotionIdSnapshot: promotion?.id,
          promotionTitleSnapshot: promotion?.title,
          promotionPriceSnapshot: promotion ? amount : undefined,
          discountAmountSnapshot: promotion
            ? paidPlan.price - amount
            : undefined,
          amount,
          currency: paidPlan.currency,
          status: 'PENDING',
          provider: 'BANK_TRANSFER',
          paymentType: 'NEW_PURCHASE',
          transferCode: transferCode(),
        },
      }),
    );
  }
  async function linkedReceipt(
    paymentId: string,
    amount: number,
    currency: string,
  ) {
    const receipt = await write(() =>
      receipts().recordBankTransaction({
        receivingBankAccountId: bankId,
        providerTransactionId: 'IT-' + randomUUID(),
        amount,
        currency,
        receivedAt: new Date().toISOString(),
        reference: 'Synthetic payment receipt',
        note: 'Synthetic bank statement evidence',
      }),
    );
    expect(receipt.status).toBe('UNMATCHED');
    await write(() =>
      receipts().linkBankTransaction(receipt.id, { paymentId }),
    );
    return receipt;
  }
  async function match(paymentId: string, amount: number, currency: string) {
    const receipt = await linkedReceipt(paymentId, amount, currency);
    const received = await write(() =>
      receipts().confirmTransactionReceived(
        receipt.id,
        adminId,
        'IT-' + randomUUID(),
      ),
    );
    expect(received.status).toBe('RECEIVED');
    return write(() => receipts().reconcileBankTransaction(receipt.id));
  }
  async function counts(userId: string) {
    return {
      subscriptions: await db().subscription.count({ where: { userId } }),
      quotaLots: await db().quotaLot.count({
        where: { subscription: { userId } },
      }),
      redemptions: await db().promotionRedemption.count({ where: { userId } }),
    };
  }

  scenario('activates exactly once; MATCHED replay preserves audit and strict confirm rejects PAID', async () => {
    const user = await userFixture(),
      payment = await paymentFixture(user.id);
    const before = await counts(user.id);
    const firstAmount = Math.floor(payment.amount / 2);
    const first = await match(payment.id, firstAmount, payment.currency);
    expect(first.activationStatus).toBe('AWAITING_FUNDS');
    const second = await match(
      payment.id,
      payment.amount - firstAmount,
      payment.currency,
    );
    expect(second.activationStatus).toBe('ACTIVATED');
    expect(
      (await db().payment.findUniqueOrThrow({ where: { id: payment.id } }))
        .status,
    ).toBe('PAID');
    const audit = await db().paymentTransaction.findUniqueOrThrow({
      where: { id: second.id },
    });
    expect(
      (await write(() => receipts().reconcileBankTransaction(second.id)))
        .activationStatus,
    ).toBe('ALREADY_ACTIVATED');
    expect(
      await db().paymentTransaction.findUniqueOrThrow({
        where: { id: second.id },
      }),
    ).toEqual(audit);
    await expect(
      write(() => payments().confirmPayment(payment.id)),
    ).rejects.toMatchObject({ status: 400 });
    expect(await counts(user.id)).toEqual({
      ...before,
      subscriptions: before.subscriptions + 1,
      quotaLots: before.quotaLots + 1,
    });
  }, 30000);

  scenario('keeps promotion snapshots after the fixture promotion has ended', async () => {
    const user = await userFixture(),
      promotion = await promotionFixture();
    const payment = await paymentFixture(user.id, promotion);
    await write(() =>
      db().promotion.update({
        where: { id: promotion.id },
        data: {
          status: 'ENDED',
          endsAt: new Date(Date.now() - 1),
        },
      }),
    );
    expect(
      (await match(payment.id, payment.amount, payment.currency))
        .activationStatus,
    ).toBe('ACTIVATED');
    expect(
      await db().payment.findUniqueOrThrow({ where: { id: payment.id } }),
    ).toMatchObject({
      status: 'PAID',
      amount: payment.amount,
      promotionIdSnapshot: promotion.id,
      promotionPriceSnapshot: payment.amount,
      planPriceSnapshot: paidPlan.price,
    });
    expect(
      await db().promotionRedemption.findUniqueOrThrow({
        where: {
          userId_promotionId: { userId: user.id, promotionId: promotion.id },
        },
      }),
    ).toMatchObject({
      userId: user.id,
      promotionId: promotion.id,
      paymentId: payment.id,
    });
  }, 30000);

  scenario('retains the second MATCHED receipt when an active paid subscription blocks activation', async () => {
    const user = await userFixture(),
      promotion = await promotionFixture();
    const first = await paymentFixture(user.id, promotion),
      second = await paymentFixture(user.id, promotion);
    expect(
      (await match(first.id, first.amount, first.currency)).activationStatus,
    ).toBe('ACTIVATED');
    const before = await counts(user.id);
    await expect(
      match(second.id, second.amount, second.currency),
    ).rejects.toThrow('PAYMENT_ACTIVATION_FAILED');
    await expect(
      write(() => payments().confirmPayment(second.id)),
    ).rejects.toThrow('ACTIVE_PAID_SUBSCRIPTION_EXISTS');
    expect(
      await db().payment.findUniqueOrThrow({ where: { id: second.id } }),
    ).toMatchObject({ status: 'PENDING', promotionIdSnapshot: promotion.id });
    expect(
      await db().paymentTransaction.findMany({
        where: { paymentId: second.id },
      }),
    ).toEqual([
      expect.objectContaining({
        status: 'MATCHED',
        verificationSource: 'MANUAL_ADMIN',
      }),
    ]);
    expect(await counts(user.id)).toEqual(before);
    expect(
      await db().promotionRedemption.findUniqueOrThrow({
        where: {
          userId_promotionId: { userId: user.id, promotionId: promotion.id },
        },
      }),
    ).toMatchObject({
      userId: user.id,
      promotionId: promotion.id,
      paymentId: first.id,
    });
    // This proves the paid-subscription guard, NOT the service duplicate-promo branch.
  }, 30000);

  scenario('independently enforces unique promotion redemption without changing paid history', async () => {
    const user = await userFixture(),
      promotion = await promotionFixture();
    const first = await paymentFixture(user.id, promotion),
      second = await paymentFixture(user.id, promotion);
    expect(
      (await match(first.id, first.amount, first.currency)).activationStatus,
    ).toBe('ACTIVATED');
    const before = await counts(user.id);
    await expect(
      write(() =>
        db().$transaction(async (tx) => {
          return tx.promotionRedemption.create({
            data: {
              userId: user.id,
              promotionId: promotion.id,
              paymentId: second.id,
            },
          });
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await counts(user.id)).toEqual(before);
    expect(
      (await db().payment.findUniqueOrThrow({ where: { id: second.id } }))
        .status,
    ).toBe('PENDING');
    // This tests the database unique constraint, not a manufactured service bypass.
  }, 30000);

  scenario('returns AWAITING_FUNDS while two MATCHED receipts remain underfunded', async () => {
    const user = await userFixture(),
      payment = await paymentFixture(user.id);
    const total = payment.amount - 1,
      firstAmount = Math.floor(total / 2);
    expect(
      (await match(payment.id, firstAmount, payment.currency)).activationStatus,
    ).toBe('AWAITING_FUNDS');
    expect(
      (await match(payment.id, total - firstAmount, payment.currency))
        .activationStatus,
    ).toBe('AWAITING_FUNDS');
    await expect(
      write(() => payments().confirmPayment(payment.id)),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PAYMENT_UNDERFUNDED' }),
    });
    expect(
      (await db().payment.findUniqueOrThrow({ where: { id: payment.id } }))
        .status,
    ).toBe('PENDING');
    expect(
      (
        await db().paymentTransaction.aggregate({
          where: { paymentId: payment.id, status: 'MATCHED' },
          _sum: { amount: true },
        })
      )._sum.amount,
    ).toBe(total);
  }, 30000);

  scenario('never counts UNMATCHED or RECEIVED receipts as MATCHED funds', async () => {
    const user = await userFixture();
    for (const status of ['UNMATCHED', 'RECEIVED'] as const) {
      const payment = await paymentFixture(user.id);
      const receipt = await linkedReceipt(
        payment.id,
        payment.amount,
        payment.currency,
      );
      if (status === 'RECEIVED')
        await write(() =>
          receipts().confirmTransactionReceived(
            receipt.id,
            adminId,
            'IT-' + randomUUID(),
          ),
        );
      const before = await counts(user.id);
      await expect(
        write(() => payments().confirmPayment(payment.id)),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PAYMENT_UNDERFUNDED' }),
      });
      expect(
        (
          await db().paymentTransaction.findUniqueOrThrow({
            where: { id: receipt.id },
          })
        ).status,
      ).toBe(status);
      expect(
        (await db().payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .status,
      ).toBe('PENDING');
      expect(await counts(user.id)).toEqual(before);
    }
  }, 30000);
});
