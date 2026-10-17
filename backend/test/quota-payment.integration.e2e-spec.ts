import 'dotenv/config';

import { PrismaService } from '../src/prisma/prisma.service';

describe('Quota and Payment Integration Safety', () => {
  let prisma: PrismaService | undefined;

  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL;

    if (!baseUrl) {
      throw new Error('DATABASE_URL chưa được cấu hình. Dừng kiểm thử.');
    }

    // Chỉ chuyển đường dẫn database, không in thông tin kết nối.
    const testUrl = new URL(baseUrl);
    testUrl.pathname = '/text_to_voice_test';

    process.env.DATABASE_URL = testUrl.toString();

    prisma = new PrismaService();

    try {
      await prisma.$connect();

      const rows = await prisma.$queryRaw<Array<{ database_name: string }>>`
        SELECT current_database() AS database_name
      `;

      if (rows[0]?.database_name !== 'text_to_voice_test') {
        throw new Error(
          'Sai database kiểm thử. Dừng ngay, không được ghi dữ liệu.',
        );
      }
    } catch (error) {
      await prisma.$disconnect().catch(() => undefined);
      prisma = undefined;
      throw error;
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  it('phải kết nối đúng text_to_voice_test trước khi cho phép test ghi dữ liệu', async () => {
    const rows = await prisma!.$queryRaw<Array<{ database_name: string }>>`
      SELECT current_database() AS database_name
    `;

    expect(rows[0]?.database_name).toBe('text_to_voice_test');
  });

  it('kiểm tra cấu trúc các bảng phục vụ integration test', async () => {
    const databaseRows = await prisma!.$queryRaw<
      Array<{ database_name: string }>
    >`
    SELECT current_database() AS database_name
  `;

    expect(databaseRows[0]?.database_name).toBe('text_to_voice_test');

    const columns = await prisma!.$queryRaw<
      Array<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>
    >`
    SELECT
      table_name,
      column_name,
      data_type,
      is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'User',
        'Project',
        'Plan',
        'Subscription',
        'QuotaLot',
        'Payment',
        'Audio',
        'Usage',
        'UsageQuotaAllocation'
      )
    ORDER BY table_name, ordinal_position
  `;

    console.log(
      'Cấu trúc bảng trong text_to_voice_test:',
      JSON.stringify(columns, null, 2),
    );

    expect(columns.length).toBeGreaterThan(0);
  });
  it('đọc danh sách Plan trong database kiểm thử', async () => {
    const db = await prisma!.$queryRaw<Array<{ database_name: string }>>`
    SELECT current_database() AS database_name
  `;

    expect(db[0]?.database_name).toBe('text_to_voice_test');

    const plans = await prisma!.plan.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        price: true,
        durationDays: true,
        characterLimit: true,
        isActive: true,
      },
      orderBy: { code: 'asc' },
    });

    console.log('DANH SÁCH PLAN:', JSON.stringify(plans, null, 2));

    expect(Array.isArray(plans)).toBe(true);
  });
  it('thống kê dữ liệu hiện có trong database kiểm thử (chỉ đọc)', async () => {
    const db = await prisma!.$queryRaw<Array<{ database_name: string }>>`
    SELECT current_database() AS database_name
  `;

    if (db[0]?.database_name !== 'text_to_voice_test') {
      throw new Error('Sai database kiểm thử. Dừng ngay, không được tiếp tục.');
    }

    const counts = await prisma!.$queryRaw<
      Array<{ table_name: string; record_count: bigint }>
    >`
    SELECT 'User'::text AS table_name, COUNT(*)::bigint AS record_count
    FROM "User"
    UNION ALL
    SELECT 'Project', COUNT(*)::bigint FROM "Project"
    UNION ALL
    SELECT 'Subscription', COUNT(*)::bigint FROM "Subscription"
    UNION ALL
    SELECT 'QuotaLot', COUNT(*)::bigint FROM "QuotaLot"
    UNION ALL
    SELECT 'Payment', COUNT(*)::bigint FROM "Payment"
    UNION ALL
    SELECT 'Audio', COUNT(*)::bigint FROM "Audio"
    UNION ALL
    SELECT 'Usage', COUNT(*)::bigint FROM "Usage"
  `;

    console.log(
      'THỐNG KÊ text_to_voice_test:',
      JSON.stringify(
        counts.map((item) => ({
          table: item.table_name,
          count: item.record_count.toString(),
        })),
        null,
        2,
      ),
    );

    expect(counts).toHaveLength(7);
  });
  it('đọc trạng thái Subscription và QuotaLot hiện có (chỉ đọc)', async () => {
    const db = await prisma!.$queryRaw<Array<{ database_name: string }>>`
    SELECT current_database() AS database_name
  `;

    if (db[0]?.database_name !== 'text_to_voice_test') {
      throw new Error('Sai database, dừng kiểm tra.');
    }

    const rows = await prisma!.$queryRaw<
      Array<{
        subscription_id: string;
        plan_code: string;
        status: string;
        expires_at: Date;
        quota_lot_id: string | null;
        characters_granted: number | null;
        characters_remaining: number | null;
        rollover_count: number | null;
        lot_expires_at: Date | null;
      }>
    >`
    SELECT
      s."id" AS subscription_id,
      p."code" AS plan_code,
      s."status",
      s."expiresAt" AS expires_at,
      q."id" AS quota_lot_id,
      q."charactersGranted" AS characters_granted,
      q."charactersRemaining" AS characters_remaining,
      q."rolloverCount" AS rollover_count,
      q."expiresAt" AS lot_expires_at
    FROM "Subscription" s
    JOIN "Plan" p ON p."id" = s."planId"
    LEFT JOIN "QuotaLot" q ON q."subscriptionId" = s."id"
    ORDER BY s."createdAt" DESC, q."createdAt" ASC
  `;

    console.log(
      'TRẠNG THÁI SUBSCRIPTION VÀ QUOTA:',
      JSON.stringify(rows, null, 2),
    );

    expect(Array.isArray(rows)).toBe(true);
  });
});
