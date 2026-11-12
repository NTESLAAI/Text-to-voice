import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import request from 'supertest';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import { PaymentSurplusModule } from '../src/payment-surplus/payment-surplus.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy/jwt.strategy';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';

type Fixtures = {
  adminId: string | null;
  userId: string | null;
  paymentId: string | null;
};
const configured = Boolean(
  process.env.PAYMENT_SURPLUS_READONLY_URL &&
  process.env.PAYMENT_SURPLUS_READONLY_FIXTURES,
);
const fixtures: Fixtures = configured
  ? JSON.parse(process.env.PAYMENT_SURPLUS_READONLY_FIXTURES!)
  : { adminId: null, userId: null, paymentId: null };
const suite = configured ? describe : describe.skip;

suite('Payment surplus GET — read-only integration', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaClient | undefined;
  let apiPool: Pool | undefined;
  let observer: Pool | undefined;
  let jwt: JwtService;
  let missingPaymentId: string;
  let ready = false;

  async function assertReadOnly(pool: Pool) {
    const identity = (
      await pool.query(`
      SELECT current_database() AS db,
        current_setting('default_transaction_read_only') AS default_read_only,
        current_setting('transaction_read_only') AS transaction_read_only
    `)
    ).rows[0];
    if (
      identity.db !== 'text_to_voice_test' ||
      identity.default_read_only !== 'on' ||
      identity.transaction_read_only !== 'on'
    ) {
      throw new Error('STOP: database/read-only identity mismatch');
    }
  }

  function http() {
    if (!ready || !app)
      throw new Error('STOP: HTTP forbidden before read-only preflight');
    return request(app.getHttpServer());
  }

  async function bearer(userId: string) {
    return `Bearer ${await jwt.signAsync({ sub: userId }, { expiresIn: '5m' })}`;
  }

  async function reference(paymentId: string) {
    const connection = await observer!.connect();
    try {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const totals = (
        await connection.query(
          `
        SELECT p."id", p."currency", p."amount"::text AS amount,
          COALESCE((SELECT SUM(t."amount"::text::numeric)
            FROM public."PaymentTransaction" t WHERE t."paymentId" = p."id"
              AND t."status" = 'MATCHED' AND t."currency" = p."currency"), 0)::text AS matched,
          (SELECT COUNT(*) FROM public."PaymentTransaction" t
            WHERE t."paymentId" = p."id" AND t."status" = 'MATCHED'
              AND t."currency" <> p."currency")::text AS bad_transactions,
          COALESCE((SELECT SUM(h."amount") FROM public."PaymentSurplusHandling" h
            WHERE h."paymentId" = p."id" AND h."status" IN ('PENDING', 'COMPLETED')
              AND h."currency" = p."currency"), 0)::text AS allocated,
          (SELECT COUNT(*) FROM public."PaymentSurplusHandling" h
            WHERE h."paymentId" = p."id" AND h."status" IN ('PENDING', 'COMPLETED')
              AND h."currency" <> p."currency")::text AS bad_allocations
        FROM public."Payment" p WHERE p."id" = $1
      `,
          [paymentId],
        )
      ).rows[0];
      if (
        !totals ||
        totals.bad_transactions !== '0' ||
        totals.bad_allocations !== '0'
      ) {
        throw new Error('Existing reference data changed or is inconsistent');
      }
      const rows = (
        await connection.query(
          `
        SELECT "id", "paymentId", "action", "status", "amount"::text AS amount,
          "currency", "idempotencyKey", "creditRemainingAmount"::text AS "creditRemainingAmount",
          "effectivePlanPriceSnapshot"::text AS "effectivePlanPriceSnapshot",
          "planCharacterLimitSnapshot", "planDurationDaysSnapshot", "convertedCharacters",
          "convertedSeconds"::text AS "convertedSeconds", "note", "externalReference",
          "createdById", "completedById", "cancelledById", "createdAt", "updatedAt",
          "completedAt", "cancelledAt"
        FROM public."PaymentSurplusHandling" WHERE "paymentId" = $1
        ORDER BY "createdAt" DESC, "id" DESC
      `,
          [paymentId],
        )
      ).rows;
      const decimal = (value: string) => new Prisma.Decimal(value).toString();
      const totalSurplus = Prisma.Decimal.max(
        0,
        new Prisma.Decimal(totals.matched).minus(totals.amount),
      );
      const allocated = new Prisma.Decimal(totals.allocated);
      if (allocated.greaterThan(totalSurplus))
        throw new Error('Reference allocation exceeds surplus');
      const result = {
        paymentId: totals.id,
        currency: totals.currency,
        totalMatched: decimal(totals.matched),
        totalSurplus: totalSurplus.toString(),
        allocatedAmount: allocated.toString(),
        availableSurplus: totalSurplus.minus(allocated).toString(),
        history: rows.map((row) => ({
          ...row,
          amount: decimal(row.amount),
          creditRemainingAmount: decimal(row.creditRemainingAmount),
          effectivePlanPriceSnapshot:
            row.effectivePlanPriceSnapshot === null
              ? null
              : decimal(row.effectivePlanPriceSnapshot),
        })),
      };
      await connection.query('COMMIT');
      return JSON.parse(JSON.stringify(result));
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  beforeAll(async () => {
    try {
      const url = new URL(process.env.PAYMENT_SURPLUS_READONLY_URL!);
      if (decodeURIComponent(url.pathname) !== '/text_to_voice_test') {
        throw new Error('Wrong target database');
      }
      url.searchParams.set('options', '-c default_transaction_read_only=on');
      const poolConfig = {
        connectionString: url.toString(),
        options: '-c default_transaction_read_only=on',
        connectionTimeoutMillis: 10000,
        max: 2,
      };
      apiPool = new Pool(poolConfig);
      observer = new Pool(poolConfig);
      // Hold both API connections at once to verify every initially created pool session.
      const acquisitions = await Promise.allSettled([
        apiPool.connect(),
        apiPool.connect(),
      ]);
      const connections = acquisitions.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      try {
        if (acquisitions.some((result) => result.status === 'rejected')) {
          throw new Error('Could not acquire all read-only pool sessions');
        }
        for (const connection of connections) {
          const row = (
            await connection.query(`SELECT current_database() AS db,
            current_setting('default_transaction_read_only') AS ro,
            current_setting('transaction_read_only') AS tx_ro`)
          ).rows[0];
          if (
            row.db !== 'text_to_voice_test' ||
            row.ro !== 'on' ||
            row.tx_ro !== 'on'
          ) {
            throw new Error('Pool session preflight failed');
          }
        }
      } finally {
        connections.forEach((connection) => connection.release());
      }
      await assertReadOnly(observer);
      prisma = new PrismaClient({ adapter: new PrismaPg(apiPool) });
      await prisma.$connect();
      await prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<Array<{ db: string; ro: string }>>`
          SELECT current_database() AS db, current_setting('transaction_read_only') AS ro
        `;
          if (rows[0]?.db !== 'text_to_voice_test' || rows[0]?.ro !== 'on') {
            throw new Error('Prisma transaction preflight failed');
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );

      missingPaymentId = randomUUID();
      while (
        (
          await observer.query(
            'SELECT 1 FROM public."Payment" WHERE "id" = $1',
            [missingPaymentId],
          )
        ).rowCount
      )
        missingPaymentId = randomUUID();

      const secret = randomBytes(48).toString('hex');
      jwt = new JwtService({ secret });
      const testingModule = await Test.createTestingModule({
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
      app = testingModule.createNestApplication({ logger: false });
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, transform: true }),
      );
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();
      ready = true;
      console.log(
        'Harness PASS: text_to_voice_test; API pool + Prisma RepeatableRead + independent SELECT read-only ON',
      );
    } catch {
      throw new Error(
        'STOP: read-only harness setup failed; HTTP tests must not run',
      );
    }
  });

  afterAll(async () => {
    ready = false;
    const results = await Promise.allSettled([
      app?.close(),
      prisma?.$disconnect(),
    ]);
    const pools = await Promise.allSettled([apiPool?.end(), observer?.end()]);
    if ([...results, ...pools].some((result) => result.status === 'rejected')) {
      throw new Error('Read-only harness connection cleanup failed');
    }
    console.log('Cleanup PASS: Nest, Prisma and PostgreSQL pools closed');
  });

  it('401 — no JWT', async () => {
    await http().get(`/admin/payments/${missingPaymentId}/surplus`).expect(401);
  });

  (fixtures.userId ? it : it.skip)(
    '403 — existing non-admin user',
    async () => {
      await http()
        .get(`/admin/payments/${missingPaymentId}/surplus`)
        .set('Authorization', await bearer(fixtures.userId!))
        .expect(403);
    },
  );

  (fixtures.adminId ? it : it.skip)('404 — admin, absent Payment', async () => {
    await http()
      .get(`/admin/payments/${missingPaymentId}/surplus`)
      .set('Authorization', await bearer(fixtures.adminId!))
      .expect(404);
  });

  (fixtures.adminId && fixtures.paymentId ? it : it.skip)(
    '200 — existing Payment matches independent Decimal SELECT',
    async () => {
      const before = await reference(fixtures.paymentId!);
      const response = await http()
        .get(`/admin/payments/${fixtures.paymentId}/surplus`)
        .set('Authorization', await bearer(fixtures.adminId!))
        .expect(200);
      const after = await reference(fixtures.paymentId!);
      expect(after).toEqual(before); // Detect concurrent changes instead of reporting false drift.
      expect(response.body).toEqual(after);
    },
  );
});
