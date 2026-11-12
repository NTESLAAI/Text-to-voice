require('dotenv').config({ quiet: true });
const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }

  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/text_to_voice_test';

  const client = new Client({
    connectionString: url.toString(),
  });

  try {
    await client.connect();

    // Xác minh database thực tế trước khi truy vấn.
    const dbResult = await client.query('SELECT current_database() AS db');

    const databaseName = dbResult.rows[0]?.db;

    if (databaseName !== 'text_to_voice_test') {
      throw new Error(
        `Unexpected database: ${databaseName}. Refusing to continue.`,
      );
    }

    console.log('Database verified:', databaseName);

    const result = await client.query(
      `
        SELECT
          q."id",
          q."sourceLotId",
          q."charactersGranted",
          q."charactersRemaining",
          q."rolloverCount",
          q."expiresAt",
          s."status" AS "subscriptionStatus"
        FROM "QuotaLot" q
        JOIN "Subscription" s
          ON s."id" = q."subscriptionId"
        WHERE q."subscriptionId" = $1
        ORDER BY q."createdAt", q."id"
      `,
      ['b67b9a99-063a-4488-81ad-02619908beb5'],
    );

    console.table(result.rows);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
