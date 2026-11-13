/* Synthetic PostgreSQL acceptance; never imports AppModule or application env. */
import 'reflect-metadata';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { JwtStrategy } from '../../src/auth/strategies/jwt.strategy/jwt.strategy';
import { PaymentController } from '../../src/payment/payment.controller';
import { PaymentService } from '../../src/payment/payment.service';
import { PaymentTransactionService } from '../../src/payment/payment-transaction.service';
import { SepaySignatureService } from '../../src/payment/sepay-signature.service';
import { SepayWebhookService } from '../../src/payment/sepay-webhook.service';
const g = require('./guard.cjs');
const packet = (globalThis as any).__rcPacket;
g.validate(packet);

describe('RCR independent PostgreSQL', () => {
  let db: any,
    reader: any,
    owner: any,
    control: any,
    app: any,
    base: string,
    jwt: JwtService;
  let admin: any,
    freePlan: any,
    paidPlan: any,
    nextId = 800000;
  const secret = randomBytes(32).toString('hex');
  const webhookSecret = randomBytes(32).toString('hex');
  const fixtures: any[] = [],
    evidence: any[] = [],
    locks: any[] = [];
  const expectedPaid = new Set<string>();
  async function read(sql: string, args: any[] = []) {
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      return (await reader.query(sql, args)).rows;
    } finally {
      await reader.query('ROLLBACK');
    }
  }
  function done(id: string, variants: string[] = []) {
    evidence.push({ id, variants, status: 'PASS' });
  }
  async function fixture(
    label: string,
    status = 'PENDING',
    receiptStatus = 'RECEIVED',
    amount = 100,
  ) {
    const user = await db.user.create({
      data: { email: randomUUID() + '@example.invalid' },
    });
    const paid = status === 'PAID';
    await db.subscription.create({
      data: {
        userId: user.id,
        planId: paid ? paidPlan.id : freePlan.id,
        status: 'ACTIVE',
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        characterLimit: paid ? 173 : 17,
        quotaLots: {
          create: {
            charactersGranted: paid ? 173 : 17,
            charactersRemaining: paid ? 173 : 17,
            rolloverCount: 0,
            expiresAt: new Date(Date.now() + 86400000),
          },
        },
      },
    });
    const payment = await db.payment.create({
      data: {
        userId: user.id,
        planId: paidPlan.id,
        paymentType: 'NEW_PURCHASE',
        status,
        paidAt: paid ? new Date() : null,
        amount: 100,
        currency: 'VND',
        provider: 'BANK_TRANSFER',
        planPriceSnapshot: 100,
        effectivePlanPriceSnapshot: '100',
        planDurationDaysSnapshot: 7,
        planCharacterLimitSnapshot: 173,
        transferCode: 'KH-' + String(++nextId).padStart(8, '2'),
      },
    });
    const receipt = await db.paymentTransaction.create({
      data: {
        paymentId: payment.id,
        provider: 'SEPAY',
        providerTransactionId: String(++nextId),
        status: receiptStatus,
        amount,
        currency: 'VND',
        reference: 'Synthetic only',
        note: 'Synthetic fixture',
        receivedAt: new Date(),
        matchedAt: receiptStatus === 'MATCHED' ? new Date() : null,
      },
    });
    const f = {
      label,
      userId: user.id,
      paymentId: payment.id,
      receiptId: receipt.id,
      receipt,
      initialStatus: status,
    };
    fixtures.push(f);
    return f;
  }
  async function audit(f: any) {
    return (
      await read(
        'SELECT row_to_json(r)::text AS value FROM public."PaymentTransaction" r WHERE id=$1',
        [f.receiptId],
      )
    )[0].value;
  }
  async function state(f: any) {
    const result: any = {};
    for (const table of [
      'Subscription',
      'QuotaLot',
      'Usage',
      'Payment',
      'PaymentTransaction',
    ]) {
      const filter =
        table === 'QuotaLot'
          ? '"subscriptionId" IN (SELECT id FROM public."Subscription" WHERE "userId"=$1)'
          : table === 'PaymentTransaction'
            ? '"paymentId" IN (SELECT id FROM public."Payment" WHERE "userId"=$1)'
            : '"userId"=$1';
      result[table] = await read(
        `SELECT row_to_json(t)::text AS value FROM public."${table}" t WHERE ${filter} ORDER BY id`,
        [f.userId],
      );
    }
    return result;
  }
  async function reconcile(f: any) {
    return request(base)
      .post(`/payment/admin/transactions/${f.receiptId}/reconcile`)
      .set(
        'Authorization',
        'Bearer ' +
          (await jwt.signAsync({
            sub: admin.id,
            email: admin.email,
            authVersion: admin.authVersion,
          })),
      )
      .send({});
  }
  async function webhook(f: any) {
    const body = {
      id: Number(f.receipt.providerTransactionId),
      gateway: 'SyntheticBank',
      accountNumber: 'SYNTHETIC_ACCOUNT',
      transferType: 'in',
      transferAmount: f.receipt.amount,
      currency: 'VND',
      transactionDate: '2026-01-01 00:00:00',
      accumulated: 0,
      content: 'Synthetic only',
      code: null,
    };
    const raw = JSON.stringify(body),
      ts = String(Math.floor(Date.now() / 1000));
    return request(base)
      .post('/payment/webhook/sepay')
      .set('Content-Type', 'application/json')
      .set('x-sepay-timestamp', ts)
      .set(
        'x-sepay-signature',
        'sha256=' +
          createHmac('sha256', webhookSecret)
            .update(ts + '.')
            .update(raw)
            .digest('hex'),
      )
      .send(raw);
  }
  async function benefits(f: any, activated: boolean) {
    const rows = await read(
      'SELECT s.status,p.code,s."characterLimit",count(q.id)::integer AS lots,COALESCE(sum(q."charactersGranted"),0)::integer AS granted,COALESCE(sum(q."charactersRemaining"),0)::integer AS remaining FROM public."Subscription" s JOIN public."Plan" p ON p.id=s."planId" LEFT JOIN public."QuotaLot" q ON q."subscriptionId"=s.id WHERE s."userId"=$1 GROUP BY s.id,p.code ORDER BY p.code',
      [f.userId],
    );
    const paid = rows.filter((r) => r.code === 'BASIC');
    expect(paid).toHaveLength(activated ? 1 : 0);
    if (activated) {
      expect(paid[0]).toEqual(
        expect.objectContaining({
          status: 'ACTIVE',
          characterLimit: 173,
          lots: 1,
          granted: 173,
          remaining: 173,
        }),
      );
      expectedPaid.add(f.paymentId);
    } else {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          code: 'FREE',
          status: 'ACTIVE',
          characterLimit: 17,
          lots: 1,
          remaining: 17,
        }),
      );
    }
    expect(
      (
        await read(
          'SELECT count(*)::integer AS n FROM public."Usage" WHERE "userId"=$1',
          [f.userId],
        )
      )[0].n,
    ).toBe(0);
  }
  async function blockedBy(pid: number, min: number) {
    const until = Date.now() + 4500;
    while (Date.now() < until) {
      const rows = (
        await control.query(
          "SELECT pid,pg_catalog.pg_blocking_pids(pid) AS blockers FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND usename=current_user AND application_name=$1 AND wait_event_type='Lock'",
          ['ttv-rcr:' + packet.manifest.runId + ':writer'],
        )
      ).rows;
      if (rows.length >= min && rows.some((r: any) => r.blockers.includes(pid)))
        return rows;
      await delay(20);
    }
    throw new Error('RCR_LOCK_NOT_OBSERVED');
  }
  async function compete(
    id: string,
    f: any,
    jobs: Array<() => PromiseLike<any>>,
  ) {
    const hold = await g.verifiedClient(packet, 'writer');
    let pending: Promise<any[]> | undefined;
    try {
      await hold.query('BEGIN');
      await hold.query(
        'SELECT id FROM public."Payment" WHERE id=$1 FOR UPDATE',
        [f.paymentId],
      );
      const pid = (await hold.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      const started: Promise<any>[] = [];
      let rows: any[] = [];
      for (const job of jobs) {
        started.push(Promise.resolve().then(job));
        pending = Promise.all(started);
        rows = await blockedBy(pid, started.length);
      }
      locks.push({
        id,
        holderPid: pid,
        waiters: rows,
        observedAt: new Date().toISOString(),
      });
      await hold.query('ROLLBACK');
      return await pending!;
    } finally {
      await hold.query('ROLLBACK').catch(() => {});
      await hold.end();
      if (pending) await pending;
    }
  }
  beforeAll(async () => {
    reader = await g.verifiedClient(packet, 'reader');
    owner = await g.verifiedClient(packet, 'owner');
    control = await g.verifiedClient(packet, 'writer');
    expect(
      (await read('SELECT count(*)::integer AS n FROM public."User"'))[0].n,
    ).toBe(0);
    const { Pool } = await import('pg'),
      { PrismaPg } = await import('@prisma/adapter-pg'),
      { PrismaClient } = await import('../../generated/prisma/client.js');
    db = new PrismaClient({
      adapter: new PrismaPg(
        new Pool({ ...g.connection(packet, 'writer'), max: 10 }),
      ),
      transactionOptions: { maxWait: 15000, timeout: 20000 },
    });
    await db.$connect();
    admin = await db.user.create({
      data: { email: randomUUID() + '@example.invalid', role: 'ADMIN' },
    });
    freePlan = await db.plan.create({
      data: {
        code: 'FREE',
        name: 'Synthetic FREE',
        price: 0,
        characterLimit: 17,
        durationDays: 7,
      },
    });
    paidPlan = await db.plan.create({
      data: {
        code: 'BASIC',
        name: 'Synthetic BASIC',
        price: 100,
        characterLimit: 173,
        durationDays: 7,
      },
    });
    const payment = new PaymentService(db),
      config = new ConfigService({
        JWT_SECRET: secret,
        SEPAY_WEBHOOK_SECRET: webhookSecret,
        SEPAY_WEBHOOK_GATEWAY: 'SyntheticBank',
        BANK_TRANSFER_ACCOUNT_NUMBER: 'SYNTHETIC_ACCOUNT',
      });
    jwt = new JwtService({ secret, signOptions: { expiresIn: '5m' } });
    const module = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret }),
      ],
      controllers: [PaymentController],
      providers: [
        { provide: PrismaService, useValue: db },
        { provide: ConfigService, useValue: config },
        JwtStrategy,
        { provide: PaymentService, useValue: payment },
        {
          provide: PaymentTransactionService,
          useValue: new PaymentTransactionService(db, payment),
        },
        {
          provide: SepaySignatureService,
          useValue: new SepaySignatureService(config),
        },
        {
          provide: SepayWebhookService,
          useValue: new SepayWebhookService(db, payment, config),
        },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false, rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    (globalThis as any).__rcHttpPort(Number(new URL(base).port));
  }, 45000);
  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.$disconnect();
    for (const c of [reader, owner, control]) if (c) await c.end();
  });
  it('RCR01 RC17 PAID returns ALREADY_ACTIVATED without granting benefits', async () => {
    const f = await fixture('RCR01', 'PAID'),
      before = await state(f),
      r = await reconcile(f);
    expect(r.status).toBe(201);
    expect(r.body.activationStatus).toBe('ALREADY_ACTIVATED');
    expect(r.body.status).toBe('MATCHED');
    const after = await state(f);
    for (const t of ['Subscription', 'QuotaLot', 'Usage', 'Payment'])
      expect(after[t]).toEqual(before[t]);
    await benefits(f, true);
    done('RCR01');
  });
  it('RCR02 MATCHED replay on PAID preserves the whole receipt audit', async () => {
    const f = await fixture('RCR02', 'PAID', 'MATCHED'),
      before = await state(f);
    for (let i = 0; i < 2; i++) {
      const r = await reconcile(f);
      expect(r.status).toBe(201);
      expect(r.body.replayed).toBe(true);
      expect(r.body.activationStatus).toBe('ALREADY_ACTIVATED');
    }
    expect(await state(f)).toEqual(before);
    await benefits(f, true);
    done('RCR02');
  });
  it('RCR03 pending MATCHED replay activates once', async () => {
    const f = await fixture('RCR03', 'PENDING', 'MATCHED'),
      before = await audit(f);
    expect((await reconcile(f)).body.activationStatus).toBe('ACTIVATED');
    expect((await reconcile(f)).body.activationStatus).toBe(
      'ALREADY_ACTIVATED',
    );
    expect(await audit(f)).toBe(before);
    await benefits(f, true);
    done('RCR03');
  });
  it('RCR04 concurrent RECEIVED reconciles and Payment before receipt lock order', async () => {
    const f = await fixture('RCR04');
    const r = await compete('RCR04', f, [
      () => reconcile(f),
      () => reconcile(f),
    ]);
    expect(r.map((x) => x.status)).toEqual([201, 201]);
    expect(r.map((x) => x.body.activationStatus).sort()).toEqual([
      'ACTIVATED',
      'ALREADY_ACTIVATED',
    ]);
    const stable = await audit(f);
    expect((await reconcile(f)).body.activationStatus).toBe(
      'ALREADY_ACTIVATED',
    );
    expect(await audit(f)).toBe(stable);
    await benefits(f, true);
    const q = await fixture('RCR04_ORDER', 'PAID'),
      hold = await g.verifiedClient(packet, 'writer'),
      probe = await g.verifiedClient(packet, 'writer');
    let pending: Promise<any> | undefined;
    try {
      await hold.query('BEGIN');
      await hold.query(
        'SELECT id FROM public."PaymentTransaction" WHERE id=$1 FOR UPDATE',
        [q.receiptId],
      );
      const pid = (await hold.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      pending = Promise.resolve(reconcile(q));
      const waiters = await blockedBy(pid, 1);
      await probe.query('BEGIN');
      await probe.query("SET LOCAL lock_timeout='300ms'");
      let code = '';
      try {
        await probe.query(
          'SELECT id FROM public."Payment" WHERE id=$1 FOR UPDATE',
          [q.paymentId],
        );
      } catch (e) {
        code = (e as any).code;
      } finally {
        await probe.query('ROLLBACK');
      }
      expect(code).toBe('55P03');
      locks.push({
        id: 'RCR04_ORDER',
        holderPid: pid,
        waiters,
        probeSqlstate: code,
      });
      await hold.query('ROLLBACK');
      expect((await pending).body.activationStatus).toBe('ALREADY_ACTIVATED');
    } finally {
      await hold.query('ROLLBACK').catch(() => {});
      await hold.end();
      await probe.end();
      if (pending) await pending;
    }
    await benefits(q, true);
    done('RCR04', ['PAYMENT_GATE', 'RECEIPT_ORDER']);
  });
  it('RCR05 simultaneous MATCHED replay grants only once', async () => {
    const f = await fixture('RCR05', 'PENDING', 'MATCHED'),
      before = await audit(f);
    const r = await compete('RCR05', f, [
      () => reconcile(f),
      () => reconcile(f),
    ]);
    expect(r.map((x) => x.status)).toEqual([201, 201]);
    expect(r.map((x) => x.body.activationStatus).sort()).toEqual([
      'ACTIVATED',
      'ALREADY_ACTIVATED',
    ]);
    expect(await audit(f)).toBe(before);
    await benefits(f, true);
    done('RCR05');
  });
  it('RCR06 reconciliation competes with signed webhook replay in both orders', async () => {
    for (const first of ['RECONCILE', 'WEBHOOK']) {
      const f = await fixture('RCR06_' + first, 'PENDING', 'MATCHED'),
        before = await audit(f);
      const jobs =
        first === 'RECONCILE'
          ? [() => reconcile(f), () => webhook(f)]
          : [() => webhook(f), () => reconcile(f)];
      const r = await compete('RCR06_' + first, f, jobs);
      expect(r.map((x) => x.status)).toEqual([201, 201]);
      expect(r[first === 'RECONCILE' ? 1 : 0].body.success).toBe(true);
      expect(await audit(f)).toBe(before);
      await benefits(f, true);
    }
    done('RCR06', ['RECONCILE_FIRST_STARTED', 'WEBHOOK_FIRST_STARTED']);
  });
  it('RCR07 underfunding is MATCHED and AWAITING_FUNDS', async () => {
    const f = await fixture('RCR07', 'PENDING', 'RECEIVED', 40),
      r = await reconcile(f);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('MATCHED');
    expect(r.body.activationStatus).toBe('AWAITING_FUNDS');
    expect(r.body.paymentConfirmation).toBeNull();
    const before = await audit(f);
    expect((await reconcile(f)).body.activationStatus).toBe('AWAITING_FUNDS');
    expect(await audit(f)).toBe(before);
    await benefits(f, false);
    done('RCR07');
  });
  it('RCR08 activation failure rolls back benefits after receipt commit then safe retry', async () => {
    const f = await fixture('RCR08'),
      before = await state(f);
    // NOT VALID leaves prior fixtures intact but checks the new synthetic paid quota insert.
    await owner.query(
      'ALTER TABLE public."QuotaLot" ADD CONSTRAINT rcr_quota_fault CHECK ("charactersGranted" <> 173) NOT VALID',
    );
    const r = await reconcile(f);
    expect(r.status).toBe(500);
    expect(r.body).toEqual(
      expect.objectContaining({
        code: 'PAYMENT_ACTIVATION_FAILED',
        receiptStatus: 'MATCHED',
        activationStatus: 'FAILED',
      }),
    );
    const after = await state(f);
    for (const table of ['Subscription', 'QuotaLot', 'Usage', 'Payment'])
      expect(after[table]).toEqual(before[table]);
    const receipt = await audit(f);
    expect(JSON.parse(receipt).status).toBe('MATCHED');
    await benefits(f, false);
    await owner.query(
      'ALTER TABLE public."QuotaLot" DROP CONSTRAINT rcr_quota_fault',
    );
    expect((await reconcile(f)).body.activationStatus).toBe('ACTIVATED');
    expect((await reconcile(f)).body.activationStatus).toBe(
      'ALREADY_ACTIVATED',
    );
    expect(await audit(f)).toBe(receipt);
    await benefits(f, true);
    done('RCR08', [
      'ERROR_AFTER_COMMIT',
      'BENEFITS_ROLLBACK',
      'CONTROLLED_RETRY',
    ]);
  });
  it('RCR09 manual and unknown MATCHED sources cannot activate by replay', async () => {
    for (const status of ['PENDING', 'PAID'])
      for (const provider of ['BANK_TRANSFER', 'UNKNOWN']) {
        const f = await fixture(
          'RCR09_' + provider + '_' + status,
          status,
          'MATCHED',
        );
        await db.paymentTransaction.update({
          where: { id: f.receiptId },
          data: { provider },
        });
        const before = await state(f);
        const r = await reconcile(f);
        expect(r.status).toBe(409);
        expect(r.body.message).toBe('RECEIPT_SOURCE_VERIFICATION_REQUIRED');
        expect(await state(f)).toEqual(before);
        await benefits(f, status === 'PAID');
      }
    done('RCR09', [
      'BANK_PENDING',
      'BANK_PAID',
      'UNKNOWN_PENDING',
      'UNKNOWN_PAID',
    ]);
  });
  it('RCR10 missing or invalid SEPAY replay metadata fails closed', async () => {
    const variants: any[] = [
      { providerTransactionId: null },
      { providerTransactionId: 'bad' },
      { matchedAt: null },
      { amount: 0 },
      { amount: -1 },
      { currency: 'USD' },
    ];
    for (let i = 0; i < variants.length; i++) {
      const f = await fixture('RCR10_' + i, 'PENDING', 'MATCHED');
      await db.paymentTransaction.update({
        where: { id: f.receiptId },
        data: variants[i],
      });
      const before = await state(f),
        r = await reconcile(f);
      expect(r.status).toBe(409);
      expect(r.body.message).toBe('RECEIPT_SOURCE_VERIFICATION_REQUIRED');
      expect(await state(f)).toEqual(before);
      await benefits(f, false);
    }
    done('RCR10', [
      'MISSING_ID',
      'INVALID_ID',
      'MISSING_MATCHED_AT',
      'ZERO_AMOUNT',
      'NEGATIVE_AMOUNT',
      'CURRENCY_MISMATCH',
    ]);
  });
  it('RCR11 invalid states, concurrent relink and failed receipt write never activate', async () => {
    const cancelled = await fixture('RCR11_CANCELLED', 'CANCELLED'),
      baseline = await state(cancelled);
    expect((await reconcile(cancelled)).status).toBe(409);
    expect(await state(cancelled)).toEqual(baseline);
    await benefits(cancelled, false);
    const failed = await fixture('RCR11_WRITE'),
      before = await state(failed);
    await owner.query(
      'ALTER TABLE public."PaymentTransaction" ADD CONSTRAINT rcr_receipt_fault CHECK (id <> \'' +
        failed.receiptId +
        "' OR status <> 'MATCHED')",
    );
    const r = await reconcile(failed);
    expect(r.status).toBe(500);
    expect(await state(failed)).toEqual(before);
    await benefits(failed, false);
    const f = await fixture('RCR11_RELINK'),
      other = await fixture('RCR11_TARGET'),
      hold = await g.verifiedClient(packet, 'writer');
    let pending: Promise<any> | undefined;
    try {
      await hold.query('BEGIN');
      await hold.query(
        'SELECT id FROM public."Payment" WHERE id=$1 FOR UPDATE',
        [f.paymentId],
      );
      const pid = (await hold.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      pending = Promise.resolve(reconcile(f));
      const waiters = await blockedBy(pid, 1);
      await hold.query(
        'UPDATE public."PaymentTransaction" SET "paymentId"=$1 WHERE id=$2',
        [other.paymentId, f.receiptId],
      );
      await hold.query('COMMIT');
      expect((await pending).status).toBe(409);
      locks.push({ id: 'RCR11_RELINK', holderPid: pid, waiters });
    } finally {
      await hold.query('ROLLBACK').catch(() => {});
      await hold.end();
      if (pending) await pending;
    }
    await benefits(f, false);
    await benefits(other, false);
    done('RCR11', ['CANCELLED', 'RECEIPT_ROLLBACK', 'CONCURRENT_RELINK']);
  });
  it('RCR12 independent reader checks all fixtures, grants and audit evidence', async () => {
    const verified = await g.verifiedClient(packet, 'reader');
    await verified.end();
    for (const f of fixtures) await benefits(f, expectedPaid.has(f.paymentId));
    expect(
      (
        await read(
          'SELECT count(*)::integer AS n FROM public."PaymentTransaction"',
        )
      )[0].n,
    ).toBe(fixtures.length);
    expect(
      (
        await read(
          'SELECT count(*)::integer AS n FROM public."PaymentSurplusHandling"',
        )
      )[0].n,
    ).toBe(0);
    for (const table of ['Usage', 'StorePurchase', 'StoreCycle'])
      expect(
        (
          await read(
            'SELECT count(*)::integer AS n FROM public."' + table + '"',
          )
        )[0].n,
      ).toBe(0);
    expect(
      (
        await read(
          "SELECT count(*)::integer AS n FROM public.\"PaymentTransaction\" WHERE status='MATCHED' AND provider='SEPAY' AND amount>0 AND currency='VND' AND \"matchedAt\" IS NULL",
        )
      )[0].n,
    ).toBe(1); // deliberately invalid RCR10 fixture only
    for (const id of [
      'RCR04',
      'RCR04_ORDER',
      'RCR05',
      'RCR06_RECONCILE',
      'RCR06_WEBHOOK',
      'RCR11_RELINK',
    ])
      expect(locks.some((x) => x.id === id)).toBe(true);
    expect(evidence.map((x) => x.id)).toEqual(g.IDS.slice(0, 11));
    done('RCR12');
    writeFileSync(
      join(dirname(packet.manifest.dataDirectory), 'scenario-evidence.json'),
      JSON.stringify(
        {
          status: 'VERIFIED',
          readiness: 'NOT_READY',
          runId: packet.manifest.runId,
          cases: evidence,
          locks,
          fixtures: fixtures.map((f) => ({
            label: f.label,
            paymentId: f.paymentId,
            userId: f.userId,
            receiptId: f.receiptId,
            expectedPaid: expectedPaid.has(f.paymentId),
          })),
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
  });
});
