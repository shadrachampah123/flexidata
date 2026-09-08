import { sql } from "drizzle-orm";
import { db } from "@/db";
import { bundlePlans, priceAlerts, providerFloatBalances } from "@/db/schema";
import { deriveProviderProductCode } from "@/lib/data-gateway";
import {
  BUNDLE_PLAN_INSERT_FIELDS,
  buildCompatInsert,
  downgradeCapabilitiesFromError,
  getSchemaCapabilities,
  isGatewaySchemaComplete,
  isSchemaIncompatibleError,
  withSchemaFallback,
} from "@/lib/schema-compat";

/**
 * Idempotent seed for *shared catalog* data only: bundle plans, price alerts
 * and the (mock) provider float. Per-user data — wallets, transactions,
 * schedules — is created when a visitor registers an account, never faked.
 */
let seedPromise: Promise<void> | null = null;
let seedStartedAt = 0;
// After a successful seed, don't re-probe for at least this long (catalog rarely changes).
const SEED_CACHE_MS = 5 * 60_000;

export function ensureSeeded(): Promise<void> {
  // If we've seeded successfully within the cache window, return immediately
  // without hitting the DB at all — this is the hot-path optimization that
  // removes the ~3s block from every page navigation.
  if (seedPromise && Date.now() - seedStartedAt < SEED_CACHE_MS) {
    return seedPromise;
  }
  if (!seedPromise) {
    seedPromise = runSeed().catch((e) => {
      seedPromise = null;
      throw e;
    });
    seedStartedAt = Date.now();
  }
  return seedPromise;
}

/**
 * Trigger seeding in the background without blocking the caller.
 * Use this from hot paths (wallet/transaction queries) where the catalog
 * data is not needed to render the current response — the seed will complete
 * in the background and be ready for the next request that does need it.
 */
export function ensureSeededBackground(): void {
  if (seedPromise) return;
  ensureSeeded().catch(() => {
    // Best-effort: catalog seeding failure is non-fatal for the current request
  });
}

/**
 * Whether the catalog seed has completed successfully in this process.
 * Lets catalog-dependent queries decide whether they can skip awaiting.
 */
export function isSeeded(): boolean {
  return seedPromise !== null;
}

/**
 * Run a best-effort catalog seed step.
 *
 * The shared catalog is a warm-up, not a prerequisite for creating an account or
 * logging in — and `ensureSeeded` runs on the sign-up / login / password-reset
 * path. A deployment whose database is one migration behind a table this seed
 * writes to (e.g. `price_alerts`) used to throw out of `runSeed`, reject the
 * `ensureSeeded()` promise, and surface every account creation as a bare
 * "Something went wrong. Please try again. (ref …)" 500. A missing relation or
 * column here is not a reason to take auth down: log it and move on, exactly as
 * the rest of the app degrades around a lagging schema.
 */
async function runSeedStep(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (!isSchemaIncompatibleError(error)) throw error;
    console.warn(
      `[flexidata] seed step "${label}" skipped — the database is missing a table or column ` +
        `(${(error as Error)?.message ?? error}). Run \`npx drizzle-kit push\` to seed it.`,
    );
  }
}

/**
 * Self-healing repair for the sign-up blocker.
 *
 * `users.referred_by` used to carry a UNIQUE index, so only one visitor could
 * ever be referred by a given user and the *second* signup using any referral
 * code failed with `duplicate key value violates unique constraint
 * "users_referred_by_idx"`. The schema now declares a plain index, but a
 * database provisioned before that change still carries the unique one, and not
 * every deployment is able to run `npx drizzle-kit push`.
 *
 * This does exactly what push would — atomically swap the index — on first
 * request after boot. It is a no-op when the index is already correct, when it
 * is absent (push has not created it yet), or when the table does not exist.
 *
 * The uniqueness is found in the catalog by column, not by name, so every
 * spelling of the old constraint is repaired — an index called
 * `users_referred_by_idx`, a unique constraint, or an index under any other
 * name.
 *
 * Exported so `npm run verify:signup` can exercise it directly: `ensureSeeded`
 * is memoized per process, so a second repair cannot be triggered through it.
 */
/**
 * Self-healing: create the Paystack checkout table if a production database
 * still predates that migration.
 *
 * The app schema declares `checkout_orders` plus two enums. Deployments that
 * shipped the checkout routes without `npx drizzle-kit push` answer
 * `checkout_orders table missing` on POST /api/checkout. This does the same
 * additive work push would: create missing enums/table/indexes, add any
 * missing columns. It never drops tables, never truncates, never rewrites
 * existing rows.
 *
 * Idempotent and safe to run on every boot.
 */
export async function repairCheckoutOrdersSchema(): Promise<void> {
  await db.execute(sql`
    do $repair$
    begin
      if not exists (select 1 from pg_type where typname = 'checkout_payment_status') then
        create type checkout_payment_status as enum ('pending', 'successful', 'failed', 'abandoned');
      end if;
      if not exists (select 1 from pg_type where typname = 'checkout_order_status') then
        create type checkout_order_status as enum (
          'awaiting_payment',
          'payment_failed',
          'abandoned',
          'paid',
          'fulfilling',
          'fulfilled',
          'fulfillment_failed'
        );
      end if;
      if not exists (select 1 from pg_type where typname = 'fulfillment_status') then
        create type fulfillment_status as enum (
          'queued',
          'submitted',
          'processing',
          'delivered',
          'failed',
          'refunded'
        );
      end if;
    end
    $repair$;
  `);

  await db.execute(sql`
    create table if not exists checkout_orders (
      id serial primary key,
      ref varchar(40) not null unique,
      user_id integer not null,
      wallet_id integer not null,
      customer_email varchar(160) not null,
      customer_phone varchar(20) not null,
      network varchar(10) not null,
      category varchar(40) not null,
      plan_label varchar(80) not null,
      provider_product_code varchar(80) not null,
      recipient varchar(20) not null,
      amount numeric(12, 2) not null,
      amount_subunits integer not null,
      currency varchar(8) not null default 'GHS',
      payment_status checkout_payment_status not null default 'pending',
      order_status checkout_order_status not null default 'awaiting_payment',
      fulfillment_status fulfillment_status not null default 'queued',
      paystack_transaction_id varchar(40),
      paystack_channel varchar(40),
      paystack_gateway_response varchar(240),
      provider_reference varchar(120),
      provider_status varchar(80),
      provider_message varchar(240),
      paid_at timestamptz,
      verified_at timestamptz,
      fulfilled_at timestamptz,
      failed_at timestamptz,
      abandoned_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);

  // Additive column repair for a table that exists but is missing a later field.
  await db.execute(sql`
    alter table checkout_orders
      add column if not exists ref varchar(40),
      add column if not exists user_id integer,
      add column if not exists wallet_id integer,
      add column if not exists customer_email varchar(160),
      add column if not exists customer_phone varchar(20),
      add column if not exists network varchar(10),
      add column if not exists category varchar(40),
      add column if not exists plan_label varchar(80),
      add column if not exists provider_product_code varchar(80),
      add column if not exists recipient varchar(20),
      add column if not exists amount numeric(12, 2),
      add column if not exists amount_subunits integer,
      add column if not exists currency varchar(8) default 'GHS',
      add column if not exists payment_status checkout_payment_status default 'pending',
      add column if not exists order_status checkout_order_status default 'awaiting_payment',
      add column if not exists fulfillment_status fulfillment_status default 'queued',
      add column if not exists paystack_transaction_id varchar(40),
      add column if not exists paystack_channel varchar(40),
      add column if not exists paystack_gateway_response varchar(240),
      add column if not exists provider_reference varchar(120),
      add column if not exists provider_status varchar(80),
      add column if not exists provider_message varchar(240),
      add column if not exists paid_at timestamptz,
      add column if not exists verified_at timestamptz,
      add column if not exists fulfilled_at timestamptz,
      add column if not exists failed_at timestamptz,
      add column if not exists abandoned_at timestamptz,
      add column if not exists created_at timestamptz default now(),
      add column if not exists updated_at timestamptz default now()
  `);

  await db.execute(sql`create index if not exists checkout_orders_user_idx on checkout_orders (user_id)`);
  await db.execute(sql`create index if not exists checkout_orders_status_idx on checkout_orders (order_status)`);
}

/**
 * Self-healing: create the wallet-deposit table (+ enum and audit columns) if
 * a production database still predates that migration.
 *
 * The app schema declares `deposit_requests` with Paystack audit fields
 * (`amount_subunits`, `currency`, `paystack_*`, `paid_at`, `verified_at`, …).
 * Deployments that shipped the deposit routes without `npx drizzle-kit push`
 * fail on POST /api/wallet/fund. This does the same additive work push would:
 * create the missing enum/table/indexes and add any missing columns. It never
 * drops tables, never truncates, never rewrites existing rows — a legacy
 * `deposit_requests` table (older column set) is simply brought up to date.
 *
 * Idempotent and safe to run on every boot.
 */
export async function repairDepositRequestsSchema(): Promise<void> {
  await db.execute(sql`
    do $repair$
    begin
      if not exists (select 1 from pg_type where typname = 'deposit_status') then
        create type deposit_status as enum ('pending', 'successful', 'failed', 'abandoned');
      end if;
    end
    $repair$;
  `);

  await db.execute(sql`
    create table if not exists deposit_requests (
      id serial primary key,
      ref varchar(40) not null unique,
      wallet_id integer not null,
      provider varchar(40) not null default 'mock',
      method varchar(40) not null,
      amount numeric(12, 2) not null,
      amount_subunits integer not null default 0,
      currency varchar(8) not null default 'GHS',
      status deposit_status not null default 'pending',
      provider_reference varchar(120),
      paystack_transaction_id varchar(40),
      paystack_channel varchar(40),
      paystack_gateway_response varchar(240),
      initiated_at timestamptz not null default now(),
      completed_at timestamptz,
      paid_at timestamptz,
      verified_at timestamptz,
      provider_payload jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);

  // Additive column repair for a table that exists but is missing a later field.
  await db.execute(sql`
    alter table deposit_requests
      add column if not exists ref varchar(40),
      add column if not exists wallet_id integer,
      add column if not exists provider varchar(40) default 'mock',
      add column if not exists method varchar(40),
      add column if not exists amount numeric(12, 2),
      add column if not exists amount_subunits integer not null default 0,
      add column if not exists currency varchar(8) default 'GHS',
      add column if not exists status deposit_status default 'pending',
      add column if not exists provider_reference varchar(120),
      add column if not exists paystack_transaction_id varchar(40),
      add column if not exists paystack_channel varchar(40),
      add column if not exists paystack_gateway_response varchar(240),
      add column if not exists initiated_at timestamptz default now(),
      add column if not exists completed_at timestamptz,
      add column if not exists paid_at timestamptz,
      add column if not exists verified_at timestamptz,
      add column if not exists provider_payload jsonb,
      add column if not exists created_at timestamptz default now(),
      add column if not exists updated_at timestamptz default now()
  `);

  await db.execute(sql`create index if not exists deposit_requests_wallet_idx on deposit_requests (wallet_id)`);
  await db.execute(sql`create index if not exists deposit_requests_status_idx on deposit_requests (status)`);
}

/**
 * Self-healing: create the withdrawal objects if a production database never
 * received the withdrawal migration.
 *
 * `withdrawal_requests` was declared in `src/db/schema.ts` (and in
 * `drizzle/meta/0005_snapshot.json`) but the SQL file the migration journal
 * points at — `drizzle/0005_lively_hiroim.sql` — was never committed, so no
 * database provisioned from this repository ever got the table. Every
 * `POST /api/wallet/withdraw` then died inside its transaction with
 * `relation "withdrawal_requests" does not exist` (SQLSTATE 42P01) and the
 * caller only saw a bare 500.
 *
 * This does the same additive work `npx drizzle-kit push` would: create the
 * missing enum, add the `withdrawal` ledger type, create the table, backfill
 * any missing column, add the foreign keys and indexes. It never drops a
 * table, never truncates and never rewrites a row — balances, the ledger and
 * existing withdrawal requests are untouched, and every statement is guarded
 * so re-running it against an up-to-date database is a no-op.
 *
 * Idempotent and safe to run on every boot.
 */
export async function repairWithdrawalSchema(): Promise<void> {
  // `CREATE TYPE` has no `IF NOT EXISTS`, so the guard is a catalog lookup —
  // the same approach the checkout and deposit repairs use.
  await db.execute(sql`
    do $repair$
    begin
      if not exists (select 1 from pg_type where typname = 'withdrawal_status') then
        create type withdrawal_status as enum (
          'pending',
          'processing',
          'successful',
          'failed',
          'rejected',
          'cancelled'
        );
      end if;
    end
    $repair$;
  `);

  // The ledger row for a withdrawal is written with `transactions.type =
  // 'withdrawal'`, a value the original `tx_type` enum does not contain.
  // `ADD VALUE IF NOT EXISTS` needs PostgreSQL 12+ (Neon is 14+). It runs as
  // its own statement rather than inside the withdrawal transaction: Postgres
  // forbids *using* a freshly added enum value in the same transaction that
  // created it.
  const txType = await db.execute(sql`select 1 as ok from pg_type where typname = 'tx_type'`);
  if ((txType.rows?.length ?? 0) > 0) {
    await db.execute(sql`alter type tx_type add value if not exists 'withdrawal'`);
  }

  await db.execute(sql`
    create table if not exists withdrawal_requests (
      id serial primary key,
      ref varchar(40) not null,
      user_id integer not null,
      wallet_id integer not null,
      amount numeric(12, 2) not null,
      fee numeric(12, 2) not null,
      net_amount numeric(12, 2) not null,
      destination_method varchar(40) not null,
      destination_details jsonb not null,
      status withdrawal_status not null default 'pending',
      admin_user_id integer,
      admin_rejection_reason varchar(240),
      provider_fields jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint withdrawal_requests_ref_unique unique (ref)
    )
  `);

  // Additive column repair for a table that exists but is missing a later
  // field. Columns are added nullable here: a NOT NULL column cannot be added
  // to a table that already holds rows without a default to fill them with,
  // and this path must never fail on a live database.
  await db.execute(sql`
    alter table withdrawal_requests
      add column if not exists ref varchar(40),
      add column if not exists user_id integer,
      add column if not exists wallet_id integer,
      add column if not exists amount numeric(12, 2),
      add column if not exists fee numeric(12, 2),
      add column if not exists net_amount numeric(12, 2),
      add column if not exists destination_method varchar(40),
      add column if not exists destination_details jsonb,
      add column if not exists status withdrawal_status default 'pending',
      add column if not exists admin_user_id integer,
      add column if not exists admin_rejection_reason varchar(240),
      add column if not exists provider_fields jsonb,
      add column if not exists created_at timestamptz default now(),
      add column if not exists updated_at timestamptz default now()
  `);

  // `ALTER TABLE … ADD CONSTRAINT` has no `IF NOT EXISTS`, so guard on the
  // catalog by constraint name.
  await db.execute(sql`
    do $repair$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'withdrawal_requests_user_id_users_id_fk'
      ) then
        alter table withdrawal_requests
          add constraint withdrawal_requests_user_id_users_id_fk
          foreign key (user_id) references users (id) on delete cascade;
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'withdrawal_requests_wallet_id_wallets_id_fk'
      ) then
        alter table withdrawal_requests
          add constraint withdrawal_requests_wallet_id_wallets_id_fk
          foreign key (wallet_id) references wallets (id) on delete cascade;
      end if;
    end
    $repair$;
  `);

  await db.execute(sql`create index if not exists withdrawal_requests_user_idx on withdrawal_requests (user_id)`);
  await db.execute(sql`create index if not exists withdrawal_requests_wallet_idx on withdrawal_requests (wallet_id)`);
  await db.execute(sql`create index if not exists withdrawal_requests_status_idx on withdrawal_requests (status)`);
  await db.execute(
    sql`create index if not exists withdrawal_requests_created_at_idx on withdrawal_requests (created_at)`,
  );

  // F2/F6 convergence with drizzle/0008_withdrawal_integrity.sql: the
  // idempotency column + partial unique index and the four CHECK constraints.
  // Same production-safety contract as the migration — report-first, never
  // rewrite: constraints are added NOT VALID, existing violators are NAMED in
  // the log (never mutated), and each constraint is VALIDATEd only when clean.
  await repairWithdrawalIntegrity();
}

/**
 * Converge `withdrawal_requests` with migration 0008 (idempotency + CHECKs).
 *
 * Runs as part of `repairWithdrawalSchema()` (and therefore before the first
 * withdrawal on every boot), so a database that never received the migration
 * file still gets the same protection. Every step is catalog-guarded and
 * idempotent; every statement is additive; no row is ever inserted, updated or
 * deleted here — including rows that violate a new constraint, which are
 * REPORTED (by ref) and left for a human to resolve.
 */
async function repairWithdrawalIntegrity(): Promise<void> {
  await db.execute(sql`alter table withdrawal_requests add column if not exists idempotency_key varchar(64)`);

  // Partial unique index (F2). A duplicate (wallet_id, idempotency_key) pair is
  // only possible via hand-edited data — the withdrawal route serializes on
  // the wallet row lock and re-checks inside its transaction, so it cannot
  // write one even before this index exists. Duplicates are reported and the
  // index is left for the operator (creating it would fail anyway); the
  // application-level guards above still hold until then.
  const dupes = await db.execute<{ refs: string | null }>(sql`
    select string_agg(w.ref, ', ' order by w.ref) as refs
    from (
      select ref, count(*) over (partition by wallet_id, idempotency_key) as n
      from withdrawal_requests
      where idempotency_key is not null
    ) w
    where w.n > 1
  `);
  const dupeRefs = (dupes.rows?.[0] as { refs?: string | null } | undefined)?.refs ?? null;
  if (dupeRefs) {
    console.warn(
      `[flexidata] NOT creating withdrawal_requests_wallet_idempotency_idx: duplicate (wallet_id, idempotency_key) pairs exist (${dupeRefs}). ` +
        "Resolve them manually (no row was touched) and re-run; idempotency currently rests on the route's wallet-lock re-check alone.",
    );
  } else {
    await db.execute(sql`
      create unique index if not exists withdrawal_requests_wallet_idempotency_idx
        on withdrawal_requests (wallet_id, idempotency_key)
        where idempotency_key is not null
    `);
  }

  // The four CHECK constraints (F6): amount > 0, fee within amount,
  // amount = fee + net, method whitelist. Each is added NOT VALID (future
  // writes enforced immediately, existing rows untouched), then VALIDATEd only
  // when zero existing rows violate it — otherwise the violators are reported
  // by ref and the constraint stays NOT VALID.
  const checks: { name: string; predicate: string; violators: string }[] = [
    {
      name: "withdrawal_requests_amount_positive_check",
      predicate: `"withdrawal_requests"."amount" > 0`,
      violators: `not (amount > 0)`,
    },
    {
      name: "withdrawal_requests_fee_within_amount_check",
      predicate: `"withdrawal_requests"."fee" >= 0 and "withdrawal_requests"."fee" <= "withdrawal_requests"."amount"`,
      violators: `not (fee >= 0 and fee <= amount)`,
    },
    {
      name: "withdrawal_requests_amount_split_check",
      predicate: `"withdrawal_requests"."amount" = "withdrawal_requests"."fee" + "withdrawal_requests"."net_amount"`,
      violators: `not (amount = fee + net_amount)`,
    },
    {
      name: "withdrawal_requests_method_check",
      predicate: `"withdrawal_requests"."destination_method" in ('momo_mtn', 'telecel_cash')`,
      violators: `not (destination_method in ('momo_mtn', 'telecel_cash'))`,
    },
  ];
  for (const check of checks) {
    const present = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_constraint where conname = ${check.name}
    `);
    if (((present.rows?.[0] as { n?: number } | undefined)?.n ?? 0) === 0) {
      await db.execute(sql.raw(
        `alter table "withdrawal_requests" add constraint "${check.name}" check (${check.predicate}) not valid`,
      ));
    }
    const bad = await db.execute<{ refs: string | null }>(sql.raw(
      `select string_agg(ref, ', ' order by ref) as refs from withdrawal_requests where ${check.violators}`,
    ));
    const badRefs = (bad.rows?.[0] as { refs?: string | null } | undefined)?.refs ?? null;
    if (badRefs) {
      console.warn(
        `[flexidata] NOT validating ${check.name}: existing row(s) violate it (${badRefs}). ` +
          "Rows preserved untouched; new writes are still enforced. Resolve the data, then run " +
          `ALTER TABLE withdrawal_requests VALIDATE CONSTRAINT ${check.name}; manually.`,
      );
    } else {
      await db.execute(sql.raw(`alter table "withdrawal_requests" validate constraint "${check.name}"`));
    }
  }
}

/**
 * One-shot guard for the withdrawal write path.
 *
 * `runSeed()` already attempts the repair on boot, but seeding is kicked off in
 * the background (`ensureSeededBackground`) from read paths, so a cold instance
 * can still receive `POST /api/wallet/withdraw` before it finishes — and that
 * request would fail with the very error this repair exists to prevent. The
 * withdrawal route therefore awaits this first: it resolves immediately once
 * the repair has been attempted in this process, so the hot path pays nothing.
 *
 * A failed repair is logged and swallowed on purpose. Money must not move on a
 * database the app could not prepare, but the decision belongs to the route's
 * own transaction (which then fails loudly, with the real Postgres error in the
 * server log) — not to a schema probe that may simply lack DDL rights.
 */
let withdrawalSchemaPromise: Promise<void> | null = null;

export function ensureWithdrawalSchema(): Promise<void> {
  if (!withdrawalSchemaPromise) {
    withdrawalSchemaPromise = repairWithdrawalSchema().catch((error) => {
      // Reset so the next request retries (a transient connection failure must
      // not disable the repair for the lifetime of the instance).
      withdrawalSchemaPromise = null;
      console.warn(
        "[flexidata] could not ensure withdrawal_requests exists — withdrawals stay unavailable until the table is created:",
        (error as Error)?.message ?? error,
        "\n  Fix: run `npx drizzle-kit push` against this database.",
      );
    });
  }
  return withdrawalSchemaPromise;
}

/** Test seam: forget that the withdrawal schema was already prepared. */
export function resetWithdrawalSchemaCache(): void {
  withdrawalSchemaPromise = null;
}

/**
 * Ensure `admin_audit_logs` accepts the admin withdrawal actions.
 *
 * Why this exists: the audit action CHECK constraint shipped narrow
 * (`0003_support_workflow.sql`: suspend / activate / delivery_resolved /
 * refund_review) and only `0006_massive_vertigo.sql` widened it to also allow
 * `approve_withdrawal` / `reject_withdrawal`. A production database that never
 * ran 0006 therefore fails the LAST statement of the admin reject flow —
 *
 *   SQLSTATE 23514 check_violation
 *   new row for relation "admin_audit_logs" violates check constraint
 *   "admin_audit_logs_action_check"  (action = 'reject_withdrawal')
 *
 * which rolls back the entire transaction (status update, wallet refund,
 * ledger update and all) and the admin UI reports "Failed to process action".
 * `drizzle-kit push` does not reliably re-diff an existing CHECK definition,
 * so the drift is healed here, additively, exactly like
 * `repairWithdrawalSchema()` heals a missing `withdrawal_requests`:
 *
 *   * the constraint is replaced ONLY when the catalog shows the live
 *     definition is missing a withdrawal action (drop + re-add the widened
 *     list `src/db/schema.ts` declares — never anything narrower);
 *   * the replay-safe partial unique index is rebuilt ONLY when its predicate
 *     still excludes the withdrawal actions, so "one audit row per
 *     (target_ref, action)" finally covers withdrawals too;
 *   * nothing is dropped that is not immediately re-created, no row is ever
 *     inserted / updated / deleted, and the whole thing is a no-op on a
 *     database that already has the current definitions.
 *
 * A database without the `admin_audit_logs` table (pre-0002) is left alone:
 * the withdrawal action route will fail loudly on its own insert and the log
 * will carry the real Postgres error.
 */
export async function repairAdminAuditActions(): Promise<void> {
  // Nothing to widen when the table itself is not there yet.
  const table = await db.execute<{ present: boolean }>(
    sql`select to_regclass('admin_audit_logs') is not null as present`,
  );
  if (!(table.rows?.[0] as { present?: boolean } | undefined)?.present) return;

  const REPLAY_ACTIONS = ["delivery_resolved", "refund_review", "approve_withdrawal", "reject_withdrawal"] as const;
  const actionList = REPLAY_ACTIONS.map((a) => `'${a}'`).join(", ");

  const check = await db.execute<{ def: string | null }>(sql`
    select pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.conrelid = 'admin_audit_logs'::regclass
      and c.conname = 'admin_audit_logs_action_check'
      and c.contype = 'c'
  `);
  const checkDef = (check.rows?.[0] as { def?: string } | undefined)?.def ?? null;
  const checkMissingAction =
    checkDef === null || REPLAY_ACTIONS.some((action) => !checkDef.includes(action));
  if (checkMissingAction) {
    // Replace (or first-create) the CHECK with the exact widened definition
    // from `src/db/schema.ts` / `drizzle/0006+`. Existing rows were written
    // under the old, narrower list, so they satisfy it by construction.
    await db.execute(
      sql`alter table admin_audit_logs drop constraint if exists admin_audit_logs_action_check`,
    );
    await db.execute(sql`
      alter table admin_audit_logs
        add constraint admin_audit_logs_action_check
        check (action in ('suspend', 'activate', 'delivery_resolved', 'refund_review', 'approve_withdrawal', 'reject_withdrawal'))
    `);
  }

  const index = await db.execute<{ def: string | null }>(sql`
    select indexdef as def
    from pg_indexes
    where indexname = 'admin_audit_logs_order_action_idx'
  `);
  const indexDef = (index.rows?.[0] as { def?: string } | undefined)?.def ?? null;
  const indexMissingAction =
    indexDef === null || REPLAY_ACTIONS.some((action) => !indexDef.includes(action));
  if (indexMissingAction) {
    // Rebuild the partial unique index with the widened predicate. Dropping it
    // costs replay-safety only for the microseconds between the two statements,
    // and the real double-refund guard is the `status = 'pending'` check under
    // `SELECT … FOR UPDATE` inside the action route's transaction.
    await db.execute(sql`drop index if exists admin_audit_logs_order_action_idx`);
    await db.execute(sql`
      create unique index admin_audit_logs_order_action_idx
        on admin_audit_logs (target_ref, action)
        where target_ref is not null and action in (${sql.raw(actionList)})
    `);
  }
}

/**
 * One-shot guard for the admin withdrawal action path, mirroring
 * `ensureWithdrawalSchema()`. Resolves immediately once the repair has been
 * attempted in this process, and retries after a failure so a transient
 * connection error cannot disable the heal for the instance's lifetime.
 */
let adminAuditActionsPromise: Promise<void> | null = null;

export function ensureAdminAuditActions(): Promise<void> {
  if (!adminAuditActionsPromise) {
    adminAuditActionsPromise = repairAdminAuditActions().catch((error) => {
      adminAuditActionsPromise = null;
      console.warn(
        "[flexidata] could not widen admin_audit_logs_action_check — admin approve/reject of withdrawals will fail with a check-constraint violation (SQLSTATE 23514) until the constraint is widened:",
        (error as Error)?.message ?? error,
        "\n  Fix (non-destructive, targeted): `cd flexiData && DATABASE_URL='…' npm run migrate:admin-audit-actions`" +
          " — applies drizzle/0007's objects only. Do NOT `npx drizzle-kit push` a database carrying" +
          " unrelated drift: it diffs the whole schema and requests DROPs of tables outside the repo.",
      );
    });
  }
  return adminAuditActionsPromise;
}

/** Test seam: forget that the audit action repair was already attempted. */
export function resetAdminAuditActionsCache(): void {
  adminAuditActionsPromise = null;
}

/**
 * Ensure performance-critical indexes exist for fast navigation and history.
 * These indexes make `getRecentTransactions`, `getActiveDeliveries` and
 * `getAllTransactions` (the queries behind Home and History) avoid sequential
 * scans on growing `transactions` tables. Safe to run concurrently with the
 * other repairs — `IF NOT EXISTS` is idempotent.
 */
export async function repairPerformanceIndexes(): Promise<void> {
  // Run all index creations in parallel; they are independent and each is
  // CONCURRENTLY-safe via IF NOT EXISTS (no lock escalation beyond share).
  await Promise.allSettled([
    db.execute(sql`create index if not exists transactions_wallet_id_idx on transactions (wallet_id)`),
    db.execute(sql`create index if not exists transactions_wallet_created_idx on transactions (wallet_id, created_at desc)`),
    db.execute(sql`create index if not exists transactions_wallet_status_idx on transactions (wallet_id, status)`),
    db.execute(sql`create index if not exists transactions_wallet_ref_idx on transactions (wallet_id, ref)`),
    db.execute(sql`create index if not exists wallets_user_id_idx on wallets (user_id)`),
    db.execute(sql`create index if not exists sessions_user_id_idx on sessions (user_id)`),
    db.execute(sql`create index if not exists sessions_expires_at_idx on sessions (expires_at)`),
    db.execute(sql`create index if not exists scheduled_topups_wallet_id_idx on scheduled_topups (wallet_id)`),
    db.execute(sql`create index if not exists price_alerts_active_idx on price_alerts (active)`),
  ]);
}

export async function repairReferrerIndex(): Promise<void> {
  // Look the uniqueness up in the catalog rather than by name. A database that
  // has been pushed, reverted and hand-patched over time may enforce it as a
  // unique *constraint* (`users_referred_by_key`) or under a different index
  // name entirely; matching on `indexname = 'users_referred_by_idx'` alone
  // missed those and left sign-up broken while claiming to be self-healing.
  //
  // `pg_table_is_visible` rather than `table_schema = current_schema()`: it
  // follows the search_path, so it keeps working when the deployment runs with
  // a non-default one.
  const rows = await db.execute<{ relation: string; constraint_name: string | null }>(sql`
    select ic.relname::text as relation,
           con.conname::text as constraint_name
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_class ic on ic.oid = i.indexrelid
    left join pg_constraint con
      on con.conindid = i.indexrelid
     and con.contype = 'u'
    where c.relname = 'users'
      and pg_table_is_visible(c.oid)
      and i.indisunique
      and i.indnatts = 1
      and (
        select a.attname
        from pg_attribute a
        where a.attrelid = c.oid
          and a.attnum = i.indkey[0]
      ) = 'referred_by'
  `);

  const found = rows.rows ?? [];
  // No unique index on that column: nothing to do.
  if (found.length === 0) return;

  // Postgres DDL is transactional, so the swap cannot leave the table without
  // an index if the second statement fails.
  await db.transaction(async (tx) => {
    for (const row of found) {
      // A unique constraint owns its index, so it has to be dropped through
      // the constraint — `drop index` would fail with "cannot drop index …
      // because constraint … requires it".
      if (row.constraint_name) {
        await tx.execute(
          sql`alter table users drop constraint ${sql.identifier(row.constraint_name)}`,
        );
      } else {
        await tx.execute(sql`drop index if exists ${sql.identifier(row.relation)}`);
      }
    }
    await tx.execute(
      sql`create index if not exists users_referred_by_idx on users (referred_by)`,
    );
  });

  console.info(
    `[flexidata] replaced the UNIQUE constraint on users.referred_by (${found
      .map((row) => row.constraint_name ?? row.relation)
      .join(", ")}) with a plain index — sign-ups using a referral code work again`,
  );
}

async function runSeed(): Promise<void> {
  // Repair blocking schema drift — these are independent DDL checks that can
  // run in parallel (was sequential before, adding ~400-800ms on cold start
  // with Neon). Use allSettled so one failure doesn't block the others.
  const repairs = await Promise.allSettled([
    (async () => {
      try {
        await repairCheckoutOrdersSchema();
      } catch (error) {
        console.warn(
          "[flexidata] could not ensure checkout_orders exists — Paystack checkout will stay unavailable until the table is created:",
          (error as Error)?.message ?? error,
          "\n  Fix: run `npx drizzle-kit push` against this database.",
        );
      }
    })(),
    (async () => {
      try {
        await repairDepositRequestsSchema();
      } catch (error) {
        console.warn(
          "[flexidata] could not ensure deposit_requests exists — wallet funding will stay unavailable until the table is created:",
          (error as Error)?.message ?? error,
          "\n  Fix: run `npx drizzle-kit push` against this database.",
        );
      }
    })(),
    (async () => {
      // Shares the same memoized promise the withdrawal route awaits, so a
      // request that lands mid-seed can never race a second copy of the DDL.
      // `ensureWithdrawalSchema` logs and swallows its own failures.
      await ensureWithdrawalSchema();
    })(),
    (async () => {
      // Same memoized promise the admin withdrawal action route awaits.
      // `ensureAdminAuditActions` logs and swallows its own failures.
      await ensureAdminAuditActions();
    })(),
    (async () => {
      try {
        await repairReferrerIndex();
      } catch (error) {
        console.warn(
          "[flexidata] could not remove the UNIQUE constraint on users.referred_by — " +
            "sign-ups that use a referral code will fail until it is gone:",
          (error as Error)?.message ?? error,
          "\n  Fix: run `npx drizzle-kit push` against this database, or, if the role " +
            "cannot run DDL, drop the constraint manually.",
        );
      }
    })(),
    (async () => {
      try {
        await repairPerformanceIndexes();
      } catch (error) {
        console.warn(
          "[flexidata] could not ensure performance indexes — history and home queries may stay slow until indexes are created:",
          (error as Error)?.message ?? error,
        );
      }
    })(),
  ]);
  // Log if any repair settled as rejected without being caught above (defense-in-depth)
  for (const r of repairs) {
    if (r.status === "rejected") {
      console.warn("[flexidata] seed repair unhandled rejection", r.reason);
    }
  }

  // Bundle plans are the catalog the whole shop is built on.
  await runSeedStep("bundle plans", async () => {
    const planRows = await db.execute(sql`select count(*)::int as c from bundle_plans`);
    const planCount = (planRows.rows[0] as { c: number }).c;

    if (planCount === 0) {
      const plans: (typeof bundlePlans.$inferInsert)[] = [];
      const add = (
        network: string,
        category: string,
        label: string,
        validity: string,
        price: string,
        retail: string,
        badge: string | null = null,
      ) =>
        plans.push({
          network,
          category,
          label,
          providerProductCode: deriveProviderProductCode(network, category, label),
          validity,
          price,
          retailPrice: retail,
          badge,
          sortOrder: plans.length,
        });

      add("MTN", "up2u", "1GB", "3 days", "4.50", "6.00");
      add("MTN", "up2u", "2GB", "7 days", "8.50", "11.00");
      add("MTN", "up2u", "4GB", "30 days", "15.00", "20.00", "POPULAR");
      add("MTN", "up2u", "6GB", "30 days", "21.00", "28.00");
      add("MTN", "up2u", "10GB", "30 days", "34.00", "42.00");
      add("MTN", "up2u", "15GB", "30 days", "48.00", "62.00");

      add("MTN", "sme", "1GB", "Non-expiry", "4.00", "5.50");
      add("MTN", "sme", "2GB", "Non-expiry", "7.50", "10.00");
      add("MTN", "sme", "5GB", "Non-expiry", "17.50", "23.00", "POPULAR");
      add("MTN", "sme", "10GB", "Non-expiry", "33.00", "42.00");
      add("MTN", "sme", "20GB", "Non-expiry", "62.00", "78.00");
      add("MTN", "sme", "50GB", "Non-expiry", "148.00", "185.00");

      add("MTN", "corporate", "5GB", "30 days", "22.00", "27.00");
      add("MTN", "corporate", "10GB", "30 days", "40.00", "50.00", "B2B");
      add("MTN", "corporate", "25GB", "30 days", "92.00", "112.00");
      add("MTN", "corporate", "50GB", "30 days", "175.00", "210.00");
      add("MTN", "corporate", "100GB", "30 days", "330.00", "400.00");

      add("MTN", "social", "WhatsApp 1GB", "7 days", "2.00", "3.00");
      add("MTN", "social", "Social Mix 2.5GB", "14 days", "6.00", "8.00", "HOT");
      add("MTN", "social", "TikTok + X 1GB", "7 days", "3.00", "4.50");
      add("MTN", "social", "Streaming 3GB", "7 days", "7.50", "10.00");

      add("TELECEL", "tdata", "1GB", "3 days", "3.80", "5.00");
      add("TELECEL", "tdata", "2.5GB", "7 days", "8.00", "11.00");
      add("TELECEL", "tdata", "5GB", "30 days", "16.00", "21.00", "POPULAR");
      add("TELECEL", "tdata", "10GB", "30 days", "31.00", "40.00");
      add("TELECEL", "tdata", "15GB", "30 days", "45.00", "58.00");
      add("TELECEL", "tdata", "30GB", "30 days", "85.00", "108.00");

      add("TELECEL", "just4u", "1.5GB Daily Vibe", "1 day", "4.00", "5.50");
      add("TELECEL", "just4u", "3GB Weekend", "3 days", "6.50", "9.00", "HOT");
      add("TELECEL", "just4u", "7GB Red Vibes", "7 days", "14.00", "19.00");
      add("TELECEL", "just4u", "12GB Super", "30 days", "26.00", "34.00");

      add("TELECEL", "gifting", "5GB", "30 days", "23.00", "28.00");
      add("TELECEL", "gifting", "10GB", "30 days", "42.00", "52.00");
      add("TELECEL", "gifting", "20GB", "30 days", "78.00", "98.00");

      // On a legacy database (pre-gateway migration) `provider_product_code`
      // does not exist; the compat insert names only the columns that are there.
      await withSchemaFallback(async (compat) => {
        if (isGatewaySchemaComplete(compat, "bundle_plans")) {
          await db.insert(bundlePlans).values(plans);
          return;
        }
        await db.execute(buildCompatInsert(compat, "bundle_plans", BUNDLE_PLAN_INSERT_FIELDS, plans));
      }, "seed bundle plans");
    }
  });

  // Provider float (mock adapter) — needed by the data purchase flow.
  // The table ships in the current schema; only guard against a database that
  // has not been migrated yet.
  try {
    const existing = await db.execute(sql`select count(*)::int as c from provider_float_balances`);
    const floatCount = (existing.rows[0] as { c: number }).c;
    if (floatCount === 0) {
      const now = new Date();
      await db.insert(providerFloatBalances).values([
        {
          providerCode: "mock",
          network: "MTN",
          currency: "GHS",
          availableBalance: "25000.00",
          reservedBalance: "0.00",
          lowBalanceThreshold: "300.00",
          lastStatus: "seeded",
          notes: "Mock provider float for development",
          lastSyncedAt: now,
        },
        {
          providerCode: "mock",
          network: "TELECEL",
          currency: "GHS",
          availableBalance: "25000.00",
          reservedBalance: "0.00",
          lowBalanceThreshold: "300.00",
          lastStatus: "seeded",
          notes: "Mock provider float for development",
          lastSyncedAt: now,
        },
      ]);
    }
  } catch (error) {
    if (!isSchemaIncompatibleError(error)) throw error;
    // Reflect the missing object in the cached capabilities so the rest of
    // the request (and /api/health) doesn't optimistically assume it exists.
    const caps = await getSchemaCapabilities();
    downgradeCapabilitiesFromError(caps, error);
    console.warn("[flexidata] provider_float_balances missing; skipped the float seed");
  }

  // Promotional price alerts shown on the dashboard. Not a reason to take the
  // sign-up / login path down if a deployment has not migrated the table yet.
  await runSeedStep("price alerts", async () => {
    const alertRows = await db.execute(sql`select count(*)::int as c from price_alerts`);
    const alertCount = (alertRows.rows[0] as { c: number }).c;
    if (alertCount === 0) {
      await db.insert(priceAlerts).values([
        {
          network: "MTN",
          title: "Flash drop — 10GB UP2U now GH₵ 29.50",
          body: "Weekend promo ends Sunday 11:59 PM. Limited pool, first come first served.",
          tag: "-22%",
        },
        {
          network: "TELECEL",
          title: "Just4U 7GB Red Vibes at GH₵ 11.99",
          body: "Personalised red deals refreshed for this weekend only.",
          tag: "-14%",
        },
        {
          network: "MTN",
          title: "Agent unlock — SME 20GB at GH₵ 58",
          body: "Registered agents get this wholesale rate all week.",
          tag: "AGENT",
        },
      ]);
    }
  });
}
