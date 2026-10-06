SELECT
  p."id",
  p."userId",
  p."planId",
  p."amount",
  p."currency",
  p."status",
  p."paymentType",
  p."upgradeOption",
  p."creditAmount",
  p."createdAt"
FROM public."Payment" p
WHERE p."status" = 'PENDING'
ORDER BY p."createdAt" DESC;