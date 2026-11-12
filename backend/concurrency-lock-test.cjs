require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const crypto = require('crypto');

const SUBSCRIPTION_ID = 'b67b9a99-063a-4488-81ad-02619908beb5';
const SOURCE_LOT_ID = '9367d285-e3ca-477a-87a1-8ddfb67e00f5';

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured.');
  }

  const url = new URL(process.env.DATABASE_URL);

  // Chi cho phep DB test, tuyet doi khong cham vao DB chinh.
  url.pathname = '/text_to_voice_test';

  if (url.pathname !== '/text_to_voice_test') {
    throw new Error('Unsafe database target.');
  }

  const connectionString = url.toString();

  const tts = new Client({ connectionString });
  const payment = new Client({ connectionString });
  const observer = new Client({ connectionString });

  let ttsTransactionOpen = false;
  let paymentTransactionOpen = false;

  // Ghi nhan TTS da commit de xu ly neu thanh toan that bai.
  let ttsCommitted = false;
  let paymentCommitted = false;

  try {
    await tts.connect();
    await payment.connect();
    await observer.connect();

    // Xac nhan ket noi dung DB test.
    const dbCheck = await observer.query('SELECT current_database() AS db');

    if (dbCheck.rows[0].db !== 'text_to_voice_test') {
      throw new Error('Connected to an unexpected database.');
    }

    // Chi chap nhan fixture ban dau dung 100 ky tu.
    const initial = await tts.query(
      `SELECT
         "charactersGranted",
         "charactersRemaining",
         "rolloverCount"
       FROM "QuotaLot"
       WHERE "id" = $1
         AND "subscriptionId" = $2`,
      [SOURCE_LOT_ID, SUBSCRIPTION_ID],
    );

    if (
      initial.rowCount !== 1 ||
      Number(initial.rows[0].charactersGranted) !== 100 ||
      Number(initial.rows[0].charactersRemaining) !== 100 ||
      Number(initial.rows[0].rolloverCount) !== 0
    ) {
      throw new Error(
        'Fixture khong dung trang thai: granted=100, remaining=100, rolloverCount=0.',
      );
    }

    // Dam bao fixture chua co Usage hoac allocation tu truoc.
    const usageBefore = await observer.query(
      `SELECT COUNT(*)::int AS count
       FROM "Usage"
       WHERE "subscriptionId" = $1`,
      [SUBSCRIPTION_ID],
    );

    const allocationsBefore = await observer.query(
      `SELECT COUNT(*)::int AS count
       FROM "UsageQuotaAllocation" a
       JOIN "QuotaLot" q ON q."id" = a."quotaLotId"
       WHERE q."subscriptionId" = $1`,
      [SUBSCRIPTION_ID],
    );

    if (
      Number(usageBefore.rows[0].count) !== 0 ||
      Number(allocationsBefore.rows[0].count) !== 0
    ) {
      throw new Error(
        'Fixture da co Usage hoac allocation; tu choi chay concurrency test.',
      );
    }

    console.log('Database:', dbCheck.rows[0].db);
    console.log('Fixture ban dau hop le, chua co Usage/allocation.');

    // TTS khoa lo quota va tru 30 ky tu, chua commit.
    await tts.query('BEGIN');
    ttsTransactionOpen = true;

    const ttsLot = await tts.query(
      `SELECT "charactersRemaining"
       FROM "QuotaLot"
       WHERE "id" = $1
       FOR UPDATE`,
      [SOURCE_LOT_ID],
    );

    if (
      ttsLot.rowCount !== 1 ||
      Number(ttsLot.rows[0].charactersRemaining) < 30
    ) {
      throw new Error('Khong du quota de mo phong TTS.');
    }

    await tts.query(
      `UPDATE "QuotaLot"
       SET "charactersRemaining" = "charactersRemaining" - 30,
           "updatedAt" = NOW()
       WHERE "id" = $1`,
      [SOURCE_LOT_ID],
    );

    // Thanh toan bat dau truy van cung lo quota.
    await payment.query('BEGIN');
    paymentTransactionOpen = true;

    // Neu cho khoa qua 5 giay, PostgreSQL se huy truy van.
    await payment.query(`SET LOCAL lock_timeout = '10s'`);

    const paymentLockPromise = payment
      .query(
        `SELECT
           "id",
           "charactersRemaining",
           "rolloverCount"
         FROM "QuotaLot"
         WHERE "subscriptionId" = $1
           AND "charactersRemaining" > 0
           AND "rolloverCount" = 0
           AND "expiresAt" > NOW()
         ORDER BY "expiresAt" ASC, "createdAt" ASC
         FOR UPDATE`,
        [SUBSCRIPTION_ID],
      )
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, error }));

    // Cho PostgreSQL xac nhan truy van thanh toan dang doi khoa.
    let lockObserved = false;
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      const result = await observer.query(
        `SELECT wait_event_type, wait_event
         FROM pg_stat_activity
         WHERE pid = $1`,
        [payment.processID],
      );

      if (result.rowCount === 1 && result.rows[0].wait_event_type === 'Lock') {
        lockObserved = true;
        console.log(
          'Da xac nhan truy van thanh toan dang cho khoa PostgreSQL.',
        );
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (!lockObserved) {
      // Rollback TTS truoc de giai phong khoa dang giu.
      if (ttsTransactionOpen) {
        await tts.query('ROLLBACK').catch(() => {});
        ttsTransactionOpen = false;
      }

      // Cho truy van thanh toan hoan tat sau khi khoa da duoc giai phong.
      const paymentLockOutcome = await paymentLockPromise;

      if (!paymentLockOutcome.ok) {
        console.error(
          'Loi truy van thanh toan:',
          paymentLockOutcome.error.message,
        );
      }

      // Luon rollback giao dich thanh toan vi day khong phai ket qua test thanh cong.
      await payment.query('ROLLBACK').catch(() => {});
      paymentTransactionOpen = false;

      throw new Error(
        'Khong xac nhan duoc trang thai cho khoa trong 5 giay. Da rollback giao dich.',
      );
    }

    // TTS commit truoc; truy van thanh toan se tiep tuc sau khi mo khoa.
    await tts.query('COMMIT');
    ttsTransactionOpen = false;
    ttsCommitted = true;

    const paymentLockOutcome = await paymentLockPromise;

    if (!paymentLockOutcome.ok) {
      throw new Error(
        `Truy van thanh toan that bai: ${paymentLockOutcome.error.message}`,
      );
    }

    const lockedLots = paymentLockOutcome.result;

    const transferredCharacters = lockedLots.rows.reduce(
      (sum, lot) => sum + Number(lot.charactersRemaining),
      0,
    );

    if (transferredCharacters !== 70) {
      throw new Error(
        `Mong doi 70 ky tu co the chuyen, nhung nhan duoc ${transferredCharacters}.`,
      );
    }

    console.log('Quota doc duoc sau khi cho khoa:', transferredCharacters);

    // Mo phong chuyen quota sang lo rollover.
    for (const lot of lockedLots.rows) {
      const newLotId = crypto.randomUUID();
      const characters = Number(lot.charactersRemaining);

      await payment.query(
        `INSERT INTO "QuotaLot"
         (
           "id",
           "subscriptionId",
           "sourceLotId",
           "charactersGranted",
           "charactersRemaining",
           "rolloverCount",
           "expiresAt",
           "createdAt",
           "updatedAt"
         )
         VALUES (
           $1, $2, $3, $4, $4, 1,
           NOW() + INTERVAL '30 days', NOW(), NOW()
         )`,
        [newLotId, SUBSCRIPTION_ID, lot.id, characters],
      );

      const updated = await payment.query(
        `UPDATE "QuotaLot"
         SET "charactersRemaining" = 0,
             "rolloverCount" = "rolloverCount" + 1,
             "updatedAt" = NOW()
         WHERE "id" = $1
           AND "charactersRemaining" = $2
           AND "rolloverCount" = 0`,
        [lot.id, characters],
      );

      if (updated.rowCount !== 1) {
        throw new Error('Khong the cap nhat lo quota goc.');
      }
    }

    await payment.query('COMMIT');
    paymentTransactionOpen = false;
    paymentCommitted = true;

    // Kiem tra trang thai cuoi cung.
    const finalLots = await tts.query(
      `SELECT
         "id",
         "sourceLotId",
         "charactersGranted",
         "charactersRemaining",
         "rolloverCount"
       FROM "QuotaLot"
       WHERE "subscriptionId" = $1
       ORDER BY "createdAt", "id"`,
      [SUBSCRIPTION_ID],
    );

    const source = finalLots.rows.find((lot) => lot.id === SOURCE_LOT_ID);

    const rollover = finalLots.rows.find(
      (lot) => lot.sourceLotId === SOURCE_LOT_ID,
    );

    const rolloverLots = finalLots.rows.filter(
      (lot) => lot.sourceLotId === SOURCE_LOT_ID,
    );

    if (
      !source ||
      rolloverLots.length !== 1 ||
      Number(source.charactersGranted) !== 100 ||
      Number(source.charactersRemaining) !== 0 ||
      Number(source.rolloverCount) !== 1 ||
      Number(rolloverLots[0].charactersGranted) !== 70 ||
      Number(rolloverLots[0].charactersRemaining) !== 70 ||
      Number(rolloverLots[0].rolloverCount) !== 1
    ) {
      throw new Error('Trang thai quota cuoi cung khong dung mong doi.');
    }

    console.log('\nCONCURRENCY TEST PASSED');
    console.log('Database: text_to_voice_test');
    console.log('TTS su dung: 30 ky tu');
    console.log('Quota chuyen: 70 ky tu');
    console.table(finalLots.rows);
  } finally {
    if (paymentTransactionOpen) {
      await payment.query('ROLLBACK').catch(() => {});
      paymentTransactionOpen = false;
    }

    if (ttsTransactionOpen) {
      await tts.query('ROLLBACK').catch(() => {});
      ttsTransactionOpen = false;
    }

    // Chi phuc hoi fixture neu TTS da commit nhung payment chua commit.
    // Khong phuc hoi neu payment da commit hoac TTS chua commit.
    if (ttsCommitted && !paymentCommitted) {
      try {
        const dbCheck = await observer.query('SELECT current_database() AS db');

        if (dbCheck.rows[0]?.db !== 'text_to_voice_test') {
          throw new Error('Tu choi phuc hoi: khong dung database test.');
        }

        // Kiem tra khong co Usage gan voi subscription test.
        const usageCheck = await observer.query(
          `SELECT COUNT(*)::int AS count
           FROM "Usage"
           WHERE "subscriptionId" = $1`,
          [SUBSCRIPTION_ID],
        );

        // Kiem tra khong co allocation nao tham chieu lo quota goc.
        const allocationCheck = await observer.query(
          `SELECT COUNT(*)::int AS count
           FROM "UsageQuotaAllocation"
           WHERE "quotaLotId" = $1`,
          [SOURCE_LOT_ID],
        );

        // Chi phuc hoi khi lo goc dang dung o trang thai trung gian
        // da biet: con 70 ky tu, rolloverCount = 0.
        const sourceCheck = await observer.query(
          `SELECT "charactersGranted",
                  "charactersRemaining",
                  "rolloverCount"
           FROM "QuotaLot"
           WHERE "id" = $1
             AND "subscriptionId" = $2`,
          [SOURCE_LOT_ID, SUBSCRIPTION_ID],
        );

        // Kiem tra khong co lo rollover nao tu lo goc.
        const rolloverCheck = await observer.query(
          `SELECT COUNT(*)::int AS count
           FROM "QuotaLot"
           WHERE "sourceLotId" = $1`,
          [SOURCE_LOT_ID],
        );

        const source = sourceCheck.rows[0];

        const canRecover =
          Number(usageCheck.rows[0].count) === 0 &&
          Number(allocationCheck.rows[0].count) === 0 &&
          sourceCheck.rowCount === 1 &&
          Number(source.charactersGranted) === 100 &&
          Number(source.charactersRemaining) === 70 &&
          Number(source.rolloverCount) === 0 &&
          Number(rolloverCheck.rows[0].count) === 0;

        if (canRecover) {
          await observer.query('BEGIN');

          const reset = await observer.query(
            `UPDATE "QuotaLot"
             SET "charactersRemaining" = 100,
                 "rolloverCount" = 0,
                 "updatedAt" = NOW()
             WHERE "id" = $1
               AND "subscriptionId" = $2
               AND "charactersGranted" = 100
               AND "charactersRemaining" = 70
               AND "rolloverCount" = 0`,
            [SOURCE_LOT_ID, SUBSCRIPTION_ID],
          );

          if (reset.rowCount !== 1) {
            throw new Error('Khong the phuc hoi fixture an toan.');
          }

          await observer.query('COMMIT');
          console.log(
            'Da phuc hoi fixture test ve 100 ky tu sau khi phep thu that bai.',
          );
        } else {
          console.error(
            'Khong tu dong phuc hoi: trang thai DB khong khop dieu kien an toan.',
          );
        }
      } catch (recoveryError) {
        await observer.query('ROLLBACK').catch(() => {});
        console.error('Loi khi phuc hoi fixture:', recoveryError.message);
      }
    }

    await payment.end().catch(() => {});
    await tts.end().catch(() => {});
    await observer.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error('CONCURRENCY TEST FAILED:', error.message);
  process.exitCode = 1;
});
