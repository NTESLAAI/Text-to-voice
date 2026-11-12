require('dotenv').config({ quiet: true });
const { Client } = require('pg');

const SUBSCRIPTION_ID = 'b67b9a99-063a-4488-81ad-02619908beb5';
const SOURCE_LOT_ID = '9367d285-e3ca-477a-87a1-8ddfb67e00f5';
const ROLLOVER_LOT_ID = '61e21015-d662-4ccb-a582-d705e2236e6d';

async function main() {
  const url = new URL(process.env.DATABASE_URL);

  // Chỉ cho phép thao tác trên database test.
  url.pathname = '/text_to_voice_test';

  if (url.pathname !== '/text_to_voice_test') {
    throw new Error('Unsafe database target');
  }

  const client = new Client({ connectionString: url.toString() });

  try {
    await client.connect();
    await client.query('BEGIN');

    // Khóa subscription để tránh reset khi có giao dịch khác đang chạy.
    const subscription = await client.query(
      `SELECT "id", "status"
       FROM "Subscription"
       WHERE "id" = $1
       FOR UPDATE`,
      [SUBSCRIPTION_ID],
    );

    if (
      subscription.rowCount !== 1 ||
      subscription.rows[0].status !== 'ACTIVE'
    ) {
      throw new Error('Unexpected subscription state. Reset cancelled.');
    }

    // Khóa và xác minh chính xác hai lô đã biết.
    const lots = await client.query(
      `SELECT
         "id",
         "sourceLotId",
         "charactersGranted",
         "charactersRemaining",
         "rolloverCount"
       FROM "QuotaLot"
       WHERE "subscriptionId" = $1
       ORDER BY "id"
       FOR UPDATE`,
      [SUBSCRIPTION_ID],
    );

    if (lots.rowCount !== 2) {
      throw new Error('Expected exactly 2 quota lots. Reset cancelled.');
    }

    const source = lots.rows.find((lot) => lot.id === SOURCE_LOT_ID);

    const rollover = lots.rows.find((lot) => lot.id === ROLLOVER_LOT_ID);

    if (
      !source ||
      !rollover ||
      source.sourceLotId !== null ||
      Number(source.charactersGranted) !== 100 ||
      Number(source.charactersRemaining) !== 0 ||
      source.rolloverCount !== 1 ||
      rollover.sourceLotId !== SOURCE_LOT_ID ||
      Number(rollover.charactersGranted) !== 70 ||
      Number(rollover.charactersRemaining) !== 70 ||
      rollover.rolloverCount !== 1
    ) {
      throw new Error(
        'Quota state differs from the expected fixture. Reset cancelled.',
      );
    }

    // Xóa đúng lô rollover do lần mô phỏng cũ tạo ra.
    const deleted = await client.query(
      `DELETE FROM "QuotaLot"
       WHERE "id" = $1
         AND "subscriptionId" = $2
         AND "sourceLotId" = $3`,
      [ROLLOVER_LOT_ID, SUBSCRIPTION_ID, SOURCE_LOT_ID],
    );

    if (deleted.rowCount !== 1) {
      throw new Error('Could not delete expected rollover lot.');
    }

    // Khôi phục lô gốc về trạng thái trước thử nghiệm.
    const updated = await client.query(
      `UPDATE "QuotaLot"
       SET "charactersRemaining" = 100,
           "rolloverCount" = 0,
           "updatedAt" = NOW()
       WHERE "id" = $1
         AND "subscriptionId" = $2
         AND "charactersGranted" = 100`,
      [SOURCE_LOT_ID, SUBSCRIPTION_ID],
    );

    if (updated.rowCount !== 1) {
      throw new Error('Could not restore source quota lot.');
    }

    await client.query('COMMIT');

    console.log('TEST FIXTURE RESET SUCCESSFULLY');
    console.log('Database: text_to_voice_test');
    console.log('Subscription:', SUBSCRIPTION_ID);
    console.log('Remaining quota: 100');
    console.log('Rollover count: 0');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('RESET FAILED:', error.message);
  process.exitCode = 1;
});
