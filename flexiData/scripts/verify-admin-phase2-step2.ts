/**
 * Phase 2, Step 2 verification harness — failed data delivery / support management.
 *
 * Proves, in three layers, that the support loop over the Needs-Attention
 * queue is safe, that the Phase 0 admin gate still guards every surface, and
 * that nothing in this step can move money:
 *
 *   A. Pure functions          ref parsing, action parsing, reason clamping,
 *                              eligibility rule (write + read mirrors agree),
 *                              support-schema capability probe.
 *   B. Source guarantees       the support route authorizes first, is never
 *                              cached, requires confirm + typed ref echo, never
 *                              trusts a browser admin id; the write module
 *                              touches ONLY checkout_orders status columns +
 *                              admin_audit_logs; no provider/paystack/ledger
 *                              call from any path; migration 0003 extends
 *                              admin_audit_logs and no financial table; the UI
 *                              write surfaces are exactly the two confirmation
 *                              modals.
 *   C. Live database           the queue shows failed/stuck orders with
 *                              support state; authorization (anonymous,
 *                              customer, forged cookie -> byte-identical 404);
 *                              confirmation + validation refusals; the
 *                              delivered-confirmation transition; refund-review
 *                              recording with the order row byte-identical;
 *                              replay idempotency (no duplicate audit rows);
 *                              admin-identity non-spoofing; revocation; and a
 *                              before/after snapshot proving wallets, ledger,
 *                              deposits, float, users and sessions are
 *                              untouched, with checkout_orders changing ONLY
 *                              its delivery-status columns.
 *
 * C needs a real PostgreSQL. The harness will:
 *   - use `DATABASE_URL` when `FLEXIDATA_ADMIN_TEST_DB=1` is also set (CI), or
 *   - boot a throwaway cluster through the optional `embedded-postgres`
 *     package (`npm i --no-save embedded-postgres`), or
 *   - skip C with a loud warning.
 * It never runs against a database it was not explicitly told to use.
 *
 * Usage: npm run verify:admin-support
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
    headers: async () => new Headers({ "user-agent": "verify-admin-phase2-step2" }),
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
      databaseDir: `/tmp/flexidata-admin-support-${process.pid}`,
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
const ADMIN_TOKEN = "phase2s2-admin-token";
const CUSTOMER_TOKEN = "phase2s2-customer-token";
const FORGED_TOKEN = "phase2s2-forged-token";

const FIVE_HOURS_AGO = "now() - interval '5 hours'";

type Ids = {
  adminId: number;
  c1: number;
  c2: number;
  wallet1: number;
  wallet2: number;
};

async function seed(pool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}): Promise<Ids> {
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
     values ($1, $2, 'verify-admin-phase2-step2', '127.0.0.1', now(), $3),
            ($4, $5, 'verify-admin-phase2-step2', '127.0.0.1', now(), $3)`,
    [admin.id, sha256(ADMIN_TOKEN), expires, c1.id, sha256(CUSTOMER_TOKEN)],
  );

  // Ledger activity so the financial snapshot is non-trivial, including the
  // checkout mirror row for CO-FAIL-1 (exactly what checkout.ts writes) and a
  // charged-but-undelivered wallet order (the read-only half of the queue).
  await q(
    `insert into transactions
       (ref, wallet_id, type, status, fulfillment_status, direction, title, subtitle, amount, points, network, recipient,
        provider, provider_reference, provider_message, charged_at, fulfilled_at, created_at)
     values
       ('DP-P2S2-1', $1, 'deposit',   'successful', 'delivered', 'in',  'Wallet Top-up', '', 500.00, 0, null, null, null, null, null, now(), null, now()),
       ('FD-ATT-1',  $1, 'data',      'failed',     'failed',    'out', 'MTN 10GB Data', '', 60.00,  0, 'MTN', '0244123456', 'mock', 'PROV-1', 'Gateway declined', ${FIVE_HOURS_AGO}, null, ${FIVE_HOURS_AGO}),
       ('CO-FAIL-1', $1, 'data',      'failed',     'failed',    'out', 'MTN 20GB Data', 'To 0244123456 • Paid via Paystack • Fulfillment needs attention', 120.00, 0, 'MTN', '0244123456', 'mock', 'PROV-2', 'Provider unreachable', ${FIVE_HOURS_AGO}, null, ${FIVE_HOURS_AGO})`,
    [wallet1.id],
  );

  const orderCols = `ref, user_id, wallet_id, customer_email, customer_phone, network, category, plan_label,
      provider_product_code, recipient, amount, amount_subunits, currency, payment_status, order_status,
      fulfillment_status, paystack_transaction_id, paystack_channel, paystack_gateway_response,
      provider_reference, provider_status, provider_message, paid_at, created_at, updated_at, failed_at`;
  const parkedMessage =
    "The data provider could not be reached after payment. Support will fulfil or refund this order.";
  const fiveHoursAgoIso = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const thirtyMinutesAgoIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  // CO-FAIL-1 / CO-FAIL-2: parked failures.  CO-STUCK-1: stuck > 2h.
  // CO-FRESH-1: in flight, NOT stuck (30 min).  CO-PENDING-1: unpaid.
  // CO-PAYFAIL-1: payment failed (queued, but nothing was captured).
  const mkOrder = (
    ref: string,
    payment: string,
    order: string,
    fulfillment: string,
    when: string,
    message: string | null,
    paystackTx: string | null,
  ) =>
    q(
      `insert into checkout_orders (${orderCols})
       values ($1, $2, $3, 'kwame@flexidata.test', '0244123456', 'MTN', 'monthly', '20GB', 'MTN-20G', '0244123456',
               120.00, 12000, 'GHS', $4, $5, $6, $7, 'card', 'Insufficient card balance', 'PROV-X', 'declined', $8,
               $9, $10, $10, $11)`,
      [
        ref,
        c1.id,
        wallet1.id,
        payment,
        order,
        fulfillment,
        paystackTx,
        message,
        payment === "successful" ? when : null, // paid_at
        when,                                    // created_at / updated_at
        order === "fulfillment_failed" ? when : null, // failed_at
      ],
    );

  await mkOrder("CO-FAIL-1", "successful", "fulfillment_failed", "failed", fiveHoursAgoIso, parkedMessage, "ps_tx_0001");
  await mkOrder("CO-FAIL-2", "successful", "fulfillment_failed", "failed", fiveHoursAgoIso, parkedMessage, "ps_tx_0002");
  await mkOrder("CO-STUCK-1", "successful", "fulfilling", "submitted", fiveHoursAgoIso, null, "ps_tx_0003");
  await mkOrder("CO-FRESH-1", "successful", "fulfilling", "submitted", thirtyMinutesAgoIso, null, "ps_tx_0004");
  await mkOrder("CO-PENDING-1", "pending", "awaiting_payment", "queued", fiveHoursAgoIso, null, null);
  await mkOrder("CO-PAYFAIL-1", "failed", "payment_failed", "queued", fiveHoursAgoIso, "Card declined.", "ps_tx_0006");

  // A stale pending deposit — part of the same queue, and proof the deposit
  // row is never actionable from here. (Deposits go stale after 24 hours.)
  await q(
    `insert into deposit_requests (ref, wallet_id, provider, method, amount, amount_subunits, currency, status, initiated_at, updated_at)
     values ('DP-STALE-1', $1, 'paystack', 'card', 75.00, 7500, 'GHS', 'pending', now() - interval '2 days', now() - interval '2 days')`,
    [wallet2.id],
  );

  return {
    adminId: Number(admin.id),
    c1: Number(c1.id),
    c2: Number(c2.id),
    wallet1: Number(wallet1.id),
    wallet2: Number(wallet2.id),
  };
}

/** Tables that must stay 100% byte-identical, every column, every row. */
const IMMUTABLE_TABLES = [
  "wallets",
  "transactions",
  "deposit_requests",
  "provider_float_balances",
  "agent_profiles",
  "bundle_plans",
  "scheduled_topups",
  "price_alerts",
  "users",
  "sessions",
] as const;

/**
 * The money columns of `checkout_orders`. A support action may never move any
 * of these; only order_status / fulfillment_status / fulfilled_at / updated_at
 * are allowed to change, and only for `delivery_resolved`.
 */
const CHECKOUT_MONEY_SQL = `select
   "id", "ref", "user_id", "wallet_id", "customer_email", "customer_phone",
   "network", "category", "plan_label", "provider_product_code", "recipient",
   "amount"::text as "amount", "amount_subunits", "currency", "payment_status",
   "paystack_transaction_id", "paystack_channel", "paystack_gateway_response",
   "provider_reference", "provider_status", "provider_message",
   "paid_at"::text as "paid_at", "verified_at"::text as "verified_at",
   "created_at"::text as "created_at", "failed_at"::text as "failed_at",
   "abandoned_at"::text as "abandoned_at"
 from "checkout_orders" order by "id" asc`;

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

async function moneySnapshot(pool: Pool): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of IMMUTABLE_TABLES) {
    const rows = (await pool.query(`select * from "${table}" order by 1 asc`)).rows;
    out[table] = JSON.stringify(rows);
  }
  out.checkout_orders_money = JSON.stringify((await pool.query(CHECKOUT_MONEY_SQL)).rows);
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("FlexiData — Admin & Operations Dashboard: Phase 2, Step 2 (support management) verification");

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
  const support = await import("@/lib/support-actions");
  const qops = await import("@/lib/admin/queries-operations");

  equal("normalizeOrderRef accepts the generated shape", support.normalizeOrderRef("CO-FAIL-1"), "CO-FAIL-1");
  equal("normalizeOrderRef trims", support.normalizeOrderRef("  CO-FAIL-1 \n"), "CO-FAIL-1");
  equal("normalizeOrderRef rejects quotes/SQL", support.normalizeOrderRef("CO'; drop table"), null);
  equal("normalizeOrderRef rejects an over-long ref", support.normalizeOrderRef("x".repeat(41)), null);
  equal("normalizeOrderRef rejects a too-short ref", support.normalizeOrderRef("ab"), null);
  equal("normalizeOrderRef rejects non-strings", support.normalizeOrderRef({ ref: "CO-1" }), null);
  equal("parseSupportAction accepts delivery_resolved", support.parseSupportAction("delivery_resolved"), "delivery_resolved");
  equal("parseSupportAction accepts refund_review", support.parseSupportAction("refund_review"), "refund_review");
  equal("parseSupportAction rejects anything else", support.parseSupportAction("settle_up_please"), null);
  equal("parseSupportAction rejects the arbitrary-status verbs", support.parseSupportAction("refund_issued"), null);
  equal("clampSupportReason keeps short text", support.clampSupportReason(" confirmed by customer "), "confirmed by customer");
  equal("clampSupportReason clamps to 240", (support.clampSupportReason("x".repeat(500)) ?? "").length, 240);
  equal("clampSupportReason maps blanks to null", support.clampSupportReason("   "), null);

  // Eligibility: the write rule and the read (UI) rule must agree exactly.
  const now = Date.UTC(2026, 8, 5, 12, 0, 0);
  const longAgo = new Date(now - 5 * 60 * 60 * 1000);
  const recent = new Date(now - 30 * 60 * 1000);
  const matrix = [
    { paymentStatus: "successful", orderStatus: "fulfillment_failed", updatedAt: longAgo },
    { paymentStatus: "successful", orderStatus: "fulfilling", updatedAt: longAgo },
    { paymentStatus: "successful", orderStatus: "paid", updatedAt: longAgo },
    { paymentStatus: "successful", orderStatus: "fulfilling", updatedAt: recent },
    { paymentStatus: "successful", orderStatus: "paid", updatedAt: recent },
    { paymentStatus: "successful", orderStatus: "fulfilled", updatedAt: longAgo },
    { paymentStatus: "pending", orderStatus: "awaiting_payment", updatedAt: longAgo },
    { paymentStatus: "failed", orderStatus: "payment_failed", updatedAt: longAgo },
    { paymentStatus: "pending", orderStatus: "fulfillment_failed", updatedAt: longAgo },
  ] as const;
  for (const row of matrix) {
    const write = support.isSupportableOrder(
      { orderStatus: row.orderStatus, paymentStatus: row.paymentStatus, updatedAt: row.updatedAt },
      now,
    );
    const read = qops.isAttentionRowActionable({
      paymentStatus: row.paymentStatus,
      orderStatus: row.orderStatus,
      updatedAtMs: row.updatedAt.getTime(),
      now,
    });
    equal(
      `eligibility agrees: ${row.paymentStatus}/${row.orderStatus}@${row.updatedAt === longAgo ? "stuck" : "fresh"}`,
      read,
      write,
    );
  }
  equal("stuck parked order IS supportable", support.isSupportableOrder(
    { orderStatus: "fulfillment_failed", paymentStatus: "successful", updatedAt: longAgo }, now), true);
  equal("fresh in-flight order is NOT supportable", support.isSupportableOrder(
    { orderStatus: "fulfilling", paymentStatus: "successful", updatedAt: recent }, now), false);
  equal("fulfilled order is NOT supportable", support.isSupportableOrder(
    { orderStatus: "fulfilled", paymentStatus: "successful", updatedAt: longAgo }, now), false);
  equal("unpaid order is NOT supportable", support.isSupportableOrder(
    { orderStatus: "fulfillment_failed", paymentStatus: "pending", updatedAt: longAgo }, now), false);
  equal("the stuck window matches the queue's STUCK_AFTER_MS", support.SUPPORT_STUCK_AFTER_MS, qops.STUCK_AFTER_MS);

  // Capability probe: the support decoration degrades on a lagging schema.
  const fakeCaps = (columnsByTable: Map<string, Set<string>>) =>
    ({ tableColumns: columnsByTable }) as never;
  equal(
    "hasSupportSchema: true with the 0003 columns",
    qops.hasSupportSchema(fakeCaps(new Map([["admin_audit_logs", new Set([
      "id", "admin_user_id", "target_user_id", "action", "reason", "target_ref", "created_at",
    ])]]))),
    true,
  );
  equal(
    "hasSupportSchema: false on a 0002-only audit table",
    qops.hasSupportSchema(fakeCaps(new Map([["admin_audit_logs", new Set([
      "id", "admin_user_id", "target_user_id", "action", "reason", "created_at",
    ])]]))),
    false,
  );
  equal(
    "hasSupportSchema: false when the audit table is absent",
    qops.hasSupportSchema(fakeCaps(new Map([["admin_audit_logs", new Set()]]))),
    false,
  );
  equal(
    "hasSupportSchema: optimistic when the catalog probe could not read",
    qops.hasSupportSchema(fakeCaps(new Map())),
    true,
  );

  // -------------------------------------------------------------------------
  section("B. Source-level guarantees");
  // -------------------------------------------------------------------------
  const { readdirSync: readDir, statSync } = await import("node:fs");
  const walk = (dir: string): string[] =>
    readDir(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

  const routePath = path.join(process.cwd(), "src/app/api/admin/orders/[ref]/support/route.ts");
  const route = readFileSync(routePath, "utf8");
  const handlerAt = route.search(/export (async function|const) POST/);
  check(
    "the support route authorizes itself before anything else",
    handlerAt >= 0 && route.slice(handlerAt, handlerAt + 300).includes("requireAdminApi()"),
    { handlerAt },
  );
  check("the support route is never cached", route.includes(`export const dynamic = "force-dynamic"`));
  check("the support route requires an explicit confirm", route.includes("body.confirm !== true"));
  check(
    "the support route requires the target order ref to be echoed and matches it",
    route.includes("normalizeOrderRef(body.orderRef)") && route.includes("!== orderRef"),
  );
  check(
    "the support route never trusts a browser-supplied admin id (uses the gate context)",
    route.includes("gate.context.admin.userId") &&
      !/body\.adminUserId|body\["adminUserId"\]|body\.admin/.test(route),
  );
  check(
    "the support route exposes only POST (no GET/PUT/PATCH/DELETE handler)",
    !/export (async function|const) (GET|PUT|PATCH|DELETE)/.test(route) &&
      /export async function POST/.test(route),
  );

  const actionsPath = path.join(process.cwd(), "src/lib/support-actions.ts");
  const actions = readFileSync(actionsPath, "utf8");
  const schemaImport = actions.match(/import\s*\{([^}]*)\}\s*from\s*"@\/db\/schema"/)?.[1] ?? "";
  const financialIdentifiers = [
    "wallets",
    "transactions",
    "depositRequests",
    "providerFloatBalances",
    "agentProfiles",
    "bundlePlans",
    "scheduledTopups",
    "priceAlerts",
  ];
  const touched = financialIdentifiers.filter((t) => new RegExp(`\\b${t}\\b`).test(schemaImport));
  check("support-actions.ts imports no financial table", touched.length === 0, touched);
  check(
    "support-actions.ts imports ONLY checkoutOrders + adminAuditLogs from the schema",
    schemaImport.split(",").map((s) => s.trim()).filter(Boolean).sort().join(",") ===
      "adminAuditLogs,checkoutOrders",
    schemaImport,
  );
  check(
    "support-actions.ts never updates/inserts anything but checkoutOrders + adminAuditLogs",
    !/(update|insert)\s*\(\s*(wallets|transactions|depositRequests|providerFloatBalances|agentProfiles)/.test(actions),
  );
  // The only SET block for the order update must be the status columns.
  const setBlock = actions.match(/\.set\(\{([\s\S]*?)\}\)/)?.[1] ?? "";
  const setFields = setBlock
    .split(",")
    .map((part) => part.trim().split(":")[0].trim())
    .filter(Boolean)
    .sort();
  equal(
    "the checkout update sets ONLY the delivery-status columns",
    setFields,
    ["fulfilledAt", "fulfillmentStatus", "orderStatus", "updatedAt"],
  );
  check(
    "the checkout update is conditional on payment capture and a supportable status",
    actions.includes(`eq(checkoutOrders.paymentStatus, "successful")`) &&
      actions.includes("inArray(checkoutOrders.orderStatus, [...SUPPORTABLE_ORDER_STATUSES])"),
  );
  // Scan CODE, not prose: the module comments about what it must never do use
  // the forbidden words deliberately, so strip comments before the scan.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/\/\/[^\n"]*$/gm, " ");
  check(
    "no refund, credit, debit or retry primitive anywhere in the write module's code",
    !/credit|debit|revers|refundWallet|nextval|setval|submitBundle|paystack\.|checkoutOrders\.amount|amountSubunits|paymentStatus:\s*[^,]*set|set\([^)]*payment/i.test(
      stripComments(actions)
        .replace(/refund_review/g, "")
        .replace(/"refunded_at|refunded_at"/g, ""),
    ),
  );
  check(
    "the write module never sets a money column on the order row",
    !/\.set\(\{[^}]*\b(amount|amountSubunits|paymentStatus|customerEmail|customerPhone|currency|paystackTransactionId|paystackChannel|paystackGatewayResponse|providerReference|providerStatus|providerMessage|failedAt|abandonedAt)\b/s.test(
      actions,
    ),
  );
  check("support-actions.ts performs no HTTP at all", !/\bfetch\(|axios|http\.request/.test(actions));

  // The migration must extend admin_audit_logs only.
  const drizzleDir = path.join(process.cwd(), "drizzle");
  const migrationFiles = readdirSync(drizzleDir).filter((f) => f.endsWith(".sql")).sort();
  check("migrations present (0000…0003)", migrationFiles.length === 4, migrationFiles);
  const migration3 = migrationFiles
    .filter((f) => f.startsWith("0003"))
    .map((f) => readFileSync(path.join(drizzleDir, f), "utf8"))
    .join("\n");
  check("a Phase 2 Step 2 migration exists (0003_*.sql)", migration3.length > 0);
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
    "users",
    "sessions",
  ];
  const migrationTouches = financialTables.filter((t) =>
    new RegExp(`(create table|alter table|drop table|truncate)\\s+"?${t}"?`, "i").test(migration3),
  );
  check("migration 0003 touches NO financial table (and not users/sessions)", migrationTouches.length === 0, migrationTouches);
  check(
    "migration 0003 alters ONLY admin_audit_logs",
    [...migration3.matchAll(/alter table\s+"([a-z_]+)"/gi)].every((m) => m[1] === "admin_audit_logs") &&
      /alter table "admin_audit_logs"/i.test(migration3),
  );
  check("migration 0003 adds target_ref", /add column "target_ref"/i.test(migration3));
  check(
    "migration 0003 re-opened the action check for exactly the four audited actions",
    /'suspend', 'activate', 'delivery_resolved', 'refund_review'/i.test(migration3),
  );
  check(
    "migration 0003 carries a partial unique index for replay-safe order audits",
    /create unique index "admin_audit_logs_order_action_idx"/i.test(migration3) &&
      /where .*target_ref.* is not null/i.test(migration3),
  );
  const migration3Statements = migration3
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  check(
    "migration 0003 is pure DDL — every statement is an ALTER/CREATE on the audit table",
    migration3Statements.length > 0 &&
      migration3Statements.every((s) => /^(alter table "admin_audit_logs"|create (unique )?index "admin_audit_logs_)/i.test(s)),
    migration3Statements.map((s) => s.slice(0, 60)),
  );
  const migration2 = readFileSync(path.join(drizzleDir, "0002_customer_management.sql"), "utf8");
  check("migration 0002 is still exactly the customer-management migration", /create table "admin_audit_logs"/i.test(migration2) && /add column "status"/i.test(migration2));

  // The only browser write surfaces are the two confirmation modals, and the
  // support one posts ONLY to the gated support endpoint with confirm + ref.
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
    "the browser write surfaces are exactly the two confirmation modals",
    writes.sort(),
    ["/src/components/admin/customer-actions.tsx", "/src/components/admin/order-support-actions.tsx"],
  );
  const supportComponent = readFileSync(
    path.join(process.cwd(), "src/components/admin/order-support-actions.tsx"),
    "utf8",
  );
  check(
    "order-support-actions.tsx posts only to the gated support endpoint with confirm: true",
    supportComponent.includes("/api/admin/orders/") &&
      supportComponent.includes("/support") &&
      supportComponent.includes("confirm: true") &&
      !/method:\s*["'](PUT|PATCH|DELETE)["']/.test(supportComponent),
  );
  check(
    "order-support-actions.tsx forces a typed-ref confirmation before enabling submit",
    supportComponent.includes("disabled={busy || !matchesRef}") && supportComponent.includes("typedRef.trim() === order.ref"),
  );
  check(
    "order-support-actions.tsx sends only the two supported action values (no free-form action)",
    /action: pending,/.test(supportComponent) &&
      !/action:\s*["'][a-z_]+["']/.test(supportComponent) &&
      [...supportComponent.matchAll(/openModal\("([a-z_]+)"\)/g)].every((m) =>
        m[1] === "delivery_resolved" || m[1] === "refund_review",
      ) &&
      (supportComponent.match(/openModal\("delivery_resolved"\)|openModal\("refund_review"\)/g) ?? []).length === 2,
  );

  // No write API anywhere under src/lib/admin (Phase 1 guarantee, re-proved).
  const adminLibFiles = walk(path.join(process.cwd(), "src/lib/admin")).filter((f) => /\.(ts|tsx)$/.test(f));
  const mutationPatterns = [
    /\bdb\.(update|insert|delete)\(/,
    /\bpool\.(query|execute)\(/,
    /sql`(insert|update|delete|truncate|alter|drop|create)\b/i,
  ];
  let offending: string[] = [];
  for (const file of adminLibFiles) {
    const source = readFileSync(file, "utf8");
    if (mutationPatterns.some((pattern) => pattern.test(source))) offending.push(file.replace(process.cwd(), ""));
  }
  equal("nothing under src/lib/admin (the read layer) can write", offending, []);

  // Every admin API handler — including the new one — re-runs the gate.
  const apiFiles = walk(path.join(process.cwd(), "src/app/api/admin")).filter((f) => f.endsWith("route.ts"));
  let ungatedApi = 0;
  for (const file of apiFiles) {
    const source = readFileSync(file, "utf8");
    const entry = source.search(/export (async function|const) (GET|POST)/);
    const body = entry >= 0 ? source.slice(entry, entry + 300) : source;
    if (!(source.includes("requireAdminApi()") && body.includes("requireAdminApi()"))) ungatedApi += 1;
  }
  check(`every admin API handler is gated (${apiFiles.length} routes)`, ungatedApi === 0, { ungatedApi });

  // Secret hygiene: no new source surface reads passwords/hashes/keys. The
  // files' own safety comments mention the words, so scan the code, not prose.
  const secretPattern = /password|secret|api[_-]?key|token_hash|sk_(test|live)|private[_-]key/i;
  const secretSurfaces = [
    actionsPath,
    routePath,
    path.join(process.cwd(), "src/components/admin/order-support-actions.tsx"),
  ].filter((f) => secretPattern.test(stripComments(readFileSync(f, "utf8"))));
  equal("no password/key material in any new support source file's code", secretSurfaces, []);

  // The customer-page account-actions panel stays suspend/activate-only.
  const queriesSource = readFileSync(path.join(process.cwd(), "src/lib/admin/queries.ts"), "utf8");
  check(
    "the account-actions audit read filters to suspend/activate (order actions live on the support screens)",
    /where "a"\."target_user_id" = \$\{userId\}\s*\n?\s*and "a"\."action" in \('suspend', 'activate'\)/.test(
      queriesSource,
    ) || queriesSource.includes(`and "a"."action" in ('suspend', 'activate')`),
  );

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
      const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

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

      // -------------------------------------------------------------------
      section("C1. The queue shows failed/stuck delivery, with support state");
      // -------------------------------------------------------------------
      const { loadAttention, loadDataOrders } = qops;
      const attention = await loadAttention({ page: 1, pageSize: 25 });
      check("actionsAvailable is true on the migrated schema", attention.actionsAvailable === true);
      // Keys are `source:ref`: a checkout order and its ledger mirror share a
      // ref, and the queue must expose them under their own sources.
      const byRef = new Map(attention.rows.map((row) => [`${row.source}:${row.ref}`, row]));
      const checkoutAt = (ref: string) => byRef.get(`checkout:${ref}`);
      check("the parked checkout order is in the queue", byRef.has("checkout:CO-FAIL-1"));
      check("the second parked order is in the queue", byRef.has("checkout:CO-FAIL-2"));
      check("the stuck paid/fulfilling order is in the queue", byRef.has("checkout:CO-STUCK-1"));
      check("a fresh in-flight order is NOT in the queue", !byRef.has("checkout:CO-FRESH-1"));
      check("an unpaid order is NOT in the queue", !byRef.has("checkout:CO-PENDING-1"));
      check("the failed-payment order is queued (nothing was captured)", byRef.has("checkout:CO-PAYFAIL-1"));
      check("the charged wallet order is queued", byRef.has("wallet:FD-ATT-1"));
      check(
        "the checkout order's LEDGER MIRROR is not double-listed in the wallet queue",
        !byRef.has("wallet:CO-FAIL-1"),
      );
      check("the stale deposit is queued", byRef.has("deposit:DP-STALE-1"));
      check("parked checkout rows are actionable", Boolean(checkoutAt("CO-FAIL-1")?.actionable));
      check("stuck checkout rows are actionable", Boolean(checkoutAt("CO-STUCK-1")?.actionable));
      check("failed-payment rows are NOT actionable", checkoutAt("CO-PAYFAIL-1")?.actionable === false);
      check("wallet-channel rows are NOT actionable", byRef.get("wallet:FD-ATT-1")?.actionable === false);
      check("deposit rows are NOT actionable", byRef.get("deposit:DP-STALE-1")?.actionable === false);
      check(
        "queue rows carry failure information and timestamps",
        Boolean(
          checkoutAt("CO-FAIL-1")?.reason.includes("Support will fulfil or refund") &&
            checkoutAt("CO-FAIL-1")?.createdAt &&
            checkoutAt("CO-FAIL-1")?.amount === 120,
        ),
        checkoutAt("CO-FAIL-1"),
      );
      check(
        "list emails stay masked",
        attention.rows.every((row) => String(row.customerEmail).includes("•")),
      );
      check(
        "no live support actions recorded yet",
        attention.rows.every((row) => row.supportAction === null),
      );
      equal("queue counts per source", attention.counts, { checkout: 4, wallet: 1, deposit: 1 });

      // The data-operations view shows the same state (nothing recorded yet).
      const dataView = await loadDataOrders({ channel: "checkout", page: 1, pageSize: 50 });
      equal("data view (checkout) lists every order", dataView.total, 6);
      check(
        "data view rows carry the support fields",
        dataView.rows.every((row) => row.supportAction === null && row.supportAt === null),
      );

      // -------------------------------------------------------------------
      section("C2. Authorization — the Phase 0 gate guards the support APIs");
      // -------------------------------------------------------------------
      const { GET: attentionRoute } = await import("@/app/api/admin/attention/route");
      const { POST: supportRoute } = await import("@/app/api/admin/orders/[ref]/support/route");
      const postSupport = (ref: string, body: unknown) =>
        supportRoute(
          new Request(`http://localhost/api/admin/orders/${encodeURIComponent(ref)}/support`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
          { params: Promise.resolve({ ref }) },
        );

      const anonAttention = await quiet(() =>
        attentionRoute(new Request("http://localhost/api/admin/attention")),
      );
      const anonAttentionBody = await anonAttention.text();
      jar.set("fd_session", CUSTOMER_TOKEN);
      const custAttention = await quiet(() =>
        attentionRoute(new Request("http://localhost/api/admin/attention")),
      );
      const custAttentionBody = await custAttention.text();
      check("GET attention: anonymous -> 404", anonAttention.status === 404, anonAttention.status);
      check(
        "GET attention: ordinary customer -> byte-identical 404",
        custAttention.status === 404 && custAttentionBody === anonAttentionBody,
        custAttention.status,
      );
      jar.set("fd_session", ADMIN_TOKEN);
      const adminAttention = await quiet(() =>
        attentionRoute(new Request("http://localhost/api/admin/attention")),
      );
      check("GET attention: authorized admin -> 200", adminAttention.status === 200, adminAttention.status);

      jar.clear();
      const anonPost = await quiet(() =>
        postSupport("CO-FAIL-1", { action: "delivery_resolved", orderRef: "CO-FAIL-1", confirm: true }),
      );
      const anonPostBody = await anonPost.text();
      check("POST support: anonymous -> 404", anonPost.status === 404, anonPost.status);
      jar.set("fd_session", CUSTOMER_TOKEN);
      const custPost = await quiet(() =>
        postSupport("CO-FAIL-1", { action: "delivery_resolved", orderRef: "CO-FAIL-1", confirm: true }),
      );
      check(
        "POST support: ordinary customer -> byte-identical 404",
        custPost.status === 404 && (await custPost.text()) === anonPostBody,
        custPost.status,
      );
      jar.set("fd_session", FORGED_TOKEN);
      const forgedPost = await quiet(() =>
        postSupport("CO-FAIL-1", { action: "delivery_resolved", orderRef: "CO-FAIL-1", confirm: true }),
      );
      check(
        "POST support: forged/unknown session -> byte-identical 404",
        forgedPost.status === 404 && (await forgedPost.text()) === anonPostBody,
        forgedPost.status,
      );
      jar.set("fd_session", ADMIN_TOKEN);
      const adminPostProbe = await postSupport("CO-NOTHING", { action: "delivery_resolved", orderRef: "CO-NOTHING", confirm: true });
      check("POST support: admin reaches the handler (unknown ref -> 404 from the store)", adminPostProbe.status === 404 && (await adminPostProbe.json()).error === "Order not found", adminPostProbe.status);

      // -------------------------------------------------------------------
      section("C3. Confirmation, validation and rejection of bad targets");
      // -------------------------------------------------------------------
      const moneyBefore = await moneySnapshot(pool);

      const noConfirm = await postSupport("CO-FAIL-1", { action: "delivery_resolved", orderRef: "CO-FAIL-1" });
      check("delivery_resolved without confirm -> 400", noConfirm.status === 400, noConfirm.status);
      const noConfirmReview = await postSupport("CO-FAIL-1", { action: "refund_review", orderRef: "CO-FAIL-1" });
      check("refund_review without confirm -> 400", noConfirmReview.status === 400, noConfirmReview.status);
      const wrongAction = await postSupport("CO-FAIL-1", { action: "set_status", orderRef: "CO-FAIL-1", confirm: true });
      check("unknown action -> 400", wrongAction.status === 400, wrongAction.status);
      const refundIssued = await postSupport("CO-FAIL-1", { action: "refund_issued", orderRef: "CO-FAIL-1", confirm: true });
      check("arbitrary status manipulation is impossible: refund_issued -> 400", refundIssued.status === 400, refundIssued.status);
      const mismatchRef = await postSupport("CO-FAIL-1", { action: "delivery_resolved", orderRef: "CO-FAIL-2", confirm: true });
      check("body ref that does not match the target -> 400", mismatchRef.status === 400, mismatchRef.status);
      const unknown = await postSupport("CO-DOES-NOT-EXIST", {
        action: "delivery_resolved",
        orderRef: "CO-DOES-NOT-EXIST",
        confirm: true,
      });
      check("wrong/unknown order reference -> 404", unknown.status === 404, unknown.status);
      const malformed = await supportRoute(
        new Request("http://localhost/api/admin/orders/CO%27;%20drop/support", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "delivery_resolved", orderRef: "CO'; drop", confirm: true }),
        }),
        { params: Promise.resolve({ ref: "CO'; drop" }) },
      );
      check("malformed order reference -> 400 before any query", malformed.status === 400, malformed.status);

      const freshRefusal = await postSupport("CO-FRESH-1", { action: "delivery_resolved", orderRef: "CO-FRESH-1", confirm: true });
      check("a fresh in-flight order refuses delivery_resolved -> 409", freshRefusal.status === 409, freshRefusal.status);
      const pendingRefusal = await postSupport("CO-PENDING-1", { action: "refund_review", orderRef: "CO-PENDING-1", confirm: true });
      check("an unpaid order refuses refund_review -> 409", pendingRefusal.status === 409, pendingRefusal.status);
      const payfailRefusal = await postSupport("CO-PAYFAIL-1", { action: "refund_review", orderRef: "CO-PAYFAIL-1", confirm: true });
      check("a not-captured payment refuses refund_review -> 409", payfailRefusal.status === 409, payfailRefusal.status);
      const ledgerRefusal = await postSupport("FD-ATT-1", { action: "delivery_resolved", orderRef: "FD-ATT-1", confirm: true });
      check("a wallet-channel (ledger) ref is not a checkout order -> 404, ledger cannot be targeted", ledgerRefusal.status === 404, ledgerRefusal.status);
      const depositRefusal = await postSupport("DP-STALE-1", { action: "refund_review", orderRef: "DP-STALE-1", confirm: true });
      check("a deposit ref is not a checkout order -> 404, deposits cannot be targeted", depositRefusal.status === 404, depositRefusal.status);

      const nothingChanged = await moneySnapshot(pool);
      equal("every refusal wrote NOTHING — all financial tables still byte-identical", nothingChanged, moneyBefore);

      // -------------------------------------------------------------------
      section("C4. Mark delivered — confirmed");
      // -------------------------------------------------------------------
      const mirrorBefore = JSON.stringify(
        await q("select * from transactions where ref = 'CO-FAIL-1' order by id asc"),
      );
      const resolve = await postSupport("CO-FAIL-1", {
        action: "delivery_resolved",
        orderRef: "CO-FAIL-1",
        confirm: true,
        reason: "customer confirmed receipt; provider ticket PROV-2 delivered",
      });
      const resolveBody = (await resolve.json()) as { ok: boolean; changed: boolean; orderStatus: string };
      check("delivery_resolved -> 200 changed", resolve.status === 200 && resolveBody.ok && resolveBody.changed === true, {
        status: resolve.status,
        body: resolveBody,
      });

      const parkedRow = (await q("select * from checkout_orders where ref = 'CO-FAIL-1'"))[0] as Record<string, unknown>;
      equal("order_status moved to fulfilled", parkedRow.order_status, "fulfilled");
      equal("fulfillment_status moved to delivered", parkedRow.fulfillment_status, "delivered");
      check("fulfilled_at is set", parkedRow.fulfilled_at != null);
      equal("payment_status untouched", String(parkedRow.payment_status), "successful");
      equal("amount untouched", String(parkedRow.amount), "120.00");
      equal("amount_subunits untouched", Number(parkedRow.amount_subunits), 12000);
      equal("paystack transaction id untouched", String(parkedRow.paystack_transaction_id), "ps_tx_0001");
      check(
        "the provider failure record is NOT overwritten (no invented provider success)",
        String(parkedRow.provider_message).includes("Support will fulfil or refund"),
        parkedRow.provider_message,
      );

      const audits = await q(
        `select admin_user_id, target_user_id, action, reason, target_ref, created_at
         from admin_audit_logs where target_ref = 'CO-FAIL-1' order by id asc`,
      );
      equal("audit: exactly one record", audits.length, 1);
      equal("audit: records the real admin", Number(audits[0].admin_user_id), ids.adminId);
      equal("audit: records the customer", Number(audits[0].target_user_id), ids.c1);
      equal("audit: records the action", audits[0].action, "delivery_resolved");
      equal("audit: records the order ref", audits[0].target_ref, "CO-FAIL-1");
      equal("audit: records the reason", audits[0].reason, "customer confirmed receipt; provider ticket PROV-2 delivered");
      check("audit: records a timestamp", audits[0].created_at != null);

      const spoofed = await postSupport("CO-STUCK-1", {
        action: "delivery_resolved",
        orderRef: "CO-STUCK-1",
        confirm: true,
        adminUserId: 999999,
        spoofAdmin: true,
      });
      check("spoofed admin identity in the body is ignored (action still succeeds)", spoofed.status === 200, spoofed.status);
      const spoofAudit = await q(
        "select admin_user_id from admin_audit_logs where target_ref = 'CO-STUCK-1' order by id desc limit 1",
      );
      equal("audit records the gate's admin, not the body's", Number(spoofAudit[0].admin_user_id), ids.adminId);

      const replay = await postSupport("CO-FAIL-1", { action: "delivery_resolved", orderRef: "CO-FAIL-1", confirm: true });
      const replayBody = (await replay.json()) as { ok: boolean };
      check("replayed delivery_resolved -> 409 already resolved", replay.status === 409 && replayBody.ok !== true, {
        status: replay.status,
      });
      equal(
        "no duplicate audit record when the same action is replayed",
        (await q("select count(*)::int as c from admin_audit_logs where target_ref = 'CO-FAIL-1'"))[0].c,
        1,
      );
      const afterReplay = (await q("select fulfilled_at from checkout_orders where ref = 'CO-FAIL-1'"))[0];
      check(
        "the replay did not re-touch fulfilled_at",
        JSON.stringify(afterReplay.fulfilled_at) === JSON.stringify(parkedRow.fulfilled_at),
        { before: parkedRow.fulfilled_at, after: afterReplay.fulfilled_at },
      );

      // Resolving must never invent customer history: the ledger mirror row is
      // the provider-attempt record and stays exactly as it was.
      const mirrorAfter = JSON.stringify(
        await q("select * from transactions where ref = 'CO-FAIL-1' order by id asc"),
      );
      equal("the checkout mirror in the ledger is untouched", mirrorAfter, mirrorBefore);
      equal("no ledger row was created for the fulfilment", (await q("select count(*)::int as c from transactions"))[0].c, 3);
      equal("no wallet point was credited", (await q("select points from wallets where id = $1", [ids.wallet1]))[0].points, 40);

      // -------------------------------------------------------------------
      section("C5. Queue for refund review — a record only, never money");
      // -------------------------------------------------------------------
      // Capture the order row BEFORE the review, so we can prove the review
      // is a pure record: the order row must be byte-identical afterwards.
      const reviewRowBefore = JSON.stringify(
        (await q("select * from checkout_orders where ref = 'CO-FAIL-2'"))[0],
      );
      const review = await postSupport("CO-FAIL-2", {
        action: "refund_review",
        orderRef: "CO-FAIL-2",
        confirm: true,
        reason: "provider confirmed failure; refund due per support policy",
      });
      const reviewBody = (await review.json()) as { ok: boolean; changed: boolean; orderStatus: string };
      check("refund_review -> 200 changed", review.status === 200 && reviewBody.ok && reviewBody.changed === true, reviewBody);
      equal("refund_review does NOT change the order status", reviewBody.orderStatus, "fulfillment_failed");

      const reviewRowAfter = JSON.stringify(
        (await q("select * from checkout_orders where ref = 'CO-FAIL-2'"))[0],
      );
      equal("the order row is byte-identical to its state BEFORE the review", reviewRowAfter, reviewRowBefore);

      const reviewAudit = await q(
        `select admin_user_id, action, target_ref, reason from admin_audit_logs where target_ref = 'CO-FAIL-2'`,
      );
      equal("audit: exactly one refund_review record", reviewAudit.length, 1);
      equal("audit: the action value is explicit", reviewAudit[0].action, "refund_review");
      equal("audit: the real admin", Number(reviewAudit[0].admin_user_id), ids.adminId);
      equal("audit: the reason", reviewAudit[0].reason, "provider confirmed failure; refund due per support policy");

      const reviewAgain = await postSupport("CO-FAIL-2", { action: "refund_review", orderRef: "CO-FAIL-2", confirm: true });
      const againBody = (await reviewAgain.json()) as { ok: boolean; changed: boolean };
      check(
        "replayed refund_review -> 200 changed:false",
        reviewAgain.status === 200 && againBody.ok === true && againBody.changed === false,
        againBody,
      );
      equal(
        "the partial unique index keeps one audit record per (order, action)",
        (await q("select count(*)::int as c from admin_audit_logs where target_ref = 'CO-FAIL-2' and action = 'refund_review'"))[0].c,
        1,
      );

      const reviewThenResolve = await postSupport("CO-FAIL-2", {
        action: "delivery_resolved",
        orderRef: "CO-FAIL-2",
        confirm: true,
        reason: "customer actually received the data after all — no refund",
      });
      check("a reviewed order can still be marked delivered", reviewThenResolve.status === 200, reviewThenResolve.status);
      equal(
        "both actions coexist in the trail as distinct records",
        (await q(
          `select action from admin_audit_logs where target_ref = 'CO-FAIL-2' order by id asc`,
        )).map((r) => r.action),
        ["refund_review", "delivery_resolved"],
      );

      // A resolved order can no longer be sent for refund review.
      const resolveThenReview = await postSupport("CO-FAIL-2", {
        action: "refund_review",
        orderRef: "CO-FAIL-2",
        confirm: true,
      });
      check("refund_review on a fulfilled order -> 409", resolveThenReview.status === 409, resolveThenReview.status);

      // -------------------------------------------------------------------
      section("C6. Support state flows into both admin views");
      // -------------------------------------------------------------------
      const attentionAfter = await loadAttention({ page: 1, pageSize: 25 });
      const afterByRef = new Map(attentionAfter.rows.map((row) => [`${row.source}:${row.ref}`, row]));
      check(
        "the resolved orders LEFT the queue (both channels — no lingering ledger-mirror ghost)",
        !afterByRef.has("checkout:CO-FAIL-1") &&
          !afterByRef.has("wallet:CO-FAIL-1") &&
          !afterByRef.has("checkout:CO-STUCK-1") &&
          !afterByRef.has("wallet:CO-STUCK-1"),
      );
      check("the refund-reviewed-then-resolved order LEFT the queue", !afterByRef.has("checkout:CO-FAIL-2"));
      check("the wallet order STAYS in the queue (read-only diagnostics)", afterByRef.has("wallet:FD-ATT-1"));
      equal("the wallet row never becomes actionable", afterByRef.get("wallet:FD-ATT-1")?.actionable, false);
      check("the stale deposit STAYS in the queue (read-only diagnostics)", afterByRef.has("deposit:DP-STALE-1"));

      const dataAfter = await loadDataOrders({ channel: "checkout", bucket: "successful", page: 1, pageSize: 50 });
      check("resolved orders now appear in the successful bucket", dataAfter.rows.some((r) => r.ref === "CO-FAIL-1"));
      check("the successful bucket count grew accordingly", (dataAfter.buckets.successful ?? 0) >= 1);
      const allData = await loadDataOrders({ channel: "checkout", page: 1, pageSize: 50 });
      const coFail2 = allData.rows.find((r) => r.ref === "CO-FAIL-2");
      equal("the data view shows the latest recorded action (delivery_resolved wins)", coFail2?.supportAction, "delivery_resolved");

      // -------------------------------------------------------------------
      section("C7. Financial safety — the whole sweep, byte for byte");
      // -------------------------------------------------------------------
      const moneyAfter = await moneySnapshot(pool);
      const differing = Object.keys(moneyAfter).filter((k) => moneyAfter[k] !== moneyBefore[k] && k !== "checkout_orders_money");
      equal("wallets, ledger, deposits, float, users, sessions … all byte-identical", differing, []);
      equal("checkout_orders money columns are byte-identical", moneyAfter.checkout_orders_money, moneyBefore.checkout_orders_money);
      equal("wallet balances did not move", JSON.parse(moneyAfter.wallets).map((w: { balance: string }) => w.balance), ["500.00", "120.00", "0.00"]);
      equal("no new checkout order appeared", (await q("select count(*)::int as c from checkout_orders"))[0].c, 6);
      equal("no new audit row beyond the four support records", (await q("select count(*)::int as c from admin_audit_logs"))[0].c, 4);

      // The customer page must not silently absorb order actions into the
      // suspend/activate panel (Step 1 contract, re-proved).
      const { loadUserDetail } = await import("@/lib/admin/queries");
      const kwameDetail = await loadUserDetail(ids.c1);
      equal("the account-actions panel stayed suspend/activate-only", kwameDetail?.accountActions.length ?? -1, 0);

      // The queue payload must never carry secret material.
      const attentionJson = await quiet(() =>
        (async () => {
          jar.set("fd_session", ADMIN_TOKEN);
          const res = await attentionRoute(new Request("http://localhost/api/admin/attention"));
          return res.text();
        })(),
      );
      check(
        "the attention JSON carries no password/hash/key/token material",
        !/password|password_hash|api[_-]?key|secret|token_hash|sk_(test|live)/i.test(attentionJson),
      );

      // -------------------------------------------------------------------
      section("C8. Revocation still kills the support surface immediately");
      // -------------------------------------------------------------------
      const beforeRevoke = await moneySnapshot(pool);
      await q("update users set is_admin = false where id = $1", [ids.adminId]);
      const afterRevoke = await quiet(() =>
        postSupport("CO-FRESH-1", { action: "delivery_resolved", orderRef: "CO-FRESH-1", confirm: true }),
      );
      const afterRevokeBody = await afterRevoke.text();
      check("revoked is_admin: POST support -> 404", afterRevoke.status === 404, afterRevoke.status);
      check(
        "the revoked-admin denial is byte-identical to the anonymous denial",
        afterRevokeBody === anonPostBody,
        afterRevokeBody,
      );
      await q("update users set is_admin = true where id = $1", [ids.adminId]);
      const afterRestore = await postSupport("CO-PENDING-1", { action: "refund_review", orderRef: "CO-PENDING-1", confirm: true });
      check("restored: the handler answers again (409 state refusal, not 404)", afterRestore.status === 409, afterRestore.status);

      // A final snapshot proves the revocation dance itself changed no money
      // (users.is_admin is excluded: that flip was performed directly by the
      // harness, not by the support feature).
      const finalMoney = await moneySnapshot(pool);
      const revokeDiffs = Object.keys(finalMoney).filter(
        (k) => k !== "users" && finalMoney[k] !== beforeRevoke[k],
      );
      equal("nothing moved during the revocation checks", revokeDiffs, []);
    } catch (error) {
      console.error(error);
      check("live section completed without an unexpected error", false, String(error));
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
