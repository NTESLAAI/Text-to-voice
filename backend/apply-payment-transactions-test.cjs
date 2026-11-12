require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
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

  const migrationName = '20261026140208_add_payment_transactions';
  const migrationPath = path.join(
    __dirname,
    'prisma',
    'migrations',
    migrationName,
    'migration.sql',
  );

  try {
    await client.connect();

    const db = await client.query(
      'SELECT current_database() AS name',
    );

    if (db.rows[0].name !== 'text_to_voice_test') {
      throw new Error('Sai database đích; dừng thao tác.');
    }

    await client.query('BEGIN');

    const existing = await client.query(`
      SELECT to_regclass('public."PaymentTransaction"') AS table_name
    `);

    const recorded = await client.query(
      `SELECT migration_name
       FROM public."_prisma_migrations"
       WHERE migration_name = $1`,
      [migrationName],
    );

    if (existing.rows[0].table_name || recorded.rowCount > 0) {
      throw new Error(
        'Bảng hoặc bản ghi migration đã tồn tại; dừng để kiểm tra thủ công.',
      );
    }

    const sql = fs.readFileSync(migrationPath, 'utf8');

    await client.query(sql);

    await client.query(
      `INSERT INTO public."_prisma_migrations"
       (id, checksum, migration_name, started_at, finished_at, logs, rolled_back_at, applied_steps_count)
       VALUES ($1, $2, $3, NOW(), NOW(), NULL, NULL, 1)`,
      [
        require('crypto').randomUUID(),
        require('crypto').createHash('sha256').update(sql).digest('hex'),
        migrationName,
      ],
    );

    await client.query('COMMIT');
    console.log('Đã áp dụng migration vào text_to_voice_test.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Không áp dụng được migration:', error.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main();
