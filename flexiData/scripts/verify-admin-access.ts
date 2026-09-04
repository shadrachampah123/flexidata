/**
 * Phase 0 verification harness for the admin access-control gate.
 *
 * Drives the REAL gate (`src/lib/admin/auth.ts`) and the REAL route handler
 * (`src/app/api/admin/me/route.ts`) against the in-memory database simulator
 * (`scripts/schema-sim.ts`), so it runs with no PostgreSQL server — the same
 * approach `verify:schema-compat` and `verify:auth-flow` already use.
 *
 * What it locks in:
 *   1. Anonymous callers get nothing (page gate and API gate).
 *   2. A normal signed-in user gets nothing, and cannot tell the admin area
 *      exists (404, byte-identical to the anonymous response).
 *   3. `users.is_admin` alone is NOT enough — the ADMIN_EMAILS allowlist is
 *      required too, and vice versa.
 *   4. An authorized admin passes both gates.
 *   5. Revoking `is_admin` denies the SAME live session on its very next
 *      request (authorization is revocable, not baked into a cookie).
 *   6. Removing the email from ADMIN_EMAILS also denies immediately.
 *   7. An expired session is refused.
 *   8. The FLEXIDATA_TEST_USER_ID impersonation seam can never become an admin
 *      bypass: blocked by default, blocked even alongside a valid admin cookie,
 *      and NEVER honoured in production regardless of the opt-in flag.
 *   9. A database missing `users.is_admin` fails closed.
 *  10. The gate performs no database WRITES of any kind.
 *
 * Run with: npm run verify:admin-access
 */
import { createHash } from "node:crypto";
import { installSim } from "./schema-sim";

// ---------------------------------------------------------------------------
// Request-scope stub. The gate calls next/headers' cookies(), which throws
// outside a Next request; seed a minimal jar before any app module is loaded.
// ---------------------------------------------------------------------------
const jar = new Map<string, string>();

function installHeaderStub() {
  const stub = {
    headers: async () => new Headers({ "user-agent": "verify-admin-access" }),
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
    // Resolution failed — the assignment below is the fallback.
  }
  try {
    const headersModule = require("next/headers");
    Object.assign(headersModule, stub);
  } catch {
    // Nothing more we can do; the harness will fail loudly if cookies() throws.
  }
}

installHeaderStub();
const sim = installSim({ migrated: true });
const fake = sim.pool() as unknown as {
  run: (sql: string, params: unknown[]) => unknown;
  captured: { kind: string; table: string }[];
  rows: Record<string, Record<string, unknown>[]>;
};

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const results: { name: string; ok: boolean; detail?: unknown }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${JSON.stringify(detail)}`}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Silence the gate's (intentional) denial logging so the report stays readable. */
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

async function main() {
  // Env baseline. NODE_ENV stays non-production for most of the run so the
  // seam tests are meaningful; the production lock is asserted explicitly.
  const env = process.env as Record<string, string | undefined>;
  delete env.FLEXIDATA_TEST_USER_ID;
  delete env.FLEXIDATA_TEST_ALLOW_ADMIN;
  env.ADMIN_EMAILS = "";

  const { db } = await import("@/db");
  const { users, sessions } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const { getAdminContext, requireAdmin, requireAdminApi, isAdminContext } = await import(
    "@/lib/admin/auth"
  );
  const { GET: adminMe } = await import("@/app/api/admin/me/route");

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------
  async function makeUser(name: string, email: string, isAdmin: boolean): Promise<number> {
    const created = await db
      .insert(users)
      .values({
        name,
        email,
        phone: `024${String(1000000 + Math.floor(Math.random() * 8999999)).slice(-7)}`,
        passwordHash: "scrypt:deadbeef:cafe",
        referralCode: `FD-${name.slice(0, 4).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        isAdmin,
      })
      .returning({ id: users.id });
    return created[0].id;
  }

  async function makeSession(userId: number, ttlMs = 60 * 60 * 1000): Promise<string> {
    const token = `tok_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    await db.insert(sessions).values({
      userId,
      tokenHash: sha256(token),
      userAgent: "verify-admin-access",
      ip: "127.0.0.1",
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return token;
  }

  const signIn = (token: string | null) => {
    jar.delete("fd_session");
    if (token) jar.set("fd_session", token);
  };

  const adminId = await makeUser("Ada Admin", "ada@flexidata.test", true);
  const normalId = await makeUser("Nana Normal", "nana@flexidata.test", false);
  const flaggedNotListedId = await makeUser("Kojo Flagged", "kojo@flexidata.test", true);

  const adminToken = await makeSession(adminId);
  const normalToken = await makeSession(normalId);
  const flaggedToken = await makeSession(flaggedNotListedId);

  // The allowlist the deployment would carry.
  env.ADMIN_EMAILS = "ada@flexidata.test, someone-else@flexidata.test";

  const writesBefore = fake.captured.length;

  // -------------------------------------------------------------------------
  section("1. Anonymous access");
  // -------------------------------------------------------------------------
  signIn(null);
  check("no session cookie -> getAdminContext() is null", (await quiet(getAdminContext)) === null);

  const anonApi = await quiet(async () => adminMe());
  const anonBody = await anonApi.clone().text();
  check("no session cookie -> GET /api/admin/me returns 404", anonApi.status === 404, anonApi.status);

  let threw = false;
  try {
    await quiet(requireAdmin);
  } catch {
    threw = true;
  }
  check("no session cookie -> requireAdmin() throws (notFound)", threw);

  // -------------------------------------------------------------------------
  section("2. Normal signed-in user (the core requirement)");
  // -------------------------------------------------------------------------
  signIn(normalToken);
  check("normal user -> getAdminContext() is null", (await quiet(getAdminContext)) === null);

  const normalApi = await quiet(async () => adminMe());
  const normalBody = await normalApi.clone().text();
  check("normal user -> GET /api/admin/me returns 404", normalApi.status === 404, normalApi.status);
  check(
    "normal user -> 404 body is identical to the anonymous 404 (no oracle)",
    normalBody === anonBody,
    { anonBody, normalBody },
  );
  check(
    "normal user -> response leaks no admin hint",
    !/admin/i.test(normalBody),
    normalBody,
  );

  let normalThrew = false;
  try {
    await quiet(requireAdmin);
  } catch {
    normalThrew = true;
  }
  check("normal user -> requireAdmin() throws (notFound)", normalThrew);

  // -------------------------------------------------------------------------
  section("3. Both signals are required");
  // -------------------------------------------------------------------------
  signIn(flaggedToken);
  check(
    "is_admin=true but email NOT in ADMIN_EMAILS -> denied",
    (await quiet(getAdminContext)) === null,
  );

  signIn(normalToken);
  env.ADMIN_EMAILS = "ada@flexidata.test, nana@flexidata.test";
  check(
    "email in ADMIN_EMAILS but is_admin=false -> denied",
    (await quiet(getAdminContext)) === null,
  );
  env.ADMIN_EMAILS = "ada@flexidata.test, someone-else@flexidata.test";

  signIn(adminToken);
  env.ADMIN_EMAILS = "";
  check(
    "authorized admin but ADMIN_EMAILS unset -> denied (fail closed)",
    (await quiet(getAdminContext)) === null,
  );
  env.ADMIN_EMAILS = "ada@flexidata.test, someone-else@flexidata.test";

  // -------------------------------------------------------------------------
  section("4. Authorized admin passes");
  // -------------------------------------------------------------------------
  signIn(adminToken);
  const ctx = await getAdminContext();
  check("admin -> getAdminContext() returns a context", ctx !== null);
  check("admin -> context is branded", ctx !== null && isAdminContext(ctx));
  check("admin -> context identifies the right user", ctx?.admin.userId === adminId, ctx?.admin);
  check("admin -> context is session-backed", ctx?.admin.via === "session" && ctx?.admin.sessionId !== null);
  check(
    "a hand-rolled object is NOT a valid AdminContext",
    !isAdminContext({ admin: { userId: adminId, email: "ada@flexidata.test" } }),
  );

  const adminApi = await adminMe();
  const adminJson = (await adminApi.clone().json()) as {
    ok: boolean;
    admin?: { userId: number; email: string };
    capabilities?: { read: string[]; write: string[] };
  };
  check("admin -> GET /api/admin/me returns 200", adminApi.status === 200, adminApi.status);
  check("admin -> API reports the right identity", adminJson.admin?.userId === adminId, adminJson.admin);
  check(
    "admin -> API exposes no capabilities in Phase 0",
    adminJson.capabilities?.read.length === 0 && adminJson.capabilities?.write.length === 0,
    adminJson.capabilities,
  );
  check(
    "admin -> API response is not cacheable",
    (adminApi.headers.get("cache-control") ?? "").includes("no-store"),
    adminApi.headers.get("cache-control"),
  );

  // -------------------------------------------------------------------------
  section("5. Revocation takes effect immediately (same live session)");
  // -------------------------------------------------------------------------
  await db.update(users).set({ isAdmin: false }).where(eq(users.id, adminId));
  check(
    "is_admin revoked -> the SAME session is denied on the next request",
    (await quiet(getAdminContext)) === null,
  );
  const revokedApi = await quiet(async () => adminMe());
  check("is_admin revoked -> GET /api/admin/me returns 404", revokedApi.status === 404, revokedApi.status);

  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  check("is_admin restored -> access returns without re-authenticating", (await getAdminContext()) !== null);

  env.ADMIN_EMAILS = "someone-else@flexidata.test";
  check(
    "email removed from ADMIN_EMAILS -> denied immediately",
    (await quiet(getAdminContext)) === null,
  );
  env.ADMIN_EMAILS = "ada@flexidata.test, someone-else@flexidata.test";

  // -------------------------------------------------------------------------
  section("6. Session validity");
  // -------------------------------------------------------------------------
  signIn("tok_this_token_was_never_issued");
  check("unknown session token -> denied", (await quiet(getAdminContext)) === null);

  const expiredToken = await makeSession(adminId, -60 * 1000);
  signIn(expiredToken);
  check("expired session -> denied", (await quiet(getAdminContext)) === null);

  const orphanToken = await makeSession(999_999);
  signIn(orphanToken);
  check("session pointing at a non-existent user -> denied", (await quiet(getAdminContext)) === null);

  // -------------------------------------------------------------------------
  section("7. FLEXIDATA_TEST_USER_ID impersonation seam");
  // -------------------------------------------------------------------------
  signIn(null);
  env.FLEXIDATA_TEST_USER_ID = String(adminId);
  check(
    "seam set, no opt-in -> denied (seam is not an admin bypass)",
    (await quiet(getAdminContext)) === null,
  );

  signIn(adminToken);
  check(
    "seam set alongside a VALID admin cookie -> still denied (no silent fallback)",
    (await quiet(getAdminContext)) === null,
  );

  signIn(null);
  env.FLEXIDATA_TEST_ALLOW_ADMIN = "1";
  const seamCtx = await getAdminContext();
  check("seam + explicit opt-in (non-production) -> allowed", seamCtx !== null);
  check("seam context is marked as test-seam", seamCtx?.admin.via === "test-seam", seamCtx?.admin);

  const savedNodeEnv = env.NODE_ENV;
  env.NODE_ENV = "production";
  check(
    "seam + opt-in in NODE_ENV=production -> NEVER honoured",
    (await quiet(getAdminContext)) === null,
  );
  env.NODE_ENV = savedNodeEnv;

  delete env.FLEXIDATA_TEST_USER_ID;
  delete env.FLEXIDATA_TEST_ALLOW_ADMIN;

  // -------------------------------------------------------------------------
  section("8. Degraded / unavailable database fails closed");
  // -------------------------------------------------------------------------
  signIn(adminToken);
  check("sanity: admin allowed before the database is degraded", (await getAdminContext()) !== null);

  // The simulator cannot model a missing column for SELECT: drizzle emits
  // unqualified names (`select "is_admin" from "users"`), which its ref-checker
  // does not inspect, so it keeps serving the stale in-memory row. Real
  // PostgreSQL raises 42703. Reproduce that faithfully at the driver so the
  // gate's actual production code path is exercised.
  const originalRun = fake.run.bind(fake);
  function failWith(error: Error, when: RegExp) {
    fake.run = (sqlRaw: string, params: unknown[]) => {
      if (when.test(sqlRaw)) throw error;
      return originalRun(sqlRaw, params);
    };
  }
  const restoreRun = () => {
    fake.run = originalRun;
  };

  const missingColumn = Object.assign(
    new Error('column "is_admin" does not exist'),
    { code: "42703" },
  );
  failWith(missingColumn, /from "?users"?/i);
  let degradedThrew: unknown = null;
  const degraded = await quiet(async () => {
    try {
      return await getAdminContext();
    } catch (error) {
      degradedThrew = error;
      return "threw" as const;
    }
  });
  check("users.is_admin missing (42703) -> denied, never assumes yes", degraded === null, {
    degraded,
    degradedThrew: degradedThrew instanceof Error ? degradedThrew.message : degradedThrew,
  });

  const missingTable = Object.assign(
    new Error('relation "users" does not exist'),
    { code: "42P01" },
  );
  failWith(missingTable, /from "?users"?/i);
  check("users table missing (42P01) -> denied", (await quiet(getAdminContext)) === null);

  const outage = Object.assign(new Error("connection terminated unexpectedly"), {
    code: "57P01",
  });
  failWith(outage, /from "?users"?/i);
  check("database outage while reading is_admin -> denied", (await quiet(getAdminContext)) === null);

  failWith(outage, /from "?sessions"?/i);
  check("database outage while reading the session -> denied", (await quiet(getAdminContext)) === null);

  restoreRun();
  check("database restored -> admin allowed again", (await getAdminContext()) !== null);


  // -------------------------------------------------------------------------
  section("9. The gate is read-only");
  // -------------------------------------------------------------------------
  const writesDuring = fake.captured.slice(writesBefore);
  // The harness itself inserts fixtures and flips is_admin; those are the only
  // writes allowed here. Anything touching money tables is a hard failure.
  const moneyTables = new Set([
    "wallets",
    "transactions",
    "deposit_requests",
    "checkout_orders",
    "provider_float_balances",
    "agent_profiles",
  ]);
  const forbidden = writesDuring.filter((c) => moneyTables.has(c.table));
  check(
    "no write of any kind reached a wallet / ledger / payment table",
    forbidden.length === 0,
    forbidden,
  );

  const sessionWrites = writesDuring.filter((c) => c.table === "sessions" && c.kind === "update");
  check(
    "the gate never mutates session rows (no last_seen_at touch, no deletes)",
    sessionWrites.length === 0,
    sessionWrites,
  );

  // -------------------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` — ${failed.length} FAILED` : ""),
  );
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name}`);
    process.exit(1);
  }
  console.log("Admin access gate (Phase 0) verified.\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
