-- Withdrawal payout system (additive; no destructive changes)
--
-- WHAT THIS MIGRATION ADDS:
--
-- 1. Add 'refunded' to withdrawal_status enum (alongside existing values)
-- 2. Add provider tracking columns to withdrawal_requests
-- 3. Create withdrawal_audit_logs table for the audit trail
-- 4. Create payout_reconciliation_exceptions table
-- 5. Add indexes for the new queries
--
-- All additions are backward-compatible. No rows are altered.
-- No balances are touched.

-- Step 1: Extend the withdrawal_status enum with 'refunded'
DO $withdrawal_payout$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
    WHERE pg_type.typname = 'withdrawal_status'
    AND pg_enum.enumlabel = 'refunded'
  ) THEN
    ALTER TYPE "withdrawal_status" ADD VALUE 'refunded';
  END IF;
END
$withdrawal_payout$;--> statement-breakpoint

-- Step 2: Add provider tracking columns to withdrawal_requests
ALTER TABLE "withdrawal_requests"
  ADD COLUMN IF NOT EXISTS "provider_reference" varchar(120),
  ADD COLUMN IF NOT EXISTS "provider_status" varchar(80),
  ADD COLUMN IF NOT EXISTS "provider_message" varchar(240),
  ADD COLUMN IF NOT EXISTS "provider_payload" jsonb,
  ADD COLUMN IF NOT EXISTS "processed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "completed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "currency" varchar(8) NOT NULL DEFAULT 'GHS';--> statement-breakpoint

-- Step 3: Create withdrawal audit logs table
CREATE TABLE IF NOT EXISTS "withdrawal_audit_logs" (
  "id" serial PRIMARY KEY,
  "withdrawal_id" integer NOT NULL REFERENCES "withdrawal_requests"("id") ON DELETE CASCADE,
  "withdrawal_ref" varchar(40) NOT NULL,
  "event" varchar(40) NOT NULL,
  "previous_status" varchar(20),
  "new_status" varchar(20),
  "actor_type" varchar(20) NOT NULL DEFAULT 'system',
  "actor_id" integer,
  "actor_email" varchar(160),
  "provider_reference" varchar(120),
  "reason" varchar(240),
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Indexes for the audit trail
CREATE INDEX IF NOT EXISTS "withdrawal_audit_logs_withdrawal_id_idx"
  ON "withdrawal_audit_logs" ("withdrawal_id");
CREATE INDEX IF NOT EXISTS "withdrawal_audit_logs_withdrawal_ref_idx"
  ON "withdrawal_audit_logs" ("withdrawal_ref");
CREATE INDEX IF NOT EXISTS "withdrawal_audit_logs_event_idx"
  ON "withdrawal_audit_logs" ("event");
CREATE INDEX IF NOT EXISTS "withdrawal_audit_logs_created_at_idx"
  ON "withdrawal_audit_logs" ("created_at");--> statement-breakpoint

-- Step 4: Create payout reconciliation exceptions table
CREATE TABLE IF NOT EXISTS "payout_reconciliation_exceptions" (
  "id" serial PRIMARY KEY,
  "withdrawal_id" integer REFERENCES "withdrawal_requests"("id") ON DELETE SET NULL,
  "withdrawal_ref" varchar(40),
  "exception_type" varchar(40) NOT NULL,
  "description" varchar(500) NOT NULL,
  "local_status" varchar(20),
  "provider_status" varchar(80),
  "provider_reference" varchar(120),
  "expected_amount" numeric(12,2),
  "actual_amount" numeric(12,2),
  "currency" varchar(8) NOT NULL DEFAULT 'GHS',
  "resolved" boolean NOT NULL DEFAULT false,
  "resolved_at" timestamptz,
  "resolved_by" integer,
  "resolution_note" varchar(240),
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Indexes for reconciliation
CREATE INDEX IF NOT EXISTS "payout_reconciliation_exceptions_type_idx"
  ON "payout_reconciliation_exceptions" ("exception_type");
CREATE INDEX IF NOT EXISTS "payout_reconciliation_exceptions_resolved_idx"
  ON "payout_reconciliation_exceptions" ("resolved");
CREATE INDEX IF NOT EXISTS "payout_reconciliation_exceptions_created_at_idx"
  ON "payout_reconciliation_exceptions" ("created_at");--> statement-breakpoint

-- Step 5: Additional indexes on withdrawal_requests for new queries
CREATE INDEX IF NOT EXISTS "withdrawal_requests_provider_ref_idx"
  ON "withdrawal_requests" ("provider_reference")
  WHERE "provider_reference" IS NOT NULL;--> statement-breakpoint

-- Step 6: Constraint for valid event types in audit log
DO $withdrawal_payout$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'withdrawal_audit_logs_event_check'
  ) THEN
    ALTER TABLE "withdrawal_audit_logs"
      ADD CONSTRAINT "withdrawal_audit_logs_event_check"
      CHECK ("event" IN (
        'created', 'approved', 'rejected', 'moved_to_processing',
        'callback_received', 'marked_successful', 'payout_failed',
        'refunded', 'provider_timeout'
      ));
  END IF;
END
$withdrawal_payout$;--> statement-breakpoint

-- Step 7: Constraint for valid exception types
DO $withdrawal_payout$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payout_reconciliation_exceptions_type_check'
  ) THEN
    ALTER TABLE "payout_reconciliation_exceptions"
      ADD CONSTRAINT "payout_reconciliation_exceptions_type_check"
      CHECK ("exception_type" IN (
        'stuck_processing', 'provider_success_local_processing',
        'provider_failure_local_processing', 'amount_mismatch',
        'duplicate_provider_reference', 'unknown_provider_reference',
        'currency_mismatch'
      ));
  END IF;
END
$withdrawal_payout$;
