DO $$
DECLARE
  v_subscription_id TEXT := 'f86fa170-e3a5-4bff-9553-e8ffbd0a87df';

  v_status TEXT;
  v_character_limit INTEGER;
  v_rollover_characters INTEGER;
  v_expires_at TIMESTAMP(3);

  v_usage_count INTEGER;
  v_quota_lot_count INTEGER;
BEGIN
  /*
   * Legacy data correction:
   * Free -> Basic previously carried 5,000 characters via
   * Subscription.rolloverCharacters.
   *
   * Under the current policy, Free quota must NOT be transferred
   * to a Paid subscription.
   *
   * This migration normalizes only the known legacy test
   * subscription identified by v_subscription_id.
   */

  SELECT
    "status",
    "characterLimit",
    "rolloverCharacters",
    "expiresAt"
  INTO
    v_status,
    v_character_limit,
    v_rollover_characters,
    v_expires_at
  FROM "Subscription"
  WHERE "id" = v_subscription_id
  FOR UPDATE;

  /*
   * If this exact test record does not exist in another environment,
   * do nothing so the migration remains safe to deploy.
   */
  IF NOT FOUND THEN
    RETURN;
  END IF;

  /*
   * Safety checks:
   * Do not modify the record if its current state is unexpected.
   */
  IF v_status <> 'ACTIVE' THEN
    RAISE EXCEPTION
      'Legacy Basic subscription % is not ACTIVE (status=%). Migration aborted.',
      v_subscription_id,
      v_status;
  END IF;

  IF v_character_limit <> 30000 THEN
    RAISE EXCEPTION
      'Legacy Basic subscription % has characterLimit=%, expected 30000. Migration aborted.',
      v_subscription_id,
      v_character_limit;
  END IF;

  IF v_rollover_characters <> 5000 THEN
    RAISE EXCEPTION
      'Legacy Basic subscription % has rolloverCharacters=%, expected 5000. Migration aborted.',
      v_subscription_id,
      v_rollover_characters;
  END IF;

  /*
   * This correction is safe only because this legacy subscription
   * has not been used and has no QuotaLot yet.
   */
  SELECT COUNT(*)
  INTO v_usage_count
  FROM "Usage"
  WHERE "subscriptionId" = v_subscription_id;

  IF v_usage_count <> 0 THEN
    RAISE EXCEPTION
      'Legacy Basic subscription % already has % Usage record(s). Migration aborted.',
      v_subscription_id,
      v_usage_count;
  END IF;

  SELECT COUNT(*)
  INTO v_quota_lot_count
  FROM "QuotaLot"
  WHERE "subscriptionId" = v_subscription_id;

  IF v_quota_lot_count <> 0 THEN
    RAISE EXCEPTION
      'Legacy Basic subscription % already has % QuotaLot record(s). Migration aborted.',
      v_subscription_id,
      v_quota_lot_count;
  END IF;

  /*
   * Remove the invalid Free -> Paid rollover.
   */
  UPDATE "Subscription"
  SET
    "rolloverCharacters" = 0,
    "updatedAt" = NOW()
  WHERE "id" = v_subscription_id;

  /*
   * Create the correct original Basic quota lot:
   * 30,000 granted / 30,000 remaining.
   */
  INSERT INTO "QuotaLot" (
    "id",
    "subscriptionId",
    "sourceLotId",
    "charactersGranted",
    "charactersRemaining",
    "rolloverCount",
    "expiresAt",
    "createdAt",
    "updatedAt"
  )
  VALUES (
    gen_random_uuid()::text,
    v_subscription_id,
    NULL,
    30000,
    30000,
    0,
    v_expires_at,
    NOW(),
    NOW()
  );
END $$;