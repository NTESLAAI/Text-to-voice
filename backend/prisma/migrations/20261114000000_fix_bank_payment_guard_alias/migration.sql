-- Correct PL/pgSQL variable/SQL alias ambiguity; no policy or data changes.
BEGIN;
SET LOCAL search_path = public, pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE OR REPLACE FUNCTION "bank_payment_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public SET extra_float_digits = 3 AS $$
DECLARE target_account public."ReceivingBankAccount";
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PAYMENT_AUDIT_IMMUTABLE'; END IF;
 IF TG_OP='UPDATE' AND NEW."receivingBankAccountId" IS DISTINCT FROM OLD."receivingBankAccountId" THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PAYMENT_ACCOUNT_IMMUTABLE'; END IF;
 IF NEW.provider='BANK_TRANSFER' AND TG_OP='INSERT' THEN
  IF NEW.amount<0 OR NOT (NEW.amount<'Infinity'::float8) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PAYMENT_AMOUNT_INVALID'; END IF;
  SELECT * INTO target_account FROM public."ReceivingBankAccount" WHERE id=NEW."receivingBankAccountId" FOR SHARE;
  IF NOT FOUND OR NOT target_account."isActive" OR target_account.currency<>NEW.currency THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_ACCOUNT_NOT_READY'; END IF;
 END IF;
 IF NEW.provider='BANK_TRANSFER' AND NEW.status='PAID' AND (TG_OP='INSERT' OR OLD.status<>'PAID') THEN
  IF NEW."receivingBankAccountId" IS NULL OR EXISTS(SELECT 1 FROM public."PaymentTransaction" r LEFT JOIN public."ReceivingBankAccount" a ON a.id=r."receivingBankAccountId" WHERE r."paymentId"=NEW.id AND r.status='MATCHED' AND (r."receivingBankAccountId" IS DISTINCT FROM NEW."receivingBankAccountId" OR r.currency<>NEW.currency OR NOT coalesce(public."bank_source_valid"(r,a),false))) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PAYMENT_SOURCE_UNVERIFIED'; END IF;
  IF coalesce((SELECT sum(r.amount::text::numeric) FROM public."PaymentTransaction" r WHERE r."paymentId"=NEW.id AND r.status='MATCHED'),0)<NEW.amount::text::numeric THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PAYMENT_UNDERFUNDED'; END IF;
 END IF;
 RETURN NEW;
END $$;
COMMIT;
