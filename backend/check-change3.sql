SELECT
  u.email,
  s.id AS subscription_id,
  p.code AS plan,
  s.status,
  s."startedAt",
  s."expiresAt",
  q.id AS quota_lot_id,
  q."charactersGranted",
  q."charactersRemaining",
  q."rolloverCount",
  q."sourceLotId"
FROM "User" u
JOIN "Subscription" s ON s."userId" = u.id
JOIN "Plan" p ON p.id = s."planId"
LEFT JOIN "QuotaLot" q ON q."subscriptionId" = s.id
WHERE u.email = 'upgrade-a-test-20260927@ntesla.local'
ORDER BY s."startedAt", q."createdAt";
