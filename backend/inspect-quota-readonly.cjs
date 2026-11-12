require('dotenv').config({ quiet: true });
const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL chưa được cấu hình.');
  }

  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/text_to_voice_test';

  const client = new Client({
    connectionString: url.toString(),
  });

  try {
    await client.connect();

    const db = await client.query('SELECT current_database() AS db');

    console.log('DATABASE:', db.rows[0].db);

    if (db.rows[0].db !== 'text_to_voice_test') {
      throw new Error('Sai database. Dừng kiểm tra.');
    }

    const result = await client.query(
      `SELECT
         "id",
         "sourceLotId",
         "charactersGranted",
         "charactersRemaining",
         "rolloverCount",
         "expiresAt"
       FROM "QuotaLot"
       WHERE "subscriptionId" = $1
       ORDER BY "createdAt" ASC, "id" ASC`,
      ['b67b9a99-063a-4488-81ad-02619908beb5'],
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
