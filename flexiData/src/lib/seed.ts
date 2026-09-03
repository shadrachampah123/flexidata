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

export function ensureSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = runSeed().catch((e) => {
      seedPromise = null;
      throw e;
    });
  }
  return seedPromise;
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
  // Repair blocking schema drift before anything writes per-user rows. A failure
  // here must not take the app down: the rest of the seed is still useful, and
  // a deployment without DDL rights should degrade, not crash.
  try {
    await repairCheckoutOrdersSchema();
  } catch (error) {
    console.warn(
      "[flexidata] could not ensure checkout_orders exists — Paystack checkout will stay unavailable until the table is created:",
      (error as Error)?.message ?? error,
      "\n  Fix: run `npx drizzle-kit push` against this database.",
    );
  }

  try {
    await repairDepositRequestsSchema();
  } catch (error) {
    console.warn(
      "[flexidata] could not ensure deposit_requests exists — wallet funding will stay unavailable until the table is created:",
      (error as Error)?.message ?? error,
      "\n  Fix: run `npx drizzle-kit push` against this database.",
    );
  }

  try {
    await repairReferrerIndex();
  } catch (error) {
    // Sign-up with a referral code will keep failing while the UNIQUE
    // constraint is in place, so say so plainly rather than burying it.
    console.warn(
      "[flexidata] could not remove the UNIQUE constraint on users.referred_by — " +
        "sign-ups that use a referral code will fail until it is gone:",
      (error as Error)?.message ?? error,
      "\n  Fix: run `npx drizzle-kit push` against this database, or, if the role " +
        "cannot run DDL, drop the constraint manually.",
    );
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
