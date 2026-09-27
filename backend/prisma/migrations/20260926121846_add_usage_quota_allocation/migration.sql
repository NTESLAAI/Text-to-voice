-- CreateTable
CREATE TABLE "UsageQuotaAllocation" (
    "id" TEXT NOT NULL,
    "usageId" TEXT NOT NULL,
    "quotaLotId" TEXT NOT NULL,
    "characters" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageQuotaAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageQuotaAllocation_usageId_idx" ON "UsageQuotaAllocation"("usageId");

-- CreateIndex
CREATE INDEX "UsageQuotaAllocation_quotaLotId_idx" ON "UsageQuotaAllocation"("quotaLotId");

-- AddForeignKey
ALTER TABLE "UsageQuotaAllocation" ADD CONSTRAINT "UsageQuotaAllocation_usageId_fkey" FOREIGN KEY ("usageId") REFERENCES "Usage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageQuotaAllocation" ADD CONSTRAINT "UsageQuotaAllocation_quotaLotId_fkey" FOREIGN KEY ("quotaLotId") REFERENCES "QuotaLot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
