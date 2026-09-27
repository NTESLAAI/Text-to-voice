-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "creditAmount" DOUBLE PRECISION,
ADD COLUMN     "paymentType" TEXT NOT NULL DEFAULT 'NEW_PURCHASE',
ADD COLUMN     "upgradeOption" TEXT;
