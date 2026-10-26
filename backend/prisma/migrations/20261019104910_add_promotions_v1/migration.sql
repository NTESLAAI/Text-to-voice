-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "discountAmountSnapshot" DOUBLE PRECISION,
ADD COLUMN     "promotionIdSnapshot" TEXT,
ADD COLUMN     "promotionPriceSnapshot" DOUBLE PRECISION,
ADD COLUMN     "promotionTitleSnapshot" TEXT;

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "PromotionStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionPlanPrice" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "promotionalPrice" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionPlanPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Promotion_status_startsAt_endsAt_idx" ON "Promotion"("status", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "PromotionPlanPrice_planId_idx" ON "PromotionPlanPrice"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionPlanPrice_promotionId_planId_key" ON "PromotionPlanPrice"("promotionId", "planId");

-- AddForeignKey
ALTER TABLE "PromotionPlanPrice" ADD CONSTRAINT "PromotionPlanPrice_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionPlanPrice" ADD CONSTRAINT "PromotionPlanPrice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
