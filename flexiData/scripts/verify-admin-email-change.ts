/**
 * Verification harness — renaming an administrator's email address.
 *
 * Drives the REAL operator CLI (`scripts/change-admin-email.ts`, spawned as a
 * child process exactly the way an operator would run it) against a REAL
 * PostgreSQL, so the guarantees below are observed on the shipped code path
 * rather than on a re-implementation of it:
 *
 *   A. Statement guard      the guard refuses every statement that is not a
 *                           read or `update "users" …` — including writes to
 *                           each financial table it exists to protect.
 *   B. Source guarantees    the script contains no INSERT/DELETE/UPDATE aimed
 *                           at a wallet, ledger, deposit, checkout, schedule,
 *                           agent, plan, alert or float table, and its only
 *                           write sites are BEGIN / the users UPDATE / COMMIT.
 *   C. Refusals             missing account, non-admin account, address already
 *                           taken (by an admin AND by a customer), same-address
 *                           no-op, and the default dry run — each one changes
 *                           NOTHING, proved by a full before/after snapshot of
 *                           every table in the database.
 *   D. The rename           exactly one admin ends up on the new address; the
 *                           old address is gone; the user id, password hash,
 *                           name, phone, referral code, `is_admin`, wallets,
 *                           sessions, password resets and `created_at` are all
 *                           unchanged; no second user was created; and every
 *                           financial table is byte-identical.
 *   E. Still the same login `verifyLogin()` accepts the NEW address with the
 *                           SAME password and rejects the old one, and the
 *                           admin gate lets the SAME live session in once
 *                           ADMIN_EMAILS lists the new address (and not before).
 *   F. Race guard           the conditional UPDATE matches zero rows if the row
 *                           moved between the pre-flight read and the write.
 *
 * The database is either
 *   - `DATABASE_URL`, used only when `FLEXIDATA_ADMIN_EMAIL_TEST_DB=1` is also
 *     set (an explicit "yes, really use this database" from the operator), or
 *   - a throwaway cluster started through the optional `embedded-postgres`
 *     package (`npm i --no-save embedded-postgres`).
 *
 * If neither is available the harness FAILS rather than reporting a hollow
 * pass: this tool writes to a production table, so an unverified run is worse
 * than no run.
 *
 * Usage: npm run verify:admin-email-change
 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** `src/db` reads DATABASE_URL at import time and refuses to load without it. */
const providedDatabaseUrl = (process.env.DATABASE_URL ?? "").trim();
if (!providedDatabaseUrl) {
  process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/placeholder";
}
process.env.AUTH_SECRET ??= "verify-admin-email-change-harness-secret-0123456789";
process.env.DATA_API_PROVIDER = "mock";
process.env.DATA_API_SCHEMA_PROBE_MS = "600000";
delete process.env.FLEXIDATA_TEST_USER_ID;
delete process.env.FLEXIDATA_TEST_ALLOW_ADMIN;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results: { name: string; ok: boolean; detail?: unknown }[] = [];
let skipped = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${JSON.stringify(detail)}`}`);
}

function equal<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : { actual, expected });
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function skip(name: string, why: string): void {
  skipped += 1;
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
    headers: async () => new Headers({ "user-agent": "verify-admin-email-change" }),
    cookies: async () => ({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
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

/** Silence the admin gate's (intentional) denial logging so output stays readable. */
function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  return fn().finally(() => {
    console.warn = warn;
    console.error = error;
  });
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Live handles, so a failure part-way through still shuts the cluster down. */
let activeClient: (Queryable & { end: () => Promise<void> }) | null = null;
let activeEmbedded: Embedded | null = null;

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
    const port = 53000 + (process.pid % 1500);
    const embedded = new mod.default({
      databaseDir: `/tmp/flexidata-admin-email-${process.pid}`,
      user: "fd",
      password: "fd",
      port,
      persistent: false,
      onLog: () => {},
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
// Fixtures — the admin account this harness renames
// ---------------------------------------------------------------------------

const OLD_EMAIL = "shadrachampah@gmail.com";
const NEW_EMAIL = "shadrachampah123@gmail.com";
const OPS_ADMIN_EMAIL = "ops@flexidata.test";
const CUSTOMER_EMAIL = "customer@flexidata.test";
const ADMIN_PASSWORD = "Correct-Horse-9";
/** A hash produced by the app's own scrypt helper, so login really works. */
let ADMIN_PASSWORD_HASH = "";

/** Every table in the schema — the snapshot compares all of them. */
const ALL_TABLES = [
  "users",
  "wallets",
  "sessions",
  "password_resets",
  "transactions",
  "deposit_requests",
  "checkout_orders",
  "scheduled_topups",
  "agent_profiles",
  "bundle_plans",
  "price_alerts",
  "provider_float_balances",
] as const;

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

/** Stable, comparable rendering of a table's contents (dates -> ISO strings). */
async function snapshot(client: Queryable): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of ALL_TABLES) {
    const { rows } = await client.query(`select * from "${table}" order by "id"`);
    out[table] = JSON.stringify(
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            value instanceof Date ? value.toISOString() : value,
          ]),
        ),
      ),
    );
  }
  return out;
}

function snapshotDiff(before: Record<string, string>, after: Record<string, string>): string[] {
  return ALL_TABLES.filter((table) => before[table] !== after[table]);
}

/** Run the shipped CLI exactly as an operator would. */
function runCli(args: string[], env: Record<string, string> = {}): { status: number; out: string } {
  const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const result = spawnSync(tsx, [path.join("scripts", "change-admin-email.ts"), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

async function seed(client: Queryable): Promise<{ adminId: number; adminWalletId: number }> {
  const { hashPassword } = await import("@/lib/auth");
  ADMIN_PASSWORD_HASH = hashPassword(ADMIN_PASSWORD);

  const insertUser = async (
    name: string,
    email: string,
    phone: string,
    referralCode: string,
    isAdmin: boolean,
    referredBy: number | null,
  ): Promise<number> => {
    const { rows } = await client.query(
      `insert into "users" ("name", "email", "phone", "password_hash", "referral_code",
                            "is_admin", "referred_by", "email_verified_at", "created_at", "updated_at")
       values ($1, $2, $3, $4, $5, $6, $7, now(), '2025-01-05T09:00:00Z', '2025-06-01T10:00:00Z')
       returning "id"`,
      [name, email, phone, ADMIN_PASSWORD_HASH, referralCode, isAdmin, referredBy],
    );
    return Number(rows[0].id);
  };

  const adminId = await insertUser("Shadrach Ampah", OLD_EMAIL, "0244000001", "FD-SHAD-0001", true, null);
  const opsId = await insertUser("Ops Admin", OPS_ADMIN_EMAIL, "0244000002", "FD-OPS-00002", true, null);
  const customerId = await insertUser(
    "Nana Customer",
    CUSTOMER_EMAIL,
    "0244000003",
    "FD-NANA-0003",
    false,
    adminId,
  );

  const insertWallet = async (
    userId: number,
    name: string,
    number: string,
    balance: string,
    points: number,
  ): Promise<number> => {
    const { rows } = await client.query(
      `insert into "wallets" ("user_id", "name", "number", "balance", "points", "referral_code", "created_at")
       values ($1, $2, $3, $4, $5, $6, '2025-01-05T09:00:01Z') returning "id"`,
      [userId, name, number, balance, points, `FD-${name.slice(0, 4).toUpperCase()}`],
    );
    return Number(rows[0].id);
  };

  const adminWalletId = await insertWallet(adminId, "Shadrach Ampah", "0244000001", "145.50", 320);
  const opsWalletId = await insertWallet(opsId, "Ops Admin", "0244000002", "20.00", 40);
  await insertWallet(customerId, "Nana Customer", "0244000003", "3.75", 12);

  await client.query(
    `insert into "agent_profiles" ("wallet_id", "tier", "referral_code", "referrals", "commission", "volume", "created_at")
     values ($1, 'Gold', 'FD-SHAD-0001', 4, '12.50', '250.00', '2025-02-01T08:00:00Z')`,
    [adminWalletId],
  );

  // Two live admin sessions + one customer session. Sessions are keyed by
  // user_id, so the rename must leave every one of them signed in.
  const adminToken = `tok_${randomBytes(12).toString("hex")}`;
  for (const [userId, token, userAgent] of [
    [adminId, adminToken, "iPhone 15 Pro"],
    [adminId, `tok_${randomBytes(12).toString("hex")}`, "Pixel 8"],
    [customerId, `tok_${randomBytes(12).toString("hex")}`, "Tecno Spark"],
  ] as [number, string, string][]) {
    await client.query(
      `insert into "sessions" ("user_id", "token_hash", "user_agent", "ip", "last_seen_at", "created_at", "expires_at")
       values ($1, $2, $3, '127.0.0.1', '2026-09-01T12:00:00Z', '2026-08-01T12:00:00Z', '2026-12-01T12:00:00Z')`,
      [userId, sha256(token), userAgent],
    );
  }

  await client.query(
    `insert into "password_resets" ("user_id", "token_hash", "used_at", "expires_at", "created_at")
     values ($1, $2, '2026-01-04T10:00:00Z', '2026-01-04T11:00:00Z', '2026-01-04T10:00:00Z')`,
    [adminId, sha256("reset-token-1")],
  );

  // Financial history on the admin's wallet: deposits, purchases, transfers,
  // rewards. Not one of these rows may move.
  const ledger: [string, string, string, string, string, string][] = [
    ["FD-DEP-0001", "deposit", "successful", "in", "Wallet deposit", "200.00"],
    ["FD-DAT-0002", "data", "successful", "out", "MTN 15GB UP2U", "35.00"],
    ["FD-AIR-0003", "airtime", "successful", "out", "MTN airtime", "10.00"],
    ["FD-TRF-0004", "transfer", "successful", "out", "Transfer to 0244000003", "25.00"],
    ["FD-RED-0005", "redemption", "successful", "out", "Points redemption", "5.00"],
    ["FD-REF-0006", "referral", "successful", "in", "Referral bonus", "10.00"],
  ];
  for (const [ref, type, status, direction, title, amount] of ledger) {
    await client.query(
      `insert into "transactions"
         ("ref", "wallet_id", "type", "status", "fulfillment_status", "direction", "title",
          "subtitle", "amount", "points", "network", "recipient", "provider", "provider_product_code",
          "provider_reference", "provider_status", "fulfillment_attempts", "charged_at", "fulfilled_at",
          "created_at")
       values ($1, $2, $3, $4, $5, $6, $7, 'ledger fixture', $8, 12, 'MTN', '0244000003', 'yenkodata',
               'YD-15GB', $9, 'successful', 1, '2026-08-02T10:00:00Z', '2026-08-02T10:01:20Z',
               '2026-08-02T10:00:00Z')`,
      [ref, adminWalletId, type, status, direction === "out" ? "delivered" : "queued", direction, title, amount, ref],
    );
  }

  await client.query(
    `insert into "deposit_requests"
       ("ref", "wallet_id", "provider", "method", "amount", "amount_subunits", "currency", "status",
        "provider_reference", "paystack_transaction_id", "paystack_channel", "paystack_gateway_response",
        "initiated_at", "completed_at", "paid_at", "verified_at", "created_at", "updated_at")
     values ('FD-DEP-0001', $1, 'paystack', 'mobile_money', '200.00', 20000, 'GHS', 'successful',
             'ref_FD-DEP-0001', 'PSV_TEST_0000001', 'mobile_money', 'Successful',
             '2026-08-02T09:59:00Z', '2026-08-02T10:00:00Z', '2026-08-02T10:00:00Z',
             '2026-08-02T10:00:00Z', '2026-08-02T09:59:00Z', '2026-08-02T10:00:00Z')`,
    [adminWalletId],
  );

  // A paid Paystack checkout order. `customer_email` is the address Paystack was
  // told at the time — it is history, and it must keep the OLD address.
  await client.query(
    `insert into "checkout_orders"
       ("ref", "user_id", "wallet_id", "customer_email", "customer_phone", "network", "category",
        "plan_label", "provider_product_code", "recipient", "amount", "amount_subunits", "currency",
        "payment_status", "order_status", "fulfillment_status", "paystack_transaction_id",
        "paystack_channel", "paid_at", "verified_at", "fulfilled_at", "created_at", "updated_at")
     values ('FD-ORD-0007', $1, $2, $3, '0244000001', 'MTN', 'up2u', 'MTN 15GB UP2U', 'YD-15GB',
             '0244000001', '45.00', 4500, 'GHS', 'successful', 'fulfilled', 'delivered',
             'PSV_TEST_0000002', 'mobile_money', '2026-08-03T11:00:00Z', '2026-08-03T11:00:00Z',
             '2026-08-03T11:01:00Z', '2026-08-03T10:59:00Z', '2026-08-03T11:01:00Z')`,
    [adminId, adminWalletId, OLD_EMAIL],
  );

  await client.query(
    `insert into "scheduled_topups" ("wallet_id", "network", "plan_label", "price", "recipient", "day_of_month", "active", "created_at")
     values ($1, 'MTN', 'MTN 5GB', '18.00', '0244000001', 1, true, '2026-07-01T09:00:00Z')`,
    [adminWalletId],
  );

  await client.query(
    `insert into "bundle_plans" ("network", "category", "label", "provider_product_code", "validity", "price", "retail_price", "badge", "sort_order")
     values ('MTN', 'up2u', 'MTN 15GB UP2U', 'YD-15GB', '30 days', '35.00', '40.00', 'Popular', 1)`,
  );
  await client.query(
    `insert into "price_alerts" ("network", "title", "body", "tag", "active", "created_at")
     values ('MTN', 'Weekend deal', 'Extra 2GB on every 10GB bundle', 'promo', true, '2026-07-15T09:00:00Z')`,
  );
  await client.query(
    `insert into "provider_float_balances" ("provider_code", "network", "currency", "available_balance", "reserved_balance", "low_balance_threshold", "last_reference", "last_status", "last_synced_at", "created_at", "updated_at")
     values ('yenkodata', 'MTN', 'GHS', '1250.00', '45.00', '100.00', 'FLOAT-1', 'successful', '2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
  );

  return { adminId, adminWalletId };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\nFlexiData — admin email rename verification");

  // -------------------------------------------------------------------------
  section("A. Statement guard (no database needed)");
  // -------------------------------------------------------------------------
  const { assertAdminEmailStatement, AdminEmailStatementViolation, GUARDED_TABLES } = await import(
    "./change-admin-email"
  );

  const refused: string[] = [];
  for (const statement of [
    `update "wallets" set "balance" = '999.00' where "id" = 1`,
    `insert into "transactions" ("ref") values ('X')`,
    `delete from "sessions" where "user_id" = 1`,
    `truncate "deposit_requests"`,
    `update "users" set "is_admin" = true where "id" = 1`, // right table, wrong shape
    `update "users" set "email" = $1; delete from "users" where "id" = 2`,
    `select * into "leak" from "users"`,
    `select nextval('users_id_seq')`,
    `drop table "users"`,
    `create table "x" ("id" int)`,
    `grant all on "users" to public`,
    `alter table "users" rename column "email" to "old_email"`,
  ]) {
    try {
      assertAdminEmailStatement(statement);
    } catch (error) {
      if (error instanceof AdminEmailStatementViolation) refused.push(statement);
    }
  }
  equal("every non-read, non-users statement is refused", refused.length, 12);

  const allowed: string[] = [];
  for (const statement of [
    `begin`,
    `commit`,
    `rollback`,
    `select * from "users" where lower("email") = lower($1)`,
    `select coalesce(md5(string_agg(x::text, '|' order by x.id)), '') as digest from "transactions" as x`,
    `select count(*)::int as c from "checkout_orders"`,
    `update "users"
        set "email" = $1, "updated_at" = now()
      where "id" = $2 and "email" = $3 and "is_admin" = true
      returning "id", "email", "is_admin", "updated_at"`,
  ]) {
    try {
      assertAdminEmailStatement(statement);
      allowed.push(statement);
    } catch {
      // counted below
    }
  }
  equal("reads, transaction control and the users UPDATE are allowed", allowed.length, 7);

  for (const table of GUARDED_TABLES) {
    let threw = false;
    try {
      assertAdminEmailStatement(`update "${table}" set "id" = "id" where "id" = 0`);
    } catch {
      threw = true;
    }
    // GUARDED_TABLES deliberately excludes `users`, so every one of these must
    // be refused — including a generic UPDATE that only *looks* harmless.
    check(`a write to "${table}" is refused`, threw);
  }

  // -------------------------------------------------------------------------
  section("B. Source guarantees (the script's own text)");
  // -------------------------------------------------------------------------
  const source = readFileSync(path.join(process.cwd(), "scripts", "change-admin-email.ts"), "utf8");
  const writeVerbs = ["insert into", "delete from", "truncate", "update"] as const;
  const offending: string[] = [];
  for (const table of GUARDED_TABLES) {
    for (const verb of writeVerbs) {
      const pattern = new RegExp(`${verb}\\s+"?${table}"?`, "i");
      if (pattern.test(source)) offending.push(`${verb} ${table}`);
    }
  }
  equal("no INSERT/DELETE/TRUNCATE/UPDATE targets a guarded table", offending, []);
  check(
    'the only UPDATE in the script is `update "users"`',
    (source.match(/\bupdate\s+"?[a-z_]+"?\s+set/gi) ?? []).every((match) => /update\s+"?users"?\s+set/i.test(match)),
    source.match(/\bupdate\s+"?[a-z_]+"?\s+set/gi),
  );
  check(
    "the UPDATE writes only email and updated_at",
    /update "users"\s+set "email" = \$1, "updated_at" = now\(\)/.test(source),
  );
  check(
    "the UPDATE is conditional on the stored email AND is_admin = true",
    /where "id" = \$2 and "email" = \$3 and "is_admin" = true/.test(source),
  );
  check(
    "the financial digest is re-checked before COMMIT (not after)",
    source.indexOf("digestDiff(before, after)") < source.indexOf('write(client, `commit`)'),
  );
  check("no INSERT anywhere in the script (it cannot create a user)", !/\binsert\s+into\b/i.test(source));

  // -------------------------------------------------------------------------
  section("Database bootstrap");
  // -------------------------------------------------------------------------
  const useProvided = Boolean(providedDatabaseUrl) && process.env.FLEXIDATA_ADMIN_EMAIL_TEST_DB === "1";
  let url = "";
  let embedded: Embedded | null = null;

  if (useProvided) {
    url = providedDatabaseUrl;
    console.log(`  Using the operator-provided DATABASE_URL (FLEXIDATA_ADMIN_EMAIL_TEST_DB=1).`);
  } else {
    const started = await startEmbedded();
    if (started) {
      embedded = started.embedded;
      url = started.url;
      console.log("  Started a throwaway PostgreSQL cluster for this run.");
    }
  }

  if (!url) {
    console.log(
      "\n  This harness writes to a real users table, so it refuses to report a hollow pass.\n" +
        "  Provide a database one of two ways:\n" +
        "    npm i --no-save embedded-postgres && npm run verify:admin-email-change\n" +
        "    DATABASE_URL=postgresql://… FLEXIDATA_ADMIN_EMAIL_TEST_DB=1 npm run verify:admin-email-change\n",
    );
    summarize();
    process.exit(1);
  }

  process.env.DATABASE_URL = url;

  const pgModule = require("pg") as {
    Client: new (config: { connectionString: string }) => Queryable & {
      connect: () => Promise<void>;
      end: () => Promise<void>;
    };
  };
  const client = new pgModule.Client({ connectionString: url });
  activeClient = client;
  activeEmbedded = embedded;
  await client.connect();
  await applyMigrations(client as unknown as { query: (sql: string) => Promise<unknown> });
  const { adminId, adminWalletId } = await seed(client);
  console.log(`  Seeded admin #${adminId} (${OLD_EMAIL}), a second admin, one customer, wallet #${adminWalletId}.`);

  const baseline = await snapshot(client);

  /** Assert the whole database is untouched. */
  async function unchangedSince(label: string, before: Record<string, string>): Promise<void> {
    const after = await snapshot(client);
    equal(`${label}: no table changed`, snapshotDiff(before, after), []);
  }

  // -------------------------------------------------------------------------
  section("C. Refusals — each one must change nothing");
  // -------------------------------------------------------------------------
  const missing = runCli(["--from", "nobody@flexidata.test", "--to", NEW_EMAIL, "--yes"]);
  check("unknown address -> exit 1", missing.status === 1, { status: missing.status, out: missing.out.slice(0, 300) });
  check("unknown address -> says no account was found", /No account found with email/i.test(missing.out));
  check("unknown address -> writes nothing", /Nothing was changed/i.test(missing.out));
  await unchangedSince("unknown address", baseline);

  const notAdmin = runCli(["--from", CUSTOMER_EMAIL, "--to", NEW_EMAIL, "--yes"]);
  check("non-admin account -> exit 1", notAdmin.status === 1, { status: notAdmin.status, out: notAdmin.out.slice(0, 300) });
  check(
    "non-admin account -> refused because is_admin is false",
    /users\.is_admin is FALSE/.test(notAdmin.out),
    notAdmin.out.slice(0, 300),
  );
  await unchangedSince("non-admin account", baseline);

  const takenByAdmin = runCli(["--from", OLD_EMAIL, "--to", OPS_ADMIN_EMAIL, "--yes"]);
  check("address held by another ADMIN -> exit 1", takenByAdmin.status === 1, { status: takenByAdmin.status });
  check(
    "address held by another ADMIN -> names the conflicting account",
    /already uses "ops@flexidata\.test"/.test(takenByAdmin.out) && /is_admin = true/.test(takenByAdmin.out),
    takenByAdmin.out.slice(0, 400),
  );
  await unchangedSince("address held by another admin", baseline);

  const takenByCustomer = runCli(["--from", OLD_EMAIL, "--to", CUSTOMER_EMAIL, "--yes"]);
  check("address held by a customer -> exit 1", takenByCustomer.status === 1, { status: takenByCustomer.status });
  check(
    "address held by a customer -> names the conflicting account",
    /already uses "customer@flexidata\.test"/.test(takenByCustomer.out),
    takenByCustomer.out.slice(0, 400),
  );
  await unchangedSince("address held by a customer", baseline);

  const sameAddress = runCli(["--from", OLD_EMAIL, "--to", OLD_EMAIL, "--yes"]);
  check("same address -> exit 1, nothing written", sameAddress.status === 1, { status: sameAddress.status });
  await unchangedSince("same address", baseline);

  const dryRun = runCli(["--from", OLD_EMAIL, "--to", NEW_EMAIL]);
  check("no --yes -> exit 0 (a plan, not a failure)", dryRun.status === 0, { status: dryRun.status, out: dryRun.out.slice(0, 300) });
  check("no --yes -> announces DRY RUN", /DRY RUN — nothing was written/.test(dryRun.out));
  check("no --yes -> shows the exact UPDATE it would run", /update "users" set "email" = 'shadrachampah123@gmail\.com'/.test(dryRun.out));
  check("no --yes -> confirms the source account is the admin", /is_admin\s+true/.test(dryRun.out));
  await unchangedSince("dry run", baseline);

  const status = runCli(["--from", OLD_EMAIL, "--status"], { ADMIN_EMAILS: OLD_EMAIL });
  check("--status -> exit 0", status.status === 0, { status: status.status });
  check("--status -> reports the wallet relationship", /#1 \(0244000001, GH₵ 145\.50, 320 pts\)/.test(status.out), status.out.slice(0, 400));
  check("--status -> reports both admin signals", /ACCESS GRANTED/.test(status.out));
  await unchangedSince("--status", baseline);

  // -------------------------------------------------------------------------
  section("D. The rename itself");
  // -------------------------------------------------------------------------
  const applied = runCli(["--from", OLD_EMAIL, "--to", NEW_EMAIL, "--yes"], {
    ADMIN_EMAILS: `${NEW_EMAIL}, ${OPS_ADMIN_EMAIL}`,
  });
  check("rename -> exit 0", applied.status === 0, { status: applied.status, out: applied.out.slice(-600) });
  check("rename -> reports the new address", applied.out.includes(`RENAMED: ${OLD_EMAIL} -> ${NEW_EMAIL}`), applied.out.slice(-600));
  console.log(
    applied.out
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => `    ${line}`)
      .join("\n"),
  );

  const after = await snapshot(client);
  const changedTables = snapshotDiff(baseline, after);
  equal("only the users table changed", changedTables, ["users"]);

  const usersBefore = JSON.parse(baseline.users) as Record<string, unknown>[];
  const usersAfter = JSON.parse(after.users) as Record<string, unknown>[];
  equal("no second user was created", usersAfter.length, usersBefore.length);

  const adminBefore = usersBefore.find((row) => row.id === adminId)!;
  const adminAfter = usersAfter.find((row) => row.id === adminId)!;
  const changedColumns = Object.keys(adminAfter).filter(
    (key) => JSON.stringify(adminAfter[key]) !== JSON.stringify(adminBefore[key]),
  );
  equal("exactly two columns changed on the admin row", changedColumns.sort(), ["email", "updated_at"]);
  equal("the email is the new address", adminAfter.email, NEW_EMAIL);
  equal("is_admin is still true", adminAfter.is_admin, true);
  equal("the user id is unchanged", adminAfter.id, adminId);
  equal("the password hash is unchanged", adminAfter.password_hash, adminBefore.password_hash);
  equal("created_at is unchanged", adminAfter.created_at, adminBefore.created_at);
  equal("updated_at moved", adminAfter.updated_at !== adminBefore.updated_at, true);
  equal(
    "the old address belongs to nobody now",
    usersAfter.filter((row) => String(row.email).toLowerCase() === OLD_EMAIL).length,
    0,
  );
  equal(
    "exactly one admin has the new address",
    usersAfter.filter((row) => String(row.email).toLowerCase() === NEW_EMAIL && row.is_admin === true).length,
    1,
  );
  equal(
    "exactly one account has the new address at all",
    usersAfter.filter((row) => String(row.email).toLowerCase() === NEW_EMAIL).length,
    1,
  );
  equal(
    "the admin count is unchanged (2: the renamed account + ops)",
    usersAfter.filter((row) => row.is_admin === true).length,
    2,
  );
  equal(
    "the customer referred BY the admin still points at the same user id",
    usersAfter.find((row) => row.email === CUSTOMER_EMAIL)!.referred_by,
    adminId,
  );

  // Wallet / session / reset relationships, row for row.
  equal("wallets byte-identical", after.wallets, baseline.wallets);
  equal("sessions byte-identical", after.sessions, baseline.sessions);
  equal("password resets byte-identical", after.password_resets, baseline.password_resets);
  equal("transactions byte-identical", after.transactions, baseline.transactions);
  equal("deposit_requests byte-identical", after.deposit_requests, baseline.deposit_requests);
  equal("checkout_orders byte-identical", after.checkout_orders, baseline.checkout_orders);
  equal("scheduled_topups byte-identical", after.scheduled_topups, baseline.scheduled_topups);
  equal("agent_profiles byte-identical", after.agent_profiles, baseline.agent_profiles);
  equal("bundle_plans byte-identical", after.bundle_plans, baseline.bundle_plans);
  equal("price_alerts byte-identical", after.price_alerts, baseline.price_alerts);
  equal("provider_float_balances byte-identical", after.provider_float_balances, baseline.provider_float_balances);
  check(
    "the paid Paystack order keeps the address it was created with",
    (JSON.parse(after.checkout_orders) as Record<string, unknown>[])[0].customer_email === OLD_EMAIL,
    (JSON.parse(after.checkout_orders) as Record<string, unknown>[])[0].customer_email,
  );

  // -------------------------------------------------------------------------
  section("E. Same account, same password, new address");
  // -------------------------------------------------------------------------
  const { verifyLogin } = await import("@/lib/accounts");
  const loginNew = await verifyLogin(NEW_EMAIL, ADMIN_PASSWORD);
  check("the NEW address signs in with the SAME password", loginNew?.id === adminId, loginNew);
  check("the OLD address no longer signs in", (await verifyLogin(OLD_EMAIL, ADMIN_PASSWORD)) === null);
  const wrongPassword = await verifyLogin(NEW_EMAIL, "not-the-password");
  check("a wrong password is still rejected", wrongPassword === null);
  const opsLogin = await verifyLogin(OPS_ADMIN_EMAIL, ADMIN_PASSWORD);
  check("the other admin still signs in", opsLogin?.id !== adminId && opsLogin !== null, opsLogin);

  // The gate needs BOTH signals. Same live session, same cookie, before and
  // after the allowlist catches up with the rename.
  const { getAdminContext } = await import("@/lib/admin/auth");
  const adminToken = (JSON.parse(after.sessions) as Record<string, unknown>[]).find(
    (row) => row.user_agent === "iPhone 15 Pro",
  );
  check("the admin's session row survived the rename", Boolean(adminToken), adminToken);

  // We cannot recover the raw token from its hash, so prove the gate against a
  // freshly issued session for the SAME user id — the thing under test is that
  // the gate resolves the renamed account, not the token itself.
  const freshToken = `tok_${randomBytes(12).toString("hex")}`;
  await client.query(
    `insert into "sessions" ("user_id", "token_hash", "user_agent", "ip", "last_seen_at", "created_at", "expires_at")
     values ($1, $2, 'harness', '127.0.0.1', now(), now(), now() + interval '1 hour')`,
    [adminId, sha256(freshToken)],
  );
  jar.set("fd_session", freshToken);

  process.env.ADMIN_EMAILS = OLD_EMAIL; // allowlist not yet updated
  const staleAllowlist = await quiet(getAdminContext);
  check(
    "stale ADMIN_EMAILS (old address) -> gate denies the renamed admin",
    staleAllowlist === null,
    staleAllowlist,
  );

  process.env.ADMIN_EMAILS = `${NEW_EMAIL}, ${OPS_ADMIN_EMAIL}`;
  const context = await quiet(getAdminContext);
  check("updated ADMIN_EMAILS -> gate admits the SAME session", context !== null, context);
  equal("the gate reports the NEW address", context?.admin.email, NEW_EMAIL);
  equal("the gate reports the SAME user id", context?.admin.userId, adminId);

  const statusAfter = runCli(["--from", NEW_EMAIL, "--status"], { ADMIN_EMAILS: NEW_EMAIL });
  check("--status on the new address -> ACCESS GRANTED", /ACCESS GRANTED/.test(statusAfter.out), statusAfter.out.slice(0, 300));

  // -------------------------------------------------------------------------
  section("F. The conditional UPDATE is the last line of defence");
  // -------------------------------------------------------------------------
  const stale = await client.query(
    `update "users"
        set "email" = $1, "updated_at" = now()
      where "id" = $2 and "email" = $3 and "is_admin" = true
      returning "id"`,
    ["whoever@flexidata.test", adminId, OLD_EMAIL], // stale: the row moved already
  );
  equal("a stale pre-flight read updates zero rows", stale.rows.length, 0);
  const rerun = runCli(["--from", OLD_EMAIL, "--to", "another@flexidata.test", "--yes"]);
  check("re-running with the old address fails cleanly", rerun.status === 1, { status: rerun.status });
  check("re-running with the old address says the account is gone", /No account found with email/i.test(rerun.out));

  const finalSnapshot = await snapshot(client);
  equal(
    "the stale UPDATE and the failed re-run changed nothing",
    snapshotDiff(after, finalSnapshot).filter((table) => table !== "sessions"),
    [],
  );

  await teardown(client, embedded);
  summarize();
  process.exit(results.some((result) => !result.ok) ? 1 : 0);
}

/**
 * Close everything before the cluster goes away. `@/db` opened its own pool
 * when the app modules were imported for the login/gate checks, and an idle
 * connection killed by the server shutdown surfaces as an unhandled 'error'
 * event — so that pool is closed (and its error event swallowed) first.
 */
async function teardown(
  client: (Queryable & { end: () => Promise<void> }) | null,
  embedded: Embedded | null,
): Promise<void> {
  await client?.end().catch(() => undefined);
  try {
    const { pool } = await import("@/db");
    (pool as unknown as { on?: (event: string, handler: () => void) => void }).on?.("error", () => {});
    await (pool as unknown as { end: () => Promise<void> }).end();
  } catch {
    // The harness never reached the app modules; nothing to close.
  }
  if (embedded) await embedded.stop().catch(() => undefined);
}

function summarize(): void {
  const failed = results.filter((result) => !result.ok);
  console.log("");
  console.log(
    `${results.length - failed.length}/${results.length} checks passed` +
      (skipped > 0 ? `, ${skipped} skipped` : "") +
      ".",
  );
  if (failed.length > 0) {
    console.log("\nFailed checks:");
    for (const failure of failed) console.log(`  - ${failure.name}  ${JSON.stringify(failure.detail ?? "")}`);
    console.log("");
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  await teardown(activeClient, activeEmbedded);
  summarize();
  process.exit(1);
});
