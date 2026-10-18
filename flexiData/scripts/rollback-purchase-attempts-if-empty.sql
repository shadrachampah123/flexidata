-- OPERATOR-ONLY recovery script. Do NOT use as a routine rollback.
--
-- Drops purchase_attempts ONLY when it is absent or contains zero rows. If any
-- claim exists, the script refuses and changes nothing: those rows are the
-- evidence for money already debited or submitted. Application rollback does not
-- require dropping this table: the rolled-back code does not reference it.
--
-- Run only after the reconciliation report is empty and an operator has
-- approved the rollback in writing:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback-purchase-attempts-if-empty.sql
DO $purchase_rollback$
BEGIN
  IF to_regclass('purchase_attempts') IS NULL THEN
    RAISE NOTICE 'purchase_attempts is already absent; nothing changed';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM purchase_attempts) THEN
    RAISE EXCEPTION 'refusing rollback: purchase_attempts contains rows; investigate with npm run reconcile:purchases -- --report';
  END IF;
  DROP TABLE purchase_attempts;
  RAISE NOTICE 'purchase_attempts dropped (it was empty)';
END
$purchase_rollback$;
