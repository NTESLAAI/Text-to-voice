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

    const db = await client.query(
      'SELECT current_database() AS db, current_schema() AS schema',
    );

    console.log('Database:', db.rows[0].db);
    console.log('Schema:', db.rows[0].schema);

    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'Payment',
          'PaymentTransaction',
          'Subscription',
          'QuotaLot'
        )
      ORDER BY table_name
    `);

    console.log(
      'Các bảng tìm thấy:',
      tables.rows.map((row) => row.table_name),
    );
    const allTables = await client.query(`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
  ORDER BY table_name
`);

    console.log(
      'DANH SÁCH TẤT CẢ BẢNG:',
      allTables.rows.map((row) => row.table_name),
    );

    const migrations = await client.query(`
  SELECT migration_name, finished_at, rolled_back_at
  FROM public._prisma_migrations
  ORDER BY started_at DESC
  LIMIT 10
`);

    console.log('10 MIGRATION GẦN NHẤT:', migrations.rows);
    const migration = await client.query(`
  SELECT migration_name, started_at, finished_at, rolled_back_at, logs
  FROM public._prisma_migrations
  WHERE migration_name = '20261026140208_add_payment_transactions'
`);

    console.log('TRẠNG THÁI MIGRATION PAYMENT TRANSACTIONS:');
    console.log(migration.rows);
    const migrationCheck = await client.query(`
  SELECT
    COUNT(*) FILTER (WHERE finished_at IS NOT NULL) AS completed,
    COUNT(*) FILTER (
      WHERE finished_at IS NULL AND rolled_back_at IS NULL
    ) AS unfinished
  FROM public._prisma_migrations
`);

    console.log('TỔNG QUAN MIGRATION:', migrationCheck.rows[0]);
    const paymentColumns = await client.query(`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'Payment'
  ORDER BY ordinal_position
`);

    console.log('CẤU TRÚC BẢNG PAYMENT:');
    console.table(paymentColumns.rows);

    const paymentTable = await client.query(`
  SELECT COUNT(*)::int AS total
  FROM public."Payment"
`);

    console.log('SỐ ĐƠN THANH TOÁN TRONG DB TEST:', paymentTable.rows[0].total);
    const checks = await client.query(`
  SELECT
    to_regclass('public."PaymentTransaction"') AS transaction_table,
    to_regclass('public."Payment"') AS payment_table,
    EXISTS (
      SELECT 1
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'Payment'
        AND constraint_type = 'PRIMARY KEY'
    ) AS payment_has_primary_key,
    EXISTS (
      SELECT 1
      FROM public."_prisma_migrations"
      WHERE migration_name = '20261026140208_add_payment_transactions'
        AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL
    ) AS migration_completed
`);

    console.log('ĐIỀU KIỆN ÁP DỤNG MIGRATION:', checks.rows[0]);
    const migrationColumns = await client.query(`
  SELECT column_name, is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = '_prisma_migrations'
  ORDER BY ordinal_position
`);

    console.log('CẤU TRÚC _prisma_migrations:');
    console.table(migrationColumns.rows);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error('Không thể xác minh DB test:', error.message);
  process.exitCode = 1;
});
