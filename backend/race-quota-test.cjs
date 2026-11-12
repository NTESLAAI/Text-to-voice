require('dotenv').config({ quiet: true });
const { Client } = require('pg');

const SUBSCRIPTION_ID = 'b67b9a99-063a-4488-81ad-02619908beb5';
const LOT_ID = '9367d285-e3ca-477a-87a1-8ddfb67e00f5';

async function main() {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/text_to_voice_test';

  if (url.pathname !== '/text_to_voice_test') {
    throw new Error('Unsafe database target');
  }

  const payment = new Client({ connectionString: url.toString() });
  const tts = new Client({ connectionString: url.toString() });

  try {
    await payment.connect();
    await tts.connect();

    // Xác nhận đúng dữ liệu thử nghiệm trước khi bắt đầu.
    const check = await payment.query(
      `SELECT "charactersRemaining"
       FROM "QuotaLot"
       WHERE "id" = $1 AND "subscriptionId" = $2`,
      [LOT_ID, SUBSCRIPTION_ID],
    );

    if (
      check.rowCount !== 1 ||
      check.rows[0].charactersRemaining !== 100
    ) {
      throw new Error(
        'Expected test quota to be exactly 100. Stop without changes.',
      );
    }

    // Giao dịch A: đọc quota nhưng chưa khóa QuotaLot.
    await payment.query('BEGIN');

    const snapshot = await payment.query(
      `SELECT "charactersRemaining"
       FROM "QuotaLot"
       WHERE "id" = $1`,
      [LOT_ID],
    );

    const staleRemaining = snapshot.rows[0].charactersRemaining;
    console.log('A - quota read before TTS:', staleRemaining);

    // Giao dịch B: mô phỏng TTS sử dụng 30 ký tự.
    await tts.query('BEGIN');

    const locked = await tts.query(
      `SELECT "charactersRemaining"
       FROM "QuotaLot"
       WHERE "id" = $1
       FOR UPDATE`,
      [LOT_ID],
    );

    const currentRemaining = locked.rows[0].charactersRemaining;

    if (currentRemaining < 30) {
      throw new Error('Insufficient quota for simulated TTS');
    }

    await tts.query(
      `UPDATE "QuotaLot"
       SET "charactersRemaining" = "charactersRemaining" - 30,
           "updatedAt" = NOW()
       WHERE "id" = $1`,
      [LOT_ID],
    );

    await tts.query('COMMIT');

    console.log(
      'B - quota after TTS commit:',
      currentRemaining - 30,
    );

    // Giao dịch A tiếp tục chuyển theo snapshot cũ.
    await payment.query(
      `INSERT INTO "QuotaLot"
       ("id", "subscriptionId", "sourceLotId",
        "charactersGranted", "charactersRemaining",
        "rolloverCount", "expiresAt", "createdAt", "updatedAt")
       SELECT
        gen_random_uuid()::text, $1, q."id",
        $2, $2, 1, NOW() + INTERVAL '30 days', NOW(), NOW()
       FROM "QuotaLot" q
       WHERE q."id" = $3`,
      [SUBSCRIPTION_ID, staleRemaining, LOT_ID],
    );

    await payment.query(
      `UPDATE "QuotaLot"
       SET "charactersRemaining" = 0,
           "rolloverCount" = 1,
           "updatedAt" = NOW()
       WHERE "id" = $1`,
      [LOT_ID],
    );

    await payment.query('COMMIT');

    const result = await payment.query(
      `SELECT "id", "sourceLotId",
              "charactersGranted", "charactersRemaining",
              "rolloverCount"
       FROM "QuotaLot"
       WHERE "subscriptionId" = $1
       ORDER BY "createdAt", "id"`,
      [SUBSCRIPTION_ID],
    );

    console.log('\nQuota lots after simulated race:');
    console.table(result.rows);

    const transferred = result.rows
      .filter(row => row.sourceLotId === LOT_ID)
      .reduce((sum, row) => sum + row.charactersGranted, 0);

    console.log('Characters transferred:', transferred);
    console.log(
      'Expected transfer after TTS usage: 70',
    );
    console.log(
      transferred === 70
        ? 'RESULT: Expected transfer amount.'
        : 'RESULT: Transfer amount differs from expected.',
    );
  } catch (error) {
    await payment.query('ROLLBACK').catch(() => {});
    await tts.query('ROLLBACK').catch(() => {});
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await payment.end();
    await tts.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
