import { CommercialControlService } from '../../src/commercial-control/commercial-control.service';
/* Synthetic integration only; no application module, dotenv or external providers. */
import 'reflect-metadata';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import { PaymentSurplusController } from '../../src/payment-surplus/payment-surplus.controller';
import { PaymentSurplusService } from '../../src/payment-surplus/payment-surplus.service';
import { PaymentController } from '../../src/payment/payment.controller';
import { PaymentService } from '../../src/payment/payment.service';
import { PaymentTransactionService } from '../../src/payment/payment-transaction.service';
import { SepaySignatureService } from '../../src/payment/sepay-signature.service';
import { SepayWebhookService } from '../../src/payment/sepay-webhook.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { JwtStrategy } from '../../src/auth/strategies/jwt.strategy/jwt.strategy';
const g = require('./guard.cjs');
const packet = (globalThis as any).__rcPacket;
g.validate(packet);

describe('REFUND/CREDIT on independently guarded PostgreSQL', () => {
  let db: any,
    reader: any,
    control: any,
    owner: any,
    app: any,
    base: string,
    jwt: JwtService;
  let plan: any, admin: any, second: any, user: any, protectedBefore: string;
  const payments: Record<string, any> = {};
  const secret = randomBytes(32).toString('hex');
  const locksObserved: string[] = [];
  async function read(sql: string, values: any[] = []) {
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      return (await reader.query(sql, values)).rows;
    } finally {
      await reader.query('ROLLBACK');
    }
  }
  async function protectedDigest() {
    const tables = [
      'User',
      'Plan',
      'Subscription',
      'QuotaLot',
      'Usage',
      'StorePurchase',
      'StoreCycle',
    ];
    const digest = createHash('sha256');
    for (const table of tables) {
      const rows = await read(
        `SELECT row_to_json(t)::text AS value FROM public."${table}" t ORDER BY id`,
      );
      digest.update(table);
      digest.update(JSON.stringify(rows));
    }
    return digest.digest('hex');
  }
  function token(actor = admin) {
    return jwt.signAsync({
      sub: actor.id,
      email: actor.email,
      authVersion: actor.authVersion,
    });
  }
  async function create(
    p: any,
    amount = '10',
    key: string = randomUUID(),
    action = 'REFUND',
    actor = admin,
    note = 'Synthetic reservation',
  ) {
    return request(base)
      .post(`/admin/payments/${p.id}/surplus/handlings`)
      .set('Authorization', 'Bearer ' + (await token(actor)))
      .set('Idempotency-Key', key)
      .send({ action, amount, note });
  }
  async function transition(
    p: any,
    id: string,
    mode = 'complete',
    actor = admin,
    extra: any = {},
  ) {
    return request(base)
      .post(`/admin/payments/${p.id}/surplus/handlings/${id}/${mode}`)
      .set('Authorization', 'Bearer ' + (await token(actor)))
      .send(
        mode === 'complete'
          ? {
              confirmation: 'Synthetic manual confirmation',
              externalReference: 'SYNTHETIC_ONLY',
              ...extra,
            }
          : { note: 'Synthetic cancellation', ...extra },
      );
  }
  async function rows(p: any) {
    return read(
      'SELECT id,status,amount::text AS amount,"creditRemainingAmount"::text AS credit,"createdById","completedById","cancelledById","completedAt","cancelledAt",note,"externalReference" FROM public."PaymentSurplusHandling" WHERE "paymentId"=$1 ORDER BY "createdAt",id',
      [p.id],
    );
  }
  async function check(p: any) {
    const sums = (
      await read(
        `SELECT p.amount::text AS amount,
      COALESCE((SELECT sum(t.amount::numeric) FROM public."PaymentTransaction" t WHERE t."paymentId"=p.id AND t.status='MATCHED'),0)::text AS matched,
      COALESCE((SELECT sum(h.amount) FROM public."PaymentSurplusHandling" h WHERE h."paymentId"=p.id AND h.status IN ('PENDING','COMPLETED')),0)::text AS allocated
      FROM public."Payment" p WHERE p.id=$1`,
        [p.id],
      )
    )[0];
    const { Prisma } = await import('../../generated/prisma/client.js');
    const total = Prisma.Decimal.max(
      0,
      new Prisma.Decimal(sums.matched).minus(sums.amount),
    );
    const allocated = new Prisma.Decimal(sums.allocated);
    expect(allocated.lessThanOrEqualTo(total)).toBe(true);
    const response = await request(base)
      .get(`/admin/payments/${p.id}/surplus`)
      .set('Authorization', 'Bearer ' + (await token()));
    expect(response.status).toBe(200);
    expect(new Prisma.Decimal(response.body.totalSurplus).equals(total)).toBe(
      true,
    );
    expect(
      new Prisma.Decimal(response.body.allocatedAmount).equals(allocated),
    ).toBe(true);
    expect(
      new Prisma.Decimal(response.body.availableSurplus).equals(
        total.minus(allocated),
      ),
    ).toBe(true);
    return response.body;
  }
  async function competing(
    id: string,
    locked: string[],
    jobs: Array<() => PromiseLike<any>>,
  ) {
    const hold = await g.verifiedClient(packet, 'writer');
    let pending: Promise<PromiseSettledResult<any>[]> | undefined;
    try {
      await hold.query('BEGIN');
      await hold.query(
        'SELECT id FROM public."Payment" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
        [locked],
      );
      const pid = (await hold.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      pending = Promise.allSettled(
        jobs.map((job) => Promise.resolve().then(job)),
      );
      const deadline = Date.now() + 5000;
      let observed = false;
      while (Date.now() < deadline) {
        const r = (
          await control.query(
            "SELECT count(*)::integer AS n,bool_or($1::integer=ANY(pg_catalog.pg_blocking_pids(pid))) AS held FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND usename=current_user AND application_name=$2 AND wait_event_type='Lock'",
            [pid, 'ttv-rc:' + packet.manifest.runId + ':writer'],
          )
        ).rows[0];
        if (r.n >= jobs.length && r.held === true) {
          observed = true;
          break;
        }
        await delay(25);
      }
      expect(observed).toBe(true);
      if (observed) locksObserved.push(id);
      await hold.query('ROLLBACK');
      const results = await pending;
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      return results.map((r) => (r as PromiseFulfilledResult<any>).value);
    } finally {
      await hold.query('ROLLBACK').catch(() => {});
      await hold.end();
      if (pending) await pending;
    }
  }
  beforeAll(async () => {
    reader = await g.verifiedClient(packet, 'reader');
    control = await g.verifiedClient(packet, 'writer');
    owner = await g.verifiedClient(packet, 'owner');
    expect(
      (await read('SELECT count(*)::integer AS n FROM public."User"'))[0].n,
    ).toBe(0);
    const { Pool } = await import('pg');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { PrismaClient } = await import('../../generated/prisma/client.js');
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
    second = await db.user.create({
      data: { email: randomUUID() + '@example.invalid', role: 'ADMIN' },
    });
    user = await db.user.create({
      data: { email: randomUUID() + '@example.invalid', role: 'USER' },
    });
    plan = await db.plan.create({
      data: {
        code: 'BASIC',
        name: 'Synthetic RC only',
        price: 150,
        currency: 'VND',
        durationDays: 7,
        characterLimit: 173,
      },
    });
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: 'ACTIVE',
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        characterLimit: 173,
        billingSource: 'WEB',
      },
    });
    await db.quotaLot.create({
      data: {
        subscriptionId: sub.id,
        charactersGranted: 173,
        charactersRemaining: 173,
        rolloverCount: 0,
        expiresAt: sub.expiresAt,
      },
    });
    for (const id of [...g.IDS, 'RC14_CREATE', 'RC10_OTHER']) {
      const decimal = id === 'RC15';
      const p = await db.payment.create({
        data: {
          userId: user.id,
          planId: plan.id,
          status: id === 'RC03' ? 'PENDING' : 'PAID',
          amount: decimal ? 80.1 : 100,
          currency: 'VND',
          provider: 'SYNTHETIC_RC',
          planPriceSnapshot: 150,
          promotionPriceSnapshot: decimal ? 100.1 : 100,
          creditAmount: decimal ? 20 : 0,
          effectivePlanPriceSnapshot: decimal ? '100.1' : '100',
          planCharacterLimitSnapshot: 173,
          planDurationDaysSnapshot: 7,
        },
      });
      const receipt = await db.paymentTransaction.create({
        data: {
          paymentId: p.id,
          provider: 'SYNTHETIC_RC',
          providerTransactionId: randomUUID(),
          status: 'MATCHED',
          amount: decimal ? 130.3 : 140,
          currency: 'VND',
        },
      });
      payments[id] = { ...p, receiptId: receipt.id };
    }
    const payment = new PaymentService(
      db,
      new CommercialControlService(
        new ConfigService({ PAYMENTS_ENABLED: 'true' }),
      ),
    );
    const surplus = new PaymentSurplusService(db);
    jwt = new JwtService({ secret, signOptions: { expiresIn: '5m' } });
    const module = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret }),
      ],
      controllers: [PaymentSurplusController, PaymentController],
      providers: [
        { provide: PrismaService, useValue: db },
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_SECRET: secret }),
        },
        JwtStrategy,
        { provide: PaymentSurplusService, useValue: surplus },
        { provide: PaymentService, useValue: payment },
        {
          provide: PaymentTransactionService,
          useValue: new PaymentTransactionService(db, payment),
        },
        {
          provide: SepaySignatureService,
          useValue: {
            verifySignature() {
              throw new Error('RC_SEPAY_FORBIDDEN');
            },
          },
        },
        {
          provide: SepayWebhookService,
          useValue: {
            handleWebhook() {
              throw new Error('RC_SEPAY_FORBIDDEN');
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    (globalThis as any).__rcHttpPort(Number(new URL(base).port));
    protectedBefore = await protectedDigest();
  }, 45000);
  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.$disconnect();
    for (const c of [reader, control, owner]) if (c) await c.end();
  });

  it('RC01 authentication and admin authorization', async () => {
    const url = `/admin/payments/${payments.RC01.id}/surplus/handlings`;
    for (const method of ['post'] as const) {
      expect((await request(base)[method](url).send({})).status).toBe(401);
      expect(
        (
          await request(base)
            [method](url)
            .set('Authorization', 'Bearer invalid.synthetic')
            .send({})
        ).status,
      ).toBe(401);
    }
    expect(
      (await create(payments.RC01, '10', randomUUID(), 'REFUND', user)).status,
    ).toBe(403);
    expect(await rows(payments.RC01)).toHaveLength(0);
  });
  it('RC02 invalid amounts, keys, notes and unsupported actions do not write', async () => {
    const p = payments.RC02;
    for (const value of [
      '0',
      '-1',
      'NaN',
      'Infinity',
      '1e2',
      '0.0000001',
      '100000000000000',
      '',
    ])
      expect((await create(p, value)).status).toBe(400);
    for (const action of ['QUOTA', 'DAYS'])
      expect((await create(p, '10', randomUUID(), action)).status).toBe(400);
    expect((await create(p, '10', '')).status).toBe(400);
    expect(
      (await create(p, '10', randomUUID(), 'REFUND', admin, ' ')).status,
    ).toBe(400);
    const h = await create(p);
    expect(h.status).toBe(201);
    expect(
      (await transition(p, h.body.id, 'complete', admin, { confirmation: ' ' }))
        .status,
    ).toBe(400);
    expect(
      (await transition(p, h.body.id, 'cancel', admin, { note: ' ' })).status,
    ).toBe(400);
    expect((await rows(p))[0].status).toBe('PENDING');
  });
  it('RC03 absent and non-PAID payments fail without writes', async () => {
    const p = payments.RC03;
    expect((await create(p)).status).toBe(409);
    for (const mode of ['complete', 'cancel'])
      expect((await transition(p, randomUUID(), mode)).status).toBe(409);
    expect((await create({ id: randomUUID() })).status).toBe(404);
    expect(await rows(p)).toHaveLength(0);
  });
  it('RC04 REFUND create and complete record manual evidence', async () => {
    const p = payments.RC04,
      h = await create(p);
    expect(h.status).toBe(201);
    expect(h.body.status).toBe('PENDING');
    const done = await transition(p, h.body.id);
    expect(done.status).toBe(201);
    expect(done.body.status).toBe('COMPLETED');
    expect(done.body.createdById).toBe(admin.id);
    expect(done.body.completedById).toBe(admin.id);
    expect(done.body.creditRemainingAmount).toBe('0');
    expect(done.body.externalReference).toBe('SYNTHETIC_ONLY');
    expect(done.body.note).toContain('[SURPLUS:COMPLETED]');
    await check(p);
  });
  it('RC05 CREDIT records funds only without quota effects', async () => {
    const p = payments.RC05,
      h = await create(p, '10', randomUUID(), 'CREDIT');
    expect(h.status).toBe(201);
    expect(h.body.creditRemainingAmount).toBe('0');
    const done = await transition(p, h.body.id);
    expect(done.body.creditRemainingAmount).toBe('10');
    expect(await protectedDigest()).toBe(protectedBefore);
    await check(p);
  });
  it('RC06 cancellation releases reservation without deleting history', async () => {
    const p = payments.RC06,
      h = await create(p, '40');
    expect(h.status).toBe(201);
    expect((await create(p, '0.000001')).status).toBe(409);
    expect((await transition(p, h.body.id, 'cancel')).status).toBe(201);
    expect((await create(p, '40')).status).toBe(201);
    expect((await rows(p)).map((r) => r.status).sort()).toEqual([
      'CANCELLED',
      'PENDING',
    ]);
    await check(p);
  });
  it('RC07 create and transition replay preserve original records', async () => {
    const p = payments.RC07,
      key = randomUUID(),
      h = await create(p, '10', key);
    expect((await create(p, '10', key)).body.id).toBe(h.body.id);
    await transition(p, h.body.id);
    const before = await rows(p);
    expect(
      (
        await transition(p, h.body.id, 'complete', second, {
          externalReference: 'SECOND_SYNTHETIC',
        })
      ).status,
    ).toBe(201);
    expect(await rows(p)).toEqual(before);
    expect((await create(p, '10', key)).body.status).toBe('COMPLETED');
    expect((await transition(p, h.body.id, 'cancel')).status).toBe(409);
    await check(p);
  });
  it('RC08 key conflicts reject changed amount, action, note, actor or payment', async () => {
    const p = payments.RC08,
      key = randomUUID();
    expect((await create(p, '10', key)).status).toBe(201);
    const before = await rows(p);
    for (const job of [
      () => create(p, '11', key),
      () => create(p, '10', key, 'CREDIT'),
      () => create(p, '10', key, 'REFUND', second),
      () => create(p, '10', key, 'REFUND', admin, 'Different'),
      () => create(payments.RC01, '10', key),
    ])
      expect((await job()).status).toBe(409);
    expect(await rows(p)).toEqual(before);
  });
  it('RC09 concurrent identical keys create one handling', async () => {
    const p = payments.RC09,
      key = randomUUID();
    const r = await competing(
      'RC09',
      [p.id],
      [() => create(p, '10', key), () => create(p, '10', key)],
    );
    expect(r.map((x) => x.status)).toEqual([201, 201]);
    expect(r[0].body.id).toBe(r[1].body.id);
    expect(await rows(p)).toHaveLength(1);
    await check(p);
  });
  it('RC10 global key race across payments rolls back the losing insert', async () => {
    const p = payments.RC10,
      q = payments.RC10_OTHER,
      key = randomUUID();
    const r = await competing(
      'RC10',
      [p.id, q.id],
      [() => create(p, '10', key), () => create(q, '10', key)],
    );
    expect(r.map((x) => x.status).sort()).toEqual([201, 409]);
    expect(
      (
        await read(
          'SELECT count(*)::integer AS n FROM public."PaymentSurplusHandling" WHERE "idempotencyKey"=$1',
          [key],
        )
      )[0].n,
    ).toBe(1);
    await check(p);
    await check(q);
  });
  it('RC11 competing reservations cannot exceed actual surplus', async () => {
    const p = payments.RC11;
    const r = await competing(
      'RC11',
      [p.id],
      [() => create(p, '30'), () => create(p, '30'), () => create(p, '30')],
    );
    expect(r.filter((x) => x.status === 201)).toHaveLength(1);
    expect(r.filter((x) => x.status === 409)).toHaveLength(2);
    await check(p);
  });
  it('RC12 competing complete/cancel and repeated transitions preserve first audit', async () => {
    const p = payments.RC12,
      h = await create(p);
    const r = await competing(
      'RC12',
      [p.id],
      [
        () => transition(p, h.body.id, 'complete', admin),
        () => transition(p, h.body.id, 'cancel', second),
      ],
    );
    expect(r.map((x) => x.status).sort()).toEqual([201, 409]);
    const before = await rows(p),
      mode = before[0].status === 'COMPLETED' ? 'complete' : 'cancel';
    const replay = await competing(
      'RC12_REPLAY',
      [p.id],
      [
        () => transition(p, h.body.id, mode, second),
        () => transition(p, h.body.id, mode, admin),
      ],
    );
    expect(replay.map((x) => x.status)).toEqual([201, 201]);
    expect(await rows(p)).toEqual(before);
    await check(p);
  });
  it('RC13 Payment row lock blocks only the selected payment', async () => {
    const p = payments.RC13,
      q = payments.RC01,
      hold = await g.verifiedClient(packet, 'writer');
    let blocked: Promise<any> | undefined;
    try {
      await hold.query('BEGIN');
      await hold.query(
        'SELECT id FROM public."Payment" WHERE id=$1 FOR UPDATE',
        [p.id],
      );
      blocked = Promise.resolve(create(p));
      let observed = false;
      for (let i = 0; i < 150; i++) {
        const r = await control.query(
          "SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
          ['ttv-rc:' + packet.manifest.runId + ':writer'],
        );
        if (r.rows[0].n > 0) {
          observed = true;
          break;
        }
        await delay(20);
      }
      expect(observed).toBe(true);
      locksObserved.push('RC13');
      expect((await create(q)).status).toBe(201);
      await hold.query('ROLLBACK');
      expect((await blocked).status).toBe(201);
    } finally {
      await hold.query('ROLLBACK').catch(() => {});
      await hold.end();
      if (blocked) await blocked;
    }
    await check(p);
  });
  it('RC14 PostgreSQL constraints roll back failed create and completion', async () => {
    const p = payments.RC14_CREATE,
      q = payments.RC14,
      h = await create(q);
    expect(h.status).toBe(201);
    await owner.query(
      'ALTER TABLE public."PaymentSurplusHandling" ADD CONSTRAINT rc_fault_create CHECK ("paymentId" <> \'' +
        p.id +
        "')",
    );
    await owner.query(
      'ALTER TABLE public."PaymentSurplusHandling" ADD CONSTRAINT rc_fault_complete CHECK ("paymentId" <> \'' +
        q.id +
        "' OR status <> 'COMPLETED')",
    );
    const before = await rows(q);
    expect((await create(p)).status).toBe(500);
    expect(await rows(p)).toHaveLength(0);
    expect((await transition(q, h.body.id)).status).toBe(500);
    expect(await rows(q)).toEqual(before);
    await check(q);
  });
  it('RC15 Decimal boundary and post-promotion pre-credit snapshot remain exact', async () => {
    const p = payments.RC15;
    await db.plan.update({ where: { id: plan.id }, data: { price: 300 } });
    try {
      const h = await create(p, '0.000001');
      expect(h.status).toBe(201);
      expect(h.body.amount).toBe('0.000001');
      expect(h.body.effectivePlanPriceSnapshot).toBe('100.1');
      expect(h.body.planCharacterLimitSnapshot).toBe(173);
      expect(h.body.planDurationDaysSnapshot).toBe(7);
      const result = await check(p);
      expect(result.availableSurplus).toBe('50.199999');
    } finally {
      await db.plan.update({
        where: { id: plan.id },
        data: { price: plan.price, updatedAt: plan.updatedAt },
      });
    }
  });
  it('RC16 bad currency and over-allocation fail closed; cancel releases reservation', async () => {
    const p = payments.RC16;
    await db.paymentTransaction.update({
      where: { id: p.receiptId },
      data: { currency: 'USD' },
    });
    expect((await create(p)).status).toBe(500);
    expect(await rows(p)).toHaveLength(0);
    await db.paymentTransaction.update({
      where: { id: p.receiptId },
      data: { currency: 'VND' },
    });
    const bad = await db.paymentSurplusHandling.create({
      data: {
        paymentId: p.id,
        action: 'REFUND',
        status: 'PENDING',
        amount: '41',
        currency: 'VND',
        idempotencyKey: randomUUID(),
        note: 'Synthetic corrupt allocation test',
        createdById: admin.id,
      },
    });
    expect((await transition(p, bad.id)).status).toBe(500);
    expect((await transition(p, bad.id, 'cancel')).status).toBe(201);
    expect((await rows(p))[0].status).toBe('CANCELLED');
    await check(p);
  });
  it('RC17 MATCHED reconciliation shares Payment lock and retains committed receipt on confirmation error', async () => {
    const p = payments.RC17,
      t = await db.paymentTransaction.create({
        data: {
          paymentId: p.id,
          provider: 'SYNTHETIC_RC',
          providerTransactionId: randomUUID(),
          status: 'RECEIVED',
          amount: 50,
          currency: 'VND',
        },
      });
    const r = await competing(
      'RC17',
      [p.id],
      [
        () => create(p, '30'),
        async () =>
          request(base)
            .post(`/payment/admin/transactions/${t.id}/reconcile`)
            .set('Authorization', 'Bearer ' + (await token()))
            .send({}),
      ],
    );
    expect(r[0].status).toBe(201);
    expect(r[1].status).toBe(400);
    expect(
      (
        await read(
          'SELECT status FROM public."PaymentTransaction" WHERE id=$1',
          [t.id],
        )
      )[0].status,
    ).toBe('MATCHED');
    expect((await check(p)).availableSurplus).toBe('60');
    expect(await protectedDigest()).toBe(protectedBefore);
  });
  it('RC18 independent reader validates all balances, audit, no privilege changes and protected data', async () => {
    const verified = await g.verifiedClient(packet, 'reader');
    await verified.end();
    expect(await protectedDigest()).toBe(protectedBefore);
    for (const p of Object.values(payments)) {
      if (p.status === 'PAID') await check(p);
    }
    const invalid = (
      await read(`SELECT count(*)::integer AS n FROM public."PaymentSurplusHandling" WHERE
      (status='COMPLETED' AND ("completedById" IS NULL OR "completedAt" IS NULL OR "cancelledAt" IS NOT NULL)) OR
      (status='CANCELLED' AND ("cancelledById" IS NULL OR "cancelledAt" IS NULL OR "completedAt" IS NOT NULL)) OR
      (action='CREDIT' AND status='COMPLETED' AND "creditRemainingAmount"<>amount) OR
      ((action<>'CREDIT' OR status<>'COMPLETED') AND "creditRemainingAmount"<>0)`)
    )[0].n;
    expect(invalid).toBe(0);
    for (const id of [
      'RC09',
      'RC10',
      'RC11',
      'RC12',
      'RC12_REPLAY',
      'RC13',
      'RC17',
    ])
      expect(locksObserved).toContain(id);
  });
});
