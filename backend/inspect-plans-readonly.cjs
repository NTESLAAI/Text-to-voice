
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Thiếu DATABASE_URL.');
  }

  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/text_to_voice_test';

  const client = new Client({
    connectionString: url.toString(),
  });

  try {
    await client.connect();

    const db = await client.query(
      'SELECT current_database() AS name',
    );

    if (db.rows[0].name !== 'text_to_voice_test') {
      throw new Error('Sai database; dừng kiểm tra.');
    }

    const result = await client.query(`
      SELECT
        "id",
        "code",
        "name",
        "price",
        "characterLimit",
        "durationDays",
        "isActive"
      FROM "Plan"
      ORDER BY "price", "code"
    `);

    console.log('DATABASE:', db.rows[0].name);
    console.table(result.rows);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('READ-ONLY CHECK FAILED:', error.message);
  process.exitCode = 1;
});
