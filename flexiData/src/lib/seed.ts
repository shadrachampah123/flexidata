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
  isMissingRelationError,
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
 * Exported so `npm run verify:signup` can exercise it directly: `ensureSeeded`
 * is memoized per process, so a second repair cannot be triggered through it.
 */
export async function repairReferrerIndex(): Promise<void> {
  const rows = await db.execute<{ indexdef: string }>(sql`
    select indexdef from pg_indexes
    where schemaname = current_schema()
      and tablename = 'users'
      and indexname = 'users_referred_by_idx'
  `);
  const indexdef = rows.rows[0]?.indexdef;
  // No index at all, or already non-unique: nothing to do.
  if (!indexdef || !/\bunique\b/i.test(indexdef)) return;

  // Postgres DDL is transactional, so the swap cannot leave the table without
  // an index if the second statement fails.
  await db.transaction(async (tx) => {
    await tx.execute(sql`drop index if exists users_referred_by_idx`);
    await tx.execute(
      sql`create index if not exists users_referred_by_idx on users (referred_by)`,
    );
  });
  console.info(
    "[flexidata] replaced the UNIQUE users_referred_by_idx with a plain index — " +
      "sign-ups using a referral code work again",
  );
}

async function runSeed(): Promise<void> {
  // Repair blocking schema drift before anything writes per-user rows. A failure
  // here must not take the app down: the rest of the seed is still useful, and
  // a deployment without DDL rights should degrade, not crash.
  try {
    await repairReferrerIndex();
  } catch (error) {
    console.warn(
      "[flexidata] could not repair users_referred_by_idx:",
      (error as Error)?.message ?? error,
    );
  }

  // Bundle plans are the catalog the whole shop is built on.
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
      if (!isMissingRelationError(error)) throw error;
      // Reflect the missing table in the cached capabilities so the rest of
      // the request (and /api/health) doesn't optimistically assume it exists.
      const caps = await getSchemaCapabilities();
      downgradeCapabilitiesFromError(caps, error);
      console.warn("[flexidata] provider_float_balances missing; skipped the float seed");
    }

  // Promotional price alerts shown on the dashboard.
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
}
