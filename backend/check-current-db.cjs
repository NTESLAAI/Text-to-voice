require("dotenv/config");
const { PrismaService } = require("./dist/src/prisma/prisma.service");

async function main() {
  const prisma = new PrismaService();
  try {
    const result = await prisma.$queryRaw`SELECT current_database() AS database_name`;
    console.log("Database hiện tại:", result[0].database_name);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Lỗi:", error.message);
  process.exitCode = 1;
});
