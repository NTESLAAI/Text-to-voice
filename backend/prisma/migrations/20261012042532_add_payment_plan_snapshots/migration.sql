-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "planCharacterLimitSnapshot" INTEGER,
ADD COLUMN     "planDurationDaysSnapshot" INTEGER,
ADD COLUMN     "planNameSnapshot" TEXT,
ADD COLUMN     "planPriceSnapshot" DOUBLE PRECISION;
