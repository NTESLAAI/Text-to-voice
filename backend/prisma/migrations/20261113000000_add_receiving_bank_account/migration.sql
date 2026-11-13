BEGIN;
SET LOCAL search_path = public, pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TYPE "ReceivingBankPolicy" AS ENUM ('SEPAY_PRIMARY','MANUAL_ALLOWED');
CREATE TYPE "ReceiptVerificationSource" AS ENUM ('SEPAY_WEBHOOK','MANUAL_ADMIN');
CREATE TABLE "ReceivingBankAccount" (
 "id" TEXT PRIMARY KEY,"code" TEXT NOT NULL,"bankCode" TEXT NOT NULL,
 "accountNumber" TEXT NOT NULL,"accountName" TEXT NOT NULL,"currency" TEXT NOT NULL DEFAULT 'VND',
 "policy" "ReceivingBankPolicy" NOT NULL,"isActive" BOOLEAN NOT NULL DEFAULT false,
 "deactivatedAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ReceivingBankAccount_identity_check" CHECK (
  length("code") BETWEEN 1 AND 100 AND "code"=btrim("code") AND
  length("bankCode") BETWEEN 1 AND 100 AND "bankCode"=lower(btrim("bankCode")) AND
  length("accountNumber") BETWEEN 1 AND 100 AND "accountNumber"=btrim("accountNumber") AND
  length(btrim("accountName")) BETWEEN 1 AND 200 AND "currency"='VND' AND
  NOT ("isActive" AND "deactivatedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "ReceivingBankAccount_code_key" ON "ReceivingBankAccount"("code");
CREATE UNIQUE INDEX "ReceivingBankAccount_bankCode_accountNumber_key" ON "ReceivingBankAccount"("bankCode","accountNumber");
ALTER TABLE "Payment" ADD COLUMN "receivingBankAccountId" TEXT;
ALTER TABLE "PaymentTransaction" ADD COLUMN "receivingBankAccountId" TEXT,
 ADD COLUMN "bankReference" TEXT, ADD COLUMN "verificationSource" "ReceiptVerificationSource",
 ADD COLUMN "sourceVerifiedAt" TIMESTAMP(3), ADD COLUMN "sourceVerifiedById" TEXT, ADD COLUMN "verificationReference" TEXT;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_receivingBankAccountId_fkey" FOREIGN KEY ("receivingBankAccountId") REFERENCES "ReceivingBankAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_receivingBankAccountId_fkey" FOREIGN KEY ("receivingBankAccountId") REFERENCES "ReceivingBankAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT "PaymentTransaction_sourceVerifiedById_fkey" FOREIGN KEY ("sourceVerifiedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT "PaymentTransaction_source_tuple_check" CHECK (
  ("verificationSource" IS NULL AND "sourceVerifiedAt" IS NULL AND "sourceVerifiedById" IS NULL) OR
  ("verificationSource" IS NOT NULL AND "sourceVerifiedAt" IS NOT NULL AND "receivingBankAccountId" IS NOT NULL AND
   (("verificationSource"='SEPAY_WEBHOOK' AND "provider"='SEPAY' AND "sourceVerifiedById" IS NULL) OR
    ("verificationSource"='MANUAL_ADMIN' AND "provider"='BANK_TRANSFER' AND "sourceVerifiedById" IS NOT NULL AND "verificationReference" IS NOT NULL AND length(btrim("verificationReference")) BETWEEN 1 AND 200))));
CREATE INDEX "Payment_receivingBankAccountId_idx" ON "Payment"("receivingBankAccountId");
CREATE INDEX "PaymentTransaction_receivingBankAccountId_idx" ON "PaymentTransaction"("receivingBankAccountId");
CREATE INDEX "PaymentTransaction_sourceVerifiedById_idx" ON "PaymentTransaction"("sourceVerifiedById");
-- Close the migration-1/migration-2 interval at the database as well as the
-- maintenance ingress. Removed ONLY after all final guards exist in migration 2.
CREATE FUNCTION "bank_rollout_fence"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF TG_TABLE_NAME='PaymentTransaction' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_ROLLOUT_NOT_COMPLETE'; END IF;
 IF TG_TABLE_NAME='Payment' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_ROLLOUT_NOT_COMPLETE'; END IF;
  IF NEW.provider='BANK_TRANSFER' AND (TG_OP='INSERT' OR NEW.status='PAID' OR NEW."receivingBankAccountId" IS DISTINCT FROM OLD."receivingBankAccountId") THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_ROLLOUT_NOT_COMPLETE'; END IF;
 ELSIF TG_TABLE_NAME='PaymentSurplusHandling' THEN
  IF TG_OP='INSERT' OR (OLD.status='PENDING' AND NEW.status='COMPLETED') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='BANK_ROLLOUT_NOT_COMPLETE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Payment_rollout_fence" BEFORE INSERT OR UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION "bank_rollout_fence"();
CREATE TRIGGER "PaymentTransaction_rollout_fence" BEFORE INSERT OR UPDATE OR DELETE ON "PaymentTransaction" FOR EACH ROW EXECUTE FUNCTION "bank_rollout_fence"();
CREATE TRIGGER "PaymentSurplusHandling_rollout_fence" BEFORE INSERT OR UPDATE ON "PaymentSurplusHandling" FOR EACH ROW EXECUTE FUNCTION "bank_rollout_fence"();
REVOKE ALL ON FUNCTION "bank_rollout_fence"() FROM PUBLIC;
COMMIT;
