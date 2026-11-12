require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { randomUUID } = require('crypto');

async function main() {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/text_to_voice_test';

  if (url.pathname !== '/text_to_voice_test') {
    throw new Error('Unsafe database target');
  }

  const client = new Client({
    connectionString: url.toString(),
  });

  const userId = randomUUID();
  const basicId = randomUUID();
  const proId = randomUUID();
  const subscriptionId = randomUUID();
  const lotId = randomUUID();

  try {
    await client.connect();
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT COUNT(*)::int AS count FROM "User"'
    );

    if (existing.rows[0].count !== 0) {
      throw new Error('Test database already contains users');
    }

    await client.query(
      `INSERT INTO "User" ("id", "email", "name", "updatedAt")
       VALUES ($1, $2, $3, NOW())`,
      [userId, 'concurrency-test@example.invalid', 'Concurrency Test']
    );

    await client.query(
      `INSERT INTO "Plan"
       ("id", "code", "name", "price", "durationDays",
        "characterLimit", "updatedAt")
       VALUES
       ($1, 'TEST_BASIC', 'Test Basic', 100000, 30, 100, NOW()),
       ($2, 'TEST_PRO', 'Test Pro', 200000, 30, 200, NOW())`,
      [basicId, proId]
    );

    await client.query(
      `INSERT INTO "Subscription"
       ("id", "userId", "planId", "startedAt", "expiresAt",
        "status", "characterLimit", "updatedAt")
       VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '30 days',
               'ACTIVE', 100, NOW())`,
      [subscriptionId, userId, basicId]
    );

    await client.query(
      `INSERT INTO "QuotaLot"
       ("id", "subscriptionId", "charactersGranted",
        "charactersRemaining", "rolloverCount", "expiresAt", "updatedAt")
       VALUES ($1, $2, 100, 100, 0,
               NOW() + INTERVAL '30 days', NOW())`,
      [lotId, subscriptionId]
    );

    await client.query('COMMIT');

    console.log('TEST DATA CREATED');
    console.log('User:', userId);
    console.log('Subscription:', subscriptionId);
    console.log('QuotaLot:', lotId);
    console.log('Remaining quota: 100');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
