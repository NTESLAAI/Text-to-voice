
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

    const [users, payments, subscriptions, freePlans] =
      await Promise.all([
        client.query(
          `SELECT COUNT(*)::int AS count
           FROM "User"
           WHERE "email" LIKE 'payment-confirm-%@example.test'`,
        ),
        client.query(
          `SELECT COUNT(*)::int AS count
           FROM "Payment"
           WHERE "transferCode" LIKE 'KH-%'`,
        ),
        client.query(
          `SELECT COUNT(*)::int AS count
           FROM "Subscription" s
           JOIN "Plan" p ON p.id = s."planId"
           WHERE p.code = 'FREE'`,
        ),
        client.query(
          `SELECT id, code, name, "isActive"
           FROM "Plan"
           WHERE code = 'FREE'`,
        ),
      ]);

    console.log(
      'TEST USERS:',
      users.rows[0].count,
    );
    console.log(
      'PAYMENTS WITH KH PREFIX (ALL TEST DB):',
      payments.rows[0].count,
    );
    console.log(
      'SUBSCRIPTIONS ON FREE PLAN:',
      subscriptions.rows[0].count,
    );
    console.log('FREE PLAN:');
    console.table(freePlans.rows);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('READ-ONLY CHECK FAILED:', error.message);
  process.exitCode = 1;
});
