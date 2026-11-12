
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Thiếu DATABASE_URL. Dừng kiểm tra.');
  }

  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/text_to_voice_test';

  const client = new Client({
    connectionString: url.toString(),
  });

  try {
    await client.connect();

    const db = await client.query(
      'SELECT current_database() AS db',
    );

    console.log('DATABASE:', db.rows[0].db);

    if (db.rows[0].db !== 'text_to_voice_test') {
      throw new Error('Sai database. Dừng kiểm tra.');
    }

    const result = await client.query(
      `SELECT
         p."id",
         p."code",
         p."name",
         p."price",
         p."isActive",
         (
           SELECT COUNT(*)::int
           FROM "Subscription" s
           WHERE s."planId" = p."id"
         ) AS subscriptions,
         (
           SELECT COUNT(*)::int
           FROM "Payment" x
           WHERE x."planId" = p."id"
         ) AS payments
       FROM "Plan" p
       WHERE p."id" = $1`,
      ['1f8d41e1-1fb3-42f3-a9d2-1ba534b249db'],
    );

    console.table(result.rows);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('READ-ONLY CHECK FAILED:', error.message);
  process.exitCode = 1;
});
