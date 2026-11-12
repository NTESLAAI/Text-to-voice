import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { PaymentSurplusModule } from '../src/payment-surplus/payment-surplus.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy/jwt.strategy';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
const { WRITE_CASES } = require('./payment-surplus-write-contract.cjs') as {
  WRITE_CASES: string[];
};
const writeMode = process.env.PAYMENT_SURPLUS_TEMP_WRITE_MODE === '1';

const APPROVED_TEST = Object.freeze({
  host: '127.0.0.1',
  port: '55432',
  cluster: '7703979600700924132',
  directory: 'd:/text-to-voice/pg-test-cluster',
});
const normalizePath = (value: string) =>
  value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

function parseWriterUrl(raw: string, name: string) {
  if (
    !/^postgres(?:ql)?:\/\/[^/?#\s]+@127\.0\.0\.1:55432\//.test(raw) ||
    /[\s\\]/.test(raw)
  )
    throw new Error('Invalid writer URL');
  const url = new URL(raw);
  if (
    !/^ttv_surplus_it_[a-f0-9]{32}$/.test(name) ||
    url.hostname !== APPROVED_TEST.host ||
    url.port !== APPROVED_TEST.port ||
    url.search ||
    url.hash ||
    url.pathname !== `/${name}` ||
    decodeURIComponent(url.username) !== 'ttv_surplus_writer' ||
    !url.password
  )
    throw new Error('Invalid writer URL');
  return url;
}

// Importing through the ordinary test suite must never connect to a database.
const configured = Boolean(
  process.env.PAYMENT_SURPLUS_TEMP_FIXTURES &&
  process.env.PAYMENT_SURPLUS_TEMP_READONLY_URL &&
  process.env.PAYMENT_SURPLUS_TEMP_TOKEN,
);
const suite = configured ? describe : describe.skip;

suite('Payment surplus — synthetic temporary database', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaClient | undefined;
  let apiPool: Pool | undefined;
  let observer: Pool | undefined;
  let control: Pool | undefined;
  let ready = false;
  let jwt: JwtService;
  let fixtures: {
    adminId: string;
    userId: string;
    paymentId: string;
    missingPaymentId: string;
    writePayments?: Record<string, string>;
  };
  const name = process.env.PAYMENT_SURPLUS_TEMP_NAME;
  const identitySql = `SELECT current_database() AS db,
    current_setting('default_transaction_read_only') AS session_ro,
    current_setting('transaction_read_only') AS tx_ro,
    current_user AS role, host(inet_server_addr()) AS address, inet_server_port()::text AS port,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT datdba::text FROM pg_database WHERE datname=current_database()) AS owner,
    (SELECT pg_catalog.shobj_description(oid,'pg_database') FROM pg_database
      WHERE datname=current_database()) AS marker`;

  function assertIdentity(row: Record<string, string>, writer = false) {
    if (
      !name ||
      !/^ttv_surplus_it_[a-f0-9]{32}$/.test(name) ||
      row.db !== name ||
      row.session_ro !== (writer ? 'off' : 'on') ||
      row.tx_ro !== (writer ? 'off' : 'on') ||
      row.oid !== process.env.PAYMENT_SURPLUS_TEMP_OID ||
      row.owner !== process.env.PAYMENT_SURPLUS_TEMP_OWNER_OID ||
      row.role !==
        (writer
          ? 'ttv_surplus_writer'
          : process.env.PAYMENT_SURPLUS_TEMP_READER_ROLE) ||
      row.address !== APPROVED_TEST.host ||
      row.port !== APPROVED_TEST.port ||
      row.marker !== `ttv-surplus-it:${process.env.PAYMENT_SURPLUS_TEMP_TOKEN}`
    ) {
      throw new Error(
        'Temporary database identity/read-only verification failed',
      );
    }
  }

  function assertWriter(row: Record<string, string>) {
    // Reuse every database/endpoint/marker check; writer additionally proves cluster identity.
    assertIdentity(row, true);
    if (
      row.role !== 'ttv_surplus_writer' ||
      row.session_role !== row.role ||
      row.role !== process.env.PAYMENT_SURPLUS_TEMP_WRITER_ROLE ||
      row.session_ro !== 'off' ||
      row.tx_ro !== 'off' ||
      row.cluster !== APPROVED_TEST.cluster ||
      normalizePath(row.directory ?? '') !== APPROVED_TEST.directory
    )
      throw new Error('Writer identity mismatch');
  }
  const writerIdentitySql = `${identitySql}, current_setting('data_directory') AS directory,
    session_user AS session_role, (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster`;

  async function checkWriterPool(pool: Pool, size: number) {
    const acquired = await Promise.allSettled(
      Array.from({ length: size }, () => pool.connect()),
    );
    const connections = acquired.flatMap((r) =>
      r.status === 'fulfilled' ? [r.value] : [],
    );
    try {
      if (connections.length !== size)
        throw new Error('Writer pool unverified');
      for (const c of connections)
        assertWriter((await c.query(writerIdentitySql)).rows[0]);
    } finally {
      connections.forEach((c) => c.release());
    }
  }

  async function checkPool(pool: Pool) {
    const acquisitions = await Promise.allSettled([
      pool.connect(),
      pool.connect(),
    ]);
    const connections = acquisitions.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    try {
      if (connections.length !== 2)
        throw new Error('Could not verify every pool session');
      for (const connection of connections)
        assertIdentity((await connection.query(identitySql)).rows[0]);
    } finally {
      connections.forEach((connection) => connection.release());
    }
  }

  function safeFailure(stage: string, error: unknown) {
    const details = error as { code?: unknown; message?: string };
    const code = details?.code;
    const reasons: Record<string, string> = {
      'Temporary database identity/read-only verification failed':
        'IDENTITY_READONLY_MISMATCH',
      'Could not verify every pool session': 'POOL_SESSIONS_UNVERIFIED',
      'Wrong temporary URL': 'INVALID_READER_URL',
      'Synthetic fixture identities missing': 'FIXTURE_IDENTITIES_MISSING',
      'Synthetic auth fixtures invalid': 'AUTH_FIXTURES_INVALID',
      'Synthetic fixture missing': 'PAYMENT_FIXTURE_MISSING',
      'Synthetic allocation exceeds surplus': 'REFERENCE_OVERALLOCATED',
    };
    return new Error(
      `${stage}; reason=${reasons[details?.message ?? ''] ?? 'OPERATION_FAILED'}; SQLSTATE=${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && !/^P\d{4}$/.test(code) ? code : 'unavailable'}; Prisma=${typeof code === 'string' && /^P\d{4}$/.test(code) ? code : 'unavailable'}`,
    );
  }

  function http() {
    if (!ready || !app)
      throw new Error('HTTP forbidden before read-only identity checks');
    return request(app.getHttpServer());
  }
  async function bearer(id: string) {
    return `Bearer ${await jwt.signAsync({ sub: id }, { expiresIn: '5m' })}`;
  }

  async function reference(paymentId = fixtures.paymentId) {
    const connection: PoolClient = await observer!.connect();
    try {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      assertIdentity((await connection.query(identitySql)).rows[0]);
      const totals = (
        await connection.query(
          `SELECT p."currency", p."amount"::text AS amount,
        COALESCE((SELECT SUM(t."amount"::text::numeric) FROM public."PaymentTransaction" t
          WHERE t."paymentId"=p."id" AND t."status"='MATCHED'
            AND t."currency"=p."currency"),0)::text AS matched,
        COALESCE((SELECT SUM(h."amount") FROM public."PaymentSurplusHandling" h
          WHERE h."paymentId"=p."id" AND h."status" IN ('PENDING','COMPLETED')
            AND h."currency"=p."currency"),0)::text AS allocated
        FROM public."Payment" p WHERE p."id"=$1`,
          [paymentId],
        )
      ).rows[0];
      if (!totals) throw new Error('Synthetic fixture missing');
      const rows = (
        await connection.query(
          `SELECT "id", "paymentId", "action", "status", "amount", "currency",
            "idempotencyKey", "creditRemainingAmount", "effectivePlanPriceSnapshot",
            "planCharacterLimitSnapshot", "planDurationDaysSnapshot", "convertedCharacters",
            "convertedSeconds", "note", "externalReference", "createdById", "completedById",
            "cancelledById", "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
            "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt",
            "completedAt" AT TIME ZONE 'UTC' AS "completedAt",
            "cancelledAt" AT TIME ZONE 'UTC' AS "cancelledAt"
          FROM public."PaymentSurplusHandling"
        WHERE "paymentId"=$1 ORDER BY "createdAt" DESC,"id" DESC`,
          [paymentId],
        )
      ).rows;
      const decimal = (value: string) => new Prisma.Decimal(value).toString();
      const surplus = Prisma.Decimal.max(
        0,
        new Prisma.Decimal(totals.matched).minus(totals.amount),
      );
      const allocated = new Prisma.Decimal(totals.allocated);
      if (allocated.greaterThan(surplus))
        throw new Error('Synthetic allocation exceeds surplus');
      const result = {
        paymentId,
        currency: totals.currency,
        totalMatched: decimal(totals.matched),
        totalSurplus: surplus.toString(),
        allocatedAmount: allocated.toString(),
        availableSurplus: surplus.minus(allocated).toString(),
        history: rows.map((row) => ({
          ...row,
          amount: decimal(row.amount),
          creditRemainingAmount: decimal(row.creditRemainingAmount),
          effectivePlanPriceSnapshot:
            row.effectivePlanPriceSnapshot === null
              ? null
              : decimal(row.effectivePlanPriceSnapshot),
          convertedSeconds: row.convertedSeconds?.toString() ?? null,
        })),
      };
      await connection.query('COMMIT');
      return JSON.parse(JSON.stringify(result));
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw safeFailure('reference-select', error);
    } finally {
      connection.release();
    }
  }

  beforeAll(async () => {
    try {
      const rawUrl = process.env.PAYMENT_SURPLUS_TEMP_READONLY_URL!;
      if (
        process.env.PAYMENT_SURPLUS_TEST_PORT !== APPROVED_TEST.port ||
        process.env.PAYMENT_SURPLUS_TEST_CLUSTER_ID !== APPROVED_TEST.cluster ||
        normalizePath(process.env.PAYMENT_SURPLUS_TEST_DATA_DIRECTORY ?? '') !==
          APPROVED_TEST.directory ||
        !/^postgres(?:ql)?:\/\/[^/?#\s]+@127\.0\.0\.1:55432\//.test(rawUrl) ||
        /[\s\\]/.test(rawUrl)
      )
        throw new Error('Wrong temporary URL');
      const url = new URL(rawUrl);
      if (
        !name ||
        !/^ttv_surplus_it_[a-f0-9]{32}$/.test(name) ||
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        url.hostname !== APPROVED_TEST.host ||
        url.port !== APPROVED_TEST.port ||
        url.search ||
        url.hash ||
        decodeURIComponent(url.username) !==
          process.env.PAYMENT_SURPLUS_TEMP_READER_ROLE ||
        decodeURIComponent(url.pathname) !== `/${name}`
      )
        throw new Error('Wrong temporary URL');
      fixtures = JSON.parse(process.env.PAYMENT_SURPLUS_TEMP_FIXTURES!);
      if (
        ![
          fixtures.adminId,
          fixtures.userId,
          fixtures.paymentId,
          fixtures.missingPaymentId,
        ].every((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))
      ) {
        throw new Error('Synthetic fixture identities missing');
      }
      const readOnlyOptions =
        '-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000';
      url.searchParams.set('options', readOnlyOptions);
      const poolConfig = {
        connectionString: url.toString(),
        options: readOnlyOptions,
        connectionTimeoutMillis: 10000,
        query_timeout: 20000,
        max: 2,
      };
      apiPool = new Pool(poolConfig);
      observer = new Pool(poolConfig);
      await checkPool(apiPool);
      await checkPool(observer);
      if (writeMode) {
        if (
          !fixtures.writePayments ||
          WRITE_CASES.some(
            (id) => !/^[a-f0-9-]{36}$/.test(fixtures.writePayments![id] ?? ''),
          ) ||
          new Set(Object.values(fixtures.writePayments)).size !==
            WRITE_CASES.length ||
          process.env.PAYMENT_SURPLUS_TEMP_WRITER_ROLE !== 'ttv_surplus_writer'
        )
          throw new Error('Invalid write fixtures');
        const writerUrl = parseWriterUrl(
          process.env.PAYMENT_SURPLUS_TEMP_WRITER_URL ?? '',
          name!,
        );
        await apiPool.end();
        const writerConfig = {
          connectionString: writerUrl.toString(),
          options:
            '-c default_transaction_read_only=off -c statement_timeout=8000 -c lock_timeout=4000 -c stats_fetch_consistency=none',
          connectionTimeoutMillis: 5000,
          query_timeout: 9000,
          max: 2,
        };
        apiPool = new Pool({
          ...writerConfig,
          application_name: 'ttv-surplus-write-api',
        });
        control = new Pool({
          ...writerConfig,
          application_name: 'ttv-surplus-write-control',
        });
        await checkWriterPool(apiPool, 2);
        await checkWriterPool(control, 2);
      }
      prisma = new PrismaClient({ adapter: new PrismaPg(apiPool) });
      await prisma.$connect();
      await prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<Array<Record<string, string>>>(
            Prisma.raw(writeMode ? writerIdentitySql : identitySql),
          );
          if (writeMode) assertWriter(rows[0]);
          else assertIdentity(rows[0]);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      const users = (
        await observer.query(
          `SELECT "id","role" FROM public."User"
        WHERE "id" IN ($1,$2)`,
          [fixtures.adminId, fixtures.userId],
        )
      ).rows;
      if (
        !users.some(
          (row) => row.id === fixtures.adminId && row.role === 'ADMIN',
        ) ||
        !users.some(
          (row) => row.id === fixtures.userId && row.role === 'USER',
        ) ||
        (
          await observer.query('SELECT 1 FROM public."Payment" WHERE "id"=$1', [
            fixtures.missingPaymentId,
          ])
        ).rowCount
      )
        throw new Error('Synthetic auth fixtures invalid');

      const secret = randomBytes(48).toString('hex');
      jwt = new JwtService({ secret });
      const module = await Test.createTestingModule({
        imports: [PaymentSurplusModule, PrismaModule],
        providers: [
          JwtStrategy,
          {
            provide: ConfigService,
            useValue: new ConfigService({ JWT_SECRET: secret }),
          },
        ],
      })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .compile();
      app = module.createNestApplication({ logger: false });
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, transform: true }),
      );
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();
      ready = true;
    } catch (error) {
      throw safeFailure('readonly-harness-setup', error);
    }
  });

  afterAll(async () => {
    ready = false;
    const closing = await Promise.allSettled([
      app?.close(),
      prisma?.$disconnect(),
    ]);
    const pools = await Promise.allSettled([
      apiPool?.end(),
      observer?.end(),
      control?.end(),
    ]);
    if ([...closing, ...pools].some((result) => result.status === 'rejected')) {
      throw new Error('Temporary harness connection cleanup failed');
    }
  });

  it('401 — missing JWT', async () => {
    await http()
      .get(`/admin/payments/${fixtures.paymentId}/surplus`)
      .expect(401);
  });
  it('403 — synthetic non-admin', async () => {
    await http()
      .get(`/admin/payments/${fixtures.paymentId}/surplus`)
      .set('Authorization', await bearer(fixtures.userId))
      .expect(403);
  });
  it('404 — synthetic admin, absent Payment', async () => {
    await http()
      .get(`/admin/payments/${fixtures.missingPaymentId}/surplus`)
      .set('Authorization', await bearer(fixtures.adminId))
      .expect(404);
  });
  it('200 — Decimal totals and complete independent SELECT history', async () => {
    const before = await reference();
    const response = await http()
      .get(`/admin/payments/${fixtures.paymentId}/surplus`)
      .set('Authorization', await bearer(fixtures.adminId))
      .expect(200);
    expect(await reference()).toEqual(before);
    expect(response.body).toEqual(before);
    for (const [key, value] of Object.entries({
      totalMatched: '150.30',
      totalSurplus: '50.20',
      allocatedAmount: '25.15',
      availableSurplus: '25.05',
    })) {
      expect(new Prisma.Decimal(response.body[key]).equals(value)).toBe(true);
    }
    expect(response.body.history).toHaveLength(3);
    expect(
      response.body.history.map((row: { status: string }) => row.status).sort(),
    ).toEqual(['CANCELLED', 'COMPLETED', 'PENDING']);
  });

  if (writeMode) {
    const paymentFor = (id: string) => fixtures.writePayments![id];
    const base = (id: string) => `/admin/payments/${id}/surplus/handlings`;
    async function create(
      paymentId: string,
      action = 'REFUND',
      amount = '10',
      key = randomUUID(),
      note = 'Synthetic manual handling',
    ) {
      return http()
        .post(base(paymentId))
        .set('Authorization', await bearer(fixtures.adminId))
        .set('Idempotency-Key', key)
        .send({ action, amount, note });
    }
    async function transition(
      paymentId: string,
      id: string,
      mode: 'complete' | 'cancel',
    ) {
      return http()
        .post(`${base(paymentId)}/${id}/${mode}`)
        .set('Authorization', await bearer(fixtures.adminId))
        .send(
          mode === 'complete'
            ? {
                confirmation: 'Synthetic manual confirmation',
                externalReference: 'SYNTHETIC_ONLY',
              }
            : { note: 'Synthetic cancellation' },
        );
    }
    async function postcheck(paymentId: string) {
      const expected = await reference(paymentId);
      const actual = await http()
        .get(`/admin/payments/${paymentId}/surplus`)
        .set('Authorization', await bearer(fixtures.adminId))
        .expect(200);
      expect(actual.body).toEqual(expected);
      expect(
        new Prisma.Decimal(expected.availableSurplus).greaterThanOrEqualTo(0),
      ).toBe(true);
      return expected;
    }
    async function competing(
      paymentId: string,
      jobs: Array<() => PromiseLike<unknown>>,
    ) {
      const gate = await control!.connect();
      let results: Promise<PromiseSettledResult<unknown>[]> | undefined;
      let failure: unknown;
      try {
        assertWriter((await gate.query(writerIdentitySql)).rows[0]);
        await gate.query('BEGIN');
        await gate.query(
          'SELECT "id" FROM public."Payment" WHERE "id"=$1 FOR UPDATE',
          [paymentId],
        );
        const gatePid = (await gate.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        results = Promise.allSettled(
          jobs.map((job) => Promise.resolve().then(job)),
        );
        const deadline = Date.now() + 2000;
        let observed = false;
        while (Date.now() < deadline) {
          const snapshot = await control!
            .query(`SELECT pid, pg_blocking_pids(pid) AS blockers
            FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND usename=current_user
            AND application_name='ttv-surplus-write-api' AND wait_event_type='Lock'`);
          if (
            snapshot.rows.length === 2 &&
            snapshot.rows.every((r) => r.blockers.length > 0) &&
            snapshot.rows.some((r) => r.blockers.includes(gatePid))
          ) {
            observed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (!observed) throw new Error('LOCK_CONTENTION_NOT_PROVEN');
      } catch (error) {
        failure = error;
      } finally {
        let releaseError: Error | undefined;
        try {
          await gate.query('ROLLBACK');
        } catch {
          releaseError = new Error('LOCK_GATE_CLOSE_FAILED');
          failure ??= releaseError;
        } finally {
          gate.release(releaseError);
        }
      }
      const settled = await results;
      if (failure) throw failure;
      if (!settled || settled.some((r) => r.status !== 'fulfilled'))
        throw new Error('CONCURRENT_REQUEST_FAILED');
      return settled.map((r) => (r as PromiseFulfilledResult<any>).value);
    }

    it('WRITE_AUTH', async () => {
      const p = paymentFor('WRITE_AUTH');
      for (const path of [
        base(p),
        `${base(p)}/${randomUUID()}/complete`,
        `${base(p)}/${randomUUID()}/cancel`,
      ]) {
        await http().post(path).send({}).expect(401);
        await http()
          .post(path)
          .set('Authorization', await bearer(fixtures.userId))
          .send({})
          .expect(403);
      }
      expect((await postcheck(p)).history).toHaveLength(0);
    });
    it('WRITE_VALIDATION', async () => {
      const p = paymentFor('WRITE_VALIDATION');
      for (const [action, amount, note] of [
        ['QUOTA', '1', 'x'],
        ['DAYS', '1', 'x'],
        ['REFUND', '0', 'x'],
        ['REFUND', 'NaN', 'x'],
        ['REFUND', '0.0000001', 'x'],
        ['CREDIT', '1', ' '],
      ]) {
        expect(
          (await create(p, action, amount, randomUUID(), note)).status,
        ).toBe(400);
      }
      await http()
        .post(base(p))
        .set('Authorization', await bearer(fixtures.adminId))
        .send({ action: 'REFUND', amount: '1', note: 'x' })
        .expect(400);
      for (const mode of ['complete', 'cancel'])
        await http()
          .post(`${base(p)}/${randomUUID()}/${mode}`)
          .set('Authorization', await bearer(fixtures.adminId))
          .send({})
          .expect(400);
      expect((await postcheck(p)).history).toHaveLength(0);
    });
    it('WRITE_PAID_ONLY', async () => {
      expect((await create(paymentFor('WRITE_PAID_ONLY'))).status).toBe(409);
      expect((await create(fixtures.missingPaymentId)).status).toBe(404);
      for (const mode of ['complete', 'cancel'] as const) {
        expect(
          (await transition(paymentFor('WRITE_PAID_ONLY'), randomUUID(), mode))
            .status,
        ).toBe(409);
        expect(
          (await transition(paymentFor('WRITE_VALIDATION'), randomUUID(), mode))
            .status,
        ).toBe(404);
      }
      expect(
        (await postcheck(paymentFor('WRITE_PAID_ONLY'))).history,
      ).toHaveLength(0);
    });
    it('WRITE_REFUND', async () => {
      const p = paymentFor('WRITE_REFUND');
      const result = await create(p);
      expect(result.status).toBe(201);
      expect(result.body.status).toBe('PENDING');
      expect((await transition(p, result.body.id, 'complete')).status).toBe(
        201,
      );
      const state = await postcheck(p);
      expect(state.history[0].status).toBe('COMPLETED');
      expect(state.history[0].externalReference).toBe('SYNTHETIC_ONLY');
      expect(state.history[0].creditRemainingAmount).toBe('0');
      expect(state.history[0].completedById).toBe(fixtures.adminId);
      expect(state.history[0].completedAt).not.toBeNull();
    });
    it('WRITE_CREDIT', async () => {
      const p = paymentFor('WRITE_CREDIT');
      const r = await create(p, 'CREDIT', '10.000001');
      expect(r.status).toBe(201);
      expect(r.body.creditRemainingAmount).toBe('0');
      expect((await transition(p, r.body.id, 'complete')).status).toBe(201);
      expect((await postcheck(p)).history[0].creditRemainingAmount).toBe(
        '10.000001',
      );
    });
    it('WRITE_CANCEL', async () => {
      const p = paymentFor('WRITE_CANCEL');
      const r = await create(p, 'CREDIT', '50.2');
      expect(r.status).toBe(201);
      expect((await create(p)).status).toBe(409);
      expect((await transition(p, r.body.id, 'cancel')).status).toBe(201);
      const state = await postcheck(p);
      expect(state.availableSurplus).toBe('50.2');
      expect(state.history[0].cancelledById).toBe(fixtures.adminId);
      expect(state.history[0].cancelledAt).not.toBeNull();
      expect(state.history[0].creditRemainingAmount).toBe('0');
      expect((await create(p, 'REFUND', '50.2')).status).toBe(201);
      await postcheck(p);
    });
    it('WRITE_IDEMPOTENT', async () => {
      const p = paymentFor('WRITE_IDEMPOTENT'),
        key = randomUUID();
      const first = await create(p, 'REFUND', '10', key);
      expect(first.status).toBe(201);
      expect((await create(p, 'REFUND', '10.000000', key)).body.id).toBe(
        first.body.id,
      );
      await transition(p, first.body.id, 'cancel');
      expect((await create(p, 'REFUND', '10', key)).body.status).toBe(
        'CANCELLED',
      );
      expect((await postcheck(p)).history).toHaveLength(1);
    });
    it('WRITE_KEY_CONFLICT', async () => {
      const p = paymentFor('WRITE_KEY_CONFLICT'),
        key = randomUUID();
      await create(p, 'REFUND', '10', key);
      expect((await create(p, 'CREDIT', '10', key)).status).toBe(409);
      expect((await create(p, 'REFUND', '11', key)).status).toBe(409);
      expect(
        (await create(p, 'REFUND', '10', key, 'Different note')).status,
      ).toBe(409);
      expect(
        (await create(paymentFor('WRITE_AUTH'), 'REFUND', '10', key)).status,
      ).toBe(409);
      expect((await postcheck(p)).history).toHaveLength(1);
    });
    it('WRITE_CONCURRENT_KEY', async () => {
      const p = paymentFor('WRITE_CONCURRENT_KEY'),
        key = randomUUID();
      const result = await competing(p, [
        () => create(p, 'CREDIT', '30', key),
        () => create(p, 'CREDIT', '30', key),
      ]);
      expect(result.map((r) => r.status)).toEqual([201, 201]);
      expect(result[0].body.id).toBe(result[1].body.id);
      expect((await postcheck(p)).history).toHaveLength(1);
    });
    it('WRITE_CONCURRENT_OVERALLOC', async () => {
      const p = paymentFor('WRITE_CONCURRENT_OVERALLOC');
      const result = await competing(p, [
        () => create(p, 'REFUND', '30'),
        () => create(p, 'CREDIT', '30'),
      ]);
      expect(result.map((r) => r.status).sort()).toEqual([201, 409]);
      const state = await postcheck(p);
      expect(state.allocatedAmount).toBe('30');
      expect(state.history).toHaveLength(1);
    });
    it('WRITE_CONCURRENT_TRANSITION', async () => {
      const p = paymentFor('WRITE_CONCURRENT_TRANSITION'),
        r = await create(p);
      const results = await competing(p, [
        () => transition(p, r.body.id, 'complete'),
        () => transition(p, r.body.id, 'cancel'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const state = await postcheck(p);
      expect(state.history).toHaveLength(1);
      expect(['COMPLETED', 'CANCELLED']).toContain(state.history[0].status);
      expect(Boolean(state.history[0].completedAt)).not.toBe(
        Boolean(state.history[0].cancelledAt),
      );
    });
    it('WRITE_AUDIT_REPLAY', async () => {
      const p = paymentFor('WRITE_AUDIT_REPLAY'),
        r = await create(p, 'CREDIT');
      const results = await competing(p, [
        () => transition(p, r.body.id, 'complete'),
        () => transition(p, r.body.id, 'complete'),
      ]);
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      expect(results[0].body).toEqual(results[1].body);
      expect((await transition(p, r.body.id, 'cancel')).status).toBe(409);
      const before = await postcheck(p);
      await transition(p, r.body.id, 'complete');
      expect(await postcheck(p)).toEqual(before);
    });
    it('WRITE_DECIMAL_SNAPSHOT', async () => {
      const p = paymentFor('WRITE_DECIMAL_SNAPSHOT');
      const r = await create(p, 'CREDIT', '0.000001');
      expect(r.status).toBe(201);
      const state = await postcheck(p);
      expect(state.availableSurplus).toBe('50.199999');
      expect(state.history[0].effectivePlanPriceSnapshot).toBe('100.1');
      const snapshot = (
        await observer!.query(
          'SELECT "amount"::text,"creditAmount"::text,"promotionPriceSnapshot"::text,"planPriceSnapshot"::text FROM public."Payment" WHERE "id"=$1',
          [p],
        )
      ).rows[0];
      expect(new Prisma.Decimal(snapshot.amount).toString()).toBe('80.1');
      expect(new Prisma.Decimal(snapshot.creditAmount).toString()).toBe('20');
      expect(new Prisma.Decimal(snapshot.planPriceSnapshot).toString()).toBe(
        '120.1',
      );
      expect(
        new Prisma.Decimal(snapshot.promotionPriceSnapshot).toString(),
      ).toBe(state.history[0].effectivePlanPriceSnapshot);
    });
    it('WRITE_READONLY_OBSERVER', async () => {
      await checkPool(observer!);
      const privileges = (
        await observer!.query(
          `SELECT has_table_privilege(current_user,'public."PaymentSurplusHandling"','INSERT,UPDATE,DELETE') AS writable`,
        )
      ).rows[0];
      expect(privileges.writable).toBe(false);
      await postcheck(paymentFor('WRITE_READONLY_OBSERVER'));
    });
    it('WRITE_POSTCHECK', async () => {
      for (const id of WRITE_CASES) await postcheck(paymentFor(id));
      const unchanged = await reference();
      expect(unchanged.availableSurplus).toBe('25.05');
      expect(unchanged.history).toHaveLength(3);
      const unchangedUsers = (
        await observer!.query(
          'SELECT "id","role" FROM public."User" ORDER BY "id"',
        )
      ).rows;
      expect(unchangedUsers).toHaveLength(2);
      expect(unchangedUsers.find((r) => r.id === fixtures.adminId)?.role).toBe(
        'ADMIN',
      );
      expect(unchangedUsers.find((r) => r.id === fixtures.userId)?.role).toBe(
        'USER',
      );
    });
  }
});
