/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-require-imports, @typescript-eslint/require-await */
// Prepared integration suite. Never selected by the ordinary Jest testRegex.
import 'reflect-metadata';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Controller,
  Get,
  UseGuards,
  Req,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type {
  StorePlatform,
  VerifiedStorePurchase,
} from '../../src/store-billing/store-billing.types';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth/jwt-auth.guard';
const guard = require('./guard.cjs');
const packet = (globalThis as unknown as { __acceptancePacket: any })
  .__acceptancePacket;
guard.validate(packet);

// Only the external AI SDK is substituted; database, JWT and locks are real.
jest.mock('@openrouter/sdk', () => ({
  OpenRouter: class {
    constructor() {
      throw new Error('EXTERNAL_AI_FORBIDDEN');
    }
  },
}));
@Controller('acceptance')
class Probe {
  @Get('session')
  @UseGuards(JwtAuthGuard)
  session(@Req() req: { user: { userId: string } }) {
    return { userId: req.user.userId };
  }
}
describe('Acceptance on independently guarded PostgreSQL 17', () => {
  let db: PrismaService, reader: any, control: any, app: any, base: string;
  let users: any,
    auth: any,
    payment: any,
    cron: any,
    store: any,
    jwt: JwtService;
  let tts: any, Audio: any, Tts: any, Workload: any;
  let paymentConfig: ConfigService;
  const mail = { sendReset: jest.fn() };
  const apple = { verify: jest.fn(), notification: jest.fn() };
  const google = {
    verify: jest.fn(),
    notification: jest.fn(),
    acknowledge: jest.fn(),
  };
  const plans: Record<string, any> = {};
  const secret = randomBytes(32).toString('hex');
  const pcm = { synthesize: jest.fn(async () => Buffer.alloc(960)) };
  const pass = 'SyntheticOnly7!';
  async function newUser() {
    return users.create({
      email: `${randomUUID()}@example.invalid`,
      password: pass,
      name: 'Synthetic acceptance',
    });
  }
  async function read(sql: string, params: unknown[] = []) {
    await reader.query('BEGIN READ ONLY');
    try {
      return (await reader.query(sql, params)).rows;
    } finally {
      await reader.query('ROLLBACK');
    }
  }
  async function contention(
    table: 'User' | 'PasswordResetToken',
    id: string,
    jobs: Array<() => Promise<unknown>>,
  ) {
    // A separate PG connection holds the real row lock while transactions enter.
    const hold = await guard.verifiedClient(packet, 'cold', 'writer');
    let results: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await hold.query('BEGIN');
      await hold.query(
        `SELECT id FROM public."${table}" WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const pid = (await hold.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      results = Promise.allSettled(jobs.map((fn) => fn()));
      const deadline = Date.now() + 10000;
      let observed = false;
      do {
        const waiting = await control.query(
          `SELECT count(*)::int AS n,
          bool_or($1::int=ANY(pg_catalog.pg_blocking_pids(pid))) AS held
          FROM pg_catalog.pg_stat_activity WHERE application_name=$2 AND wait_event_type='Lock'`,
          [pid, `ttv-it:${packet.manifest.runId}:writer`],
        );
        observed =
          waiting.rows[0].n >= jobs.length && waiting.rows[0].held === true;
        if (!observed) await delay(25);
      } while (!observed && Date.now() < deadline);
      expect(observed).toBe(true); // Not merely Promise.all or a fixed sleep.
      await hold.query('ROLLBACK');
      return await results;
    } finally {
      await hold.query('ROLLBACK').catch(() => undefined);
      await hold.end();
      if (results) await results;
    }
  }
  function receipt(
    userId: string,
    platform: StorePlatform,
    change: Partial<VerifiedStorePurchase> = {},
  ): VerifiedStorePurchase {
    const id = randomBytes(6).readUIntBE(0, 6).toString();
    return {
      platform,
      reference: id,
      chainId: id,
      cycleId: id,
      productId: platform === 'APPLE' ? 'synthetic.apple' : 'synthetic.google',
      basePlanId: platform === 'GOOGLE' ? 'synthetic-monthly' : undefined,
      accountBinding: store.binding(userId, platform),
      environment: 'Sandbox',
      state: 'ACTIVE',
      startedAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 86400000),
      initialCycle: true,
      acknowledged: false,
      autoRenew: true,
      ...change,
    };
  }
  beforeAll(async () => {
    // No Prisma client, production module, dotenv or app bootstrap before this.
    reader = await guard.verifiedClient(packet, 'cold', 'reader');
    control = await guard.verifiedClient(packet, 'cold', 'writer');
    const empty = await control.query(
      'SELECT count(*)::int AS n FROM public."User"',
    );
    guard.insist(empty.rows[0].n === 0, 'SYNTHETIC_EMPTY_DATABASE_REQUIRED');
    const { Pool } = await import('pg');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { PrismaClient } = await import('../../generated/prisma/client.js');
    const pool = new Pool({
      ...guard.connection(packet, 'cold', 'writer'),
      max: 8,
    });
    db = new PrismaClient({
      adapter: new PrismaPg(pool),
      transactionOptions: { maxWait: 15000, timeout: 20000 },
    }) as unknown as PrismaService;
    await db.$connect();
    const { UsersService } = await import('../../src/users/users.service.js');
    const { AuthService } = await import('../../src/auth/auth.service.js');
    const { AuthController } =
      await import('../../src/auth/auth.controller.js');
    const { AuthRateLimitGuard } =
      await import('../../src/auth/auth-rate-limit.guard.js');
    const { JwtStrategy } =
      await import('../../src/auth/strategies/jwt.strategy/jwt.strategy.js');
    const { PrismaService: PrismaToken } =
      await import('../../src/prisma/prisma.service.js');
    const { PaymentService } =
      await import('../../src/payment/payment.service.js');
    const { PaymentController } =
      await import('../../src/payment/payment.controller.js');
    const { PaymentTransactionService } =
      await import('../../src/payment/payment-transaction.service.js');
    const { SepayWebhookService } =
      await import('../../src/payment/sepay-webhook.service.js');
    const { SepaySignatureService } =
      await import('../../src/payment/sepay-signature.service.js');
    const { SubscriptionExpiryService } =
      await import('../../src/subscription/subscription-expiry.service.js');
    const { StoreBillingService } =
      await import('../../src/store-billing/store-billing.service.js');
    const { StoreSettings } =
      await import('../../src/store-billing/store-settings.service.js');
    Tts = (await import('../../src/tts/tts.service.js')).TtsService;
    Audio = (await import('../../src/audio/audio.service.js')).AudioService;
    Workload = (await import('../../src/ai/ai-workload.service.js'))
      .AiWorkloadService;
    // Fixture values only; no production pricing, quota or settings are modified.
    for (const [code, limit] of Object.entries({
      FREE: 5000,
      BASIC: 30000,
      PRO: 80000,
      BUSINESS: 250000,
    })) {
      plans[code] = await db.plan.create({
        data: {
          code,
          name: `Synthetic ${code}`,
          price: code === 'FREE' ? 0 : 100,
          currency: 'VND',
          durationDays: 7,
          characterLimit: limit,
        },
      });
    }
    const config = new ConfigService({ JWT_SECRET: secret });
    paymentConfig = new ConfigService({
      SEPAY_WEBHOOK_SECRET: secret,
      BANK_TRANSFER_ACCOUNT_NUMBER: 'synthetic-account',
      SEPAY_WEBHOOK_GATEWAY: 'synthetic-bank',
    });
    users = new UsersService(db);
    jwt = new JwtService({ secret, signOptions: { expiresIn: '5m' } });
    auth = new AuthService(users, jwt, db, mail as any);
    payment = new PaymentService(db);
    cron = new SubscriptionExpiryService(db);
    store = new StoreBillingService(
      db,
      new StoreSettings(
        new ConfigService({
          STORE_REFERENCE_ENCRYPTION_KEY_BASE64:
            randomBytes(32).toString('base64'),
          STORE_PRODUCT_MAPPING: JSON.stringify([
            {
              platform: 'APPLE',
              productId: 'synthetic.apple',
              planCode: 'BASIC',
            },
            {
              platform: 'GOOGLE',
              productId: 'synthetic.google',
              basePlanId: 'synthetic-monthly',
              planCode: 'BASIC',
            },
          ]),
        }),
      ),
      apple as any,
      google as any,
    );
    tts = new Tts(db, new Audio(db), pcm, new Workload(new ConfigService()));
    const module = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret }),
      ],
      controllers: [AuthController, PaymentController, Probe],
      providers: [
        { provide: PrismaToken, useValue: db },
        { provide: ConfigService, useValue: config },
        { provide: AuthService, useValue: auth },
        { provide: PaymentService, useValue: payment },
        {
          provide: PaymentTransactionService,
          useValue: new PaymentTransactionService(db, payment),
        },
        {
          provide: SepaySignatureService,
          useValue: new SepaySignatureService(paymentConfig),
        },
        {
          provide: SepayWebhookService,
          useValue: new SepayWebhookService(db, payment, paymentConfig),
        },
        JwtStrategy,
        AuthRateLimitGuard,
      ],
    }).compile();
    app = module.createNestApplication({ logger: false, rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    (globalThis as any).__allowAcceptanceHttpPort(Number(new URL(base).port));
  });
  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.$disconnect();
    if (reader) await reader.end();
    if (control) await control.end();
    // Keep data/artifacts for review. No deleteMany, DROP or old-cluster cleanup.
  });
  it('A01 migration cold history and checksum are complete', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const rows = await read(
      'SELECT migration_name,checksum,finished_at,rolled_back_at FROM public._prisma_migrations ORDER BY migration_name',
    );
    expect(rows).toHaveLength(26);
    for (const row of rows) {
      expect(Boolean(row.finished_at) && !row.rolled_back_at).toBe(true);
      expect(
        row.checksum ===
          guard.hash(
            fs.readFileSync(
              path.join(
                __dirname,
                '../../prisma/migrations',
                row.migration_name,
                'migration.sql',
              ),
            ),
          ),
      ).toBe(true);
    }
  });
  it('A02 register creates one User, FREE subscription and quota atomically', async () => {
    const u = await newUser();
    const result = await read(
      'SELECT s."characterLimit",q."charactersRemaining" FROM "Subscription" s JOIN "QuotaLot" q ON q."subscriptionId"=s.id WHERE s."userId"=$1',
      [u.id],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      characterLimit: 5000,
      charactersRemaining: 5000,
    });
    await request(base)
      .post('/users')
      .send({ email: 'unused@example.invalid', password: pass })
      .expect(404);
    await request(base)
      .post('/auth/register')
      .send({ password: 'weak' })
      .expect(400);
  });
  it('A03 real JWT signatures, expiry, version and password change revoke sessions', async () => {
    const u = await newUser();
    const login = await auth.login({ identifier: u.email, password: pass });
    await request(base)
      .get('/acceptance/session')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(200);
    for (const token of [
      await jwt.signAsync({ sub: u.id }),
      await jwt.signAsync({ sub: u.id, authVersion: 0 }, { expiresIn: -1 }),
      await new JwtService({ secret: 'synthetic-wrong' }).signAsync({
        sub: u.id,
        authVersion: 0,
      }),
    ]) {
      await request(base)
        .get('/acceptance/session')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    }
    await users.changePassword(u.id, pass, 'SyntheticNew8!');
    await request(base)
      .get('/acceptance/session')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(401);
  });
  it('A04 reset token contention consumes once and increments authVersion once', async () => {
    const u = await newUser();
    const login = await auth.login({ identifier: u.email, password: pass });
    mail.sendReset.mockClear();
    await auth.forgotPassword(u.email);
    const raw = mail.sendReset.mock.calls[0][1];
    const token = await db.passwordResetToken.findFirstOrThrow({
      where: { userId: u.id },
    });
    const results = await contention('PasswordResetToken', token.id, [
      () => auth.resetPassword(raw, 'SyntheticNew8!'),
      () => auth.resetPassword(raw, 'SyntheticNew9!'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: u.id } })).authVersion,
    ).toBe(1);
    await request(base)
      .get('/acceptance/session')
      .set('Authorization', `Bearer ${login.accessToken}`)
      .expect(401);
  });
  async function webhook(
    order: any,
    amount = 100,
    change: Record<string, unknown> = {},
  ) {
    const body = {
      id: Math.floor(Math.random() * 1000000000),
      gateway: 'synthetic-bank',
      transactionDate: new Date().toISOString(),
      accountNumber: 'synthetic-account',
      content: order.transferCode,
      code: order.transferCode,
      transferType: 'in',
      transferAmount: amount,
      accumulated: 0,
      currency: 'VND',
      ...change,
    };
    const text = JSON.stringify(body),
      stamp = String(Math.floor(Date.now() / 1000));
    const signature =
      'sha256=' +
      createHmac('sha256', secret).update(`${stamp}.${text}`).digest('hex');
    return { text, stamp, signature, body };
  }
  async function send(
    hook: Awaited<ReturnType<typeof webhook>>,
    signature = hook.signature,
  ) {
    return request(base)
      .post('/payment/webhook/sepay')
      .set('Content-Type', 'application/json')
      .set('x-sepay-timestamp', hook.stamp)
      .set('x-sepay-signature', signature)
      .send(hook.text);
  }
  it('A05 real HTTP SePay signature, underpayment, replay and one activation', async () => {
    const u = await newUser(),
      order = await payment.createPayment(u.id, 'BASIC');
    const first = await webhook(order, 40),
      second = await webhook(order, 70);
    expect((await send(first, 'sha256=' + '0'.repeat(64))).status).toBe(401);
    expect((await send(first)).status).toBeLessThan(300);
    expect(
      (await db.payment.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).not.toBe('PAID');
    expect((await send(second)).status).toBeLessThan(300);
    expect((await send(second)).status).toBeLessThan(300);
    expect(
      await db.paymentTransaction.count({ where: { paymentId: order.id } }),
    ).toBe(2);
    expect(
      await db.subscription.count({
        where: { userId: u.id, status: 'ACTIVE', plan: { code: 'BASIC' } },
      }),
    ).toBe(1);
  });
  it('A06 two worker TTS transactions contend; quota never goes negative', async () => {
    const u = await newUser();
    const project = await db.project.create({
      data: { userId: u.id, name: 'Synthetic' },
    });
    await db.quotaLot.updateMany({
      where: { subscription: { userId: u.id } },
      data: { charactersRemaining: 7 },
    });
    const speech = {
      projectId: project.id,
      text: 'Test',
      language: 'vi',
      character: 'adult_male',
      tone: 'neutral',
      emotion: 'natural',
      style: 'conversation',
      region: 'north_vietnam',
      speed: 1,
    };
    const other = new Tts(
      db,
      new Audio(db),
      pcm,
      new Workload(new ConfigService()),
    );
    const result = await contention('User', u.id, [
      () => tts.synthesize(speech, u.id),
      () => other.synthesize(speech, u.id),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.usage.count({ where: { userId: u.id } })).toBe(1);
    const lots = await db.quotaLot.findMany({
      where: { subscription: { userId: u.id } },
    });
    expect(lots.reduce((sum, l) => sum + l.charactersRemaining, 0)).toBe(3);
  });
  it('A07 cron and payment contention leaves only one effective paid subscription', async () => {
    const u = await newUser(),
      order = await payment.createPayment(u.id, 'BASIC');
    await db.subscription.updateMany({
      where: { userId: u.id },
      data: { status: 'EXPIRED' },
    });
    await db.subscription.create({
      data: {
        userId: u.id,
        planId: plans.BASIC.id,
        status: 'ACTIVE',
        startedAt: new Date(0),
        expiresAt: new Date(Date.now() - 26 * 3600000),
        characterLimit: 30000,
      },
    });
    await db.paymentTransaction.create({
      data: {
        paymentId: order.id,
        provider: 'BANK_TRANSFER',
        providerTransactionId: randomUUID(),
        amount: 100,
        currency: 'VND',
        status: 'MATCHED',
      },
    });
    await contention('User', u.id, [
      () => cron.expireSubscriptionsAfterGracePeriod(),
      () => payment.confirmPayment(order.id),
    ]);
    expect(
      (await db.payment.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe('PAID');
    expect(
      await db.subscription.count({
        where: {
          userId: u.id,
          status: 'ACTIVE',
          expiresAt: { gt: new Date() },
        },
      }),
    ).toBe(1);
  });
  it.each(['APPLE', 'GOOGLE'] as const)(
    'A08 %s ledger, verified renewal and notification replay grant once',
    async (platform) => {
      const u = await newUser(),
        v = receipt(u.id, platform);
      const provider = platform === 'APPLE' ? apple : google;
      provider.verify.mockResolvedValue(v);
      provider.notification.mockResolvedValue(v);
      await store.verify(u.id, platform, v.reference);
      await store.verify(u.id, platform, v.reference);
      await expect(payment.createPayment(u.id, 'PRO')).rejects.toThrow(
        'ACTIVE_PAID_SUBSCRIPTION_EXISTS',
      );
      const old = await db.storeCycle.findFirstOrThrow({
        where: { purchase: { userId: u.id } },
      });
      const boundary = new Date(Date.now() - 1000);
      await db.storeCycle.update({
        where: { id: old.id },
        data: { expiresAt: boundary },
      });
      await db.subscription.update({
        where: { id: old.subscriptionId! },
        data: { expiresAt: boundary },
      });
      await db.quotaLot.updateMany({
        where: { subscriptionId: old.subscriptionId! },
        data: { charactersRemaining: 23, expiresAt: boundary },
      });
      const renewal = receipt(u.id, platform, {
        chainId: v.chainId,
        initialCycle: false,
        renewalEligible: true,
        startedAt: boundary,
      });
      provider.verify.mockResolvedValue(renewal);
      provider.notification.mockResolvedValue(renewal);
      const result = await contention('User', u.id, [
        () => store.verify(u.id, platform, renewal.reference),
        () => store.notification(platform, 'synthetic-notification'),
      ]);
      expect(result.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(
        await db.storeCycle.count({
          where: { purchase: { userId: u.id }, deliveryStatus: 'GRANTED' },
        }),
      ).toBe(2);
      expect(
        await db.subscription.count({
          where: {
            userId: u.id,
            status: 'ACTIVE',
            expiresAt: { gt: new Date() },
          },
        }),
      ).toBe(1);
      expect(
        await db.quotaLot.count({
          where: { sourceLotId: { not: null }, subscription: { userId: u.id } },
        }),
      ).toBe(1);
      expect((await store.catalog(u.id, platform)).purchaseEnabled).toBe(false);
    },
  );
  it('A09 paid conflict is retained; expiry allows a new purchase without combining plans', async () => {
    const u = await newUser(),
      order = await payment.createPayment(u.id, 'BASIC');
    const hook = await webhook(order);
    expect((await send(hook)).status).toBeLessThan(300);
    const v = receipt(u.id, 'APPLE');
    apple.verify.mockResolvedValue(v);
    expect(
      (await store.verify(u.id, 'APPLE', v.reference)).deliveryStatus,
    ).toBe('REVIEW_REQUIRED');
    expect(
      await db.storeCycle.count({ where: { purchase: { userId: u.id } } }),
    ).toBe(1);
    await db.subscription.updateMany({
      where: { userId: u.id },
      data: {
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() - 26 * 3600000),
      },
    });
    expect((await payment.createPayment(u.id, 'PRO')).paymentType).toBe(
      'NEW_PURCHASE',
    );
  });
  it('A10 actual constraint failure rolls back User/FREE/quota without a Prisma mock', async () => {
    const owner = await guard.verifiedClient(packet, 'cold', 'owner');
    const email = `${randomUUID()}@example.invalid`;
    try {
      await owner.query(
        'ALTER TABLE public."QuotaLot" ADD CONSTRAINT ttv_acceptance_fault CHECK ("charactersGranted" <> 5000) NOT VALID',
      );
      await expect(
        users.create({ email, password: pass }),
      ).rejects.toBeDefined();
      expect(await db.user.count({ where: { email } })).toBe(0);
    } finally {
      await owner.query(
        'ALTER TABLE public."QuotaLot" DROP CONSTRAINT IF EXISTS ttv_acceptance_fault',
      );
      await owner.end();
    }
  });
  it('A12 store quota failure rolls back ledger and delivery before acknowledgement', async () => {
    const u = await newUser();
    const v = receipt(u.id, 'GOOGLE');
    google.verify.mockResolvedValue(v);
    google.acknowledge.mockClear();
    const owner = await guard.verifiedClient(packet, 'cold', 'owner');
    try {
      await owner.query(
        'ALTER TABLE public."QuotaLot" ADD CONSTRAINT ttv_store_fault CHECK ("charactersGranted" <> 30000) NOT VALID',
      );
      await expect(
        store.verify(u.id, 'GOOGLE', v.reference),
      ).rejects.toBeDefined();
      expect(await db.storePurchase.count({ where: { userId: u.id } })).toBe(0);
      expect(
        await db.subscription.count({
          where: { userId: u.id, planId: plans.BASIC.id },
        }),
      ).toBe(0);
      expect(google.acknowledge).not.toHaveBeenCalled();
    } finally {
      await owner.query(
        'ALTER TABLE public."QuotaLot" DROP CONSTRAINT IF EXISTS ttv_store_fault',
      );
      await owner.end();
    }
  });
  it('A13 failed password update rolls back token consumption and authVersion', async () => {
    const u = await newUser();
    mail.sendReset.mockClear();
    await auth.forgotPassword(u.email);
    const raw = mail.sendReset.mock.calls[0][1];
    const token = await db.passwordResetToken.findFirstOrThrow({
      where: { userId: u.id },
    });
    const owner = await guard.verifiedClient(packet, 'cold', 'owner');
    try {
      await owner.query(
        'ALTER TABLE public."User" ADD CONSTRAINT ttv_reset_fault CHECK ("authVersion" = 0) NOT VALID',
      );
      await expect(
        auth.resetPassword(raw, 'SyntheticNew8!'),
      ).rejects.toBeDefined();
      expect(
        (
          await db.passwordResetToken.findUniqueOrThrow({
            where: { id: token.id },
          })
        ).usedAt,
      ).toBeNull();
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: u.id } })).authVersion,
      ).toBe(0);
      await expect(
        auth.login({ identifier: u.email, password: pass }),
      ).resolves.toHaveProperty('accessToken');
    } finally {
      await owner.query(
        'ALTER TABLE public."User" DROP CONSTRAINT IF EXISTS ttv_reset_fault',
      );
      await owner.end();
    }
  });
  it('A11 AI failure cannot consume quota or create Usage', async () => {
    const u = await newUser(),
      project = await db.project.create({
        data: { userId: u.id, name: 'Synthetic failure' },
      });
    const bad = new Tts(
      db,
      new Audio(db),
      {
        synthesize: async () => {
          throw new Error('SYNTHETIC_AI_FAILURE');
        },
      },
      new Workload(new ConfigService()),
    );
    await expect(
      bad.synthesize(
        {
          projectId: project.id,
          text: 'Test',
          language: 'vi',
          character: 'adult_male',
          tone: 'neutral',
          emotion: 'natural',
          style: 'conversation',
          region: 'north_vietnam',
          speed: 1,
        },
        u.id,
      ),
    ).rejects.toBeDefined();
    expect(await db.usage.count({ where: { userId: u.id } })).toBe(0);
    const rows = await read(
      'SELECT q."charactersRemaining" FROM "QuotaLot" q JOIN "Subscription" s ON s.id=q."subscriptionId" WHERE s."userId"=$1',
      [u.id],
    );
    expect(rows[0].charactersRemaining).toBe(5000);
  });
});
