-- Store verification and initial-cycle delivery links. No backfill or execution here.
CREATE TABLE "StorePurchase" (
  "id" TEXT NOT NULL, "platform" TEXT NOT NULL, "chainKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL, "referenceCipher" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StorePurchase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StorePurchase_platform_check" CHECK ("platform" IN ('APPLE', 'GOOGLE'))
);
CREATE TABLE "StoreCycle" (
  "id" TEXT NOT NULL, "platform" TEXT NOT NULL, "cycleKey" TEXT NOT NULL,
  "purchaseId" TEXT NOT NULL, "planId" TEXT NOT NULL, "productId" TEXT NOT NULL,
  "environment" TEXT NOT NULL, "state" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL, "subscriptionId" TEXT,
  "autoRenew" BOOLEAN NOT NULL, "observedAt" TIMESTAMP(3) NOT NULL,
  "refundReview" BOOLEAN NOT NULL DEFAULT false,
  "deliveryStatus" TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoreCycle_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StoreCycle_delivery_check" CHECK ("deliveryStatus" IN ('REVIEW_REQUIRED', 'GRANTED')),
  CONSTRAINT "StoreCycle_platform_check" CHECK ("platform" IN ('APPLE', 'GOOGLE'))
);
CREATE UNIQUE INDEX "StorePurchase_platform_chainKey_key" ON "StorePurchase"("platform", "chainKey");
CREATE UNIQUE INDEX "StoreCycle_platform_cycleKey_key" ON "StoreCycle"("platform", "cycleKey");
CREATE INDEX "StoreCycle_purchaseId_idx" ON "StoreCycle"("purchaseId");
CREATE UNIQUE INDEX "StoreCycle_subscriptionId_key" ON "StoreCycle"("subscriptionId");
ALTER TABLE "Subscription" ADD COLUMN "billingSource" TEXT NOT NULL DEFAULT 'WEB';
ALTER TABLE "StorePurchase" ADD CONSTRAINT "StorePurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreCycle" ADD CONSTRAINT "StoreCycle_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "StorePurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreCycle" ADD CONSTRAINT "StoreCycle_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreCycle" ADD CONSTRAINT "StoreCycle_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
