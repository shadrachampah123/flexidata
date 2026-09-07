-- PR #38 — production-safe, targeted schema migration for `reject_withdrawal`.
--
-- WHAT IT DOES (and only this):
--   Widens `admin_audit_logs_action_check` and rebuilds the replay-safe
--   partial unique index `admin_audit_logs_order_action_idx` so the admin
--   withdrawal actions ('approve_withdrawal', 'reject_withdrawal') are
--   accepted by a production database that never ran `drizzle/0006` /
--   `drizzle/0007` — the exact drift that made every reject roll back with
--   SQLSTATE 23514 on the audit INSERT and left the user's refund uncommitted.
--
-- WHY NOT `drizzle-kit push`:
--   `push` diffs src/db/schema.ts against the LIVE database and wants to make
--   it match in BOTH directions. The production database carries tables that
--   predate/exist outside the repo schema, so push detected "table removals"
--   and asked for destructive DROP TABLEs — the aborted migration. This file
--   touches NOTHING except the two `admin_audit_logs` objects (plus a
--   pre-0003 column repair that is `IF NOT EXISTS` only).
--
-- SAFETY CONTRACT — every statement is additive or a same-name swap of an
-- already-declared definition:
--   * NO DROP TABLE, NO TRUNCATE, NO DELETE, NO UPDATE, NO INSERT, NO row is
--     ever rewritten. No foreign key, no column, and no table outside
--     `admin_audit_logs` is modified — wallet balances, withdrawals, the
--     ledger and deposit_requests (including the genuine Paystack deposit
--     DP-MTMZN2P8SSBR) are provably untouched: nothing in this file can
--     reach them.
--   * The whole file runs in ONE transaction: any failure (including an
--     unexpected state the guards below detect) rolls everything back and
--     changes nothing. `lock_timeout` makes it abort rather than block a busy
--     production table.
--   * The CHECK swap only happens when the live definition still lacks the
--     withdrawal actions (identical to the app's self-heal probe); re-running
--     on a current database is a documented no-op. Existing rows satisfy the
--     widened list by construction (the old constraint was a strict subset),
--     and the file REFUSES to run if a violating row is found anyway, or if an
--     unknown second CHECK constrains `action` — it never drops objects it
--     does not know the exact definition of.
--   * Re-adding a CHECK validates with a scan, never a table rewrite, and the
--     index rebuild covers only the (tiny) audit table.
--
-- HOW TO RUN (prefer the Node runner; it adds preflight reporting, the
-- DP-MTMZN2P8SSBR before/after proof and the post-apply verification):
--   cd flexiData
--   DATABASE_URL='postgresql://…' npx tsx scripts/apply-pr38-admin-audit-migration.ts
-- Raw psql, for a DBA who wants to eyeball it:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/pr38-widen-admin-audit-log-actions.sql
--
-- Final state is byte-identical to `drizzle/0006` + `drizzle/0007` and to what
-- `src/db/schema.ts` declares, so nothing drifts for future diffs.

BEGIN;

-- Fail fast instead of queueing ACCESS EXCLUSIVE behind a busy writer.
SET LOCAL lock_timeout = '5s';

-- The migration repairs the withdrawal audit path only; creating
-- `admin_audit_logs` itself belongs to 0002/0003. A database without the
-- table must be brought up with the full migration set, not this delta.
DO $$
BEGIN
  IF to_regclass('public.admin_audit_logs') IS NULL THEN
    RAISE EXCEPTION
      'admin_audit_logs does not exist: this targeted migration deliberately creates no tables. '
      'Apply the full drizzle/ migration set (0000..0007) for this database first.';
  END IF;
END
$$;

-- Additive-only repair for pre-0003 baselines: PR #38's audit writes record
-- the withdrawal ref in `target_ref`, and the replay-safety index below needs
-- the column. `IF NOT EXISTS` keeps this a no-op everywhere it already ran.
ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS target_ref varchar(40);
CREATE INDEX IF NOT EXISTS admin_audit_logs_ref_idx ON admin_audit_logs USING btree (target_ref);

DO $$
DECLARE
  v_live text;      -- live CHECK definition
  v_def  text;      -- live index definition
  v_bad  text;      -- any row that would violate the widened CHECK
  v_odd  text;      -- unknown extra constraints on "action"
BEGIN
  -- ---------------------------------------------------------------------
  -- 1. Widen the action CHECK — only when it actually still lacks the
  --    withdrawal actions (the catalog test mirrors repairAdminAuditActions
  --    in src/lib/seed.ts, so an already-current database is a no-op).
  -- ---------------------------------------------------------------------
  SELECT pg_get_constraintdef(c.oid) INTO v_live
    FROM pg_constraint c
   WHERE c.conrelid = 'public.admin_audit_logs'::regclass
     AND c.conname  = 'admin_audit_logs_action_check'
     AND c.contype  = 'c';

  IF v_live IS NULL
     OR v_live NOT LIKE '%approve_withdrawal%'
     OR v_live NOT LIKE '%reject_withdrawal%' THEN

    -- Refuse to proceed while an unknown second CHECK also constrains the
    -- `action` column: swapping only the named one would leave the real
    -- blocker in place, and dropping objects we did not create is exactly
    -- the blind destructive behaviour this migration exists to avoid.
    SELECT string_agg(DISTINCT c.conname, ', ') INTO v_odd
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'public.admin_audit_logs'::regclass
       AND c.contype  = 'c'
       AND c.conname <> 'admin_audit_logs_action_check'
       AND a.attname  = 'action';
    IF v_odd IS NOT NULL THEN
      RAISE EXCEPTION
        'admin_audit_logs.action carries unexpected CHECK constraint(s): %. '
        'This migration only knows how to re-create admin_audit_logs_action_check — '
        'investigate/renumber the extra constraint instead; nothing was changed.', v_odd;
    END IF;

    -- Belt and braces: under the legacy (narrower) constraint such rows are
    -- impossible, but a database whose constraint was once dropped by hand
    -- could hold them — fail loudly instead of dying inside ADD CONSTRAINT.
    SELECT string_agg(DISTINCT action, ', ') INTO v_bad
      FROM admin_audit_logs
     WHERE action NOT IN ('suspend', 'activate', 'delivery_resolved',
                          'refund_review', 'approve_withdrawal', 'reject_withdrawal');
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION
        'admin_audit_logs holds % row action(s) outside the widened list: %. '
        'Nothing was changed; triage these rows first.', v_bad, v_bad;
    END IF;

    EXECUTE 'ALTER TABLE admin_audit_logs DROP CONSTRAINT IF EXISTS admin_audit_logs_action_check';
    EXECUTE $ddl$
      ALTER TABLE admin_audit_logs
        ADD CONSTRAINT admin_audit_logs_action_check
        CHECK (action in ('suspend', 'activate', 'delivery_resolved', 'refund_review',
                          'approve_withdrawal', 'reject_withdrawal'))
    $ddl$;
    RAISE NOTICE 'pr38: admin_audit_logs_action_check widened to include approve_withdrawal / reject_withdrawal';
  ELSE
    RAISE NOTICE 'pr38: admin_audit_logs_action_check already accepts the withdrawal actions — unchanged';
  END IF;

  -- ---------------------------------------------------------------------
  -- 2. Rebuild the replay-safe partial unique index with the widened
  --    predicate, so "at most one audit row per (target_ref, action)"
  --    finally covers the withdrawal actions (the exactly-once backstop
  --    that POST /api/admin/withdrawals/[id]/action claims up front).
  --    Same-name swap only; no other index is dropped.
  -- ---------------------------------------------------------------------
  SELECT indexdef INTO v_def
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname  = 'admin_audit_logs_order_action_idx';

  IF v_def IS NULL
     OR v_def NOT LIKE '%approve_withdrawal%'
     OR v_def NOT LIKE '%reject_withdrawal%' THEN
    EXECUTE 'DROP INDEX IF EXISTS admin_audit_logs_order_action_idx';
    EXECUTE $ddl$
      CREATE UNIQUE INDEX admin_audit_logs_order_action_idx
        ON admin_audit_logs USING btree (target_ref, action)
        WHERE target_ref IS NOT NULL
          AND action IN ('delivery_resolved', 'refund_review',
                         'approve_withdrawal', 'reject_withdrawal')
    $ddl$;
    RAISE NOTICE 'pr38: admin_audit_logs_order_action_idx rebuilt with the widened predicate';
  ELSE
    RAISE NOTICE 'pr38: admin_audit_logs_order_action_idx already widened — unchanged';
  END IF;
END
$$;

COMMIT;

-- Final state after COMMIT: the two admin_audit_logs objects match
-- src/db/schema.ts / drizzle/0007 exactly. Verification (read-only catalog
-- re-read, row-count + admin_audit_logs checksum comparison, and a rolled-
-- back write probe of the exact reject/approve audit INSERTs) is performed by
-- scripts/apply-pr38-admin-audit-migration.ts and by /api/health
-- (`adminAuditSchema.status` must read "current").
