-- Phase B payout hardening: enforce provider-reference uniqueness.
--
-- WHAT THIS MIGRATION DOES (all additive; no table/column is dropped, no row
-- is rewritten, no balance is touched):
--
--   Converts `withdrawal_requests_provider_ref_idx` (created NON-unique by
--   0009) into a PARTIAL UNIQUE index on (provider_reference)
--   WHERE provider_reference IS NOT NULL — the database enforcement behind
--   "one provider transfer maps to at most one withdrawal".
--
-- WHY: every withdrawal sent to a payout provider carries that provider's own
-- transfer reference (Paystack `transfer_code`). The unique index makes "a
-- retried payout can never be adopted twice" database-enforced even if every
-- application-level guard were bypassed. NULLs (withdrawals never sent to a
-- provider) are excluded — Postgres treats NULLs as distinct, so un-sent
-- withdrawals are unaffected.
--
-- PRODUCTION SAFETY (report-first, never rewrite):
--
--   * Before touching the index, a report step lists (via RAISE NOTICE) every
--     duplicated provider_reference, identified by withdrawal `ref` — nothing
--     is deleted, updated or "repaired".
--   * If ANY duplicate exists, this migration FAILS LOUDLY (SQLSTATE 23505
--     naming the refs) instead of silently skipping, because silently skipping
--     would leave transfer uniqueness unenforced with only a log line.
--   * If the index already exists AND is already unique, this is a no-op.
--   * If the index exists but is non-unique (the 0009 shape), it is dropped
--     and recreated as unique — an index-only rebuild; table data is untouched
--     and no concurrent DML is blocked beyond the brief index lock.
--
-- Every step is catalog-guarded so this file is safe to re-apply and converges
-- with the runtime self-heal in `src/lib/seed.ts`
-- (`repairPayoutSystemSchema`), which performs the same steps.
DO $withdrawal_provider_ref_unique$
declare
  dup_count integer;
  dup_refs text;
  idx_is_unique boolean;
begin
  -- Report-first: duplicates would fail the unique index below. The payout
  -- execution path assigns each provider transfer to exactly one withdrawal
  -- (stable reference + an in-transaction re-check), so any that exist are
  -- hand-edited data the operator must resolve.
  select count(*), string_agg(w.ref, ', ' order by w.ref)
    into dup_count, dup_refs
    from (
      select ref, provider_reference,
             count(*) over (partition by provider_reference) as n
        from withdrawal_requests
       where provider_reference is not null
    ) w
   where w.n > 1;
  if dup_count is not null and dup_count > 0 then
    raise notice '[flexidata 0010] REFUSING to enforce withdrawal_requests_provider_ref_idx as UNIQUE: % row(s) share a provider_reference: %. Resolve the duplicates (no row is touched by this migration) and re-run.',
      dup_count, dup_refs;
    raise exception 'withdrawal_requests holds duplicate provider_reference values: %', dup_refs
      using errcode = '23505';
  end if;

  select i.indisunique into idx_is_unique
    from pg_class c
    join pg_index i on i.indexrelid = c.oid
   where c.relname = 'withdrawal_requests_provider_ref_idx';

  if idx_is_unique is null then
    -- No index at all (e.g. a database that never applied 0009's index):
    -- create the unique shape directly.
    create unique index "withdrawal_requests_provider_ref_idx"
      on "withdrawal_requests" using btree ("provider_reference")
      where "withdrawal_requests"."provider_reference" is not null;
  elsif idx_is_unique = false then
    -- The 0009 non-unique shape: index-only rebuild to unique. Table rows are
    -- untouched; only the access path changes.
    drop index "withdrawal_requests_provider_ref_idx";
    create unique index "withdrawal_requests_provider_ref_idx"
      on "withdrawal_requests" using btree ("provider_reference")
      where "withdrawal_requests"."provider_reference" is not null;
  else
    raise notice '[flexidata 0010] withdrawal_requests_provider_ref_idx is already UNIQUE — no-op.';
  end if;
end
$withdrawal_provider_ref_unique$;
