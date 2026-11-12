-- CreateEnum
CREATE TYPE "PaymentSurplusAction" AS ENUM ('REFUND', 'QUOTA', 'DAYS', 'CREDIT');
CREATE TYPE "PaymentSurplusStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

-- Nullable snapshot: preserve existing payments without backfilling.
ALTER TABLE "Payment" ADD COLUMN "effectivePlanPriceSnapshot" DECIMAL(20,6);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_effectivePlanPriceSnapshot_check"
    CHECK ("effectivePlanPriceSnapshot" IS NULL OR (
        "effectivePlanPriceSnapshot" >= 0
        AND "effectivePlanPriceSnapshot" <> 'NaN'::numeric
    ));

-- CreateTable: UUID and updatedAt are supplied by Prisma Client.
CREATE TABLE "PaymentSurplusHandling" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "action" "PaymentSurplusAction" NOT NULL,
    "status" "PaymentSurplusStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "creditRemainingAmount" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "effectivePlanPriceSnapshot" DECIMAL(20,6),
    "planCharacterLimitSnapshot" INTEGER,
    "planDurationDaysSnapshot" INTEGER,
    "convertedCharacters" INTEGER,
    "convertedSeconds" BIGINT,
    "note" TEXT,
    "externalReference" TEXT,
    "createdById" TEXT NOT NULL,
    "completedById" TEXT,
    "cancelledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "PaymentSurplusHandling_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentSurplusHandling_amount_check" CHECK (
        "amount" > 0 AND "amount" <> 'NaN'::numeric
    ),
    CONSTRAINT "PaymentSurplusHandling_idempotencyKey_check" CHECK (
        "idempotencyKey" ~ '[^[:space:]]'
    ),
    CONSTRAINT "PaymentSurplusHandling_currency_check" CHECK (
        "currency" ~ '[^[:space:]]'
    ),
    CONSTRAINT "PaymentSurplusHandling_conversionAction_check" CHECK (
        ("convertedCharacters" IS NULL OR "action" = 'QUOTA')
        AND ("convertedSeconds" IS NULL OR "action" = 'DAYS')
    ),
    CONSTRAINT "PaymentSurplusHandling_creditRemainingAmount_check" CHECK (
        "creditRemainingAmount" >= 0
        AND "creditRemainingAmount" <= "amount"
        AND "creditRemainingAmount" <> 'NaN'::numeric
        AND (
            ("action" = 'CREDIT' AND "status" = 'COMPLETED'
                AND "creditRemainingAmount" = "amount")
            OR (("action" <> 'CREDIT' OR "status" <> 'COMPLETED')
                AND "creditRemainingAmount" = 0)
        )
    ),
    CONSTRAINT "PaymentSurplusHandling_priceSnapshot_check" CHECK (
        "effectivePlanPriceSnapshot" IS NULL OR (
            "effectivePlanPriceSnapshot" >= 0
            AND "effectivePlanPriceSnapshot" <> 'NaN'::numeric
        )
    ),
    CONSTRAINT "PaymentSurplusHandling_quotaSnapshot_check" CHECK (
        "planCharacterLimitSnapshot" IS NULL OR "planCharacterLimitSnapshot" > 0
    ),
    CONSTRAINT "PaymentSurplusHandling_durationSnapshot_check" CHECK (
        "planDurationDaysSnapshot" IS NULL OR "planDurationDaysSnapshot" > 0
    ),
    CONSTRAINT "PaymentSurplusHandling_convertedCharacters_check" CHECK (
        "convertedCharacters" IS NULL OR "convertedCharacters" >= 0
    ),
    CONSTRAINT "PaymentSurplusHandling_convertedSeconds_check" CHECK (
        "convertedSeconds" IS NULL OR "convertedSeconds" >= 0
    ),
    CONSTRAINT "PaymentSurplusHandling_statusAudit_check" CHECK (
        ("status" = 'PENDING'
            AND "completedById" IS NULL AND "completedAt" IS NULL
            AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
        OR ("status" = 'COMPLETED'
            AND "completedById" IS NOT NULL AND "completedAt" IS NOT NULL
            AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
        OR ("status" = 'CANCELLED'
            AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL
            AND "completedById" IS NULL AND "completedAt" IS NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSurplusHandling_idempotencyKey_key"
    ON "PaymentSurplusHandling"("idempotencyKey");
CREATE INDEX "PaymentSurplusHandling_paymentId_status_idx"
    ON "PaymentSurplusHandling"("paymentId", "status");
CREATE INDEX "PaymentSurplusHandling_action_status_idx"
    ON "PaymentSurplusHandling"("action", "status");

-- AddForeignKey
ALTER TABLE "PaymentSurplusHandling" ADD CONSTRAINT "PaymentSurplusHandling_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentSurplusHandling" ADD CONSTRAINT "PaymentSurplusHandling_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentSurplusHandling" ADD CONSTRAINT "PaymentSurplusHandling_completedById_fkey"
    FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentSurplusHandling" ADD CONSTRAINT "PaymentSurplusHandling_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cross-row rules belong in the future API transaction under a Payment lock:
-- currency must match Payment; PENDING + COMPLETED allocations must not exceed surplus.
-- Status transitions and immutability of completed records also require API enforcement.
