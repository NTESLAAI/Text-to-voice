-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "sourcePlanCharacterLimitSnapshot" INTEGER,
ADD COLUMN     "sourcePlanPriceSnapshot" DOUBLE PRECISION;
