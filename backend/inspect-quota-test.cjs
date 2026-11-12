require('dotenv').config({ quiet: true });
const { Client } = require('pg');

async function main() {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/text_to_voice_test';
  const client = new Client({ connectionString: url.toString() });
  const subscriptionId = 'b67b9a99-063a-4488-81ad-02619908beb5';

  try {
    await client.connect();

    const db = await client.query('SELECT current_database() AS db');
    if (db.rows[0].db !== 'text_to_voice_test') {
      throw new Error('SAI DATABASE — dung kiem tra ngay!');
    }

    const usage = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM "Usage" WHERE "subscriptionId" = $1`,
      [subscriptionId],
    );

    const allocations = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM "UsageQuotaAllocation" a
       JOIN "QuotaLot" q ON q."id" = a."quotaLotId"
       WHERE q."subscriptionId" = $1`,
      [subscriptionId],
    );

    const rollover = await client.query(
      `SELECT "id", "sourceLotId", "charactersGranted",
              "charactersRemaining", "rolloverCount"
       FROM "QuotaLot"
       WHERE "subscriptionId" = $1 AND "sourceLotId" IS NOT NULL`,
      [subscriptionId],
    );

    console.log('Database:', db.rows[0].db);
    console.log('Usage count:', usage.rows[0].count);
    console.log('Allocation count:', allocations.rows[0].count);
    console.log('Rollover lots:');
    console.table(rollover.rows);
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
