-- Widen `admin_audit_logs_action_check` (and the replay-safe partial unique
-- index) to accept the withdrawal actions.
--
-- Why this migration exists: `0006_massive_vertigo.sql` widened the audit
-- action CHECK to include 'approve_withdrawal' / 'reject_withdrawal', but a
-- production database migrated before that file landed still enforces the
-- 0003-era list:
--
--   CHECK (action in ('suspend','activate','delivery_resolved','refund_review'))
--
-- Every admin withdrawal action then dies on its LAST statement —
--
--   SQLSTATE 23514 check_violation
--   new row for relation "admin_audit_logs" violates check constraint
--   "admin_audit_logs_action_check"  (action = 'reject_withdrawal')
--
-- which rolls back the whole reject transaction (status update, wallet
-- refund, ledger update and all) and the admin UI shows
-- "Failed to process action". `drizzle-kit push` does not reliably re-diff
-- CHECK definitions that already exist under the same name, and the runtime
-- self-heal in `src/lib/seed.ts` covered only `withdrawal_requests` — so the
-- drift survived until now.
--
-- This migration is SAFE and IDEMPOTENT BY CONSTRUCTION:
--   * it drops the constraint only to re-add the exact widened definition
--     `src/db/schema.ts` (and 0006) already declare;
--   * re-adding a CHECK requires a table scan, never a rewrite — existing
--     rows already satisfy it (they were written under the old, narrower
--     constraint);
--   * no table is dropped, no column changes, no row is inserted, updated
--     or deleted — including the genuine Paystack deposit DP-MTMZN2P8SSBR;
--   * running it against a database that already applied 0006 re-creates
--     identical objects (a harmless no-op swap);
--   * the partial unique index is re-created with the widened predicate so
--     replay safety ("at most one audit row per target per action") covers
--     withdrawal actions too.
ALTER TABLE "admin_audit_logs" DROP CONSTRAINT IF EXISTS "admin_audit_logs_action_check";--> statement-breakpoint
DROP INDEX IF EXISTS "admin_audit_logs_order_action_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "admin_audit_logs_order_action_idx" ON "admin_audit_logs" USING btree ("target_ref","action") WHERE "admin_audit_logs"."target_ref" is not null and "admin_audit_logs"."action" in ('delivery_resolved', 'refund_review', 'approve_withdrawal', 'reject_withdrawal');--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_action_check" CHECK ("admin_audit_logs"."action" in ('suspend', 'activate', 'delivery_resolved', 'refund_review', 'approve_withdrawal', 'reject_withdrawal'));
