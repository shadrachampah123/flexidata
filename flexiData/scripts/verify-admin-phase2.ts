/**
 * Phase 2, Step 1 verification harness — FlexiData customer management.
 *
 * Proves, in three layers, that customer management is safe and that the
 * Phase 0 authorization gate still guards every admin surface:
 *
 *   A. Pure functions          filter parsing used by the new surface.
 *   B. Source guarantees       the status route is gated; the only write path
 *                              touches `users` + `admin_audit_logs`; the only
 *                              browser write is the confirmed suspend/activate
 *                              POST; the migration adds nothing to financial
 *                              tables; the Phase 0 gate still guards every
 *                              handler and page.
 *   C. Live database           search, detail, suspend/activate idempotency,
 *                              audit records, admin-identity non-spoofing,
 *                              suspended-customer blocking, and a before/after
 *                              snapshot proving no financial row changed.
 *
 * C needs a real PostgreSQL. The harness will:
 *   - use `DATABASE_URL` when `FLEXIDATA_ADMIN_TEST_DB=1` is also set (CI), or
 *   - boot a throwaway cluster through the optional `embedded-postgres`
 *     package (`npm i --no-save embedded-postgres`), or
 *   - skip C with a loud warning.
 *
 * It never runs against a database it was not explicitly told to use.
 *
 * Usage: npm run verify:admin-phase2
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** `src/db` reads `DATABASE_URL` at import time; placeholder for A–B only. */
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
    headers: async () => new Headers({ "user-agent": "verify-admin-phase2" }),
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
    const port = 53000 + (process.pid % 2000);
    const embedded = new mod.default({
      databaseDir: `/tmp/flexidata-admin-phase2-${process.pid}`,
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

async function applyMigrations(client: { query: (sql: string) => Promise<unknown> }): Promise<void> {
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
// Fixtures
// ---------------------------------------------------------------------------

const ADMIN_EMAIL = "ada@flexidata.test";
const ADMIN_TOKEN = "phase2-admin-token";
const CUSTOMER_TOKEN = "phase2-customer-token";

async function seed(pool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}): Promise<{ adminId: number; c1: number; c2: number; wallet1: number; wallet2: number }> {
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const expires = new Date(Date.now() + 30 * 86400_000).toISOString();

  const [c1] = await q(
    `insert into users (name, email, phone, password_hash, referral_code, is_admin)
     values ('Kwame Mensah', 'kwame@flexidata.test', '0244123456', 'scrypt:a:b', 'KWAME1', false)
     returning id`,
  );
  const [c2] = await q(
    `insert into users (name, email, phone, password_hash, referral_code, is_admin)
     values ('Ama Serwaa', 'ama@flexidata.test', '0244987654', 'scrypt:a:b', 'AMA001', false)
     returning id`,
  );
  const [admin] = await q(
    `insert into users (name, email, phone, password_hash, referral_code, is_admin)
     values ('Ada Admin', $1, '0500000001', 'scrypt:a:b', 'ADA001', true)
     returning id`,
    [ADMIN_EMAIL],
  );

  const [wallet1] = await q(
    `insert into wallets (user_id, name, number, balance, points)
     values ($1, 'Kwame Mensah', '0244123456', 500.00, 40) returning id`,
    [c1.id],
  );
  const [wallet2] = await q(
    `insert into wallets (user_id, name, number, balance, points)
     values ($1, 'Ama Serwaa', '0244987654', 120.00, 5) returning id`,
    [c2.id],
  );
  await q(
    `insert into wallets (user_id, name, number, balance, points)
     values ($1, 'Ada Admin', '0500000001', 0.00, 0)`,
    [admin.id],
  );

  await q(
    `insert into sessions (user_id, token_hash, user_agent, ip, last_seen_at, expires_at)
     values ($1, $2, 'verify-admin-phase2', '127.0.0.1', now(), $3),
            ($4, $5, 'verify-admin-phase2', '127.0.0.1', now(), $3)`,
    [admin.id, sha256(ADMIN_TOKEN), expires, c1.id, sha256(CUSTOMER_TOKEN)],
  );

  // A little ledger activity so the detail screen has something to show, and so
  // the financial snapshot below is non-trivial.
  await q(
    `insert into transactions
       (ref, wallet_id, type, status, fulfillment_status, direction, title, subtitle, amount, points, network, recipient, charged_at, fulfilled_at, created_at)
     values ('DP-P2-1', $1, 'deposit', 'successful', 'delivered', 'in', 'Wallet Top-up', '', 500.00, 0, null, null, now(), now(), now())`,
    [wallet1.id],
  );

  return {
    adminId: Number(admin.id),
    c1: Number(c1.id),
    c2: Number(c2.id),
    wallet1: Number(wallet1.id),
    wallet2: Number(wallet2.id),
  };
}

/** Everything that must be byte-identical before and after the admin actions. */
const FINANCIAL_SNAPSHOT_SQL = `select
  (select count(*)::int from users) as users_count,
  (select count(*)::int from wallets) as wallets_count,
  (select coalesce(sum(balance), 0)::text from wallets) as wallets_balance,
  (select count(*)::int from transactions) as tx_count,
  (select coalesce(sum(amount), 0)::text from transactions) as tx_amount,
  (select count(*)::int from deposit_requests) as deposit_count,
  (select coalesce(sum(amount), 0)::text from deposit_requests) as deposit_amount,
  (select count(*)::int from checkout_orders) as order_count,
  (select count(*)::int from sessions) as session_count`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("FlexiData — Admin & Operations Dashboard: Phase 2, Step 1 verification");

  const providedUrl = providedDatabaseUrl;
  const allowProvided = process.env.FLEXIDATA_ADMIN_TEST_DB === "1";

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
  const filters = await import("@/lib/admin/filters");
  equal("parseId accepts a positive integer", filters.parseId("42"), 42);
  equal("parseId rejects a non-numeric id", filters.parseId("abc"), null);
  equal("parseId rejects a negative id", filters.parseId("-1"), null);
  equal("parseSearch neutralises SQL wildcards", filters.parseSearch("a%b_c\\d"), "a b c d");
  equal("parseSearch truncates to 60 chars", filters.parseSearch("x".repeat(90)).length, 60);

  // -------------------------------------------------------------------------
  section("B. Source-level guarantees");
  // -------------------------------------------------------------------------
  const { readdirSync: readDir, statSync } = await import("node:fs");
  const walk = (dir: string): string[] =>
    readDir(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

  const statusRoutePath = path.join(
    process.cwd(),
    "src/app/api/admin/users/[id]/status/route.ts",
  );
  const statusRoute = readFileSync(statusRoutePath, "utf8");
  const statusHandler = statusRoute.search(/export (async function|const) POST/);
  const statusGateAt = statusRoute.indexOf("requireAdminApi()");
  check(
    "the status route authorizes itself before anything else",
    statusGateAt >= 0 && statusRoute.slice(statusHandler, statusHandler + 300).includes("requireAdminApi()"),
    { statusHandler, statusGateAt },
  );
  check("the status route is never cached", statusRoute.includes(`export const dynamic = "force-dynamic"`));
  check(
    "the status route never trusts a browser-supplied admin id (uses the gate context)",
    statusRoute.includes("gate.context.admin.userId") &&
      !/body\.adminUserId|body\["adminUserId"\]|body\.admin/.test(statusRoute),
  );
  check("the status route requires an explicit confirm", statusRoute.includes("confirm"));

  const mgmtPath = path.join(process.cwd(), "src/lib/customer-management.ts");
  const mgmt = readFileSync(mgmtPath, "utf8");
  const financialTables = [
    "wallets",
    "transactions",
    "deposit_requests",
    "checkout_orders",
    "provider_float_balances",
    "agent_profiles",
    "bundle_plans",
    "scheduled_topups",
    "price_alerts",
  ];
  // Only the schema imports matter: the doc comment names financial tables to
  // say the module can never reach them, so the code-level check looks at what
  // the module actually binds from `@/db/schema`.
  const schemaImport = mgmt.match(/import\s*\{([^}]*)\}\s*from\s*"@\/db\/schema"/)?.[1] ?? "";
  const financialIdentifiers = [
    "wallets",
    "transactions",
    "depositRequests",
    "checkoutOrders",
    "providerFloatBalances",
    "agentProfiles",
    "bundlePlans",
    "scheduledTopups",
    "priceAlerts",
  ];
  const mgmtTouches = financialIdentifiers.filter((t) => new RegExp(`\\b${t}\\b`).test(schemaImport));
  check(
    "customer-management.ts imports no financial table",
    mgmtTouches.length === 0,
    mgmtTouches,
  );
  check(
    "customer-management.ts only mutates users + adminAuditLogs",
    /\b(update|insert)\s*\(\s*(users|adminAuditLogs)\s*\)/.test(mgmt) &&
      !/(update|insert)\s*\(\s*(wallets|transactions|depositRequests|checkoutOrders)/.test(mgmt),
  );
  check(
    "customer-management.ts writes the audit row only when the status changed",
    mgmt.includes("updated.length > 0") && mgmt.includes("adminAuditLogs"),
  );

  // The migration must only add users.status and admin_audit_logs.
  const drizzleDir = path.join(process.cwd(), "drizzle");
  const phase2Migration = readdirSync(drizzleDir)
    .filter((f) => f.startsWith("0002") && f.endsWith(".sql"))
    .map((f) => readFileSync(path.join(drizzleDir, f), "utf8"))
    .join("\n");
  check("a Phase 2 migration exists (0002_*.sql)", phase2Migration.length > 0);
  const migrationTouches = financialTables.filter((t) =>
    new RegExp(`(create table|alter table)\\s+"?${t}"?`, "i").test(phase2Migration),
  );
  check("the migration touches no financial table", migrationTouches.length === 0, migrationTouches);
  check("the migration adds the status column", /add column "status"/i.test(phase2Migration));
  check("the migration creates admin_audit_logs", /create table "admin_audit_logs"/i.test(phase2Migration));

  // The only browser write surface is the confirmed customer-status POST.
  const browserFacing = [
    ...walk(path.join(process.cwd(), "src/app/admin")),
    ...walk(path.join(process.cwd(), "src/components/admin")),
  ];
  const writeCalls = /\bmethod:\s*["'](POST|PUT|PATCH|DELETE)["']|\.post\(|\.put\(|\.patch\(|\.delete\(|\baction=\{/i;
  const writes: string[] = [];
  for (const file of browserFacing) {
    const source = readFileSync(file, "utf8");
    if (writeCalls.test(source)) writes.push(file.replace(process.cwd(), ""));
  }
  equal(
    "the only browser write surface is the customer-actions component",
    writes,
    ["/src/components/admin/customer-actions.tsx"],
  );
  const actionsComponent = readFileSync(
    path.join(process.cwd(), "src/components/admin/customer-actions.tsx"),
    "utf8",
  );
  check(
    "customer-actions.tsx posts only to the gated status endpoint with confirm: true",
    actionsComponent.includes("/api/admin/users/") &&
      actionsComponent.includes("/status") &&
      actionsComponent.includes("confirm: true") &&
      !/method:\s*["'](PUT|PATCH|DELETE)["']/.test(actionsComponent),
  );

  // Every admin handler and page still re-checks the Phase 0 gate.
  const apiFiles = walk(path.join(process.cwd(), "src/app/api/admin")).filter((f) =>
    f.endsWith("route.ts"),
  );
  let ungatedApi = 0;
  for (const file of apiFiles) {
    const source = readFileSync(file, "utf8");
    const handler = source.search(/export (async function|const) (GET|POST)/);
    const body = handler >= 0 ? source.slice(handler, handler + 300) : source;
    if (!(source.includes("requireAdminApi()") && body.includes("requireAdminApi()"))) ungatedApi += 1;
  }
  equal("every admin API handler is gated", ungatedApi, 0);

  const pageFiles = walk(path.join(process.cwd(), "src/app/admin")).filter((f) =>
    f.endsWith("page.tsx"),
  );
  const ungatedPages = pageFiles.filter(
    (file) => !readFileSync(file, "utf8").includes("requireAdmin()"),
  );
  equal("every admin page re-checks the gate", ungatedPages.length, 0, ungatedPages);

  // -------------------------------------------------------------------------
  section("C. Live database checks");
  // -------------------------------------------------------------------------
  const url = liveUrl;
  if (!url) skip("live checks", skipReason);

  let poolRef: { end: () => Promise<void> } | null = null;
  if (url) {
    try {
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
      const q = async (sql: string, params: unknown[] = []) =>
        (await pool.query(sql, params)).rows;

      const { loadUsers, loadUserDetail } = await import("@/lib/admin/queries");
      const { GET: usersRoute } = await import("@/app/api/admin/users/route");
      const { GET: userDetailRoute } = await import("@/app/api/admin/users/[id]/route");
      const { POST: statusRoute } = await import("@/app/api/admin/users/[id]/status/route");

      // -------------------------------------------------------------------
      section("C1. Reads: search + detail");
      // -------------------------------------------------------------------
      const allUsers = await loadUsers({ page: 1, pageSize: 25 });
      equal("loadUsers lists every account", allUsers.total, 3);
      equal("loadUsers: search by name", (await loadUsers({ search: "kwame" })).total, 1);
      equal("loadUsers: search by email", (await loadUsers({ search: "ama@" })).total, 1);
      equal("loadUsers: search by phone", (await loadUsers({ search: "0244987654" })).total, 1);
      check("loadUsers: list rows are masked", allUsers.rows.every((r) => r.email.includes("•")));
      const kwameRow = allUsers.rows.find((r) => r.userId === ids.c1);
      equal("loadUsers: status is available on the migrated schema", kwameRow?.status, "active");

      const detail = await loadUserDetail(ids.c1);
      equal("loadUserDetail: identity", detail?.user.email, "kwame@flexidata.test");
      equal("loadUserDetail: wallet balance", detail?.wallets[0]?.balance, 500);
      equal("loadUserDetail: status", detail?.user.status, "active");
      equal("loadUserDetail: no account actions yet", detail?.accountActions.length, 0);

      // -------------------------------------------------------------------
      section("C2. API authorization");
      // -------------------------------------------------------------------
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

      const listEndpoint = () => usersRoute(new Request("http://localhost/api/admin/users"));
      const detailEndpoint = () =>
        userDetailRoute(new Request("http://localhost/api/admin/users/1"), {
          params: Promise.resolve({ id: String(ids.c1) }),
        });

      for (const [name, call] of [
        ["/api/admin/users", listEndpoint],
        ["/api/admin/users/[id]", detailEndpoint],
      ] as const) {
        jar.clear();
        const anonymous = await quiet(() => call());
        jar.set("fd_session", CUSTOMER_TOKEN);
        const customer = await quiet(() => call());
        jar.set("fd_session", ADMIN_TOKEN);
        const admin = await quiet(() => call());
        jar.clear();

        const anonymousBody = await anonymous.text();
        const customerBody = await customer.text();
        check(`${name}: anonymous -> 404`, anonymous.status === 404, anonymous.status);
        check(
          `${name}: ordinary customer -> 404 (identical to anonymous)`,
          customer.status === 404 && customerBody === anonymousBody,
          customer.status,
        );
        check(`${name}: authorized admin -> 200`, admin.status === 200, admin.status);
      }

      const postStatus = (id: number, body: unknown) =>
        statusRoute(
          new Request(`http://localhost/api/admin/users/${id}/status`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
          { params: Promise.resolve({ id: String(id) }) },
        );

      // Anonymous / customer cannot reach the write endpoint either.
      jar.clear();
      const anonStatus = await quiet(() => postStatus(ids.c1, { action: "suspend", confirm: true }));
      check("status POST: anonymous -> 404", anonStatus.status === 404, anonStatus.status);
      jar.set("fd_session", CUSTOMER_TOKEN);
      const customerStatus = await quiet(() =>
        postStatus(ids.c1, { action: "suspend", confirm: true }),
      );
      check("status POST: ordinary customer -> 404", customerStatus.status === 404, customerStatus.status);
      jar.set("fd_session", ADMIN_TOKEN);

      // -------------------------------------------------------------------
      section("C3. Suspend / activate");
      // -------------------------------------------------------------------
      const before = (await pool.query(FINANCIAL_SNAPSHOT_SQL)).rows[0];

      const noConfirm = await postStatus(ids.c1, { action: "suspend" });
      check("suspend without confirm -> 400", noConfirm.status === 400, noConfirm.status);
      const invalidAction = await postStatus(ids.c1, { action: "delete", confirm: true });
      check("invalid action -> 400", invalidAction.status === 400, invalidAction.status);
      const badId = await statusRoute(
        new Request("http://localhost/api/admin/users/0/status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "suspend", confirm: true }),
        }),
        { params: Promise.resolve({ id: "0" }) },
      );
      check("invalid user id -> 400", badId.status === 400, badId.status);

      const suspend = await postStatus(ids.c1, {
        action: "suspend",
        confirm: true,
        reason: "fraud review — ticket #123",
      });
      const suspendBody = (await suspend.json()) as { ok: boolean; status: string; changed: boolean };
      check("suspend -> 200 changed", suspend.status === 200 && suspendBody.ok && suspendBody.changed === true, {
        status: suspend.status,
        body: suspendBody,
      });
      equal(
        "suspend changed exactly the right customer",
        (await q("select status from users where id = $1", [ids.c1]))[0].status,
        "suspended",
      );
      equal(
        "suspend left the other customer untouched",
        (await q("select status from users where id = $1", [ids.c2]))[0].status,
        "active",
      );
      equal(
        "suspend left the admin untouched",
        (await q("select status from users where id = $1", [ids.adminId]))[0].status,
        "active",
      );

      const auditAfterSuspend = await q(
        `select admin_user_id, target_user_id, action, reason, created_at
         from admin_audit_logs where target_user_id = $1 order by id desc`,
        [ids.c1],
      );
      equal("audit: exactly one record", auditAfterSuspend.length, 1);
      equal("audit: records the real admin", Number(auditAfterSuspend[0].admin_user_id), ids.adminId);
      equal("audit: records the target", Number(auditAfterSuspend[0].target_user_id), ids.c1);
      equal("audit: records the action", auditAfterSuspend[0].action, "suspend");
      equal("audit: records the reason", auditAfterSuspend[0].reason, "fraud review — ticket #123");
      check("audit: records a timestamp", auditAfterSuspend[0].created_at != null, auditAfterSuspend[0].created_at);

      // Idempotency: replaying the same action changes nothing and writes no
      // duplicate audit record.
      const suspendAgain = await postStatus(ids.c1, { action: "suspend", confirm: true });
      const suspendAgainBody = (await suspendAgain.json()) as { changed: boolean };
      check("suspend again -> 200 changed:false", suspendAgain.status === 200 && suspendAgainBody.changed === false, {
        status: suspendAgain.status,
        body: suspendAgainBody,
      });
      equal(
        "no duplicate audit record on replay",
        (await q("select count(*)::int as c from admin_audit_logs where target_user_id = $1", [ids.c1]))[0].c,
        1,
      );

      // Admin identity cannot be spoofed: a forged adminUserId in the body is
      // ignored in favour of the gate's identity.
      const spoof = await postStatus(ids.c2, {
        action: "suspend",
        confirm: true,
        adminUserId: 999999,
        reason: "spoof attempt",
      });
      check("spoofed body still succeeds for the real admin", spoof.status === 200, spoof.status);
      const spoofAudit = await q(
        "select admin_user_id from admin_audit_logs where target_user_id = $1 order by id desc limit 1",
        [ids.c2],
      );
      equal("spoofed admin id is ignored — the real admin is recorded", Number(spoofAudit[0].admin_user_id), ids.adminId);

      // Administrators cannot be suspended from this screen.
      const suspendAdmin = await postStatus(ids.adminId, { action: "suspend", confirm: true });
      check("suspending an administrator -> 400", suspendAdmin.status === 400, suspendAdmin.status);

      // Activate restores the status and records a second action for c1.
      const activate = await postStatus(ids.c1, { action: "activate", confirm: true, reason: null });
      const activateBody = (await activate.json()) as { status: string; changed: boolean };
      check("activate -> 200 changed", activate.status === 200 && activateBody.changed === true, activateBody);
      equal(
        "activate restores the status",
        (await q("select status from users where id = $1", [ids.c1]))[0].status,
        "active",
      );
      equal(
        "audit trail now has the suspend + activate pair",
        (await q("select count(*)::int as c from admin_audit_logs where target_user_id = $1", [ids.c1]))[0].c,
        2,
      );

      // -------------------------------------------------------------------
      section("C4. Financial safety");
      // -------------------------------------------------------------------
      const after = (await pool.query(FINANCIAL_SNAPSHOT_SQL)).rows[0];
      equal("financial tables are byte-identical after the suspend/activate sweep", after, before);

      // -------------------------------------------------------------------
      section("C5. A suspended customer is blocked from acting");
      // -------------------------------------------------------------------
      const { requireAccount } = await import("@/lib/api-auth");
      const { POST: agentRegister } = await import("@/app/api/agent/register/route");

      // Pin the customer via the non-production test seam (the same seam the
      // customer-flow harnesses use) so no session write can muddy the snapshot.
      process.env.FLEXIDATA_TEST_USER_ID = String(ids.c1);
      await pool.query("update users set status = 'suspended' where id = $1", [ids.c1]);

      const blocked = await requireAccount();
      check(
        "requireAccount refuses a suspended account with 403 account_suspended",
        blocked.ok === false && blocked.response.status === 403,
        blocked.ok === false ? blocked.response.status : "ok",
      );
      const blockedBody = blocked.ok === false ? ((await blocked.response.json()) as { code: string }) : null;
      equal("the refusal carries the account_suspended code", blockedBody?.code, "account_suspended");

      const agentRes = await agentRegister(new Request("http://localhost/api/agent/register", { method: "POST" }));
      check("a real action route returns 403 for a suspended customer", agentRes.status === 403, agentRes.status);

      // Reactivate -> the same customer is allowed again.
      await pool.query("update users set status = 'active' where id = $1", [ids.c1]);
      const allowed = await requireAccount();
      check("after activation requireAccount succeeds again", allowed.ok === true, allowed.ok ? "ok" : "refused");

      delete process.env.FLEXIDATA_TEST_USER_ID;
      await pool.query("update users set status = 'active' where id = $1", [ids.c1]);

      const finalSnapshot = (await pool.query(FINANCIAL_SNAPSHOT_SQL)).rows[0];
      equal("financial tables unchanged after the suspension-blocking sweep", finalSnapshot, before);
    } finally {
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
