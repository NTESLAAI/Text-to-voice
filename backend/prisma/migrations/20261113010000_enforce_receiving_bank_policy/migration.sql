-- Requires a verified maintenance window: ALL old writers stopped before BOTH migrations.
BEGIN;
SET LOCAL search_path = public, pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE "Payment", "PaymentTransaction", "PaymentSurplusHandling", "ReceivingBankAccount" IN ACCESS EXCLUSIVE MODE;
-- Replacement indexes exist before the original is removed. NULL external IDs
-- retain legacy PostgreSQL semantics; new bank inserts require a nonempty ID.
CREATE UNIQUE INDEX "PaymentTransaction_nonmanual_provider_key" ON "PaymentTransaction"("provider","providerTransactionId") WHERE "provider" <> 'BANK_TRANSFER';
CREATE UNIQUE INDEX "PaymentTransaction_manual_account_key" ON "PaymentTransaction"("receivingBankAccountId","providerTransactionId") WHERE "provider"='BANK_TRANSFER' AND "receivingBankAccountId" IS NOT NULL;
CREATE UNIQUE INDEX "PaymentTransaction_manual_legacy_key" ON "PaymentTransaction"("provider","providerTransactionId") WHERE "provider"='BANK_TRANSFER' AND "receivingBankAccountId" IS NULL;
DROP INDEX "PaymentTransaction_provider_providerTransactionId_key";

CREATE FUNCTION "bank_account_immutable"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_ACCOUNT_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."isActive" OR NEW."deactivatedAt" IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_ACCOUNT_MUST_START_INACTIVE'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.code,NEW."bankCode",NEW."accountNumber",NEW."accountName",NEW.currency,NEW.policy,NEW."createdAt") IS DISTINCT FROM ROW(OLD.id,OLD.code,OLD."bankCode",OLD."accountNumber",OLD."accountName",OLD.currency,OLD.policy,OLD."createdAt") OR OLD."deactivatedAt" IS NOT NULL THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_ACCOUNT_IMMUTABLE';
  END IF;
  IF OLD."isActive" AND NOT NEW."isActive" THEN NEW."deactivatedAt" := clock_timestamp();
  ELSIF NEW."deactivatedAt" IS DISTINCT FROM OLD."deactivatedAt" THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_ACCOUNT_CUTOFF_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ReceivingBankAccount_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ReceivingBankAccount" FOR EACH ROW EXECUTE FUNCTION "bank_account_immutable"();

CREATE FUNCTION "bank_source_valid"(r public."PaymentTransaction", a public."ReceivingBankAccount") RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
 SELECT r."receivingBankAccountId" IS NOT NULL AND a.id=r."receivingBankAccountId" AND
 r.currency=a.currency AND r.amount>0 AND r.amount<'Infinity'::float8 AND
 r."providerTransactionId" IS NOT NULL AND length(btrim(r."providerTransactionId"))>0 AND
 (r.status<>'MATCHED' OR r."matchedAt" IS NOT NULL) AND
 r."sourceVerifiedAt" IS NOT NULL AND (a."isActive" OR (a."deactivatedAt" IS NOT NULL AND r."sourceVerifiedAt"<=a."deactivatedAt")) AND
 ((r.provider='SEPAY' AND a.policy='SEPAY_PRIMARY' AND r."verificationSource"='SEPAY_WEBHOOK' AND r."sourceVerifiedById" IS NULL) OR
 (r.provider='BANK_TRANSFER' AND a.policy='MANUAL_ALLOWED' AND r."verificationSource"='MANUAL_ADMIN' AND r."sourceVerifiedById" IS NOT NULL AND r."verificationReference" IS NOT NULL AND length(btrim(r."verificationReference"))>0))
$$;

CREATE FUNCTION "bank_receipt_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE a public."ReceivingBankAccount"; p public."Payment";
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='RECEIPT_IMMUTABLE'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD."receivingBankAccountId" IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LEGACY_RECEIPT_REVIEW_REQUIRED'; END IF;
  IF ROW(NEW.id,NEW.provider,NEW."providerTransactionId",NEW."receivingBankAccountId",NEW.amount,NEW.currency,NEW."receivedAt",NEW."bankReference",NEW."createdAt") IS DISTINCT FROM ROW(OLD.id,OLD.provider,OLD."providerTransactionId",OLD."receivingBankAccountId",OLD.amount,OLD.currency,OLD."receivedAt",OLD."bankReference",OLD."createdAt") OR
    (OLD."paymentId" IS NOT NULL AND NEW."paymentId" IS DISTINCT FROM OLD."paymentId") OR
    (OLD."verificationSource" IS NOT NULL AND ROW(NEW."verificationSource",NEW."sourceVerifiedAt",NEW."sourceVerifiedById",NEW."verificationReference",NEW.note) IS DISTINCT FROM ROW(OLD."verificationSource",OLD."sourceVerifiedAt",OLD."sourceVerifiedById",OLD."verificationReference",OLD.note)) OR
    (OLD.status='MATCHED' AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='RECEIPT_IMMUTABLE';
  END IF;
 END IF;
 IF NEW.provider NOT IN ('SEPAY','BANK_TRANSFER') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_PROVIDER_UNSUPPORTED'; END IF;
 IF NEW."receivingBankAccountId" IS NULL OR NEW."providerTransactionId" IS NULL OR length(btrim(NEW."providerTransactionId"))=0 OR NEW."providerTransactionId"<>btrim(NEW."providerTransactionId") THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_RECEIPT_IDENTITY_REQUIRED'; END IF;
 SELECT * INTO a FROM public."ReceivingBankAccount" WHERE id=NEW."receivingBankAccountId" FOR SHARE;
 IF NOT FOUND OR NEW.currency<>a.currency OR NEW.amount<=0 OR NOT (NEW.amount<'Infinity'::float8) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_RECEIPT_INVALID'; END IF;
 IF (NEW.provider='BANK_TRANSFER' AND a.policy<>'MANUAL_ALLOWED') OR (NEW.provider='SEPAY' AND a.policy<>'SEPAY_PRIMARY') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_POLICY_REFUSED'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT a."isActive" THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_ACCOUNT_INACTIVE'; END IF;
  IF NEW.provider='BANK_TRANSFER' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('BANK_TRANSFER:'||NEW."providerTransactionId",0));
   IF EXISTS(SELECT 1 FROM public."PaymentTransaction" WHERE provider='BANK_TRANSFER' AND "receivingBankAccountId" IS NULL AND "providerTransactionId"=NEW."providerTransactionId") THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LEGACY_RECEIPT_REVIEW_REQUIRED'; END IF;
   IF NEW.status<>'UNMATCHED' OR NEW."verificationSource" IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='MANUAL_RECEIPT_MUST_START_UNVERIFIED'; END IF;
  ELSE
   IF NEW."verificationSource" IS DISTINCT FROM 'SEPAY_WEBHOOK'::public."ReceiptVerificationSource" THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SOURCE_VERIFICATION_REQUIRED'; END IF;
   NEW."sourceVerifiedAt" := clock_timestamp();
  END IF;
 ELSIF OLD."verificationSource" IS NULL AND NEW."verificationSource" IS NOT NULL THEN
  IF NOT a."isActive" OR OLD.status<>'UNMATCHED' OR NEW.status<>'RECEIVED' OR NEW."verificationSource"<>'MANUAL_ADMIN' OR NEW."sourceVerifiedById" IS NULL OR NOT EXISTS(SELECT 1 FROM public."User" WHERE id=NEW."sourceVerifiedById" AND role='ADMIN') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SOURCE_VERIFICATION_REFUSED'; END IF;
  NEW."sourceVerifiedAt" := clock_timestamp();
 END IF;
 IF NEW."paymentId" IS NOT NULL THEN
  SELECT * INTO p FROM public."Payment" WHERE id=NEW."paymentId";
  IF NOT FOUND OR p."receivingBankAccountId" IS DISTINCT FROM NEW."receivingBankAccountId" OR p.currency<>NEW.currency THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='RECEIVING_ACCOUNT_MISMATCH'; END IF;
 END IF;
 IF NEW.status IN ('RECEIVED','MATCHED') AND NOT coalesce(public."bank_source_valid"(NEW,a),false) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SOURCE_VERIFICATION_REQUIRED'; END IF;
 IF TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status='UNMATCHED' AND NEW.status='RECEIVED') OR (OLD.status='RECEIVED' AND NEW.status='MATCHED')) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='RECEIPT_TRANSITION_REFUSED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "PaymentTransaction_bank_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PaymentTransaction" FOR EACH ROW EXECUTE FUNCTION "bank_receipt_guard"();

CREATE FUNCTION "bank_payment_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public SET extra_float_digits = 3 AS $$
DECLARE a public."ReceivingBankAccount";
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PAYMENT_AUDIT_IMMUTABLE'; END IF;
 IF TG_OP='UPDATE' AND NEW."receivingBankAccountId" IS DISTINCT FROM OLD."receivingBankAccountId" THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PAYMENT_ACCOUNT_IMMUTABLE'; END IF;
 IF NEW.provider='BANK_TRANSFER' AND TG_OP='INSERT' THEN
  IF NEW.amount<0 OR NOT (NEW.amount<'Infinity'::float8) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PAYMENT_AMOUNT_INVALID'; END IF;
  SELECT * INTO a FROM public."ReceivingBankAccount" WHERE id=NEW."receivingBankAccountId" FOR SHARE;
  IF NOT FOUND OR NOT a."isActive" OR a.currency<>NEW.currency THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_ACCOUNT_NOT_READY'; END IF;
 END IF;
 IF NEW.provider='BANK_TRANSFER' AND NEW.status='PAID' AND (TG_OP='INSERT' OR OLD.status<>'PAID') THEN
  IF NEW."receivingBankAccountId" IS NULL OR EXISTS(SELECT 1 FROM public."PaymentTransaction" r LEFT JOIN public."ReceivingBankAccount" a ON a.id=r."receivingBankAccountId" WHERE r."paymentId"=NEW.id AND r.status='MATCHED' AND (r."receivingBankAccountId" IS DISTINCT FROM NEW."receivingBankAccountId" OR r.currency<>NEW.currency OR NOT coalesce(public."bank_source_valid"(r,a),false))) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PAYMENT_SOURCE_UNVERIFIED'; END IF;
  IF coalesce((SELECT sum(r.amount::text::numeric) FROM public."PaymentTransaction" r WHERE r."paymentId"=NEW.id AND r.status='MATCHED'),0)<NEW.amount::text::numeric THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PAYMENT_UNDERFUNDED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Payment_bank_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION "bank_payment_guard"();

CREATE FUNCTION "bank_surplus_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public SET extra_float_digits = 3 AS $$
DECLARE p public."Payment";
BEGIN
 IF TG_OP='UPDATE' AND OLD.status IN ('COMPLETED','CANCELLED') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SURPLUS_AUDIT_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' OR (OLD.status='PENDING' AND NEW.status='COMPLETED') THEN
  SELECT * INTO p FROM public."Payment" WHERE id=NEW."paymentId" FOR UPDATE;
  IF p.status<>'PAID' OR p."receivingBankAccountId" IS NULL OR EXISTS(SELECT 1 FROM public."PaymentTransaction" r LEFT JOIN public."ReceivingBankAccount" a ON a.id=r."receivingBankAccountId" WHERE r."paymentId"=p.id AND r.status='MATCHED' AND (r."receivingBankAccountId" IS DISTINCT FROM p."receivingBankAccountId" OR r.currency<>p.currency OR NOT coalesce(public."bank_source_valid"(r,a),false))) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SURPLUS_SOURCE_UNVERIFIED'; END IF;
  IF NEW.currency<>p.currency OR NEW.action NOT IN ('REFUND','CREDIT') OR
    coalesce((SELECT sum(h.amount) FROM public."PaymentSurplusHandling" h WHERE h."paymentId"=p.id AND h.status IN ('PENDING','COMPLETED') AND h.id<>NEW.id),0)+NEW.amount >
    greatest(0,coalesce((SELECT sum(r.amount::text::numeric) FROM public."PaymentTransaction" r WHERE r."paymentId"=p.id AND r.status='MATCHED'),0)-p.amount::text::numeric)
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SURPLUS_ALLOCATION_REFUSED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "PaymentSurplusHandling_source_guard" BEFORE INSERT OR UPDATE ON "PaymentSurplusHandling" FOR EACH ROW EXECUTE FUNCTION "bank_surplus_guard"();
REVOKE ALL ON FUNCTION "bank_account_immutable"(),"bank_receipt_guard"(),"bank_payment_guard"(),"bank_surplus_guard"() FROM PUBLIC;
DROP TRIGGER "Payment_rollout_fence" ON "Payment";
DROP TRIGGER "PaymentTransaction_rollout_fence" ON "PaymentTransaction";
DROP TRIGGER "PaymentSurplusHandling_rollout_fence" ON "PaymentSurplusHandling";
DROP FUNCTION "bank_rollout_fence"();
COMMIT;
