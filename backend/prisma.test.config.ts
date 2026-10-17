import "dotenv/config";
import { defineConfig } from "prisma/config";

const baseUrl = process.env["DATABASE_URL"];

if (!baseUrl) {
  throw new Error("DATABASE_URL is not configured");
}

const testUrl = new URL(baseUrl);
testUrl.pathname = "/text_to_voice_test";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: testUrl.toString(),
  },
});
