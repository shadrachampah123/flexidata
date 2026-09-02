/**
 * Regression harness for the sign-up / auth failure chain:
 *
 *   sign-up creates the account but the session fails -> "(ref …)" 500
 *   -> retry reports "email already used" (orphaned account)
 *   -> login looks like "wrong details"
 *   -> the password reset email points at an unreachable link.
 *
 * Drives the real route handlers against the in-memory database
 * (see scripts/schema-sim.ts) so it runs without a PostgreSQL server.
 *
 * What it locks in:
 *   1. A missing AUTH_SECRET fails sign-up *before* any write — no account is
 *      created, so the retry after the fix is not "email already used".
 *   2. A sessions table the migrations never reached no longer orphans the
 *      account: the write degrades like the sign-up writes, and even total
 *      failure answers "your account exists, sign in" — never a bare 500.
 *   3. Re-registering with the same email + correct password signs the visitor
 *      in (recovers previously orphaned accounts automatically).
 *   4. Reset links are built from the request origin (explicit APP_BASE_URL
 *      wins), never localhost in production, and a production deployment
 *      without an email transport answers honestly instead of leaking or
 *      inventing a link.
 *
 * Run with: npm run verify:auth-flow
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { installSim } from "./schema-sim";

// ---------------------------------------------------------------------------
// Request-scope stub. The route handlers call next/headers' cookies() and
// headers(), which throw outside a Next request; seed a minimal jar before any
// app module is required (the header stub is to cookies what installSim's
// pg.Pool swap is to the database).
// ---------------------------------------------------------------------------
const jar = new Map<string, string>();

function installHeaderStub() {
  const stub = {
    headers: async () => new Headers({ "user-agent": "verify-auth-flow" }),
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
    // Resolution failed — the mutation fallback below is all we have.
  }
  try {
    const headersModule = require("next/headers");
    headersModule.headers = stub.headers;
    headersModule.cookies = stub.cookies;
  } catch {
    // Either the cache seeding above worked (this require returned our stub,
    // making these assignments harmless) or require() is unavailable.
  }
}

installHeaderStub();
const { pool: getPool, schema } = installSim({ migrated: true });

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------
const results: { name: string; ok: boolean; detail?: unknown }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${JSON.stringify(detail)}`}`);
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const SIGNUP = {
  name: "Ama Serwaa",
  email: "ama@flexidata-verify.test",
  phone: "0241234567",
  password: "Passw0rd123",
};

/** Env keys this script shuffles; each mutation restores the previous value. */
function setEnv(patch: Record<string, string | undefined>): Record<string, string | undefined> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return previous;
}

let webhookServer: Server | null = null;
const webhookBodies: { to?: string; subject?: string; text?: string }[] = [];
const resendBodies: { from?: string; to?: string[]; subject?: string; text?: string; reply_to?: string }[] = [];

async function main() {
  process.env.AUTH_SECRET ??= "verify-auth-flow-secret-0123456789abcdef";

  // App modules load only after the sim pool and the header stub are in place.
  const registerRoute = require("@/app/api/auth/register/route");
  const loginRoute = require("@/app/api/auth/login/route");
  const forgotRoute = require("@/app/api/auth/forgot-password/route");
  const resetRoute = require("@/app/api/auth/reset-password/route");
  const healthRoute = require("@/app/api/health/route");
  const { listSessions } = require("@/lib/auth");
  const { resolveAppBaseUrl } = require("@/lib/notifications");
  const { resetSchemaCapabilitiesCache } = require("@/lib/schema-compat");

  const pool = getPool();
  const userRowFor = (email: string) => pool.rows.users.find((r) => r.email === email);
  const lastInsertInto = (table: string) =>
    pool.captured.filter((c) => c.kind === "insert" && c.table === table).slice(-1)[0];

  // ── 1. Pure link-building ───────────────────────────────────────────────
  console.log("\n— resolveAppBaseUrl —");
  {
    const saved = setEnv({
      APP_BASE_URL: undefined,
      NEXT_PUBLIC_APP_URL: undefined,
      VERCEL_URL: undefined,
      NODE_ENV: "production",
    });
    check("production with no config and no origin -> null (never localhost)",
      resolveAppBaseUrl() === null, resolveAppBaseUrl());
    check("request origin is used when nothing is configured",
      resolveAppBaseUrl("https://app.flexidata.example") === "https://app.flexidata.example",
      resolveAppBaseUrl("https://app.flexidata.example"));
    setEnv({ VERCEL_URL: "flexidata-abc123.vercel.app" });
    check("VERCEL_URL is the platform fallback",
      resolveAppBaseUrl() === "https://flexidata-abc123.vercel.app", resolveAppBaseUrl());
    setEnv({ APP_BASE_URL: "https://flexidata.com/" });
    check("APP_BASE_URL wins (and trailing slash is trimmed)",
      resolveAppBaseUrl("https://app.flexidata.example") === "https://flexidata.com",
      resolveAppBaseUrl("https://app.flexidata.example"));
    setEnv({ APP_BASE_URL: "http://localhost:3000", NEXT_PUBLIC_APP_URL: undefined });
    check("a production localhost APP_BASE_URL is ignored for email links",
      resolveAppBaseUrl("https://app.flexidata.example") === "https://app.flexidata.example",
      resolveAppBaseUrl("https://app.flexidata.example"));
    setEnv(saved);
  }

  // ── 2. Happy path ───────────────────────────────────────────────────────
  console.log("\n— sign-up & sign-in on a healthy deployment —");
  {
    const res = await registerRoute.POST(jsonRequest("/api/auth/register", SIGNUP));
    const body = await res.json();
    check("sign-up returns 200 ok", res.status === 200 && body.ok === true, body);
    check("user row committed", userRowFor(SIGNUP.email) !== undefined, pool.rows.users.length);
    check("session row written", pool.rows.sessions.length === 1, pool.rows.sessions.length);
    check("both cookies issued", jar.has("fd_session") && jar.has("fd_auth"), [...jar.keys()]);

    const dup = await registerRoute.POST(
      jsonRequest("/api/auth/register", { ...SIGNUP, phone: "0553332221", password: "Wr0ngPass1" }),
    );
    const dupBody = await dup.json();
    check("duplicate email + wrong password stays a refusal",
      dup.status === 400 && dupBody.error === "An account with this email already exists", dupBody);

    const badLogin = await loginRoute.POST(
      jsonRequest("/api/auth/login", { identifier: SIGNUP.email, password: "Wr0ngPass1" }),
    );
    check("wrong password is a 401", badLogin.status === 401, badLogin.status);

    const goodLogin = await loginRoute.POST(
      jsonRequest("/api/auth/login", { identifier: SIGNUP.email, password: SIGNUP.password }),
    );
    const loginBody = await goodLogin.json();
    check("correct credentials sign in", goodLogin.status === 200 && loginBody.ok === true, loginBody);
  }

  // ── 3. AUTH_SECRET missing: fail BEFORE the write ───────────────────────
  console.log("\n— AUTH_SECRET missing (the orphaned-account deploy) —");
  {
    const saved = setEnv({ AUTH_SECRET: undefined });
    const orphanEmail = "blocked@flexidata-verify.test";

    const res = await registerRoute.POST(
      jsonRequest("/api/auth/register", { ...SIGNUP, email: orphanEmail, phone: "0209998887" }),
    );
    const body = await res.json();
    check("sign-up fails loudly", res.status === 500 && /\(ref [0-9A-F]{6}\)/.test(body.error ?? ""), body);
    check("nothing was written — no orphan to trip over later",
      userRowFor(orphanEmail) === undefined, pool.rows.users.map((r) => r.email));

    const login = await loginRoute.POST(
      jsonRequest("/api/auth/login", { identifier: SIGNUP.email, password: SIGNUP.password }),
    );
    const loginBody = await login.json();
    check("login is an honest 503, never a bare 500 that reads as 'wrong details'",
      login.status === 503 && /temporarily unavailable/.test(loginBody.error ?? ""), loginBody);

    setEnv(saved);

    const retry = await registerRoute.POST(
      jsonRequest("/api/auth/register", { ...SIGNUP, email: orphanEmail, phone: "0209998887" }),
    );
    const retryBody = await retry.json();
    check("the retry after the env fix just works (the email was never orphaned)",
      retry.status === 200 && retryBody.ok === true, retryBody);
  }

  // ── 4. Sessions table a migration behind (optional columns missing) ──────
  console.log("\n— sessions table one migration behind —");
  {
    const savedColumns = schema.tables.sessions;
    schema.tables.sessions = ["id", "user_id", "token_hash", "expires_at", "created_at"];
    resetSchemaCapabilitiesCache();

    const driftEmail = "drift@flexidata-verify.test";
    const res = await registerRoute.POST(
      jsonRequest("/api/auth/register", { ...SIGNUP, email: driftEmail, phone: "0271112223" }),
    );
    const body = await res.json();
    check("sign-up still succeeds end to end", res.status === 200 && body.ok === true && !body.needsLogin, body);
    const insert = lastInsertInto("sessions");
    check(
      "session insert names only columns the database has",
      !!insert &&
        insert.columns.includes("user_id") &&
        insert.columns.includes("token_hash") &&
        !insert.columns.includes("user_agent") &&
        !insert.columns.includes("last_seen_at"),
      insert?.columns,
    );

    const userId = userRowFor(driftEmail)?.id as number;
    const listed = await listSessions(userId);
    check("listSessions survives the drifted table",
      listed.length === 1 && listed[0].userAgent === "unknown device", listed);

    schema.tables.sessions = savedColumns;
    resetSchemaCapabilitiesCache();
  }

  // ── 5. Sessions table entirely missing: the account must never be orphaned
  console.log("\n— sessions table missing entirely —");
  {
    const savedColumns = schema.tables.sessions;
    schema.tables.sessions = [];
    resetSchemaCapabilitiesCache();

    const strandedEmail = "stranded@flexidata-verify.test";
    const attempt = { ...SIGNUP, email: strandedEmail, phone: "0265554443" };

    const res = await registerRoute.POST(jsonRequest("/api/auth/register", attempt));
    const body = await res.json();
    check("account exists, session impossible -> needsLogin, not a (ref) 500",
      res.status === 200 && body.ok === true && body.needsLogin === true, body);
    check("the account row was not rolled back", userRowFor(strandedEmail) !== undefined, undefined);

    const retry = await registerRoute.POST(jsonRequest("/api/auth/register", attempt));
    const retryBody = await retry.json();
    check('the retry is never a "email already used" dead end',
      retry.status === 200 && retryBody.ok === true, retryBody);

    const login = await loginRoute.POST(
      jsonRequest("/api/auth/login", { identifier: strandedEmail, password: attempt.password }),
    );
    check("login honestly reports the outage", login.status === 503, login.status);

    // The deployment heals (migrations run): the very next attempt signs the
    // previously stranded visitor straight in — no support ticket needed.
    schema.tables.sessions = savedColumns;
    resetSchemaCapabilitiesCache();

    const healed = await registerRoute.POST(jsonRequest("/api/auth/register", attempt));
    const healedBody = await healed.json();
    check("stranded account self-heals: re-register + password signs in",
      healed.status === 200 && healedBody.ok === true && healedBody.recovered === true, healedBody);
  }

  // ── 6. Reset flow on a drifted password_resets table ─────────────────────
  console.log("\n— password_resets without used_at —");
  {
    const savedColumns = schema.tables.password_resets;
    schema.tables.password_resets = ["id", "user_id", "token_hash", "expires_at", "created_at"];
    resetSchemaCapabilitiesCache();

    const forgot = await forgotRoute.POST(
      jsonRequest(
        "/api/auth/forgot-password",
        { email: SIGNUP.email },
        { host: "app.flexidata.example", "x-forwarded-proto": "https" },
      ),
    );
    const forgotBody = await forgot.json();
    check("forgot-password succeeds on the drifted table", forgot.status === 200, forgotBody);
    check(
      "dev link is built from the request origin (not localhost, no APP_BASE_URL set)",
      typeof forgotBody.devPreviewUrl === "string" &&
        forgotBody.devPreviewUrl.startsWith("https://app.flexidata.example/reset-password?token="),
      forgotBody.devPreviewUrl,
    );

    const token = new URL(forgotBody.devPreviewUrl as string).searchParams.get("token") ?? "";
    const reset = await resetRoute.POST(
      jsonRequest("/api/auth/reset-password", { token, password: "N3wPassword9" }),
    );
    const resetBody = await reset.json();
    check("token consumes fine without used_at", reset.status === 200 && resetBody.ok === true, resetBody);

    const oldLogin = await loginRoute.POST(
      jsonRequest("/api/auth/login", { identifier: SIGNUP.email, password: SIGNUP.password }),
    );
    check("old password rejected after reset", oldLogin.status === 401, oldLogin.status);
    const newLogin = await loginRoute.POST(
      jsonRequest("/api/auth/login", { identifier: SIGNUP.email, password: "N3wPassword9" }),
    );
    check("new password signs in", newLogin.status === 200, newLogin.status);

    schema.tables.password_resets = savedColumns;
    resetSchemaCapabilitiesCache();
  }

  // ── 7. Production email behaviour ────────────────────────────────────────
  console.log("\n— production: never invent or leak a reset link —");
  {
    // A local capture server stands in for the transactional-email relay.
    webhookServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        webhookBodies.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => webhookServer!.listen(0, "127.0.0.1", resolve));
    const port = (webhookServer.address() as AddressInfo).port;

    const saved = setEnv({
      NODE_ENV: "production",
      APP_BASE_URL: undefined,
      NEXT_PUBLIC_APP_URL: undefined,
      VERCEL_URL: undefined,
      RESEND_API_KEY: undefined,
      RESEND_FROM_EMAIL: undefined,
      RESEND_REPLY_TO: undefined,
      NOTIFY_WEBHOOK_URL: undefined,
    });

    const noTransport = await forgotRoute.POST(
      jsonRequest(
        "/api/auth/forgot-password",
        { email: SIGNUP.email },
        { host: "app.flexidata.example", "x-forwarded-proto": "https" },
      ),
    );
    const noTransportBody = await noTransport.json();
    check("no email transport in production -> honest 502 (not a silent dead end)",
      noTransport.status === 502, noTransportBody);
    check("no reset link leaks while failing", noTransportBody.devPreviewUrl === undefined, noTransportBody);

    // Resend is deliberately called directly by the app — a local fetch stub
    // lets this regression test inspect the exact provider payload without
    // needing an API key or a live email delivery.
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.resend.com/emails") {
        resendBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ id: "email_verify_123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return nativeFetch(input, init);
    };

    setEnv({
      RESEND_API_KEY: "re_verify_123",
      RESEND_FROM_EMAIL: "FlexiData <support@flexidata.example>",
      RESEND_REPLY_TO: "help@flexidata.example",
    });
    const resent = await forgotRoute.POST(
      jsonRequest(
        "/api/auth/forgot-password",
        { email: SIGNUP.email },
        { host: "app.flexidata.example", "x-forwarded-proto": "https" },
      ),
    );
    const resentBody = await resent.json();
    check("reset email is delivered directly through Resend", resent.status === 200 && resentBody.ok === true, resentBody);
    check(
      "Resend receives the recipient, verified sender, reply address, and deployment reset link",
      resendBodies.some(
        (body) =>
          body.to?.[0] === SIGNUP.email &&
          body.from === "FlexiData <support@flexidata.example>" &&
          body.reply_to === "help@flexidata.example" &&
          (body.text ?? "").includes("https://app.flexidata.example/reset-password?token="),
      ),
      resendBodies,
    );
    globalThis.fetch = nativeFetch;
    setEnv({ RESEND_API_KEY: undefined, RESEND_FROM_EMAIL: undefined, RESEND_REPLY_TO: undefined });

    setEnv({ NOTIFY_WEBHOOK_URL: `http://127.0.0.1:${port}/relay` });
    const sent = await forgotRoute.POST(
      jsonRequest(
        "/api/auth/forgot-password",
        { email: SIGNUP.email },
        { host: "app.flexidata.example", "x-forwarded-proto": "https" },
      ),
    );
    const sentBody = await sent.json();
    check("reset email delivered via the relay", sent.status === 200, sentBody);
    check("email link points at the deployment the visitor used",
      webhookBodies.some((b) =>
        (b.text ?? "").includes("https://app.flexidata.example/reset-password?token="),
      ),
      webhookBodies.map((b) => b.text?.split("\n").find((l) => l.includes("reset-password"))),
    );

    setEnv({ APP_BASE_URL: "https://flexidata.com" });
    webhookBodies.length = 0;
    await forgotRoute.POST(
      jsonRequest(
        "/api/auth/forgot-password",
        { email: SIGNUP.email },
        { host: "app.flexidata.example", "x-forwarded-proto": "https" },
      ),
    );
    check("explicit APP_BASE_URL still wins over the request origin",
      webhookBodies.every((b) => (b.text ?? "").includes("https://flexidata.com/reset-password?token=")),
      webhookBodies.map((b) => b.text?.split("\n").find((l) => l.includes("reset-password"))),
    );

    setEnv(saved);
    webhookServer.close();
    webhookServer = null;
  }

  // ── 8. Health surfaces the auth posture ──────────────────────────────────
  console.log("\n— health —");
  {
    const health = await (await healthRoute.GET()).json();
    check("health reports the auth section",
      health.auth?.secretConfigured === true && health.auth?.schema?.status === "current", health.auth);
  }
}

main()
  .catch((error) => {
    console.error("auth-flow harness crashed:", error);
    process.exitCode = 2;
  })
  .finally(() => {
    webhookServer?.close();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} checks passed\n`);
    if (passed !== results.length && process.exitCode === undefined) process.exitCode = 1;
  });
