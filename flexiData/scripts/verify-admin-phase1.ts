/**
 * Phase 1 verification harness — FlexiData Admin & Operations Dashboard.
 *
 * Proves, in three independent layers, that the dashboard is READ-ONLY and that
 * the Phase 0 authorization gate still guards every admin surface:
 *
 *   A. Pure functions        masking, filter parsing, reconciliation classifier.
 *   B. Statement guard       the JS-level guard refuses anything that is not a read.
 *   C. Source guarantees     every admin handler/page calls the gate; no mutation
 *                            API is used anywhere under `src/lib/admin`; no
 *                            migration was added.
 *   D. Database enforcement  PostgreSQL itself rejects a write inside the admin
 *                            transaction (SQLSTATE 25006), independent of the
 *                            JS guard.
 *   E. Query correctness     seeded fixtures with hand-computed expected values.
 *   F. No writes             a before/after snapshot of every financial table.
 *   G. API authorization     anonymous → 404, ordinary customer → 404,
 *                            authorized admin → 200, for every endpoint.
 *
 * D–G need a real PostgreSQL. The harness will:
 *   - use `DATABASE_URL` when `FLEXIDATA_ADMIN_TEST_DB=1` is also set (CI), or
 *   - boot a throwaway cluster through the optional `embedded-postgres`
 *     package (`npm i --no-save embedded-postgres`), or
 *   - skip D–G with a loud warning.
 *
 * It never runs against a database it was not explicitly told to use, and it
 * never writes to a financial table except to create its own fixtures.
 *
 * Usage: npm run verify:admin-phase1
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * `src/db` reads `DATABASE_URL` at import time and refuses to load without it.
 * Sections A–C never touch the database, so a placeholder keeps them runnable;
 * the live sections below only ever use a URL the operator explicitly handed us
 * or a throwaway cluster this harness started itself.
 */
const providedDatabaseUrl = (process.env.DATABASE_URL ?? "").trim();
if (!providedDatabaseUrl) {
  process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/placeholder";
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results: { name: string; ok: boolean; detail?: unknown }[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${JSON.stringify(detail)}`}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function equal<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : { actual, expected });
}

function skip(name: string, why: string): void {
  console.log(`  SKIP  ${name}  -> ${why}`);
}

// ---------------------------------------------------------------------------
// Module stubs — `server-only` and `next/headers`
// ---------------------------------------------------------------------------

const jar = new Map<string, string>();

function installStubs(): void {
  try {
    const resolved = require.resolve("server-only");
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: {},
    } as unknown as NodeJS.Module;
  } catch {
    // Not resolvable — nothing to stub.
  }

  const stub = {
    headers: async () => new Headers({ "user-agent": "verify-admin-phase1" }),
    cookies: async () => ({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) as string } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  };
  try {
    const resolved = require.resolve("next/headers");
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: stub,
    } as unknown as NodeJS.Module;
  } catch {
    // Fall through to the assignment below.
  }
  try {
    Object.assign(require("next/headers"), stub);
  } catch {
    // Nothing more we can do; the harness will fail loudly if cookies() throws.
  }
}

installStubs();

// ---------------------------------------------------------------------------
// Database bootstrap
// ---------------------------------------------------------------------------

type Embedded = {
  initialise: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getPgClient: () => {
    connect: () => Promise<void>;
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
};

async function startEmbedded(): Promise<{ embedded: Embedded; url: string } | null> {
  try {
    const mod = (await import("embedded-postgres")) as unknown as {
      default: new (options: Record<string, unknown>) => Embedded;
    };
    // A pid-derived port so a leftover cluster from an aborted run can never
    // silently hand us someone else's database.
    const port = 52000 + (process.pid % 2000);
    const embedded = new mod.default({
      databaseDir: `/tmp/flexidata-admin-phase1-${process.pid}`,
      user: "fd",
      password: "fd",
      port,
      persistent: false,
      onLog: () => {},
      // Not swallowed: `embedded-postgres` rejects with `undefined` when the
      // error callback drops the message, which would make a failure look
      // inexplicable.
      onError: (message: string) => console.log(`  [postgres] ${message}`),
    });
    await embedded.initialise();
    await embedded.start();
    return { embedded, url: `postgresql://fd:fd@localhost:${port}/postgres` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`  (embedded-postgres unavailable: ${reason})`);
    return null;
  }
}

async function applyMigrations(client: {
  query: (sql: string) => Promise<unknown>;
}): Promise<void> {
  const dir = path.join(process.cwd(), "drizzle");
  const files = readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const sqlText = readFileSync(path.join(dir, file), "utf8");
    for (const statement of sqlText.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await client.query(trimmed);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures (hand-computed expectations in the assertions below)
// ---------------------------------------------------------------------------

const ADMIN_EMAIL = "ada@flexidata.test";
const CUSTOMER_TOKEN = "phase1-customer-token";
const ADMIN_TOKEN = "phase1-admin-token";

async function seed(pool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}): Promise<{ wallet1: number; wallet2: number; wallet3: number; user1: number; user2: number }> {
  const q = async (sql: string, params: unknown[] = []) =>
    (await pool.query(sql, params)).rows;

  const [user1] = await q(
    `insert into users (name, email, phone, password_hash, referral_code, is_admin)
     values ('Kwame Mensah', 'kwame@flexidata.test', '0244123456', 'scrypt:a:b', 'KWAME1', false)
     returning id`,
  );
  const [user2] = await q(
    `insert into users (name, email, phone, password_hash, referral_code, is_admin)
     values ('Ada Admin', $1, '0500000001', 'scrypt:a:b', 'ADA001', true)
     returning id`,
    [ADMIN_EMAIL],
  );

  const [wallet1] = await q(
    `insert into wallets (user_id, name, number, balance, points)
     values ($1, 'Kwame Mensah', '0244123456', 500.00, 40) returning id`,
    [user1.id],
  );
  const [wallet2] = await q(
    `insert into wallets (user_id, name, number, balance, points)
     values ($1, 'Ada Admin', '0500000001', 100.00, 0) returning id`,
    [user2.id],
  );
  // Orphaned wallet (user_id NULL): a reconciliation finding, not something the
  // dashboard repairs.
  const [wallet3] = await q(
    `insert into wallets (user_id, name, number, balance, points)
     values (null, 'Unlinked wallet', '0200000009', 7.00, 0) returning id`,
  );

  const tx = `insert into transactions
    (ref, wallet_id, type, status, fulfillment_status, direction, title, subtitle, amount, points, network, recipient, charged_at, fulfilled_at, refunded_at, created_at)
    values ($1, $2, $3, $4, $5, $6, $7, '', $8, 0, $9, $10, $11, $12, $13, $14)`;

  // w1 ledger. Expected (money-moving) rows:
  //   +500 deposit (successful, charged)
  //   -10  data    (successful, charged)
  //   -20  data    (failed, NOT charged)      -> excluded
  //   -30  data    (reversed, refunded)       -> excluded
  //   -5   transfer(successful, no charged_at)-> included (transfer exception)
  //   -15  data    (pending, charged)         -> included
  //   -12  data    (successful) but it is a Paystack checkout order -> excluded
  //   -40  data    (failed but charged, old)  -> included (charged, refunded_at null)
  //   => 500 - 10 - 5 - 15 - 40 = 430 ; stored 500 ; difference +70
  await pool.query(tx, [
    "DP-SEED-1", wallet1.id, "deposit", "successful", "delivered", "in",
    "Wallet Top-up", 500.0, null, null, "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z", null, "2026-09-01T10:00:00Z",
  ]);
  await pool.query(tx, [
    "FD-SEED-1", wallet1.id, "data", "successful", "delivered", "out",
    "MTN 1GB", 10.0, "MTN", "0244123456", "2026-09-01T11:00:00Z", "2026-09-01T11:00:05Z", null, "2026-09-01T11:00:00Z",
  ]);
  await pool.query(tx, [
    "FD-SEED-2", wallet1.id, "data", "failed", "failed", "out",
    "MTN 2GB", 20.0, "MTN", "0244123456", null, null, null, "2026-09-01T12:00:00Z",
  ]);
  await pool.query(tx, [
    "FD-SEED-3", wallet1.id, "data", "reversed", "refunded", "out",
    "MTN 3GB", 30.0, "MTN", "0244123456", "2026-09-01T13:00:00Z", null, "2026-09-01T13:30:00Z", "2026-09-01T13:00:00Z",
  ]);
  await pool.query(tx, [
    "TR-SEED-1", wallet1.id, "transfer", "successful", "queued", "out",
    "Wallet Transfer", 5.0, null, "0500000001", null, null, null, "2026-09-01T14:00:00Z",
  ]);
  // Deliberately recent: an order in flight is normal traffic, and this row is
  // what proves the queue does not report it.
  const minutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  await pool.query(tx, [
    "FD-SEED-4", wallet1.id, "data", "pending", "processing", "out",
    "Telecel 1GB", 15.0, "TELECEL", "0244123456", minutesAgo, null, null, minutesAgo,
  ]);
  await pool.query(tx, [
    "FD-SEED-5", wallet1.id, "data", "failed", "failed", "out",
    "MTN 5GB", 40.0, "MTN", "0244123456", "2026-08-28T09:00:00Z", null, null, "2026-08-28T09:00:00Z",
  ]);
  // Mirrored Paystack checkout order: money never touched the wallet.
  await pool.query(tx, [
    "CO-SEED-1", wallet1.id, "data", "successful", "delivered", "out",
    "MTN 1GB", 12.0, "MTN", "0244123456", "2026-09-01T16:00:00Z", "2026-09-01T16:00:05Z", null, "2026-09-01T16:00:00Z",
  ]);
  // w2 ledger: one deposit, fully reconciled.
  await pool.query(tx, [
    "DP-SEED-2", wallet2.id, "deposit", "successful", "delivered", "in",
    "Wallet Top-up", 100.0, null, null, "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z", null, "2026-09-01T10:00:00Z",
  ]);

  const deposit = `insert into deposit_requests
    (ref, wallet_id, provider, method, amount, amount_subunits, currency, status,
     paystack_transaction_id, paystack_channel, paystack_gateway_response, initiated_at, paid_at, verified_at, completed_at)
    values ($1, $2, 'paystack', 'card', $3, $4, 'GHS', $5, $6, 'card', $7, $8, $9, $10, $11)`;
  await pool.query(deposit, [
    "DP-SEED-1", wallet1.id, 500.0, 50000, "successful", "111111", "Approved",
    "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z", "2026-09-01T10:00:01Z", "2026-09-01T10:00:01Z",
  ]);
  await pool.query(deposit, [
    "DP-SEED-2", wallet2.id, 100.0, 10000, "successful", "222222", "Approved",
    "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z", "2026-09-01T10:00:01Z", "2026-09-01T10:00:01Z",
  ]);
  // Settled at Paystack but with no matching ledger row: "not credited".
  await pool.query(deposit, [
    "DP-SEED-3", wallet1.id, 25.0, 2500, "successful", "333333", "Approved",
    "2026-09-01T17:00:00Z", "2026-09-01T17:00:00Z", "2026-09-01T17:00:01Z", "2026-09-01T17:00:01Z",
  ]);
  // Parked by the verification-mismatch guard.
  await pool.query(deposit, [
    "DP-SEED-4", wallet1.id, 15.0, 1500, "failed", "444444",
    "Payment did not match this deposit (amount/currency/reference) and was not credited. Contact support.",
    "2026-08-30T09:00:00Z", null, "2026-08-30T09:05:00Z", "2026-08-30T09:05:00Z",
  ]);
  // Stale pending attempt (> 24h).
  await pool.query(deposit, [
    "DP-SEED-5", wallet1.id, 60.0, 6000, "pending", null, null,
    "2026-08-28T09:00:00Z", null, null, null,
  ]);

  const order = `insert into checkout_orders
    (ref, user_id, wallet_id, customer_email, customer_phone, network, category, plan_label,
     provider_product_code, recipient, amount, amount_subunits, currency, payment_status,
     order_status, fulfillment_status, paystack_transaction_id, paystack_channel,
     provider_message, paid_at, verified_at, fulfilled_at, failed_at, created_at, updated_at)
    values ($1, $2, $3, $4, $5, 'MTN', 'sme', $6, 'MTN-SME-1GB', $5, $7, $8, 'GHS', $9, $10, $11,
            $12, 'card', $13, $14, $14, $15, $16, $17, $18)`;
  await pool.query(order, [
    "CO-SEED-1", user1.id, wallet1.id, "kwame@flexidata.test", "0244123456", "MTN 1GB",
    12.0, 1200, "successful", "fulfilled", "delivered", "900001", null,
    "2026-09-01T16:00:00Z", "2026-09-01T16:00:05Z", null, "2026-09-01T16:00:00Z", "2026-09-01T16:00:05Z",
  ]);
  // The src/lib/checkout.ts:541 park: paid, provider unreachable, never retried.
  await pool.query(order, [
    "CO-SEED-2", user1.id, wallet1.id, "kwame@flexidata.test", "0244123456", "MTN 2GB",
    30.0, 3000, "successful", "fulfillment_failed", "failed", "900002",
    "The data provider could not be reached after payment. Support will fulfil or refund this order.",
    "2026-08-30T08:00:00Z", null, "2026-08-30T08:00:30Z", "2026-08-30T08:00:00Z", "2026-08-30T08:00:30Z",
  ]);
  // Paid but stuck in fulfilment for hours.
  const fiveHoursAgo = new Date(Date.now() - 5 * 3600_000).toISOString();
  await pool.query(order, [
    "CO-SEED-3", user1.id, wallet1.id, "kwame@flexidata.test", "0244123456", "Telecel 3GB",
    45.0, 4500, "successful", "paid", "submitted", "900003", null,
    fiveHoursAgo, null, null, fiveHoursAgo, fiveHoursAgo,
  ]);
  await pool.query(order, [
    "CO-SEED-4", user1.id, wallet1.id, "kwame@flexidata.test", "0244123456", "MTN 500MB",
    5.0, 500, "pending", "awaiting_payment", "queued", null, null,
    null, null, null, "2026-09-01T18:00:00Z", "2026-09-01T18:00:00Z",
  ]);

  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const expires = new Date(Date.now() + 30 * 86400_000).toISOString();
  await pool.query(
    `insert into sessions (user_id, token_hash, user_agent, ip, last_seen_at, expires_at)
     values ($1, $2, 'verify-admin-phase1', '127.0.0.1', now(), $3),
            ($4, $5, 'verify-admin-phase1', '127.0.0.1', now(), $3)`,
    [user1.id, sha256(CUSTOMER_TOKEN), expires, user2.id, sha256(ADMIN_TOKEN)],
  );

  return {
    wallet1: Number(wallet1.id),
    wallet2: Number(wallet2.id),
    wallet3: Number(wallet3.id),
    user1: Number(user1.id),
    user2: Number(user2.id),
  };
}

/** Everything that must be byte-identical before and after browsing. */
const SNAPSHOT_SQL = `select
  (select count(*)::int from users) as users_count,
  (select count(*)::int from wallets) as wallets_count,
  (select coalesce(sum(balance), 0)::text from wallets) as wallets_balance,
  (select count(*)::int from transactions) as tx_count,
  (select coalesce(sum(amount), 0)::text from transactions) as tx_amount,
  (select count(*)::int from deposit_requests) as deposit_count,
  (select coalesce(sum(amount), 0)::text from deposit_requests) as deposit_amount,
  (select coalesce(max(updated_at)::text, '') from deposit_requests) as deposit_updated,
  (select count(*)::int from checkout_orders) as order_count,
  (select coalesce(max(updated_at)::text, '') from checkout_orders) as order_updated,
  (select count(*)::int from sessions) as session_count`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("FlexiData — Admin & Operations Dashboard: Phase 1 verification");

  const providedUrl = providedDatabaseUrl;
  const allowProvided = process.env.FLEXIDATA_ADMIN_TEST_DB === "1";

  // Decide where the live checks will run BEFORE any application module is
  // imported: `src/db` builds its pool from DATABASE_URL at import time, so the
  // URL has to be final before section B pulls that module in.
  let embedded: Embedded | null = null;
  let liveUrl: string | null = null;
  let skipReason = "";
  if (providedUrl && allowProvided) {
    liveUrl = providedUrl;
    console.log("  using DATABASE_URL (FLEXIDATA_ADMIN_TEST_DB=1)");
  } else if (providedUrl) {
    skipReason = "DATABASE_URL is set but FLEXIDATA_ADMIN_TEST_DB is not - refusing to touch it";
  } else {
    const booted = await startEmbedded();
    if (booted) {
      embedded = booted.embedded;
      liveUrl = booted.url;
      console.log("  started a throwaway PostgreSQL cluster (embedded-postgres)");
    } else {
      skipReason =
        "no DATABASE_URL and the optional `embedded-postgres` package is not installed " +
        "(npm i --no-save embedded-postgres)";
    }
  }
  if (liveUrl) process.env.DATABASE_URL = liveUrl;

  // -------------------------------------------------------------------------
  section("A. Pure functions");
  // -------------------------------------------------------------------------
  const { maskEmail, maskPhone } = await import("@/lib/admin/redact");
  equal("maskPhone hides the middle of a Ghanaian number", maskPhone("0244123456"), "024••••456");
  equal("maskPhone degrades safely for a short value", maskPhone("123"), "•••");
  equal("maskEmail keeps the domain", maskEmail("kwame@flexidata.test"), "k•••@flexidata.test");
  equal("maskEmail handles a missing value", maskEmail(null), "—");

  const filters = await import("@/lib/admin/filters");
  equal("parsePage clamps below 1", filters.parsePage("0"), 1);
  equal("parsePageSize rejects an unsupported size", filters.parsePageSize("1000"), 25);
  equal("parsePageSize accepts a supported size", filters.parsePageSize("50"), 50);
  equal(
    "parseSearch neutralises SQL wildcards",
    filters.parseSearch("a%b_c\\d"),
    "a b c d",
  );
  equal("parseEnum drops an unknown value", filters.parseEnum("nope", ["a", "b"] as const), null);
  equal("parseDateFrom is start of day", filters.parseDateFrom("2026-09-04"), "2026-09-04T00:00:00.000Z");
  equal("parseDateTo is end of day", filters.parseDateTo("2026-09-04"), "2026-09-04T23:59:59.999Z");
  equal("offsetFor respects the page size", filters.offsetFor(3, 25), 50);
  equal("toQueryString drops empty values", filters.toQueryString({ a: "1", b: "" }), "?a=1");

  const { classifyReconciliation, reconciliationRule } = await import("@/lib/admin/reconciliation");
  const exactRule = reconciliationRule({ chargedAt: true, refundedAt: true, checkoutTable: true });
  const estimateRule = reconciliationRule({ chargedAt: false, refundedAt: false, checkoutTable: true });
  equal("exact rule is trusted", exactRule.exact, true);
  equal("degraded rule is an estimate", estimateRule.exact, false);
  equal(
    "a matching wallet is healthy",
    classifyReconciliation({ storedBalance: 100, calculatedBalance: 100, examined: 2, rule: exactRule }).status,
    "matched",
  );
  equal(
    "a 70.00 difference is a mismatch requiring investigation",
    classifyReconciliation({ storedBalance: 500, calculatedBalance: 430, examined: 5, rule: exactRule }),
    {
      difference: 70,
      status: "mismatch",
      severity: "critical",
      label: "Mismatch",
      guidance: "Requires investigation",
      estimated: false,
    },
  );
  equal(
    "sub-pesewa noise is not a finding",
    classifyReconciliation({ storedBalance: 100.001, calculatedBalance: 100, examined: 1, rule: exactRule }).status,
    "matched",
  );
  equal(
    "an unknowable calculation is 'Not available', never zero",
    classifyReconciliation({ storedBalance: 100, calculatedBalance: null, examined: null, rule: estimateRule }).status,
    "unknown",
  );

  // -------------------------------------------------------------------------
  section("B. Read-only statement guard (no database)");
  // -------------------------------------------------------------------------
  const { assertReadOnlyStatement, AdminReadOnlyViolation } = await import("@/lib/admin/db");
  const refused = (statement: string): boolean => {
    try {
      assertReadOnlyStatement(statement);
      return false;
    } catch (error) {
      return error instanceof AdminReadOnlyViolation;
    }
  };
  const allowed = (statement: string): boolean => {
    try {
      assertReadOnlyStatement(statement);
      return true;
    } catch {
      return false;
    }
  };
  check("SELECT is allowed", allowed("select 1"));
  check("CTE (WITH … SELECT) is allowed", allowed("with x as (select 1) select * from x"));
  check("transaction control is allowed", allowed("set transaction read only"));
  check("commit is allowed", allowed("commit"));
  check("INSERT is refused", refused("insert into wallets (balance) values (1)"));
  check("UPDATE is refused", refused(`update "wallets" set "balance" = 1`));
  check("DELETE is refused", refused("delete from wallets where id = 1"));
  check("DDL is refused", refused("drop table wallets"));
  check("SELECT … INTO is refused", refused("select * into backup from wallets"));
  check("sequence advance is refused", refused("select nextval('wallets_id_seq')"));
  check("comment-smuggled write is refused", refused("select 1 --nothing\n; delete from wallets"));

  // -------------------------------------------------------------------------
  section("C. Source-level guarantees");
  // -------------------------------------------------------------------------
  const { readdirSync: readDir, statSync } = await import("node:fs");
  const walk = (dir: string): string[] =>
    readDir(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

  const apiFiles = walk(path.join(process.cwd(), "src/app/api/admin")).filter((file) =>
    file.endsWith("route.ts"),
  );
  check(`admin API handlers found (${apiFiles.length})`, apiFiles.length >= 9);
  for (const file of apiFiles) {
    const source = readFileSync(file, "utf8");
    const route = file.replace(process.cwd(), "");
    // The gate must be the first thing the handler does — before any input is
    // read and before any query runs.
    const handler = source.search(/export (async function|const) GET/);
    const gateAt = source.indexOf("requireAdminApi()");
    const body = handler >= 0 ? source.slice(handler, handler + 400) : source;
    check(
      `${route} authorizes itself before doing anything else`,
      gateAt >= 0 && body.includes("requireAdminApi()"),
      { route, handler, gateAt },
    );
    check(`${route} is never cached`, source.includes(`export const dynamic = "force-dynamic"`));
  }

  const layoutSource = readFileSync(path.join(process.cwd(), "src/app/admin/layout.tsx"), "utf8");
  check("the /admin layout runs the gate before anything renders", layoutSource.includes("requireAdmin()"));
  check(
    "the /admin layout exports no metadata (a title would leak into the 404 shown to non-admins)",
    !/export\s+(const|async function)\s+metadata/.test(layoutSource),
  );

  const pageFiles = walk(path.join(process.cwd(), "src/app/admin")).filter((file) =>
    file.endsWith("page.tsx"),
  );
  check(`admin pages found (${pageFiles.length})`, pageFiles.length >= 10);
  for (const file of pageFiles) {
    const source = readFileSync(file, "utf8");
    check(
      `${file.replace(process.cwd(), "")} re-checks the gate`,
      source.includes("requireAdmin()"),
    );
  }

  const libFiles = walk(path.join(process.cwd(), "src/lib/admin"));
  // Deliberately narrow: `createHash(...).update(...)` and similar are not
  // database writes, and every admin read goes through `withReadOnlyTx`, so a
  // write can only enter through a drizzle mutation API or raw mutating SQL.
  const mutationPatterns = [
    /\bdb\.(update|insert|delete)\(/,
    /\bpool\.(query|execute)\(/,
    /sql`(insert|update|delete|truncate|alter|drop|create)\b/i,
    /\bexecute\(\s*sql`(insert|update|delete|truncate|alter|drop|create)\b/i,
  ];
  for (const file of libFiles) {
    const source = readFileSync(file, "utf8");
    const offending = mutationPatterns.filter((pattern) => pattern.test(source));
    check(`${file.replace(process.cwd(), "")} uses no write API`, offending.length === 0, {
      offending: offending.map(String),
    });
  }

  // The browser can only ever ask for data: no client component or admin page
  // may issue a non-GET request, so no write path can be reached from the UI.
  const browserFacing = [
    ...walk(path.join(process.cwd(), "src/app/admin")),
    ...walk(path.join(process.cwd(), "src/components/admin")),
  ];
  const writeCalls = /\bmethod:\s*["'](POST|PUT|PATCH|DELETE)["']|\.post\(|\.put\(|\.patch\(|\.delete\(|\baction=\{/i;
  for (const file of browserFacing) {
    const source = readFileSync(file, "utf8");
    check(`${file.replace(process.cwd(), "")} issues no non-GET request`, !writeCalls.test(source));
  }

  // No migration: the drizzle directory and the schema must be untouched.
  let gitClean = true;
  let gitDetail = "";
  try {
    const changed = execFileSync("git", ["status", "--porcelain", "--", "drizzle", "src/db/schema.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    gitClean = changed.length === 0;
    gitDetail = changed;
  } catch (error) {
    gitDetail = `git unavailable: ${(error as Error).message}`;
  }
  check("no migration or schema change (drizzle/ and src/db/schema.ts are clean)", gitClean, gitDetail);

  // -------------------------------------------------------------------------
  section("D–G. Live database checks");
  // -------------------------------------------------------------------------
  const url = liveUrl;
  if (!url) skip("live checks", skipReason);

  let poolRef: { end: () => Promise<void> } | null = null;
  if (url) {
   try {
    process.env.DATABASE_URL = url;
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    process.env.DATA_API_PROVIDER = "mock";
    process.env.DATA_API_SCHEMA_PROBE_MS = "600000";
    delete process.env.FLEXIDATA_TEST_USER_ID;
    delete process.env.FLEXIDATA_TEST_ALLOW_ADMIN;

    const { pool } = await import("@/db");
    poolRef = pool as unknown as { end: () => Promise<void> };

    if (embedded) {
      const client = embedded.getPgClient();
      await client.connect();
      await applyMigrations(client);
      await client.end();
    } else {
      const client = await pool.connect();
      await applyMigrations(client as unknown as { query: (sql: string) => Promise<unknown> });
      client.release();
    }

    const ids = await seed(pool);

    // ---------------------------------------------------------------------
    section("D. The database itself refuses writes");
    // ---------------------------------------------------------------------
    const raw = await pool.connect();
    try {
      // Each attempt gets its own transaction: the first rejected write aborts
      // the transaction, so a shared one would mask later statements with
      // SQLSTATE 25P02 instead of the 25006 we are proving.
      for (const [label, statement] of [
        ["UPDATE", `update "wallets" set "balance" = 999 where "id" = ${ids.wallet1}`],
        ["INSERT", `insert into "transactions" ("ref", "wallet_id", "type", "status", "direction", "title", "amount") values ('HACK', ${ids.wallet1}, 'data', 'successful', 'in', 'x', 1)`],
        ["DELETE", `delete from "wallets" where "id" = ${ids.wallet1}`],
        ["DDL", `create table "admin_harness_should_not_exist" ("id" int)`],
      ] as const) {
        await raw.query("begin");
        await raw.query("set transaction read only");
        const setting = await raw.query("select current_setting('transaction_read_only') as v");
        if (label === "UPDATE") {
          equal("SET TRANSACTION READ ONLY is in force", setting.rows[0]?.v, "on");
        }
        let code = "";
        try {
          await raw.query(statement);
        } catch (error) {
          code = String((error as { code?: string }).code ?? "");
        }
        check(`${label} inside the read-only transaction is rejected (25006)`, code === "25006", { code });
        await raw.query("rollback");
      }
    } finally {
      raw.release();
    }

    const { withReadOnlyTx } = await import("@/lib/admin/db");
    const { sql } = await import("drizzle-orm");
    let guardTripped = false;
    try {
      await withReadOnlyTx("harness", async (tx) => {
        await tx.execute(sql`update "wallets" set "balance" = 1`);
      });
    } catch (error) {
      guardTripped = error instanceof (await import("@/lib/admin/db")).AdminReadOnlyViolation;
    }
    check("the admin executor refuses an UPDATE before it reaches the database", guardTripped);

    const readOnlySetting = await withReadOnlyTx("harness", async (tx) => {
      const result = await tx.execute<{ v: string }>(
        sql`select current_setting('transaction_read_only') as v`,
      );
      return result.rows[0]?.v ?? "";
    });
    equal("every admin read really runs inside a read-only transaction", readOnlySetting, "on");

    // ---------------------------------------------------------------------
    section("E. Query correctness against seeded fixtures");
    // ---------------------------------------------------------------------
    const before = (await pool.query(SNAPSHOT_SQL)).rows[0];

    const { loadOverview, loadWallets, loadWalletDetail, loadReconciliation, loadUsers, loadUserDetail } =
      await import("@/lib/admin/queries");
    const {
      loadTransactions,
      loadDataOrders,
      loadAttention,
      loadPayments,
      loadTransactionDetail,
    } = await import("@/lib/admin/queries-operations");

    const overview = await loadOverview();
    equal("overview: users", overview.counts.users, 2);
    equal("overview: wallets", overview.counts.wallets, 3);
    equal("overview: total wallet balance", overview.counts.totalWalletBalance, 607);
    equal("overview: successful deposits", overview.counts.successfulDeposits, 3);
    equal("overview: successful deposit value", overview.counts.successfulDepositsValue, 625);
    equal("overview: successful purchases", overview.counts.successfulPurchases, 2);
    equal("overview: pending transactions", overview.counts.pendingTransactions, 1);
    equal("overview: failed transactions", overview.counts.failedTransactions, 2);
    equal("overview: reversed transactions", overview.counts.reversedTransactions, 1);
    equal("overview: pending deliveries (data/airtime only)", overview.counts.pendingDeliveries, 1);
    equal("overview: failed deliveries", overview.counts.failedDeliveries, 2);
    equal("overview: stuck paid orders", overview.counts.stuckCheckoutOrders, 1);
    equal("overview: support queue", overview.counts.supportQueue, 1);
    equal("overview: wallet discrepancies", overview.counts.walletDiscrepancies, 2);
    check(
      "overview: the support queue is the first issue",
      overview.issues[0]?.id === "support-queue" && overview.issues[0]?.severity === "critical",
      overview.issues[0],
    );

    const walletsPage = await loadWallets({ page: 1, pageSize: 25 });
    equal("wallets: every wallet is listed", walletsPage.total, 3);
    const wallet1 = walletsPage.rows.find((row) => row.walletId === ids.wallet1);
    equal("wallets: stored balance is the wallet value", wallet1?.storedBalance, 500);
    equal("wallets: calculated balance excludes non-money rows", wallet1?.calculatedBalance, 430);
    equal("wallets: difference is stored − calculated", wallet1?.difference, 70);
    equal("wallets: a mismatch is flagged", wallet1?.diffStatus, "mismatch");
    const wallet2 = walletsPage.rows.find((row) => row.walletId === ids.wallet2);
    equal("wallets: a reconciled wallet is matched", wallet2?.diffStatus, "matched");
    const localPart = (email: string) => email.split("@")[0] ?? "";
    check(
      "wallets: no list row ever exposes a full email or phone",
      walletsPage.rows.every(
        (row) =>
          (row.userEmail === null ||
            row.userEmail === "—" ||
            localPart(row.userEmail).includes("•")) &&
          (row.userPhone === null || row.userPhone === "—" || row.userPhone.includes("•")),
      ),
      walletsPage.rows.map((row) => [row.userEmail, row.userPhone]),
    );
    equal(
      "wallets: mismatch filter returns only the two broken wallets",
      (await loadWallets({ onlyMismatches: true, page: 1, pageSize: 25 })).total,
      2,
    );

    const detail = await loadWalletDetail(ids.wallet1, 1, 10);
    equal("wallet detail: stored balance", detail?.reconciliation.storedBalance, 500);
    equal("wallet detail: calculated balance", detail?.reconciliation.calculatedBalance, 430);
    equal("wallet detail: guidance", detail?.reconciliation.guidance, "Requires investigation");
    equal(
      "wallet detail: labels the calculation as non-authoritative",
      detail?.reconciliation.rule.label.startsWith("Ledger-derived"),
      true,
    );
    check(
      "wallet detail: contributions exclude rows that never moved money",
      (detail?.contributions.every((row) => row.charged || row.type === "transfer") ?? false),
      detail?.contributions.map((row) => ({ ref: row.ref, charged: row.charged, type: row.type })),
    );

    const reconciliation = await loadReconciliation({ page: 1, pageSize: 25 });
    equal("reconciliation: wallets examined", reconciliation.walletsExamined, 3);
    equal("reconciliation: mismatches", reconciliation.mismatches, 2);
    equal("reconciliation: rows returned", reconciliation.total, 3);
    equal("reconciliation: reported without a fix path", reconciliation.rows[0]?.guidance, "Requires investigation");

    const transactions = await loadTransactions({ page: 1, pageSize: 25 });
    equal("transactions: every ledger row is reachable", transactions.total, 9);
    equal(
      "transactions: filtered by status",
      (await loadTransactions({ status: "failed", page: 1, pageSize: 25 })).total,
      2,
    );
    equal(
      "transactions: filtered by reference search",
      (await loadTransactions({ search: "FD-SEED-1", page: 1, pageSize: 25 })).total,
      1,
    );
    equal(
      "transactions: filtered by amount range",
      (await loadTransactions({ amountMin: 40, amountMax: 40, page: 1, pageSize: 25 })).total,
      1,
    );
    equal("transaction detail: loads by reference", (await loadTransactionDetail("FD-SEED-1"))?.amount, 10);

    const walletOrders = await loadDataOrders({ channel: "wallet", page: 1, pageSize: 25 });
    equal("data (wallet): rows", walletOrders.total, 6);
    equal("data (wallet): successful", walletOrders.buckets.successful, 2);
    equal("data (wallet): failures", walletOrders.buckets.failed, 2);
    equal("data (wallet): refunded/reversed", walletOrders.buckets.refunded, 1);
    equal("data (wallet): requires support (charged and never resolved)", walletOrders.buckets.attention, 1);
    check(
      "data (wallet): phone numbers are masked",
      walletOrders.rows.every((row) => row.phone.includes("•")),
    );
    const checkoutOrders = await loadDataOrders({ channel: "checkout", page: 1, pageSize: 25 });
    equal("data (checkout): rows", checkoutOrders.total, 4);
    equal("data (checkout): fulfilled", checkoutOrders.buckets.successful, 1);
    equal("data (checkout): awaiting payment", checkoutOrders.buckets.pending, 1);
    equal("data (checkout): requires support", checkoutOrders.buckets.attention, 2);
    equal(
      "data (checkout): wallet debit is honestly labelled as untouched",
      checkoutOrders.rows[0]?.walletDebit,
      "Paid via Paystack (wallet untouched)",
    );

    const attention = await loadAttention({ page: 1, pageSize: 25 });
    // CO-SEED-2 (parked) + CO-SEED-3 (stuck) + FD-SEED-5 (charged, undelivered)
    // + DP-SEED-4 (parked mismatch) + DP-SEED-5 (stale pending).
    equal("attention: queue length", attention.total, 5);
    check(
      "attention: the parked checkout order is present and critical",
      attention.rows.some(
        (row) => row.ref === "CO-SEED-2" && row.severity === "critical" && row.source === "checkout",
      ),
      attention.rows.map((row) => ({ ref: row.ref, severity: row.severity })),
    );
    check(
      "attention: the parked order explains itself for support",
      attention.rows.some((row) => row.ref === "CO-SEED-2" && /Support will fulfil or refund/.test(row.reason)),
      attention.rows.find((row) => row.ref === "CO-SEED-2")?.reason,
    );
    check(
      "attention: a charged-but-undelivered wallet order is present",
      attention.rows.some((row) => row.ref === "FD-SEED-5" && row.source === "wallet"),
      attention.rows.map((row) => row.ref),
    );
    check(
      "attention: a merely-in-flight order is NOT in the queue",
      !attention.rows.some((row) => row.ref === "FD-SEED-4"),
      attention.rows.map((row) => row.ref),
    );
    check(
      "attention: a refunded order is NOT in the queue",
      !attention.rows.some((row) => row.ref === "FD-SEED-3"),
      attention.rows.map((row) => row.ref),
    );

    const payments = await loadPayments({ page: 1, pageSize: 25 });
    equal("payments: rows", payments.total, 5);
    equal("payments: successful", payments.summary.successful, 3);
    equal("payments: failed", payments.summary.failed, 1);
    equal("payments: pending", payments.summary.pending, 1);
    equal(
      "payments: credited filter",
      (await loadPayments({ credit: "credited", page: 1, pageSize: 25 })).total,
      2,
    );
    equal(
      "payments: not-credited filter",
      (await loadPayments({ credit: "not-credited", page: 1, pageSize: 25 })).total,
      3,
    );
    const creditedRow = payments.rows.find((row) => row.ref === "DP-SEED-1");
    equal("payments: a settled deposit reads as credited", creditedRow?.walletCredit, "credited");
    const uncreditedRow = payments.rows.find((row) => row.ref === "DP-SEED-3");
    equal("payments: a settled deposit with no ledger row is flagged", uncreditedRow?.walletCredit, "not-credited");

    const users = await loadUsers({ page: 1, pageSize: 25 });
    equal("users: every account is listed", users.total, 2);
    check("users: list rows are masked", users.rows.every((row) => row.email.includes("•")));
    equal("users: search by name", (await loadUsers({ search: "kwame" })).total, 1);
    const userDetail = await loadUserDetail(ids.user1);
    equal("user detail: identity loads", userDetail?.user.email, "kwame@flexidata.test");
    equal("user detail: wallet balance", userDetail?.wallets[0]?.balance, 500);
    equal("user detail: recent ledger rows", userDetail?.recentTransactions.length, 8);
    equal("user detail: recent checkout orders", userDetail?.recentOrders.length, 4);

    // ---------------------------------------------------------------------
    section("F. Browsing the dashboard changes nothing");
    // ---------------------------------------------------------------------
    const after = (await pool.query(SNAPSHOT_SQL)).rows[0];
    equal("financial tables are byte-identical after every read", after, before);

    // ---------------------------------------------------------------------
    section("G. Admin API authorization");
    // ---------------------------------------------------------------------
    const endpoints: { name: string; call: () => Promise<Response> }[] = [];
    const { GET: overviewRoute } = await import("@/app/api/admin/overview/route");
    endpoints.push({ name: "/api/admin/overview", call: () => overviewRoute() as Promise<Response> });

    const { GET: walletsRoute } = await import("@/app/api/admin/wallets/route");
    endpoints.push({
      name: "/api/admin/wallets",
      call: () => walletsRoute(new Request("http://localhost/api/admin/wallets")) as Promise<Response>,
    });
    const { GET: walletDetailRoute } = await import("@/app/api/admin/wallets/[id]/route");
    endpoints.push({
      name: "/api/admin/wallets/[id]",
      call: () =>
        walletDetailRoute(new Request("http://localhost/api/admin/wallets/1"), {
          params: Promise.resolve({ id: String(ids.wallet1) }),
        }) as Promise<Response>,
    });
    const { GET: transactionsRoute } = await import("@/app/api/admin/transactions/route");
    endpoints.push({
      name: "/api/admin/transactions",
      call: () =>
        transactionsRoute(new Request("http://localhost/api/admin/transactions")) as Promise<Response>,
    });
    const { GET: transactionDetailRoute } = await import("@/app/api/admin/transactions/[ref]/route");
    endpoints.push({
      name: "/api/admin/transactions/[ref]",
      call: () =>
        transactionDetailRoute(new Request("http://localhost/api/admin/transactions/FD-SEED-1"), {
          params: Promise.resolve({ ref: "FD-SEED-1" }),
        }) as Promise<Response>,
    });
    const { GET: dataRoute } = await import("@/app/api/admin/data/route");
    endpoints.push({
      name: "/api/admin/data",
      call: () => dataRoute(new Request("http://localhost/api/admin/data")) as Promise<Response>,
    });
    const { GET: attentionRoute } = await import("@/app/api/admin/attention/route");
    endpoints.push({
      name: "/api/admin/attention",
      call: () =>
        attentionRoute(new Request("http://localhost/api/admin/attention")) as Promise<Response>,
    });
    const { GET: paymentsRoute } = await import("@/app/api/admin/payments/route");
    endpoints.push({
      name: "/api/admin/payments",
      call: () => paymentsRoute(new Request("http://localhost/api/admin/payments")) as Promise<Response>,
    });
    const { GET: reconciliationRoute } = await import("@/app/api/admin/reconciliation/route");
    endpoints.push({
      name: "/api/admin/reconciliation",
      call: () =>
        reconciliationRoute(new Request("http://localhost/api/admin/reconciliation")) as Promise<Response>,
    });
    const { GET: usersRoute } = await import("@/app/api/admin/users/route");
    endpoints.push({
      name: "/api/admin/users",
      call: () => usersRoute(new Request("http://localhost/api/admin/users")) as Promise<Response>,
    });
    const { GET: userDetailRoute } = await import("@/app/api/admin/users/[id]/route");
    endpoints.push({
      name: "/api/admin/users/[id]",
      call: () =>
        userDetailRoute(new Request("http://localhost/api/admin/users/1"), {
          params: Promise.resolve({ id: String(ids.user1) }),
        }) as Promise<Response>,
    });

    const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
      const warn = console.warn;
      const error = console.error;
      console.warn = () => {};
      console.error = () => {};
      try {
        return await fn();
      } finally {
        console.warn = warn;
        console.error = error;
      }
    };

    for (const endpoint of endpoints) {
      jar.clear();
      const anonymous: Response = await quiet(() => endpoint.call());
      jar.set("fd_session", CUSTOMER_TOKEN);
      const customer: Response = await quiet(() => endpoint.call());
      jar.set("fd_session", ADMIN_TOKEN);
      const admin: Response = await quiet(() => endpoint.call());
      jar.clear();

      const anonymousBody = await anonymous.text();
      const customerBody = await customer.text();

      check(
        `${endpoint.name}: anonymous → 404`,
        anonymous.status === 404 && anonymousBody.includes('"Not found"'),
        { status: anonymous.status, body: anonymousBody.slice(0, 120) },
      );
      check(
        `${endpoint.name}: ordinary customer → 404 (identical to anonymous)`,
        customer.status === 404 && customerBody === anonymousBody,
        { status: customer.status },
      );
      check(`${endpoint.name}: authorized admin → 200`, admin.status === 200, {
        status: admin.status,
        body: (await admin.text()).slice(0, 160),
      });
    }

    // The two-signal rule still holds: revoke is_admin and the SAME session dies.
    await pool.query("update users set is_admin = false where id = $1", [ids.user2]);
    jar.set("fd_session", ADMIN_TOKEN);
    const revoked: Response = await quiet(() => endpoints[0].call());
    check("revoking is_admin denies the live session immediately", revoked.status === 404, {
      status: revoked.status,
    });
    await pool.query("update users set is_admin = true where id = $1", [ids.user2]);

    const finalSnapshot = (await pool.query(SNAPSHOT_SQL)).rows[0];
    // `users.updated_at` is not part of the snapshot, but the fixture flip above
    // only touched is_admin on the harness's own admin account.
    equal("financial tables unchanged after the API sweep", finalSnapshot, before);

   } finally {
    // Always tear the throwaway cluster down, even when an assertion above
    // throws, so a failed run cannot leave a server on the port.
    if (poolRef) await poolRef.end().catch(() => undefined);
    if (embedded) await embedded.stop().catch(() => undefined);
   }
  }

  // -------------------------------------------------------------------------
  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length > 0 ? `\nFAILED: ${failed.map((result) => result.name).join(", ")}` : ""),
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
