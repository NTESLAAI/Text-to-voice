-- CreateTable
CREATE TABLE "QuotaLot" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "charactersGranted" INTEGER NOT NULL,
    "charactersRemaining" INTEGER NOT NULL,
    "rolloverCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuotaLot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuotaLot_subscriptionId_idx" ON "QuotaLot"("subscriptionId");

-- CreateIndex
CREATE INDEX "QuotaLot_expiresAt_idx" ON "QuotaLot"("expiresAt");

-- AddForeignKey
ALTER TABLE "QuotaLot" ADD CONSTRAINT "QuotaLot_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
