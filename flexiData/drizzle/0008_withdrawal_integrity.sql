-- Payout-readiness remediation (F2 + F6): withdrawal idempotency + stored-data integrity.
--
-- WHAT THIS MIGRATION ADDS (all additive; no table/column is dropped, no row is
-- rewritten, no balance is touched):
--
--   1. `withdrawal_requests.idempotency_key` (nullable; legacy rows stay NULL).
--   2. Partial unique index `withdrawal_requests_wallet_idempotency_idx` on
--      (wallet_id, idempotency_key) WHERE idempotency_key IS NOT NULL — the
--      database enforcement behind "a retried withdrawal can never deduct twice".
--   3. Four CHECK constraints making impossible withdrawal states unrepresentable:
--        withdrawal_requests_amount_positive_check      amount > 0
--        withdrawal_requests_fee_within_amount_check    0 <= fee <= amount
--        withdrawal_requests_amount_split_check        amount = fee + net_amount
--        withdrawal_requests_method_check               destination_method IN ('momo_mtn','telecel_cash')
--
-- PRODUCTION SAFETY (report-first, never rewrite):
--
--   * The CHECK constraints are added `NOT VALID`: every NEW or UPDATED row is
--     enforced immediately, while pre-existing rows are left untouched.
--   * Before validation, a report block lists (via RAISE NOTICE) every existing
--     row that would violate each constraint, identified by its `ref` — nothing
--     is deleted, updated or "repaired".
--   * Each constraint is VALIDATEd only when it currently has ZERO violations;
--     otherwise validation is refused (loud NOTICE naming the refs) and the
--     constraint stays `NOT VALID` — new writes are still protected while the
--     legacy rows await a human decision. Re-running `VALIDATE CONSTRAINT`
--     after the data is addressed converges the schema with no further migration.
--   * The unique index is created only when no duplicate (wallet_id,
--     idempotency_key) pair exists; duplicates (only possible via hand-edited
--     data — the application cannot write them) are reported and fail the
--     migration LOUDLY rather than being silently skipped, because silently
--     skipping would leave idempotency unenforced with only a log line.
--
-- Every statement is guarded (`IF NOT EXISTS` / catalog checks) so this file is
-- safe to re-apply and converges with the runtime self-heal in
-- `src/lib/seed.ts` (`repairWithdrawalSchema`), which performs the same steps.
ALTER TABLE "withdrawal_requests" ADD COLUMN IF NOT EXISTS "idempotency_key" varchar(64);--> statement-breakpoint
DO $withdrawal_integrity$
declare
  dup_count integer;
  dup_refs text;
begin
  -- Report-first: duplicates would fail the unique index below. The application
  -- cannot write them (wallet-row serialization + an in-transaction re-check),
  -- so any that exist are hand-edited data the operator must resolve.
  select count(*), string_agg(w.ref, ', ' order by w.ref)
    into dup_count, dup_refs
    from (
      select ref, wallet_id, idempotency_key,
             count(*) over (partition by wallet_id, idempotency_key) as n
        from withdrawal_requests
       where idempotency_key is not null
    ) w
   where w.n > 1;
  if dup_count is not null and dup_count > 0 then
    raise notice '[flexidata 0008] REFUSING to create withdrawal_requests_wallet_idempotency_idx: % row(s) share a (wallet_id, idempotency_key) pair: %. Resolve the duplicates (no row is touched by this migration) and re-run.',
      dup_count, dup_refs;
    raise exception 'withdrawal_requests holds duplicate (wallet_id, idempotency_key) pairs: %', dup_refs
      using errcode = '23505';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'withdrawal_requests_wallet_idempotency_idx') then
    create unique index "withdrawal_requests_wallet_idempotency_idx"
      on "withdrawal_requests" using btree ("wallet_id", "idempotency_key")
      where "withdrawal_requests"."idempotency_key" is not null;
  end if;
end
$withdrawal_integrity$;--> statement-breakpoint
DO $withdrawal_integrity$
declare
  missing_constraint text;
begin
  -- Add each CHECK as NOT VALID (new/updated rows enforced at once; existing
  -- rows untouched). Guarded by constraint name so re-applying is a no-op.
  if not exists (select 1 from pg_constraint where conname = 'withdrawal_requests_amount_positive_check') then
    alter table "withdrawal_requests"
      add constraint "withdrawal_requests_amount_positive_check"
      check ("withdrawal_requests"."amount" > 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'withdrawal_requests_fee_within_amount_check') then
    alter table "withdrawal_requests"
      add constraint "withdrawal_requests_fee_within_amount_check"
      check ("withdrawal_requests"."fee" >= 0 and "withdrawal_requests"."fee" <= "withdrawal_requests"."amount") not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'withdrawal_requests_amount_split_check') then
    alter table "withdrawal_requests"
      add constraint "withdrawal_requests_amount_split_check"
      check ("withdrawal_requests"."amount" = "withdrawal_requests"."fee" + "withdrawal_requests"."net_amount") not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'withdrawal_requests_method_check') then
    alter table "withdrawal_requests"
      add constraint "withdrawal_requests_method_check"
      check ("withdrawal_requests"."destination_method" in ('momo_mtn', 'telecel_cash')) not valid;
  end if;
end
$withdrawal_integrity$;--> statement-breakpoint
DO $withdrawal_integrity$
declare
  v_count integer;
  v_refs text;
begin
  -- Report-first: name every existing violator by ref. This block NEVER raises
  -- and NEVER writes — it only reports, so the rows it names are preserved.
  select count(*), string_agg(ref, ', ' order by ref) into v_count, v_refs
    from withdrawal_requests where not (amount > 0);
  if v_count > 0 then
    raise notice '[flexidata 0008] withdrawal_requests_amount_positive_check violated by % row(s): %. Rows preserved; constraint left NOT VALID.',
      v_count, v_refs;
  end if;
  select count(*), string_agg(ref, ', ' order by ref) into v_count, v_refs
    from withdrawal_requests where not (fee >= 0 and fee <= amount);
  if v_count > 0 then
    raise notice '[flexidata 0008] withdrawal_requests_fee_within_amount_check violated by % row(s): %. Rows preserved; constraint left NOT VALID.',
      v_count, v_refs;
  end if;
  select count(*), string_agg(ref, ', ' order by ref) into v_count, v_refs
    from withdrawal_requests where not (amount = fee + net_amount);
  if v_count > 0 then
    raise notice '[flexidata 0008] withdrawal_requests_amount_split_check violated by % row(s): %. Rows preserved; constraint left NOT VALID.',
      v_count, v_refs;
  end if;
  select count(*), string_agg(ref, ', ' order by ref) into v_count, v_refs
    from withdrawal_requests where not (destination_method in ('momo_mtn', 'telecel_cash'));
  if v_count > 0 then
    raise notice '[flexidata 0008] withdrawal_requests_method_check violated by % row(s): %. Rows preserved; constraint left NOT VALID.',
      v_count, v_refs;
  end if;

  -- Conditional validation: VALIDATE only what is currently clean; refuse (with
  -- the refs in the log) anything that is not. A refused constraint still
  -- enforces every future write — only the legacy rows stay unvalidated.
  select string_agg(ref, ', ' order by ref) into v_refs
    from withdrawal_requests where not (amount > 0);
  if v_refs is null then
    alter table "withdrawal_requests" validate constraint "withdrawal_requests_amount_positive_check";
  else
    raise notice '[flexidata 0008] NOT validating withdrawal_requests_amount_positive_check: % still violate(s) it.', v_refs;
  end if;
  select string_agg(ref, ', ' order by ref) into v_refs
    from withdrawal_requests where not (fee >= 0 and fee <= amount);
  if v_refs is null then
    alter table "withdrawal_requests" validate constraint "withdrawal_requests_fee_within_amount_check";
  else
    raise notice '[flexidata 0008] NOT validating withdrawal_requests_fee_within_amount_check: % still violate(s) it.', v_refs;
  end if;
  select string_agg(ref, ', ' order by ref) into v_refs
    from withdrawal_requests where not (amount = fee + net_amount);
  if v_refs is null then
    alter table "withdrawal_requests" validate constraint "withdrawal_requests_amount_split_check";
  else
    raise notice '[flexidata 0008] NOT validating withdrawal_requests_amount_split_check: % still violate(s) it.', v_refs;
  end if;
  select string_agg(ref, ', ' order by ref) into v_refs
    from withdrawal_requests where not (destination_method in ('momo_mtn', 'telecel_cash'));
  if v_refs is null then
    alter table "withdrawal_requests" validate constraint "withdrawal_requests_method_check";
  else
    raise notice '[flexidata 0008] NOT validating withdrawal_requests_method_check: % still violate(s) it.', v_refs;
  end if;
end
$withdrawal_integrity$;
