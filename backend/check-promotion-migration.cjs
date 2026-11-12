require("dotenv/config");
const { PrismaClient } = require("./dist/generated/prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL
  })
});

async function main() {
  const tables = await prisma.$queryRaw`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('Promotion', 'PromotionPlanPrice', 'PromotionRedemption')
    ORDER BY table_name
  `;

  const columns = await prisma.$queryRaw`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Payment'
      AND column_name IN (
        'promotionIdSnapshot',
        'promotionTitleSnapshot',
        'promotionPriceSnapshot',
        'discountAmountSnapshot'
      )
    ORDER BY column_name
  `;

  console.log("PROMOTION TABLES:", tables);
  console.log("PAYMENT PROMOTION COLUMNS:", columns);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());