UPDATE "Subscription" AS s
SET "characterLimit" = p."characterLimit"
FROM "Plan" AS p
WHERE s."planId" = p."id"
  AND s."rolloverCharacters" > 0
  AND s."characterLimit" = p."characterLimit" + s."rolloverCharacters";
