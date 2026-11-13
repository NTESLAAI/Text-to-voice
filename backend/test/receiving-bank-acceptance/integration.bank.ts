/* Synthetic bank acceptance; no AppModule, dotenv, external AI/payment/SMTP. */
import 'reflect-metadata';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
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
import { ReceivingBankAccountService } from '../../src/payment/receiving-bank-account.service';
import { PaymentSurplusController } from '../../src/payment-surplus/payment-surplus.controller';
import { PaymentSurplusService } from '../../src/payment-surplus/payment-surplus.service';
const g = require('./guard.cjs'),
  legacy = require('./legacy.cjs'),
  p = (globalThis as any).__rcPacket,
  root = dirname(p.manifest.dataDirectory);
g.validate(p);
describe('Receiving bank acceptance', () => {
  let db: any,
    reader: any,
    owner: any,
    control: any,
    app: any,
    jwt: JwtService,
    base: string,
    config: ConfigService;
  let manual: any,
    manual2: any,
    sepay: any,
    inactive: any,
    admin: any,
    freePlan: any,
    paidPlan: any;
  const baseline = JSON.parse(
    readFileSync(join(root, 'legacy-baseline.json'), 'utf8'),
  );
  const evidence: any[] = [],
    locks: any[] = [],
    fixtures: any[] = [],
    processes: any[] = [];
  const secret = randomBytes(32).toString('hex'),
    hookSecret = randomBytes(32).toString('hex');
  let sequence = 900000,
    halted = false;
  let lastHttpStatus: number | null = null;
  let lastResponseCode: string | null = null;
  async function read(sql: string, args: any[] = []) {
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      return (await reader.query(sql, args)).rows;
    } finally {
      await reader.query('ROLLBACK');
    }
  }
  function done(id: string, variants: string[] = []) {
    evidence.push({ id, status: 'PASS', variants });
  }
  async function account(
    label: string,
    policy = 'MANUAL_ALLOWED',
    active = true,
  ) {
    const a = await db.receivingBankAccount.create({
      data: {
        code: 'synthetic-' + label,
        bankCode: 'syntheticbank',
        accountNumber: '000' + String(++sequence),
        accountName: 'Synthetic only',
        policy,
      },
    });
    if (active)
      return db.receivingBankAccount.update({
        where: { id: a.id },
        data: { isActive: true },
      });
    return a;
  }
  async function fixture(label: string, a = manual, amount = 100) {
    const u = await db.user.create({
      data: { email: randomUUID() + '@example.invalid' },
    });
    await db.subscription.create({
      data: {
        userId: u.id,
        planId: freePlan.id,
        status: 'ACTIVE',
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        characterLimit: 17,
        quotaLots: {
          create: {
            charactersGranted: 17,
            charactersRemaining: 17,
            expiresAt: new Date(Date.now() + 86400000),
          },
        },
      },
    });
    const payment = await db.payment.create({
      data: {
        userId: u.id,
        planId: paidPlan.id,
        receivingBankAccountId: a.id,
        provider: 'BANK_TRANSFER',
        status: 'PENDING',
        amount,
        currency: 'VND',
        paymentType: 'NEW_PURCHASE',
        planPriceSnapshot: 100,
        effectivePlanPriceSnapshot: '100',
        planCharacterLimitSnapshot: 173,
        planDurationDaysSnapshot: 7,
        transferCode:
          'KH-' +
          (++sequence)
            .toString(7)
            .split('')
            .map((x) => String(Number(x) + 2))
            .join('')
            .padStart(8, '2'),
      },
    });
    const f = {
      label,
      userId: u.id,
      paymentId: payment.id,
      accountId: a.id,
      transferCode: payment.transferCode,
    };
    fixtures.push(f);
    return f;
  }
  async function auth() {
    return (
      'Bearer ' +
      (await jwt.signAsync({
        sub: admin.id,
        email: admin.email,
        authVersion: admin.authVersion,
      }))
    );
  }
  async function post(url: string, body: any = {}) {
    const response = await request(base)
      .post(url)
      .set('Authorization', await auth())
      .send(body);
    lastHttpStatus = response.status;
    const allowed = [
      'PAYMENT_ACTIVATION_FAILED',
      'PAYMENT_UNDERFUNDED',
      'RECEIPT_SOURCE_VERIFICATION_REQUIRED',
      'RECEIVING_ACCOUNT_UNKNOWN',
    ];
    lastResponseCode = allowed.includes(response.body?.code)
      ? response.body.code
      : null;
    return response;
  }
  function dto(a = manual, key: string = randomUUID(), amount = 140) {
    return {
      receivingBankAccountId: a.id,
      providerTransactionId: key,
      amount,
      currency: 'VND',
      receivedAt: '2026-01-01T00:00:00.000Z',
      reference: 'Synthetic only',
      note: 'Synthetic only',
    };
  }
  async function record(a = manual, key: string = randomUUID(), amount = 140) {
    const r = await post('/payment/admin/transactions', dto(a, key, amount));
    expect(r.status).toBe(201);
    return r.body;
  }
  async function link(r: any, f: any) {
    return post(`/payment/admin/transactions/${r.id}/link`, {
      paymentId: f.paymentId,
    });
  }
  async function verify(r: any) {
    return post(`/payment/admin/transactions/${r.id}/confirm-received`, {
      evidenceReference: 'synthetic-statement-row',
    });
  }
  async function reconcile(r: any) {
    return post(`/payment/admin/transactions/${r.id}/reconcile`);
  }
  async function prepare(f: any, a = manual, amount = 140) {
    const r = await record(a, randomUUID(), amount);
    expect((await link(r, f)).status).toBe(201);
    expect((await verify(r)).status).toBe(201);
    return r;
  }
  async function receiptAudit(id: string) {
    return (
      await read(
        'SELECT row_to_json(r)::text AS value FROM public."PaymentTransaction" r WHERE id=$1',
        [id],
      )
    )[0].value;
  }
  async function state(f: any) {
    const rows: any = {};
    for (const t of ['Subscription', 'QuotaLot', 'Usage', 'Payment']) {
      const where =
        t === 'QuotaLot'
          ? '"subscriptionId" IN (SELECT id FROM public."Subscription" WHERE "userId"=$1)'
          : '"userId"=$1';
      rows[t] = await read(
        `SELECT row_to_json(t)::text AS value FROM public."${t}" t WHERE ${where} ORDER BY id`,
        [f.userId],
      );
    }
    return rows;
  }
  async function benefits(f: any, paid: boolean) {
    const r = await read(
      'SELECT s.status,pl.code,count(q.id)::integer AS lots,COALESCE(sum(q."charactersGranted"),0)::integer AS granted,COALESCE(sum(q."charactersRemaining"),0)::integer AS remaining FROM public."Subscription" s JOIN public."Plan" pl ON pl.id=s."planId" LEFT JOIN public."QuotaLot" q ON q."subscriptionId"=s.id WHERE s."userId"=$1 GROUP BY s.id,pl.code ORDER BY pl.code',
      [f.userId],
    );
    const b = r.filter((x) => x.code === 'BASIC');
    expect(b).toHaveLength(paid ? 1 : 0);
    if (paid)
      expect(b[0]).toEqual(
        expect.objectContaining({
          status: 'ACTIVE',
          lots: 1,
          granted: 173,
          remaining: 173,
        }),
      );
    else
      expect(r).toEqual([
        expect.objectContaining({
          code: 'FREE',
          status: 'ACTIVE',
          lots: 1,
          remaining: 17,
        }),
      ]);
    expect(
      (
        await read(
          'SELECT count(*)::integer AS n FROM public."Usage" WHERE "userId"=$1',
          [f.userId],
        )
      )[0].n,
    ).toBe(0);
  }
  async function sqlRefused(sql: string, args: any[] = [], client = control) {
    let code = '';
    await client.query('BEGIN');
    try {
      await client.query(sql, args);
    } catch (e) {
      code = (e as any).code;
    } finally {
      await client.query('ROLLBACK');
    }
    expect(['23514', '23505', '42501']).toContain(code);
    return code;
  }
  async function waitFor(pid: number, n: number) {
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      const rows = (
        await control.query(
          "SELECT pid,application_name,pg_catalog.pg_blocking_pids(pid) AS blockers FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND usename=current_user AND application_name LIKE $1 AND wait_event_type='Lock'",
          ['ttv-bank:' + p.manifest.runId + ':writer%'],
        )
      ).rows;
      if (rows.length >= n && rows.some((r: any) => r.blockers.includes(pid)))
        return rows;
      await delay(25);
    }
    throw Error('BANK_LOCK_NOT_OBSERVED');
  }
  async function compete(
    id: string,
    f: any,
    jobs: Array<() => PromiseLike<any>>,
  ) {
    const hold = await g.verifiedClient(p, 'writer');
    let pending: Promise<any[]> | undefined;
    try {
      await hold.query('BEGIN');
      await hold.query(
        'SELECT id FROM public."Payment" WHERE id=$1 FOR UPDATE',
        [f.paymentId],
      );
      const pid = (await hold.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      pending = Promise.all(jobs.map((j) => Promise.resolve().then(j)));
      const rows = await waitFor(pid, jobs.length);
      locks.push({ id, holderPid: pid, waiters: rows });
      await hold.query('ROLLBACK');
      return await pending!;
    } finally {
      await hold.query('ROLLBACK').catch(() => {});
      await hold.end();
      if (pending) await pending;
    }
  }
  function child(a: any, key: string) {
    let childPid = 0;
    const result = new Promise<any>((resolve, reject) => {
      let out = '',
        err = '',
        settled = false;
      const c = spawn(
        process.execPath,
        [join(__dirname, 'process-worker.cjs'), a.id, key],
        {
          cwd: join(__dirname, '../..'),
          env: g.osEnvironment(),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        },
      );
      childPid = c.pid!;
      const timer = setTimeout(() => {
        c.kill();
        finish(Error('BANK_PROCESS_TIMEOUT'));
      }, 20000);
      function finish(e?: Error, v?: any) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (e) reject(e);
        else resolve(v);
      }
      c.stdout.on('data', (b) => {
        out += b;
        if (out.length > 4096) {
          c.kill();
          finish(Error('BANK_PROCESS_OUTPUT_LIMIT'));
        }
      });
      c.stderr.on('data', (b) => {
        err += b;
        if (err.length > 1e6) {
          c.kill();
          finish(Error('BANK_PROCESS_OUTPUT_LIMIT'));
        }
      });
      c.on('error', () => finish(Error('BANK_PROCESS_START_FAILED')));
      c.on('close', (code) => {
        try {
          const r = JSON.parse(out);
          if (
            code !== 0 ||
            !['RECORDED', 'REFUSED'].includes(r.status) ||
            r.processId !== childPid
          )
            throw Error();
          finish(undefined, r);
        } catch {
          finish(Error('BANK_PROCESS_FAILED'));
        }
      });
      for (const s of [c.stdin, c.stdio[3]] as any[]) {
        s.on('error', () => {});
        s.end(JSON.stringify(p));
      }
    });
    return { pid: childPid, result };
  }
  async function multi(id: string, accounts: any[], key: string) {
    const hold = await g.verifiedClient(p, 'writer');
    let pending: Promise<any[]> | undefined;
    try {
      await hold.query('BEGIN');
      await hold.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'BANK_TRANSFER:' + key,
      ]);
      const pid = (await hold.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      const jobs = accounts.map((a) => child(a, key));
      expect(new Set(jobs.map((j) => j.pid)).size).toBe(2);
      pending = Promise.all(jobs.map((j) => j.result));
      const waiters = await waitFor(pid, 2);
      for (const j of jobs)
        expect(
          waiters.some((w: any) =>
            w.application_name.endsWith('node-' + j.pid),
          ),
        ).toBe(true);
      locks.push({
        id,
        holderPid: pid,
        waiters,
        processIds: jobs.map((j) => j.pid),
      });
      await hold.query('ROLLBACK');
      const r = await pending;
      processes.push({ id, results: r });
      return r;
    } finally {
      await hold.query('ROLLBACK').catch(() => {});
      await hold.end();
      if (pending) await pending;
    }
  }
  async function hook(f: any, id = ++sequence, amount = 140) {
    const body = {
      id,
      gateway: 'syntheticbank',
      accountNumber: sepay.accountNumber,
      transferType: 'in',
      transferAmount: amount,
      currency: 'VND',
      transactionDate: '2026-01-01 00:00:00',
      accumulated: 0,
      code: f.transferCode,
      content: f.transferCode,
      referenceCode: 'NOT_A_UNIQUE_KEY',
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
          createHmac('sha256', hookSecret)
            .update(ts + '.')
            .update(raw)
            .digest('hex'),
      )
      .send(raw);
  }
  const scenario = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (halted) throw Error('BANK_STOPPED_AFTER_FAILURE');
      lastHttpStatus = null;
      lastResponseCode = null;
      try {
        await fn();
      } catch (e) {
        halted = true;
        const caseId = /^(BANK\d{2})\b/.exec(name)?.[1];
        if (g.IDS.includes(caseId))
          writeFileSync(
            join(root, 'failure-diagnostic.json'),
            JSON.stringify({
              status: 'UNKNOWN',
              readiness: 'NOT_READY',
              caseId,
              code: 'BANK_ASSERTION_OR_EXECUTION_FAILED',
              lastHttpStatus,
              lastResponseCode,
            }),
            { flag: 'wx' },
          );
        throw e;
      }
    });
  beforeAll(async () => {
    reader = await g.verifiedClient(p, 'reader');
    owner = await g.verifiedClient(p, 'owner');
    control = await g.verifiedClient(p, 'writer');
    await legacy.compare(reader, baseline);
    const { Pool } = await import('pg'),
      { PrismaPg } = await import('@prisma/adapter-pg'),
      { PrismaClient } = await import('../../generated/prisma/client.js');
    db = new PrismaClient({
      adapter: new PrismaPg(
        new Pool({ ...g.connection(p, 'writer'), max: 10 }),
      ),
      transactionOptions: { maxWait: 15000, timeout: 20000 },
    });
    await db.$connect();
    admin = await db.user.findUniqueOrThrow({ where: { id: baseline.admin } });
    freePlan = await db.plan.findUniqueOrThrow({
      where: { id: baseline.freePlan },
    });
    paidPlan = await db.plan.findUniqueOrThrow({
      where: { id: baseline.paidPlan },
    });
    manual = await account('manual');
    manual2 = await account('manual2');
    sepay = await account('sepay', 'SEPAY_PRIMARY');
    inactive = await account('inactive', 'MANUAL_ALLOWED', false);
    const payment = new PaymentService(db),
      configValues = {
        JWT_SECRET: secret,
        SEPAY_WEBHOOK_SECRET: hookSecret,
        SEPAY_RECEIVING_BANK_ACCOUNT_ID: sepay.id,
        BANK_TRANSFER_ACCOUNT_NUMBER: sepay.accountNumber,
        SEPAY_WEBHOOK_GATEWAY: 'syntheticbank',
      };
    config = new ConfigService(configValues);
    jwt = new JwtService({ secret, signOptions: { expiresIn: '5m' } });
    const mod = await Test.createTestingModule({
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({ secret }),
      ],
      controllers: [PaymentController, PaymentSurplusController],
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
        {
          provide: PaymentSurplusService,
          useValue: new PaymentSurplusService(db),
        },
      ],
    }).compile();
    app = mod.createNestApplication({ logger: false, rawBody: true });
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

  scenario(
    'BANK01 cold install and legacy upgrade preserve old-column snapshots',
    async () => {
      const cold = JSON.parse(
        readFileSync(join(root, 'cold-manifest.json'), 'utf8'),
      );
      const c = await g.verifiedClient({ ...p, manifest: cold }, 'reader');
      try {
        expect(
          (
            await c.query(
              'SELECT count(*)::integer AS n FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL',
            )
          ).rows[0].n,
        ).toBe(29);
        expect(
          (await c.query('SELECT count(*)::integer AS n FROM public."User"'))
            .rows[0].n,
        ).toBe(0);
      } finally {
        await c.end();
      }
      await legacy.compare(reader, baseline);
      done('BANK01', ['COLD_29', 'UPGRADE_29', 'LEGACY_UNCHANGED']);
    },
  );
  scenario('BANK02 migration-one rollout fence blocks old writes', async () => {
    const r = JSON.parse(readFileSync(join(root, 'expand-fence.json'), 'utf8'));
    expect(r.status).toBe('VERIFIED');
    expect(r.results.map((x: any) => x.step)).toEqual([
      'INSERT_PAYMENT',
      'UPDATE_RECEIPT',
      'DELETE_RECEIPT',
    ]);
    expect(r.results.every((x: any) => x.sqlstate === '23514')).toBe(true);
    done(
      'BANK02',
      r.results.map((x: any) => x.step),
    );
  });
  scenario(
    'BANK03 account identity, policy, cutoff and initial inactive are immutable',
    async () => {
      expect(inactive.isActive).toBe(false);
      for (const sql of [
        'UPDATE public."ReceivingBankAccount" SET policy=\'SEPAY_PRIMARY\' WHERE id=$1',
        'UPDATE public."ReceivingBankAccount" SET "accountNumber"=\'different\' WHERE id=$1',
        'DELETE FROM public."ReceivingBankAccount" WHERE id=$1',
      ])
        await sqlRefused(sql, [manual.id]);
      await sqlRefused(
        'INSERT INTO public."ReceivingBankAccount" (id,code,"bankCode","accountNumber","accountName",policy,"isActive","updatedAt") VALUES ($1,$2,\'syntheticbank\',$3,\'Synthetic\',\'MANUAL_ALLOWED\',true,now())',
        [randomUUID(), randomUUID(), String(++sequence)],
      );
      done('BANK03', ['POLICY', 'ACCOUNT_NUMBER', 'DELETE', 'START_INACTIVE']);
    },
  );
  scenario(
    'BANK04 new Payment binds registry and refuses missing or conflicting configuration',
    async () => {
      const user = await db.user.create({
        data: { email: randomUUID() + '@example.invalid' },
      });
      await db.subscription.create({
        data: {
          userId: user.id,
          planId: freePlan.id,
          status: 'ACTIVE',
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
          characterLimit: 17,
          quotaLots: {
            create: {
              charactersGranted: 17,
              charactersRemaining: 17,
              expiresAt: new Date(Date.now() + 86400000),
            },
          },
        },
      });
      const svc = new ReceivingBankAccountService(db);
      delete process.env.RECEIVING_BANK_ACCOUNT_ID;
      await expect(
        svc.createPayment({
          userId: user.id,
          planId: paidPlan.id,
          provider: 'BANK_TRANSFER',
          status: 'PENDING',
          amount: 100,
          currency: 'VND',
        }),
      ).rejects.toThrow('RECEIVING_ACCOUNT_NOT_CONFIGURED');
      process.env.RECEIVING_BANK_ACCOUNT_ID = manual.id;
      const payment = await svc.createPayment({
        userId: user.id,
        planId: paidPlan.id,
        provider: 'BANK_TRANSFER',
        status: 'PENDING',
        amount: 100,
        currency: 'VND',
      });
      expect(payment.receivingBankAccountId).toBe(manual.id);
      process.env.RECEIVING_BANK_ACCOUNT_ID = inactive.id;
      await expect(
        svc.createPayment({
          userId: user.id,
          planId: paidPlan.id,
          provider: 'BANK_TRANSFER',
          status: 'PENDING',
          amount: 100,
          currency: 'VND',
        }),
      ).rejects.toThrow('BANK_ACCOUNT_INACTIVE');
      delete process.env.RECEIVING_BANK_ACCOUNT_ID;
      done('BANK04', ['MISSING_CONFIG', 'MANUAL_BOUND', 'INACTIVE']);
    },
  );
  scenario(
    'BANK05 manual entry obeys policy and rejects client verification fields',
    async () => {
      for (const a of [sepay, inactive, { id: randomUUID() }]) {
        const r = await post('/payment/admin/transactions', dto(a));
        expect(r.status).toBe(409);
      }
      expect(
        (
          await post('/payment/admin/transactions', {
            ...dto(),
            verificationSource: 'MANUAL_ADMIN',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post('/payment/admin/transactions', {
            ...dto(),
            policy: 'MANUAL_ALLOWED',
          })
        ).status,
      ).toBe(400);
      done('BANK05', [
        'SEPAY_PRIMARY',
        'INACTIVE',
        'UNKNOWN',
        'FAKE_PROOF',
        'FAKE_POLICY',
      ]);
    },
  );
  scenario(
    'BANK06 manual source proof, link account and currency are guarded',
    async () => {
      const f = await fixture('BANK06'),
        r = await record(manual);
      const wrong = await fixture('BANK06_WRONG', manual2);
      expect((await link(r, wrong)).status).toBe(409);
      expect((await link(r, f)).status).toBe(201);
      expect(
        (await post(`/payment/admin/transactions/${r.id}/confirm-received`, {}))
          .status,
      ).toBe(400);
      expect((await verify(r)).status).toBe(201);
      const row = JSON.parse(await receiptAudit(r.id));
      expect(row.verificationSource).toBe('MANUAL_ADMIN');
      expect(row.sourceVerifiedById).toBe(admin.id);
      expect(row.verificationReference).toBe('synthetic-statement-row');
      const activation = await reconcile(r);
      expect(activation.status).toBe(201);
      expect(activation.body.activationStatus).toBe('ACTIVATED');
      await benefits(f, true);
      done('BANK06', ['ACCOUNT_MISMATCH', 'EVIDENCE_REQUIRED', 'ADMIN_AUDIT']);
    },
  );
  scenario(
    'BANK07 two Node processes same account and key create one receipt',
    async () => {
      const r = await multi('BANK07', [manual, manual], 'SYNTHETIC_MP_SAME');
      expect(r.map((x) => x.status)).toEqual(['RECORDED', 'RECORDED']);
      expect(r[0].receiptId).toBe(r[1].receiptId);
      done('BANK07');
    },
  );
  scenario(
    'BANK08 two Node processes different accounts may share an external ID',
    async () => {
      const r = await multi(
        'BANK08',
        [manual, manual2],
        'SYNTHETIC_MP_DIFFERENT',
      );
      expect(r.map((x) => x.status)).toEqual(['RECORDED', 'RECORDED']);
      expect(r[0].receiptId).not.toBe(r[1].receiptId);
      done('BANK08');
    },
  );
  scenario(
    'BANK09 two Node processes cannot recount a legacy bank ID',
    async () => {
      const key = baseline.payments[0].key,
        r = await multi('BANK09', [manual, manual2], key);
      expect(
        r.every(
          (x) =>
            x.status === 'REFUSED' &&
            x.code === 'LEGACY_RECEIPT_REVIEW_REQUIRED',
        ),
      ).toBe(true);
      expect(
        (
          await read(
            'SELECT count(*)::integer AS n FROM public."PaymentTransaction" WHERE provider=\'BANK_TRANSFER\' AND "providerTransactionId"=$1',
            [key],
          )
        )[0].n,
      ).toBe(1);
      done('BANK09');
    },
  );
  scenario(
    'BANK10 SePay receipt is counted once and referenceCode is not unique',
    async () => {
      const f = await fixture('BANK10', sepay),
        id = ++sequence;
      expect((await hook(f, id)).status).toBe(201);
      const r = (
        await read(
          'SELECT id FROM public."PaymentTransaction" WHERE provider=\'SEPAY\' AND "providerTransactionId"=$1',
          [String(id)],
        )
      )[0];
      const before = await receiptAudit(r.id);
      expect((await hook(f, id)).body.duplicate).toBe(true);
      expect(await receiptAudit(r.id)).toBe(before);
      await benefits(f, true);
      const q = await fixture('BANK10_REFERENCE', sepay);
      expect((await hook(q, ++sequence)).status).toBe(201);
      await benefits(q, true);
      const otherAccount = await account('sepay-unique', 'SEPAY_PRIMARY');
      const otherPayment = await fixture('BANK10_GLOBAL_KEY', otherAccount);
      const duplicate = await sqlRefused(
        'INSERT INTO public."PaymentTransaction" (id,"paymentId",provider,"providerTransactionId","receivingBankAccountId",amount,currency,status,"verificationSource","sourceVerifiedAt","updatedAt") VALUES ($1,$2,\'SEPAY\',$3,$4,140,\'VND\',\'UNMATCHED\',\'SEPAY_WEBHOOK\',now(),now())',
        [randomUUID(), otherPayment.paymentId, String(id), otherAccount.id],
      );
      expect(duplicate).toBe('23505');
      done('BANK10', [
        'REPLAY',
        'SAME_REFERENCE_DIFFERENT_IDS',
        'SEPAY_GLOBAL_ID_DIFFERENT_ACCOUNTS',
      ]);
    },
  );
  scenario(
    'BANK11 inactive serializes against source verification; new funds fail closed',
    async () => {
      const a = await account('cutoff'),
        f = await fixture('BANK11', a),
        r = await record(a);
      expect((await link(r, f)).status).toBe(201);
      const hold = await g.verifiedClient(p, 'writer');
      let pending: Promise<any> | undefined;
      try {
        await hold.query('BEGIN');
        await hold.query(
          'SELECT id FROM public."ReceivingBankAccount" WHERE id=$1 FOR UPDATE',
          [a.id],
        );
        const pid = (await hold.query('SELECT pg_backend_pid() AS pid')).rows[0]
          .pid;
        pending = Promise.resolve(verify(r));
        const waiters = await waitFor(pid, 1);
        await hold.query(
          'UPDATE public."ReceivingBankAccount" SET "isActive"=false,"updatedAt"=now() WHERE id=$1',
          [a.id],
        );
        await hold.query('COMMIT');
        expect((await pending).status).toBe(409);
        locks.push({ id: 'BANK11', holderPid: pid, waiters });
      } finally {
        await hold.query('ROLLBACK').catch(() => {});
        await hold.end();
        if (pending) await pending;
      }
      expect((await post('/payment/admin/transactions', dto(a))).status).toBe(
        409,
      );
      await sqlRefused(
        'UPDATE public."ReceivingBankAccount" SET "isActive"=true WHERE id=$1',
        [a.id],
      );
      await benefits(f, false);
      done('BANK11');
    },
  );
  scenario(
    'BANK12 prior verified receipt completes after inactive without source rewrite',
    async () => {
      const a = await account('prior'),
        f = await fixture('BANK12', a),
        r = await prepare(f, a);
      const before = await receiptAudit(r.id);
      await new ReceivingBankAccountService(db).deactivate(a.id);
      const result = await reconcile(r);
      expect(result.body.activationStatus).toBe('ACTIVATED');
      const stable = await receiptAudit(r.id);
      expect(JSON.parse(stable).sourceVerifiedAt).toBe(
        JSON.parse(before).sourceVerifiedAt,
      );
      expect((await reconcile(r)).body.activationStatus).toBe(
        'ALREADY_ACTIVATED',
      );
      expect(await receiptAudit(r.id)).toBe(stable);
      await benefits(f, true);
      done('BANK12');
    },
  );
  scenario(
    'BANK13 signed webhook replay competes with reconcile under a real Payment lock',
    async () => {
      const f = await fixture(
        'BANK13',
        sepay,
      ); /* Retain a committed MATCHED receipt while activation rolls back at a fixture constraint. */
      const id = ++sequence;
      await owner.query(
        'ALTER TABLE public."Payment" ADD CONSTRAINT bank_confirm_fault CHECK (id<>\'' +
          f.paymentId +
          "' OR status<>'PAID')",
      );
      expect((await hook(f, id)).status).toBe(500);
      await owner.query(
        'ALTER TABLE public."Payment" DROP CONSTRAINT bank_confirm_fault',
      );
      const r = (
          await read(
            'SELECT id FROM public."PaymentTransaction" WHERE provider=\'SEPAY\' AND "providerTransactionId"=$1',
            [String(id)],
          )
        )[0],
        before = await receiptAudit(r.id);
      const results = await compete('BANK13', f, [
        () => reconcile(r),
        () => hook(f, id),
      ]);
      expect(results.map((x) => x.status)).toEqual([201, 201]);
      expect(await receiptAudit(r.id)).toBe(before);
      await benefits(f, true);
      done('BANK13');
    },
  );
  scenario(
    'BANK14 direct confirmation rejects legacy and unverified receipt sources',
    async () => {
      for (const old of baseline.payments.filter(
        (x: any) => x.status === 'PENDING',
      ))
        expect((await post(`/payment/${old.id}/confirm`)).status).toBe(409);
      const f = await fixture('BANK14'),
        r = await record();
      expect((await link(r, f)).status).toBe(201);
      expect((await post(`/payment/${f.paymentId}/confirm`)).status).toBe(400);
      await benefits(f, false);
      done('BANK14');
    },
  );
  scenario(
    'BANK15 surplus keeps legacy totals UNKNOWN; cancel remains available',
    async () => {
      const old = baseline.payments.find(
        (x: any) => x.status === 'PAID' && x.receiptStatus === 'MATCHED',
      );
      const url = `/admin/payments/${old.id}/surplus`;
      const report = await request(base)
        .get(url)
        .set('Authorization', await auth());
      expect(report.body.totalSurplus).toBe('40');
      expect(report.body.spendableAmount).toBeNull();
      expect(report.body.spendabilityStatus).toBe('UNKNOWN');
      expect(
        (
          await request(base)
            .post(url + '/handlings')
            .set('Authorization', await auth())
            .set('Idempotency-Key', randomUUID())
            .send({ action: 'CREDIT', amount: '1', note: 'Synthetic' })
        ).status,
      ).toBe(409);
      expect(
        (
          await post(url + `/handlings/${baseline.pendingHandling}/complete`, {
            confirmation: 'Synthetic',
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await post(url + `/handlings/${baseline.pendingHandling}/cancel`, {
            note: 'Synthetic cancellation',
          })
        ).status,
      ).toBe(201);
      const f = await fixture('BANK15_VALID'),
        r = await prepare(f);
      expect((await reconcile(r)).status).toBe(201);
      const h = await request(base)
        .post(`/admin/payments/${f.paymentId}/surplus/handlings`)
        .set('Authorization', await auth())
        .set('Idempotency-Key', randomUUID())
        .send({
          action: 'CREDIT',
          amount: '20.000001',
          note: 'Synthetic credit',
        });
      expect(h.status).toBe(201);
      expect(
        (
          await post(
            `/admin/payments/${f.paymentId}/surplus/handlings/${h.body.id}/complete`,
            { confirmation: 'Synthetic manual confirmation' },
          )
        ).status,
      ).toBe(201);
      await benefits(f, true);
      done('BANK15', [
        'LEGACY_READ',
        'CREATE_BLOCKED',
        'COMPLETE_BLOCKED',
        'CANCEL_ALLOWED',
        'VERIFIED_CREDIT',
      ]);
    },
  );
  scenario(
    'BANK16 activation rollback after receipt commit and safe retry preserve audit',
    async () => {
      const f = await fixture('BANK16'),
        r = await prepare(f),
        before = await state(f);
      await owner.query(
        'ALTER TABLE public."QuotaLot" ADD CONSTRAINT bank_quota_fault CHECK ("charactersGranted"<>173) NOT VALID',
      );
      const failed = await reconcile(r);
      expect(failed.status).toBe(500);
      expect(failed.body.receiptStatus).toBe('MATCHED');
      expect(failed.body.activationStatus).toBe('FAILED');
      expect(await state(f)).toEqual(before);
      const audit = await receiptAudit(r.id);
      await owner.query(
        'ALTER TABLE public."QuotaLot" DROP CONSTRAINT bank_quota_fault',
      );
      expect((await reconcile(r)).body.activationStatus).toBe('ACTIVATED');
      expect((await reconcile(r)).body.activationStatus).toBe(
        'ALREADY_ACTIVATED',
      );
      expect(await receiptAudit(r.id)).toBe(audit);
      await benefits(f, true);
      done('BANK16');
    },
  );
  scenario(
    'BANK17 final DB guards reject old writer identities and mutations',
    async () => {
      const old = baseline.payments[0];
      await sqlRefused(
        'UPDATE public."PaymentTransaction" SET status=\'MATCHED\' WHERE id=$1',
        [old.receiptId],
      );
      await sqlRefused('DELETE FROM public."PaymentTransaction" WHERE id=$1', [
        old.receiptId,
      ]);
      await sqlRefused(
        'INSERT INTO public."PaymentTransaction" (id,provider,"providerTransactionId",amount,status,"updatedAt") VALUES ($1,\'BANK_TRANSFER\',$2,10,\'UNMATCHED\',now())',
        [randomUUID(), randomUUID()],
      );
      const r = await record();
      await sqlRefused(
        'UPDATE public."PaymentTransaction" SET "receivingBankAccountId"=$2 WHERE id=$1',
        [r.id, manual2.id],
      );
      await sqlRefused(
        'ALTER TABLE public."PaymentTransaction" DISABLE TRIGGER ALL',
      );
      done('BANK17', [
        'LEGACY_UPDATE',
        'LEGACY_DELETE',
        'NULL_INSERT',
        'IDENTITY_MUTATION',
        'NO_DDL',
      ]);
    },
  );
  scenario(
    'BANK18 reader validates legacy, unique indexes, audit, balances and all required evidence',
    async () => {
      const verified = await g.verifiedClient(p, 'reader');
      await verified.end();
      await legacy.compare(reader, baseline, true);
      expect(evidence.map((x) => x.id)).toEqual(g.IDS.slice(0, 17));
      for (const id of ['BANK07', 'BANK08', 'BANK09', 'BANK11', 'BANK13'])
        expect(locks.some((x) => x.id === id)).toBe(true);
      expect(processes).toHaveLength(3);
      for (const t of ['Usage', 'StorePurchase', 'StoreCycle'])
        expect(
          (
            await read('SELECT count(*)::integer AS n FROM public."' + t + '"')
          )[0].n,
        ).toBe(0);
      const duplicates = await read(
        'SELECT count(*)::integer AS n FROM (SELECT provider,"receivingBankAccountId","providerTransactionId" FROM public."PaymentTransaction" WHERE "providerTransactionId" IS NOT NULL GROUP BY provider,"receivingBankAccountId","providerTransactionId" HAVING count(*)>1) d',
      );
      expect(duplicates[0].n).toBe(0);
      const indexes = await read(
        'SELECT c.relname,i.indisunique,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) AS definition FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid WHERE c.relname=ANY($1::text[])',
        [
          [
            'PaymentTransaction_nonmanual_provider_key',
            'PaymentTransaction_manual_account_key',
            'PaymentTransaction_manual_legacy_key',
          ],
        ],
      );
      expect(indexes).toHaveLength(3);
      expect(
        indexes.every((x) => x.indisunique && x.indisvalid && x.indisready),
      ).toBe(true);
      const nonmanual = indexes.find(
        (x) => x.relname === 'PaymentTransaction_nonmanual_provider_key',
      )!.definition;
      expect(nonmanual).toContain('provider');
      expect(nonmanual).not.toContain('receivingBankAccountId');
      expect(
        indexes.find(
          (x) => x.relname === 'PaymentTransaction_manual_legacy_key',
        )!.definition,
      ).toContain('IS NULL');
      done('BANK18');
      writeFileSync(
        join(root, 'scenario-evidence.json'),
        JSON.stringify(
          {
            status: 'VERIFIED',
            readiness: 'NOT_READY',
            runId: p.manifest.runId,
            cases: evidence,
            locks,
            processes,
            fixtures,
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
    },
  );
});
