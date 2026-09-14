-- Add quota fields to Subscription
ALTER TABLE "Subscription"
ADD COLUMN "characterLimit" INTEGER,
ADD COLUMN "rolloverCharacters" INTEGER NOT NULL DEFAULT 0;

-- Add subscription reference to Usage
ALTER TABLE "Usage"
ADD COLUMN "subscriptionId" TEXT;

-- Create index
CREATE INDEX "Usage_subscriptionId_idx"
ON "Usage"("subscriptionId");

-- Create foreign key
ALTER TABLE "Usage"
ADD CONSTRAINT "Usage_subscriptionId_fkey"
FOREIGN KEY ("subscriptionId")
REFERENCES "Subscription"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

-- Backfill characterLimit for existing subscriptions
UPDATE "Subscription" s
SET "characterLimit" = p."characterLimit"
FROM "Plan" p
WHERE s."planId" = p."id"
  AND s."characterLimit" IS NULL;

-- Create a FREE subscription for users who have historical Usage
-- but do not have any Subscription yet.
INSERT INTO "Subscription" (
    "id",
    "userId",
    "planId",
    "startedAt",
    "expiresAt",
    "status",
    "characterLimit",
    "rolloverCharacters",
        "pricePaid",
    "currency",
    "updatedAt"
)
SELECT
    md5(u."userId" || ':FREE')::uuid,
    u."userId",
    p."id",
    MIN(u."createdAt"),
    MIN(u."createdAt") + (p."durationDays" || ' days')::interval,
    'ACTIVE',
    p."characterLimit",
    0,
    0,
    p."currency",
    NOW()
FROM "Usage" u
CROSS JOIN "Plan" p
WHERE p."code" = 'FREE'
  AND NOT EXISTS (
      SELECT 1
      FROM "Subscription" s
      WHERE s."userId" = u."userId"
  )
GROUP BY
    u."userId",
    p."id",
    p."durationDays",
    p."characterLimit",
    p."currency";

-- Backfill Usage to the correct Subscription cycle
UPDATE "Usage" u
SET "subscriptionId" = s."id"
FROM "Subscription" s
WHERE u."userId" = s."userId"
  AND u."createdAt" >= s."startedAt"
  AND u."createdAt" < s."expiresAt"
  AND u."subscriptionId" IS NULL;

-- Make characterLimit required
ALTER TABLE "Subscription"
ALTER COLUMN "characterLimit" SET NOT NULL;

-- Make subscriptionId required
ALTER TABLE "Usage"
ALTER COLUMN "subscriptionId" SET NOT NULL;