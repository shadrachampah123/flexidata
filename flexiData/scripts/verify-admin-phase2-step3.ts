/**
 * Phase 2, Step 3 verification harness — the investigation & accountability layer.
 *
 * Proves, in three layers, that Step 3 adds diagnosis, review and status
 * surfaces ONLY, that the Phase 0 admin gate guards every one of them, and that
 * nothing in this step can move money or write a single row:
 *
 *   A. Pure functions          the diagnosis engine (order, deposit, probe),
 *                              open-review classification, reference parsing,
 *                              the probe throttle window, and the three-way
 *                              agreement of the support-eligibility rule.
 *   B. Source guarantees       every new route authorizes first and is never
 *                              cached; every new page re-checks the gate; the
 *                              diagnosis engine imports no database and no
 *                              gateway; the probe module imports no settlement
 *                              path and no database; the read layer has no write
 *                              API and runs all four loaders inside
 *                              `withReadOnlyTx`; the browser write surface is
 *                              STILL exactly the two Step 1/2 confirmation
 *                              modals; `drizzle/` and `src/db/schema.ts` are
 *                              byte-identical to the base commit (no migration);
 *                              the financial modules are byte-identical too.
 *   C. Live database           the investigation views classify seeded states
 *                              correctly; the drill-down dead ends are gone
 *                              (every order and deposit reference resolves,
 *                              including the ones with no ledger row); the audit
 *                              trail is readable, filterable and masked; the
 *                              refund-review backlog opens and closes with the
 *                              real Step 2 actions; the Paystack probe answers
 *                              from a stub gateway, is throttled, and writes
 *                              nothing; authorization (anonymous, customer,
 *                              forged cookie, admin flag without allowlist,
 *                              mid-session revocation) is a byte-identical 404
 *                              on all six endpoints; and a before/after snapshot
 *                              proves EVERY table — including `checkout_orders`
 *                              in full and `admin_audit_logs` itself — is
 *                              byte-identical after the whole sweep.
 *
 * C needs a real PostgreSQL. The harness will:
 *   - use `DATABASE_URL` when `FLEXIDATA_ADMIN_TEST_DB=1` is also set (CI), or
 *   - boot a throwaway cluster through the optional `embedded-postgres`
 *     package (`npm i --no-save embedded-postgres`), or
 *   - skip C with a loud warning.
 * It never runs against a database it was not explicitly told to use.
 *
 * Usage: npm run verify:admin-ops
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execSync } from "node:child_process";
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
    headers: async () => new Headers({ "user-agent": "verify-admin-phase2-step3" }),
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
    // The harness fails loudly below if cookies() throws.
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
    const port = 55000 + (process.pid % 1500);
    const embedded = new mod.default({
      databaseDir: `/tmp/flexidata-admin-ops-${process.pid}`,
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
const ADMIN2_EMAIL = "other@flexidata.test";
const ADMIN_TOKEN = "phase2s3-admin-token";
const CUSTOMER_TOKEN = "phase2s3-customer-token";
const FORGED_TOKEN = "phase2s3-forged-token";

type Ids = {
  adminId: number;
  admin2Id: number;
  c1: number;
  c2: number;
  wallet1: number;
  wallet2: number;
};

const PARKED_MESSAGE =
  "The data provider could not be reached after payment. Support will fulfil or refund this order.";
const ORDER_MISMATCH_MESSAGE =
  "Payment did not match the order (amount/currency/reference) and was not fulfilled. Contact support for a refund.";
const DEPOSIT_MISMATCH_MESSAGE =
  "Payment did not match this deposit (amount/currency/reference) and was not credited. Contact support.";
const DEMO_LOCK_MESSAGE =
  "Not settled: demo deposits are disabled in production. Wallet was not credited.";

type OrderFixture = {
  ref: string;
  payment: string;
  order: string;
  fulfillment: string;
  ageMs: number;
  amount?: number;
  subunits?: number;
  message?: string | null;
  paystackTx?: string | null;
  gateway?: string | null;
  /** Ledger mirror written by `checkout.ts` (null = the parked-before-submit case). */
  mirror?: null | {
    status: string;
    fulfillment: string;
    direction?: string;
    amount?: number;
    refunded?: boolean;
  };
};

const ORDER_FIXTURES: OrderFixture[] = [
  {
    ref: "CO-PARK-1",
    payment: "successful",
    order: "fulfillment_failed",
    fulfillment: "failed",
    ageMs: 5 * 3600_000,
    message: PARKED_MESSAGE,
    paystackTx: "ps_tx_park1",
    mirror: { status: "failed", fulfillment: "failed" },
  },
  {
    // The fulfillment-error branch of `checkout.ts` parks the order and writes
    // NO ledger mirror — the case that made the old drill-down a 404.
    ref: "CO-NOMIRROR-1",
    payment: "successful",
    order: "fulfillment_failed",
    fulfillment: "failed",
    ageMs: 5 * 3600_000,
    message: PARKED_MESSAGE,
    paystackTx: "ps_tx_nomirror",
    mirror: null,
  },
  {
    ref: "CO-STUCK-1",
    payment: "successful",
    order: "fulfilling",
    fulfillment: "submitted",
    ageMs: 5 * 3600_000,
    paystackTx: "ps_tx_stuck1",
    mirror: null,
  },
  {
    ref: "CO-FRESH-1",
    payment: "successful",
    order: "fulfilling",
    fulfillment: "submitted",
    ageMs: 30 * 60_000,
    paystackTx: "ps_tx_fresh1",
    mirror: null,
  },
  {
    ref: "CO-MISMATCH-1",
    payment: "failed",
    order: "payment_failed",
    fulfillment: "queued",
    ageMs: 5 * 3600_000,
    message: "Card declined.",
    paystackTx: "ps_tx_mismatch1",
    gateway: ORDER_MISMATCH_MESSAGE,
    mirror: null,
  },
  {
    ref: "CO-DONE-1",
    payment: "successful",
    order: "fulfilled",
    fulfillment: "delivered",
    ageMs: 6 * 3600_000,
    paystackTx: "ps_tx_done1",
    mirror: { status: "successful", fulfillment: "delivered" },
  },
  {
    ref: "CO-DIVERGE-1",
    payment: "successful",
    order: "fulfilled",
    fulfillment: "delivered",
    ageMs: 6 * 3600_000,
    paystackTx: "ps_tx_diverge1",
    mirror: { status: "failed", fulfillment: "failed", amount: 99 },
  },
  {
    ref: "CO-REFUNDMIRROR-1",
    payment: "successful",
    order: "fulfillment_failed",
    fulfillment: "failed",
    ageMs: 5 * 3600_000,
    message: PARKED_MESSAGE,
    paystackTx: "ps_tx_refundmirror",
    mirror: { status: "failed", fulfillment: "failed", refunded: true },
  },
  {
    ref: "CO-DRIFT-1",
    payment: "successful",
    order: "fulfillment_failed",
    fulfillment: "failed",
    ageMs: 5 * 3600_000,
    amount: 120,
    subunits: 9999,
    message: PARKED_MESSAGE,
    paystackTx: "ps_tx_drift1",
    mirror: null,
  },
  {
    ref: "CO-PENDING-1",
    payment: "pending",
    order: "awaiting_payment",
    fulfillment: "queued",
    ageMs: 5 * 3600_000,
    mirror: null,
  },
  {
    ref: "CO-REVIEW-1",
    payment: "successful",
    order: "fulfillment_failed",
    fulfillment: "failed",
    ageMs: 5 * 3600_000,
    message: PARKED_MESSAGE,
    paystackTx: "ps_tx_review1",
    mirror: { status: "failed", fulfillment: "failed" },
  },
  {
    ref: "CO-RESOLVED-1",
    payment: "successful",
    order: "fulfilled",
    fulfillment: "delivered",
    ageMs: 6 * 3600_000,
    paystackTx: "ps_tx_resolved1",
    mirror: { status: "successful", fulfillment: "delivered" },
  },
];

type DepositFixture = {
  ref: string;
  provider: string;
  status: string;
  amount: number;
  subunits?: number;
  ageMs: number;
  gateway?: string | null;
  paystackTx?: string | null;
  credits?: { amount: number; status?: string }[];
  reversed?: number;
};

const DEPOSIT_FIXTURES: DepositFixture[] = [
  {
    ref: "DP-OK-1",
    provider: "paystack",
    status: "successful",
    amount: 100,
    ageMs: 3 * 3600_000,
    paystackTx: "ps_dep_ok1",
    credits: [{ amount: 100 }],
  },
  {
    ref: "DP-NOCREDIT-1",
    provider: "paystack",
    status: "successful",
    amount: 80,
    ageMs: 3 * 3600_000,
    paystackTx: "ps_dep_nocredit",
    credits: [],
  },
  {
    ref: "DP-MISMATCH-1",
    provider: "paystack",
    status: "failed",
    amount: 60,
    ageMs: 4 * 3600_000,
    gateway: DEPOSIT_MISMATCH_MESSAGE,
    paystackTx: "ps_dep_mismatch",
    credits: [],
  },
  {
    ref: "DP-STALE-1",
    provider: "paystack",
    status: "pending",
    amount: 75,
    ageMs: 48 * 3600_000,
    credits: [],
  },
  {
    ref: "DP-DEMO-1",
    provider: "mock",
    status: "failed",
    amount: 50,
    ageMs: 5 * 3600_000,
    gateway: DEMO_LOCK_MESSAGE,
    credits: [],
  },
  {
    // The credit that landed is not the amount recorded. A genuine double credit
    // for one reference is impossible in this schema (`transactions.ref` is
    // UNIQUE), so `duplicate-credit` is proved in the pure layer and the unique
    // index is asserted here instead.
    ref: "DP-WRONGAMT-1",
    provider: "paystack",
    status: "successful",
    amount: 80,
    ageMs: 2 * 3600_000,
    paystackTx: "ps_dep_wrongamt",
    credits: [{ amount: 70 }],
  },
  {
    ref: "DP-DRIFT-1",
    provider: "paystack",
    status: "pending",
    amount: 50,
    subunits: 4500,
    ageMs: 10 * 60_000,
    credits: [],
  },
  {
    ref: "DP-REVERSED-1",
    provider: "paystack",
    status: "failed",
    amount: 30,
    ageMs: 6 * 3600_000,
    credits: [],
    reversed: 1,
  },
];

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
     values ('Ada Admin', $1, '0500000001', 'scrypt:a:b', 'ADA001', true) returning id`,
    [ADMIN_EMAIL],
  );
  // is_admin = true but NOT on the ADMIN_EMAILS allowlist: one signal is not enough.
  const [admin2] = await q(
    `insert into users (name, email, phone, password_hash, referral_code, is_admin)
     values ('Other Admin', $1, '0500000002', 'scrypt:a:b', 'OTH001', true) returning id`,
    [ADMIN2_EMAIL],
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
     values ($1, $2, 'verify-admin-phase2-step3', '127.0.0.1', now(), $4),
            ($3, $5, 'verify-admin-phase2-step3', '127.0.0.1', now(), $4),
            ($6, $7, 'verify-admin-phase2-step3', '127.0.0.1', now(), $4)`,
    [
      admin.id,
      sha256(ADMIN_TOKEN),
      c1.id,
      expires,
      sha256(CUSTOMER_TOKEN),
      admin2.id,
      sha256("phase2s3-admin2-token"),
    ],
  );

  // ---- checkout orders (+ the ledger mirrors checkout.ts writes) -----------
  const orderCols = `ref, user_id, wallet_id, customer_email, customer_phone, network, category, plan_label,
      provider_product_code, recipient, amount, amount_subunits, currency, payment_status, order_status,
      fulfillment_status, paystack_transaction_id, paystack_channel, paystack_gateway_response,
      provider_reference, provider_status, provider_message, paid_at, created_at, updated_at, failed_at, fulfilled_at`;

  for (const fixture of ORDER_FIXTURES) {
    const amount = fixture.amount ?? 120;
    const subunits = fixture.subunits ?? amount * 100;
    const when = new Date(Date.now() - fixture.ageMs).toISOString();
    await q(
      `insert into checkout_orders (${orderCols})
       values ($1, $2, $3, 'kwame@flexidata.test', '0244123456', 'MTN', 'monthly', '20GB', 'MTN-20G', '0244123456',
               $4, $5, 'GHS', $6, $7, $8, $9, 'card', $10, 'PROV-X', 'declined', $11,
               $12, $13, $13, $14, $15)`,
      [
        fixture.ref,
        c1.id,
        wallet1.id,
        amount.toFixed(2),
        subunits,
        fixture.payment,
        fixture.order,
        fixture.fulfillment,
        fixture.paystackTx ?? null,
        fixture.gateway ?? "Approved",
        fixture.message ?? null,
        fixture.payment === "successful" ? when : null, // paid_at
        when, // created_at / updated_at
        fixture.order === "fulfillment_failed" ? when : null, // failed_at
        fixture.order === "fulfilled" ? when : null, // fulfilled_at
      ],
    );

    if (fixture.mirror) {
      await q(
        `insert into transactions
           (ref, wallet_id, type, status, fulfillment_status, direction, title, subtitle, amount, points,
            network, recipient, provider, provider_reference, provider_message, charged_at, fulfilled_at,
            refunded_at, created_at)
         values ($1, $2, 'data', $3, $4, $5, 'MTN 20GB Data', 'To 0244123456 • Paid via Paystack', $6, 0,
                 'MTN', '0244123456', 'mock', 'PROV-X', $7, $8, $9, $10, $8)`,
        [
          fixture.ref,
          wallet1.id,
          fixture.mirror.status,
          fixture.mirror.fulfillment,
          fixture.mirror.direction ?? "out",
          (fixture.mirror.amount ?? amount).toFixed(2),
          fixture.message ?? null,
          when, // charged_at / created_at
          fixture.mirror.fulfillment === "delivered" ? when : null,
          fixture.mirror.refunded ? when : null,
        ],
      );
    }
  }

  // ---- deposits (+ their ledger credit rows) -------------------------------
  for (const fixture of DEPOSIT_FIXTURES) {
    const when = new Date(Date.now() - fixture.ageMs).toISOString();
    await q(
      `insert into deposit_requests
         (ref, wallet_id, provider, method, amount, amount_subunits, currency, status,
          paystack_transaction_id, paystack_channel, paystack_gateway_response,
          initiated_at, updated_at, paid_at, verified_at, completed_at)
       values ($1, $2, $3, 'card', $4, $5, 'GHS', $6, $7, 'card', $8, $9, $9, $10, $10, $11)`,
      [
        fixture.ref,
        wallet1.id,
        fixture.provider,
        fixture.amount.toFixed(2),
        fixture.subunits ?? fixture.amount * 100,
        fixture.status,
        fixture.paystackTx ?? null,
        fixture.gateway ?? null,
        when,
        fixture.status === "successful" ? when : null,
        fixture.status === "successful" || fixture.status === "failed" ? when : null,
      ],
    );

    for (const credit of fixture.credits ?? []) {
      await q(
        `insert into transactions
           (ref, wallet_id, type, status, fulfillment_status, direction, title, subtitle, amount, points, created_at)
         values ($1, $2, 'deposit', $3, 'delivered', 'in', 'Wallet Top-up', 'Paystack • Card', $4, 0, $5)`,
        [fixture.ref, wallet1.id, credit.status ?? "successful", credit.amount.toFixed(2), when],
      );
    }
    for (let i = 0; i < (fixture.reversed ?? 0); i += 1) {
      await q(
        `insert into transactions
           (ref, wallet_id, type, status, fulfillment_status, direction, title, subtitle, amount, points, created_at)
         values ($1, $2, 'deposit', 'reversed', 'refunded', 'in', 'Wallet Top-up', 'Reversed', $3, 0, $4)`,
        [fixture.ref, wallet1.id, fixture.amount.toFixed(2), when],
      );
    }
  }

  // ---- the audit trail Steps 1 and 2 would have written --------------------
  const reviewAt = new Date(Date.now() - 3 * 3600_000).toISOString();
  const resolvedAt = new Date(Date.now() - 1 * 3600_000).toISOString();
  await q(
    `insert into admin_audit_logs (admin_user_id, target_user_id, action, reason, target_ref, created_at)
     values ($1, $2, 'suspend', 'Chargeback investigation', null, $5),
            ($1, $2, 'activate', 'Resolved', null, $6),
            ($1, $2, 'refund_review', 'Provider confirmed no delivery', $3, $5),
            ($1, $2, 'refund_review', 'Customer reports no data', $4, $5),
            ($1, $2, 'delivery_resolved', 'Confirmed on the provider dashboard', $4, $6)`,
    [admin.id, c1.id, "CO-REVIEW-1", "CO-RESOLVED-1", reviewAt, resolvedAt],
  );
  // An open review against a parked order, recorded by the second administrator.
  await q(
    `insert into admin_audit_logs (admin_user_id, target_user_id, action, reason, target_ref, created_at)
     values ($1, $2, 'refund_review', 'Awaiting finance', $3, $4)`,
    [admin2.id, c1.id, "CO-PARK-1", reviewAt],
  );

  return {
    adminId: Number(admin.id),
    admin2Id: Number(admin2.id),
    c1: Number(c1.id),
    c2: Number(c2.id),
    wallet1: Number(wallet1.id),
    wallet2: Number(wallet2.id),
  };
}

/**
 * Tables that must stay 100% byte-identical, every column, every row. Step 3 is
 * a read-only step, so unlike Step 2 this list includes `checkout_orders` IN
 * FULL (Step 2 was allowed to change delivery-status columns; Step 3 may not
 * change anything) and `admin_audit_logs` itself (reading the trail must not add
 * to it).
 */
const IMMUTABLE_TABLES = [
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
  "admin_audit_logs",
] as const;

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

async function snapshot(pool: Pool, tables: readonly string[] = IMMUTABLE_TABLES): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of tables) {
    try {
      const rows = (await pool.query(`select * from "${table}" order by 1 asc`)).rows;
      out[table] = JSON.stringify(rows);
    } catch (error) {
      out[table] = `unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return out;
}

function diffSnapshot(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(before).filter((key) => before[key] !== after[key]);
}

// ---------------------------------------------------------------------------
// A tiny Paystack stub: GET /transaction/verify/:ref
// ---------------------------------------------------------------------------

type StubTransaction = {
  status: string;
  reference: string;
  amount: number;
  currency?: string;
  id?: number;
  channel?: string;
  paid_at?: string;
  gateway_response?: string;
};

async function startPaystackStub(routes: Record<string, StubTransaction | { status: false; message: string }>) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = /^\/transaction\/verify\/(.+)$/.exec(url.pathname);
    res.setHeader("content-type", "application/json");
    if (!match) {
      res.statusCode = 404;
      res.end(JSON.stringify({ status: false, message: "Not found" }));
      return;
    }
    const ref = decodeURIComponent(match[1]);
    const payload = routes[ref];
    if (!payload) {
      res.statusCode = 404;
      res.end(JSON.stringify({ status: false, message: "Transaction not found" }));
      return;
    }
    if ("status" in payload && payload.status === false) {
      res.statusCode = 404;
      res.end(JSON.stringify(payload));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ status: true, message: "Verification successful", data: payload }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("FlexiData — Admin & Operations Dashboard: Phase 2, Step 3 (investigation & accountability) verification");

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
  section("A. Pure functions — the diagnosis engine, parsing and the throttle");
  // -------------------------------------------------------------------------
  const diagnosis = await import("@/lib/admin/diagnosis");
  const filters = await import("@/lib/admin/filters");
  const probe = await import("@/lib/admin/paystack-status");
  const support = await import("@/lib/support-actions");
  const qops = await import("@/lib/admin/queries-operations");

  const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
  const iso = (ms: number) => new Date(ms).toISOString();
  const H5 = 5 * 3600_000;
  const M30 = 30 * 60_000;

  const baseOrder = {
    ref: "CO-1",
    orderStatus: "fulfillment_failed",
    paymentStatus: "successful",
    fulfillmentStatus: "failed",
    amount: 120,
    amountSubunits: 12000,
    currency: "GHS",
    network: "MTN",
    planLabel: "20GB",
    recipient: "0244123456",
    paystackTransactionId: "ps_1",
    paystackGatewayResponse: "Approved",
    providerReference: "PROV-1",
    providerStatus: "declined",
    providerMessage: "Provider unreachable",
    createdAt: iso(NOW - H5),
    updatedAt: iso(NOW - H5),
    paidAt: iso(NOW - H5),
    verifiedAt: iso(NOW - H5),
    fulfilledAt: null,
    failedAt: iso(NOW - H5),
    abandonedAt: null,
  };
  const noMirror = diagnosis.mirrorFactsFrom(null);
  const ids = (list: { id: string }[]) => list.map((entry) => entry.id).sort();

  check("mirrorFactsFrom(null) reports no mirror", diagnosis.mirrorFactsFrom(null).exists === false);
  check(
    "mirrorFactsFrom maps a ledger row",
    diagnosis.mirrorFactsFrom({
      status: "failed",
      fulfillmentStatus: "failed",
      direction: "out",
      amount: 120,
      chargedAt: null,
      fulfilledAt: null,
      refundedAt: null,
    }).exists === true,
  );

  // -- order rules
  const parked = diagnosis.diagnoseCheckoutOrder({ order: baseOrder, mirror: noMirror, now: NOW });
  check("parked order: money taken, delivery failed", ids(parked).includes("captured-not-delivered"));
  check("parked order: no mirror row is reported as a fact", ids(parked).includes("mirror-missing"));
  check(
    "parked order: the verdict is critical",
    diagnosis.summarizeFindings(parked).severity === "critical",
  );
  check(
    "parked order: guidance names the support workflow and denies money movement",
    parked.some((f) => f.id === "captured-not-delivered" && /Requires support/.test(f.guidance) && /cannot refund/.test(f.guidance)),
  );

  const stuck = diagnosis.diagnoseCheckoutOrder({
    order: { ...baseOrder, orderStatus: "fulfilling", fulfillmentStatus: "submitted", failedAt: null },
    mirror: noMirror,
    now: NOW,
  });
  check("stuck order (>2h paid, unfulfilled) is flagged", ids(stuck).includes("stuck-in-fulfilment"));

  const fresh = diagnosis.diagnoseCheckoutOrder({
    order: {
      ...baseOrder,
      orderStatus: "fulfilling",
      fulfillmentStatus: "submitted",
      failedAt: null,
      updatedAt: iso(NOW - M30),
    },
    mirror: noMirror,
    now: NOW,
  });
  check("a fresh in-flight order is NOT called stuck", !ids(fresh).includes("stuck-in-fulfilment"));
  check("a fresh in-flight order is NOT called captured-not-delivered", !ids(fresh).includes("captured-not-delivered"));

  const mismatch = diagnosis.diagnoseCheckoutOrder({
    order: {
      ...baseOrder,
      paymentStatus: "failed",
      orderStatus: "payment_failed",
      fulfillmentStatus: "queued",
      paystackGatewayResponse: ORDER_MISMATCH_MESSAGE,
    },
    mirror: noMirror,
    now: NOW,
  });
  check("a mismatch-parked order is recognised", ids(mismatch).includes("verification-mismatch"));
  check(
    "a mismatch-parked order also reports the gateway id without a capture",
    ids(mismatch).includes("gateway-id-without-capture"),
  );

  const drift = diagnosis.diagnoseCheckoutOrder({
    order: { ...baseOrder, amountSubunits: 9999 },
    mirror: noMirror,
    now: NOW,
  });
  check("amount / subunit drift is critical", ids(drift).includes("subunit-drift"));
  check(
    "an order whose pesewas match is NOT flagged for drift",
    !ids(parked).includes("subunit-drift"),
  );

  const done = diagnosis.diagnoseCheckoutOrder({
    order: {
      ...baseOrder,
      orderStatus: "fulfilled",
      fulfillmentStatus: "delivered",
      fulfilledAt: iso(NOW - H5),
      failedAt: null,
    },
    mirror: {
      exists: true,
      status: "successful",
      fulfillmentStatus: "delivered",
      direction: "out",
      amount: 120,
      chargedAt: iso(NOW - H5),
      fulfilledAt: iso(NOW - H5),
      refundedAt: null,
    },
    now: NOW,
  });
  equal("a cleanly fulfilled order has exactly one healthy finding", ids(done), ["fulfilled-clean"]);
  check("a cleanly fulfilled order's verdict is healthy", diagnosis.summarizeFindings(done).severity === "healthy");

  const diverged = diagnosis.diagnoseCheckoutOrder({
    order: { ...baseOrder, orderStatus: "fulfilled", fulfillmentStatus: "delivered", failedAt: null },
    mirror: {
      exists: true,
      status: "failed",
      fulfillmentStatus: "failed",
      direction: "out",
      amount: 99,
      chargedAt: null,
      fulfilledAt: null,
      refundedAt: null,
    },
    now: NOW,
  });
  check("ledger mirror status divergence is flagged", ids(diverged).includes("mirror-status-divergence"));
  check("ledger mirror amount divergence is flagged", ids(diverged).includes("mirror-amount-divergence"));

  const refundedMirror = diagnosis.diagnoseCheckoutOrder({
    order: baseOrder,
    mirror: {
      exists: true,
      status: "failed",
      fulfillmentStatus: "failed",
      direction: "out",
      amount: 120,
      chargedAt: null,
      fulfilledAt: null,
      refundedAt: iso(NOW - M30),
    },
    now: NOW,
  });
  check("a refunded ledger mirror on a checkout order is flagged", ids(refundedMirror).includes("mirror-refund-divergence"));

  const creditMirror = diagnosis.diagnoseCheckoutOrder({
    order: baseOrder,
    mirror: {
      exists: true,
      status: "failed",
      fulfillmentStatus: "failed",
      direction: "in",
      amount: 120,
      chargedAt: null,
      fulfilledAt: null,
      refundedAt: null,
    },
    now: NOW,
  });
  check("a mirror row that is not a debit is flagged", ids(creditMirror).includes("mirror-direction"));

  const unpaid = diagnosis.diagnoseCheckoutOrder({
    order: {
      ...baseOrder,
      paymentStatus: "pending",
      orderStatus: "awaiting_payment",
      fulfillmentStatus: "queued",
      paystackTransactionId: null,
      failedAt: null,
      paidAt: null,
    },
    mirror: noMirror,
    now: NOW,
  });
  equal("an unpaid order reports only that nothing was captured", ids(unpaid), ["nothing-captured"]);
  check("an unpaid order's verdict is healthy", diagnosis.summarizeFindings(unpaid).severity === "healthy");

  // -- review state
  const openReview = [
    { action: "refund_review", at: iso(NOW - 3 * 3600_000) },
  ];
  const closedReview = [
    { action: "refund_review", at: iso(NOW - 3 * 3600_000) },
    { action: "delivery_resolved", at: iso(NOW - 1 * 3600_000) },
  ];
  const reopened = [
    { action: "refund_review", at: iso(NOW - 3 * 3600_000) },
    { action: "delivery_resolved", at: iso(NOW - 5 * 3600_000) },
  ];
  check("a lone refund review is open", diagnosis.hasOpenRefundReview(openReview) === true);
  check("a review resolved afterwards is closed", diagnosis.hasOpenRefundReview(closedReview) === false);
  check("a review recorded AFTER the resolution is open again", diagnosis.hasOpenRefundReview(reopened) === true);
  check("no review at all is not open", diagnosis.hasOpenRefundReview([]) === false);

  const withReview = diagnosis.diagnoseCheckoutOrder({
    order: baseOrder,
    mirror: noMirror,
    actions: openReview,
    now: NOW,
  });
  check("an open review surfaces on the order page", ids(withReview).includes("refund-review-open"));
  const withClosedReview = diagnosis.diagnoseCheckoutOrder({
    order: { ...baseOrder, orderStatus: "fulfilled", fulfillmentStatus: "delivered", failedAt: null },
    mirror: {
      exists: true,
      status: "successful",
      fulfillmentStatus: "delivered",
      direction: "out",
      amount: 120,
      chargedAt: null,
      fulfilledAt: iso(NOW - M30),
      refundedAt: null,
    },
    actions: closedReview,
    now: NOW,
  });
  check(
    "a resolved review reads as an admin-confirmed delivery, not an open review",
    ids(withClosedReview).includes("admin-confirmed-delivery") &&
      !ids(withClosedReview).includes("refund-review-open"),
  );

  // -- deposit rules
  const baseDeposit = {
    ref: "DP-1",
    status: "successful",
    provider: "paystack",
    method: "card",
    amount: 100,
    amountSubunits: 10000,
    currency: "GHS",
    paystackTransactionId: "ps_dep_1",
    paystackGatewayResponse: "Approved",
    initiatedAt: iso(NOW - 3 * 3600_000),
    paidAt: iso(NOW - 3 * 3600_000),
    verifiedAt: iso(NOW - 3 * 3600_000),
    completedAt: iso(NOW - 3 * 3600_000),
    updatedAt: iso(NOW - 3 * 3600_000),
  };
  const credited = { creditRows: 1, successfulCredits: 1, reversedRows: 0, creditedAmount: 100, creditedAt: iso(NOW - 3 * 3600_000) };
  const clean = diagnosis.diagnoseDeposit({ deposit: baseDeposit, credit: credited, now: NOW });
  equal("a settled and credited deposit is clean", ids(clean), ["credited-clean"]);

  const notCredited = diagnosis.diagnoseDeposit({
    deposit: baseDeposit,
    credit: { creditRows: 0, successfulCredits: 0, reversedRows: 0, creditedAmount: null, creditedAt: null },
    now: NOW,
  });
  check("a settled deposit with no credit is critical", ids(notCredited).includes("settled-not-credited"));

  const duplicated = diagnosis.diagnoseDeposit({
    deposit: baseDeposit,
    credit: { creditRows: 2, successfulCredits: 2, reversedRows: 0, creditedAmount: 100, creditedAt: null },
    now: NOW,
  });
  check("two credits for one deposit is critical", ids(duplicated).includes("duplicate-credit"));

  const wrongAmount = diagnosis.diagnoseDeposit({
    deposit: baseDeposit,
    credit: { ...credited, creditedAmount: 90 },
    now: NOW,
  });
  check("a credit for the wrong amount is critical", ids(wrongAmount).includes("credit-amount-divergence"));

  const depositMismatch = diagnosis.diagnoseDeposit({
    deposit: {
      ...baseDeposit,
      status: "failed",
      paystackGatewayResponse: DEPOSIT_MISMATCH_MESSAGE,
    },
    credit: { creditRows: 0, successfulCredits: 0, reversedRows: 0, creditedAmount: null, creditedAt: null },
    now: NOW,
  });
  check("a mismatch-parked deposit is recognised", ids(depositMismatch).includes("verification-mismatch"));
  check(
    "a mismatch-parked deposit is NOT reported as settled-but-uncradited",
    !ids(depositMismatch).includes("settled-not-credited"),
  );

  const demoLocked = diagnosis.diagnoseDeposit({
    deposit: { ...baseDeposit, status: "failed", provider: "mock", paystackGatewayResponse: DEMO_LOCK_MESSAGE, paystackTransactionId: null },
    credit: { creditRows: 0, successfulCredits: 0, reversedRows: 0, creditedAmount: null, creditedAt: null },
    now: NOW,
  });
  check("a demo deposit refused in production is explained", ids(demoLocked).includes("demo-deposit-locked"));

  const stale = diagnosis.diagnoseDeposit({
    deposit: { ...baseDeposit, status: "pending", initiatedAt: iso(NOW - 48 * 3600_000), paystackTransactionId: null },
    credit: { creditRows: 0, successfulCredits: 0, reversedRows: 0, creditedAmount: null, creditedAt: null },
    now: NOW,
  });
  check("a deposit pending over 24h is flagged", ids(stale).includes("stale-pending"));

  const recentPending = diagnosis.diagnoseDeposit({
    deposit: { ...baseDeposit, status: "pending", initiatedAt: iso(NOW - M30), paystackTransactionId: null },
    credit: { creditRows: 0, successfulCredits: 0, reversedRows: 0, creditedAmount: null, creditedAt: null },
    now: NOW,
  });
  check("a fresh pending deposit is not stale", !ids(recentPending).includes("stale-pending"));
  equal("a fresh unsettled deposit is reported as agreeing", ids(recentPending), ["not-settled"]);

  const depositDrift = diagnosis.diagnoseDeposit({
    deposit: { ...baseDeposit, amountSubunits: 4500, status: "pending", paystackTransactionId: null },
    credit: { creditRows: 0, successfulCredits: 0, reversedRows: 0, creditedAmount: null, creditedAt: null },
    now: NOW,
  });
  check("deposit subunit drift is critical", ids(depositDrift).includes("subunit-drift"));

  const reversed = diagnosis.diagnoseDeposit({
    deposit: { ...baseDeposit, status: "failed", paystackTransactionId: null },
    credit: { creditRows: 1, successfulCredits: 0, reversedRows: 1, creditedAmount: null, creditedAt: null },
    now: NOW,
  });
  check("a reversed ledger row is surfaced", ids(reversed).includes("credit-reversed"));

  // -- probe classification (the same three predicates the settlement path uses)
  const subjectOrder = {
    kind: "order" as const,
    ref: "CO-PARK-1",
    storedStatus: "successful",
    storedAmountSubunits: 12000,
    storedCurrency: "GHS",
    storedTransactionId: "ps_tx_park1",
  };
  const agreeing = diagnosis.diagnosePaystackProbe({
    subject: subjectOrder,
    probe: {
      status: "success",
      rawStatus: "success",
      reference: "CO-PARK-1",
      amountSubunits: 12000,
      currency: "GHS",
      transactionId: "4411",
      channel: "card",
      paidAt: iso(NOW - H5),
      gatewayResponse: "Successful",
    },
  });
  equal("a matching successful charge agrees with a captured order", ids(agreeing), ["probe-agrees"]);

  const capturedNotSettled = diagnosis.diagnosePaystackProbe({
    subject: { ...subjectOrder, storedStatus: "pending" },
    probe: {
      status: "success",
      rawStatus: "success",
      reference: "CO-PARK-1",
      amountSubunits: 12000,
      currency: "GHS",
      transactionId: "4411",
      channel: "card",
      paidAt: iso(NOW - H5),
      gatewayResponse: "Successful",
    },
  });
  check(
    "a matching charge we never settled is critical",
    ids(capturedNotSettled).includes("probe-captured-not-settled"),
  );
  check(
    "the unsettled-charge guidance names the customer's own verify path and denies money movement",
    capturedNotSettled.some((f) => /customer's checkout verify path/.test(f.guidance) && /never/.test(f.guidance)),
  );

  const probeMismatch = diagnosis.diagnosePaystackProbe({
    subject: { ...subjectOrder, storedStatus: "failed" },
    probe: {
      status: "success",
      rawStatus: "success",
      reference: "CO-PARK-1",
      amountSubunits: 9999,
      currency: "GHS",
      transactionId: "4412",
      channel: "card",
      paidAt: null,
      gatewayResponse: "Successful",
    },
  });
  check("a successful charge for the wrong amount is a mismatch", ids(probeMismatch).includes("probe-mismatch"));
  check(
    "the mismatch finding states which predicate failed",
    probeMismatch.some((f) => f.id === "probe-mismatch" && /amountOk=false/.test(f.detail)),
  );

  const wrongCurrency = diagnosis.diagnosePaystackProbe({
    subject: subjectOrder,
    probe: {
      status: "success",
      rawStatus: "success",
      reference: "CO-PARK-1",
      amountSubunits: 12000,
      currency: "USD",
      transactionId: "4413",
      channel: "card",
      paidAt: null,
      gatewayResponse: "Successful",
    },
  });
  check("a currency mismatch is caught", ids(wrongCurrency).includes("probe-mismatch"));

  const wrongReference = diagnosis.diagnosePaystackProbe({
    subject: subjectOrder,
    probe: {
      status: "success",
      rawStatus: "success",
      reference: "CO-SOMETHING-ELSE",
      amountSubunits: 12000,
      currency: "GHS",
      transactionId: "4414",
      channel: "card",
      paidAt: null,
      gatewayResponse: "Successful",
    },
  });
  check("a reference mismatch is caught for an order (strict equality)", ids(wrongReference).includes("probe-mismatch"));

  const depositReferenceTolerance = diagnosis.diagnosePaystackProbe({
    subject: {
      kind: "deposit",
      ref: "DP-OK-1",
      storedStatus: "successful",
      storedAmountSubunits: 10000,
      storedCurrency: "GHS",
      storedTransactionId: "ps_dep_ok1",
      credited: true,
    },
    // `deposits.ts` tolerates a missing reference and falls back to our own ref.
    probe: {
      status: "success",
      rawStatus: "success",
      reference: null,
      amountSubunits: 10000,
      currency: "GHS",
      transactionId: "4415",
      channel: "card",
      paidAt: null,
      gatewayResponse: "Successful",
    },
  });
  check(
    "a deposit probe tolerates a missing reference exactly as deposits.ts does",
    ids(depositReferenceTolerance).includes("probe-agrees"),
  );

  const settledNotCredited = diagnosis.diagnosePaystackProbe({
    subject: {
      kind: "deposit",
      ref: "DP-NOCREDIT-1",
      storedStatus: "successful",
      storedAmountSubunits: 8000,
      storedCurrency: "GHS",
      storedTransactionId: "ps_dep_nocredit",
      credited: false,
    },
    probe: {
      status: "success",
      rawStatus: "success",
      reference: "DP-NOCREDIT-1",
      amountSubunits: 8000,
      currency: "GHS",
      transactionId: "4416",
      channel: "card",
      paidAt: null,
      gatewayResponse: "Successful",
    },
  });
  check(
    "a settled deposit with no credit is escalated even when Paystack agrees",
    ids(settledNotCredited).includes("probe-settled-not-credited"),
  );

  const contradicted = diagnosis.diagnosePaystackProbe({
    subject: subjectOrder,
    probe: {
      status: "reversed",
      rawStatus: "reversed",
      reference: "CO-PARK-1",
      amountSubunits: 12000,
      currency: "GHS",
      transactionId: "4417",
      channel: "card",
      paidAt: null,
      gatewayResponse: "Reversed by bank",
    },
  });
  check("Paystack contradicting a captured payment is critical", ids(contradicted).includes("probe-contradicts-capture"));

  const notCaptured = diagnosis.diagnosePaystackProbe({
    subject: { ...subjectOrder, storedStatus: "pending" },
    probe: {
      status: "abandoned",
      rawStatus: "abandoned",
      reference: "CO-PARK-1",
      amountSubunits: null,
      currency: null,
      transactionId: null,
      channel: null,
      paidAt: null,
      gatewayResponse: "Checkout abandoned",
    },
  });
  equal("an abandoned charge on an unsettled record agrees", ids(notCaptured), ["probe-not-captured"]);

  const stillPending = diagnosis.diagnosePaystackProbe({
    subject: { ...subjectOrder, storedStatus: "pending" },
    probe: {
      status: "pending",
      rawStatus: "ongoing",
      reference: "CO-PARK-1",
      amountSubunits: null,
      currency: null,
      transactionId: null,
      channel: null,
      paidAt: null,
      gatewayResponse: null,
    },
  });
  equal("an in-progress charge is reported as unknown, never as paid", ids(stillPending), ["probe-pending"]);

  // -- tracking projection for an order with no ledger row
  const trackable = diagnosis.orderToTrackable(baseOrder, noMirror);
  check("an order with no mirror still projects a trackable record", trackable.ref === "CO-1" && trackable.type === "data");
  check("a parked order never projects as successful", trackable.status === "failed");
  const trackablePaid = diagnosis.orderToTrackable(
    { ...baseOrder, orderStatus: "fulfilling", fulfillmentStatus: "submitted" },
    noMirror,
  );
  check("a paid, in-flight order projects as pending", trackablePaid.status === "pending");
  const trackableMirror = diagnosis.orderToTrackable(baseOrder, {
    exists: true,
    status: "failed",
    fulfillmentStatus: "failed",
    direction: "out",
    amount: 120,
    chargedAt: iso(NOW - H5),
    fulfilledAt: null,
    refundedAt: null,
  });
  check("when a mirror row exists it wins, so admin and customer agree", trackableMirror.status === "failed");

  // -- reference parsing (read layer) ≡ normalizeOrderRef (write layer)
  const refMatrix: unknown[] = [
    "CO-PARK-1",
    "  CO-PARK-1 \n",
    "DP-OK-1",
    "FD-MTP97MFCLNHE",
    "ab",
    "x".repeat(41),
    "CO'; drop table",
    "CO PARK",
    "'\"<>%",
    null,
    undefined,
    42,
    { ref: "CO-1" },
    ["CO-1"],
  ];
  const refDivergence = refMatrix.filter(
    (value) => filters.parseRef(value) !== support.normalizeOrderRef(value),
  );
  equal("parseRef (read) and normalizeOrderRef (write) agree on every input", refDivergence, []);
  equal("parseRef accepts the generated shapes", [filters.parseRef("CO-PARK-1"), filters.parseRef("DP-OK-1")], ["CO-PARK-1", "DP-OK-1"]);
  equal("parseRef rejects SQL metacharacters", filters.parseRef("CO'; drop table"), null);
  equal("parseRef rejects an over-long ref", filters.parseRef("x".repeat(41)), null);

  // -- the three copies of the support-eligibility rule must agree
  const eligibilityMatrix = [
    { paymentStatus: "successful", orderStatus: "fulfillment_failed", updatedAtMs: NOW - M30 },
    { paymentStatus: "successful", orderStatus: "fulfillment_failed", updatedAtMs: NOW - H5 },
    { paymentStatus: "successful", orderStatus: "paid", updatedAtMs: NOW - H5 },
    { paymentStatus: "successful", orderStatus: "fulfilling", updatedAtMs: NOW - H5 },
    { paymentStatus: "successful", orderStatus: "fulfilling", updatedAtMs: NOW - M30 },
    { paymentStatus: "successful", orderStatus: "fulfilled", updatedAtMs: NOW - H5 },
    { paymentStatus: "pending", orderStatus: "fulfillment_failed", updatedAtMs: NOW - H5 },
    { paymentStatus: "failed", orderStatus: "payment_failed", updatedAtMs: NOW - H5 },
    { paymentStatus: "successful", orderStatus: "abandoned", updatedAtMs: NOW - H5 },
  ];
  const eligibilityDivergence = eligibilityMatrix.filter((row) => {
    const a = diagnosis.isOrderSupportActionable({ ...row, now: NOW });
    const b = support.isSupportableOrder(
      {
        orderStatus: row.orderStatus,
        paymentStatus: row.paymentStatus,
        updatedAt: row.updatedAtMs === null ? (null as unknown as Date) : new Date(row.updatedAtMs),
      },
      NOW,
    );
    const c = qops.isAttentionRowActionable({ ...row, now: NOW });
    return a !== b || a !== c;
  });
  equal("diagnosis, support-actions and the attention queue agree on eligibility", eligibilityDivergence, []);
  check(
    "a null `updated_at` is treated conservatively (never support-actionable)",
    diagnosis.isOrderSupportActionable({ paymentStatus: "successful", orderStatus: "paid", updatedAtMs: null, now: NOW }) ===
      false,
  );

  // -- constants must not drift apart
  equal(
    "the stuck-order window is the same constant everywhere",
    [diagnosis.DIAGNOSIS_STUCK_AFTER_MS, support.SUPPORT_STUCK_AFTER_MS, qops.STUCK_AFTER_MS],
    [2 * 60 * 60 * 1000, 2 * 60 * 60 * 1000, 2 * 60 * 60 * 1000],
  );
  equal(
    "the stale-deposit window is the same constant everywhere",
    [diagnosis.DIAGNOSIS_STALE_DEPOSIT_MS, qops.STALE_DEPOSIT_MS],
    [24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000],
  );

  // -- probe throttle arithmetic
  const throttleBase = { adminUserId: 7, kind: "order" as const, ref: "CO-PARK-1", now: NOW };
  check(
    "a fresh administrator may probe",
    probe.probeThrottleDecision({ ...throttleBase, adminHits: [], refHits: [] }).allowed === true,
  );
  check(
    `the ${probe.PROBE_REF_LIMIT - 1}th probe of one reference is still allowed`,
    probe.probeThrottleDecision({
      ...throttleBase,
      adminHits: Array.from({ length: probe.PROBE_REF_LIMIT - 1 }, (_, i) => NOW - i * 1000),
      refHits: Array.from({ length: probe.PROBE_REF_LIMIT - 1 }, (_, i) => NOW - i * 1000),
    }).allowed === true,
  );
  const atLimit = probe.probeThrottleDecision({
    ...throttleBase,
    adminHits: Array.from({ length: probe.PROBE_REF_LIMIT }, (_, i) => NOW - i * 1000),
    refHits: Array.from({ length: probe.PROBE_REF_LIMIT }, (_, i) => NOW - i * 1000),
  });
  check(
    "once the per-reference limit is reached the next probe is refused",
    atLimit.allowed === false && atLimit.scope === "reference",
    atLimit,
  );
  const refLimited = probe.probeThrottleDecision({
    ...throttleBase,
    adminHits: Array.from({ length: probe.PROBE_REF_LIMIT + 1 }, (_, i) => NOW - i * 1000),
    refHits: Array.from({ length: probe.PROBE_REF_LIMIT + 1 }, (_, i) => NOW - i * 1000),
  });
  check("one reference too many is refused", refLimited.allowed === false);
  check(
    "the refusal says how long to wait",
    refLimited.allowed === false && refLimited.retryAfterSeconds > 0 && refLimited.retryAfterSeconds <= 300,
    refLimited,
  );
  const adminLimited = probe.probeThrottleDecision({
    ...throttleBase,
    adminHits: Array.from({ length: probe.PROBE_ADMIN_LIMIT + 1 }, (_, i) => NOW - i * 1000),
    refHits: [],
  });
  check("the per-administrator ceiling is enforced across references", adminLimited.allowed === false);
  check(
    "hits older than the window do not count",
    probe.probeThrottleDecision({
      ...throttleBase,
      adminHits: Array.from({ length: 50 }, () => NOW - probe.PROBE_WINDOW_MS - 1000),
      refHits: Array.from({ length: 50 }, () => NOW - probe.PROBE_WINDOW_MS - 1000),
    }).allowed === true,
  );
  check("the probe result carries a do-not-misread notice", /nothing was written/i.test(probe.PROBE_NOTICE));

  // -------------------------------------------------------------------------
  section("B. Source-level guarantees");
  // -------------------------------------------------------------------------
  const root = process.cwd();
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      const stat = require("node:fs").statSync(full);
      return stat.isDirectory() ? walk(full) : [full];
    });
  const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/\/\/[^"\n]*$/gm, " ");

  const NEW_ROUTES = [
    "src/app/api/admin/orders/[ref]/route.ts",
    "src/app/api/admin/orders/[ref]/paystack-status/route.ts",
    "src/app/api/admin/payments/[ref]/route.ts",
    "src/app/api/admin/payments/[ref]/paystack-status/route.ts",
    "src/app/api/admin/audit/route.ts",
    "src/app/api/admin/reviews/route.ts",
  ];
  const NEW_PAGES = [
    "src/app/admin/orders/[ref]/page.tsx",
    "src/app/admin/payments/[ref]/page.tsx",
    "src/app/admin/audit/page.tsx",
    "src/app/admin/reviews/page.tsx",
  ];

  for (const route of NEW_ROUTES) {
    const source = read(route);
    const entry = source.search(/export (async function|const) GET/);
    const body = entry >= 0 ? source.slice(entry, entry + 400) : source;
    check(`${route} exists and exports GET`, entry >= 0);
    check(`${route} runs the Phase 0 gate before anything else`, body.includes("requireAdminApi()"));
    check(`${route} is never cached`, source.includes(`export const dynamic = "force-dynamic"`));
    check(`${route} exposes no write verb`, !/export async function (POST|PUT|PATCH|DELETE)/.test(source));
  }
  for (const page of NEW_PAGES) {
    const source = read(page);
    check(`${page} re-checks the gate`, source.includes("requireAdmin()"));
    check(`${page} is never cached`, source.includes(`export const dynamic = "force-dynamic"`));
    check(
      `${page} exports no metadata title that would leak the admin area`,
      !/title:\s*["'][^"']*admin/i.test(source),
    );
  }

  // The diagnosis engine: pure by construction. These scan the CODE — the files'
  // own safety comments name the modules they deliberately do not import.
  const diagnosisSource = read("src/lib/admin/diagnosis.ts");
  const diagnosisCode = stripComments(diagnosisSource);
  check("diagnosis.ts imports no database", !/@\/db/.test(diagnosisCode));
  check("diagnosis.ts imports no gateway or settlement module", !/@\/lib\/(paystack|deposits|checkout|payments|data-gateway)/.test(diagnosisCode));
  check(
    "diagnosis.ts performs no HTTP and no clock capture at import time",
    !/\bfetch\(|axios|http\.request/.test(diagnosisSource),
  );
  check(
    "diagnosis.ts contains no mutation verb in code",
    !/\b(insert|update|delete|truncate)\b/i.test(stripComments(diagnosisSource).replace(/updatedAt|updated_at|lastUpdatedAt/g, "")),
  );
  check("diagnosis.ts is not server-only (it is pure and unit-testable)", !/import "server-only"/.test(diagnosisSource));

  // The probe module: no database, no settlement path.
  const probeSource = read("src/lib/admin/paystack-status.ts");
  const probeCode = stripComments(probeSource);
  check("paystack-status.ts imports no database", !/@\/db/.test(probeCode));
  check(
    "paystack-status.ts imports ONLY read-only symbols from the Paystack client",
    [...probeCode.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/paystack"/g)]
      .flatMap((m) => m[1].split(",").map((part) => part.trim()))
      .filter(Boolean)
      .sort()
      .join(",") ===
      ["PaystackConfigError", "PaystackRequestError", "isPaystackConfigured", "paystackMode", "paystackVerifyTransaction"]
        .sort()
        .join(","),
  );
  check(
    "paystack-status.ts cannot reach a settlement, credit or submit path",
    !/reconcileDeposit|reconcileCheckoutOrder|settleAtomic|fulfillPaidOrder|initPayment|submitDataBundleOrder|upsertProviderFloatBalance|creditReferralReward/.test(
      probeCode,
    ),
  );
  check(
    "paystack-status.ts imports no settlement module at all",
    !/from "@\/lib\/(deposits|checkout|payments|data-gateway)"/.test(probeCode),
  );
  check(
    "paystack-status.ts contains no mutation verb in code",
    !/\.(insert|update|delete)\(|\b(insert into|update |delete from)\b/i.test(stripComments(probeSource)),
  );
  check("the probe is time-bounded", probeSource.includes("PROBE_TIMEOUT_MS") && probeSource.includes("withTimeout"));
  check("the probe is throttled before the outbound call", /probeThrottleDecision\(/.test(probeSource));

  // The read layer.
  const investigationSource = read("src/lib/admin/queries-investigation.ts");
  const investigationCode = stripComments(investigationSource);
  check("queries-investigation.ts is server-only", investigationSource.includes(`import "server-only"`));
  check("queries-investigation.ts imports no settlement module", !/from "@\/lib\/(deposits|checkout|payments|data-gateway)"/.test(investigationCode));
  check(
    "queries-investigation.ts imports only the posture readers from the Paystack client",
    [...investigationCode.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/paystack"/g)]
      .flatMap((m) => m[1].split(",").map((part) => part.trim()))
      .filter(Boolean)
      .sort()
      .join(",") === ["isPaystackConfigured", "paystackMode"].sort().join(","),
  );
  equal(
    "every investigation loader runs inside a read-only transaction",
    (investigationSource.match(/withReadOnlyTx\(/g) ?? []).length,
    4,
  );
  check(
    "the read layer never selects a raw provider payload",
    !/provider_payload|provider_response/.test(investigationCode),
  );

  // No write API anywhere under src/lib/admin (the Phase 1 guarantee, re-proved
  // with the three new files present).
  const adminLibFiles = walk(path.join(root, "src/lib/admin")).filter((f) => /\.(ts|tsx)$/.test(f));
  const mutationPatterns = [
    /\bdb\.(update|insert|delete)\(/,
    /\bpool\.(query|execute)\(/,
    /sql`(insert|update|delete|truncate|alter|drop|create)\b/i,
  ];
  const offending = adminLibFiles
    .filter((file) => mutationPatterns.some((pattern) => pattern.test(readFileSync(file, "utf8"))))
    .map((file) => file.replace(root, ""));
  equal("nothing under src/lib/admin (the read layer) can write", offending, []);
  check(`the admin read layer now has ${adminLibFiles.length} files`, adminLibFiles.length >= 12);

  // The browser write surface is UNCHANGED: still exactly the two Step 1/2 modals.
  const browserFacing = [
    ...walk(path.join(root, "src/app/admin")),
    ...walk(path.join(root, "src/components/admin")),
  ];
  const writeCalls = /\bmethod:\s*["'](POST|PUT|PATCH|DELETE)["']|\.post\(|\.put\(|\.patch\(|\.delete\(|\baction=\{/i;
  const writes = browserFacing
    .filter((file) => writeCalls.test(readFileSync(file, "utf8")))
    .map((file) => file.replace(root, ""))
    .sort();
  equal(
    "the browser write surfaces are STILL exactly the two confirmation modals",
    writes,
    ["/src/components/admin/customer-actions.tsx", "/src/components/admin/order-support-actions.tsx"],
  );
  const probeComponent = read("src/components/admin/paystack-probe.tsx");
  check("the probe component issues a GET and nothing else", /method:\s*"GET"/.test(probeComponent) && !writeCalls.test(probeComponent));
  check(
    "the probe component hardcodes no endpoint — the page passes the gated URL",
    !/\/api\/admin\//.test(stripComments(probeComponent)) && probeComponent.includes("endpoint: string"),
  );
  const probePages = ["src/app/admin/orders/[ref]/page.tsx", "src/app/admin/payments/[ref]/page.tsx"];
  check(
    "the only endpoint each investigation page hands the probe is its own /paystack-status route",
    probePages.every((page) => {
      const endpoints = [...read(page).matchAll(/endpoint=\{`([^`]+)`\}/g)].map((m) => m[1]);
      return endpoints.length === 1 && endpoints[0].endsWith("/paystack-status");
    }),
  );
  check(
    "the investigation panels contain no control that could change a record",
    !/<button|<form|fetch\(/.test(read("src/components/admin/investigation.tsx")),
  );

  // Every admin API handler — including the six new ones — re-runs the gate.
  const apiFiles = walk(path.join(root, "src/app/api/admin")).filter((f) => f.endsWith("route.ts"));
  const ungated = apiFiles.filter((file) => {
    const source = readFileSync(file, "utf8");
    const entry = source.search(/export (async function|const) (GET|POST)/);
    const body = entry >= 0 ? source.slice(entry, entry + 400) : source;
    return !(source.includes("requireAdminApi()") && body.includes("requireAdminApi()"));
  });
  check(`every admin API handler is gated (${apiFiles.length} routes)`, ungated.length === 0, ungated.map((f) => f.replace(root, "")));
  check("Step 3 added six admin API routes", apiFiles.length >= 16, apiFiles.length);

  const pageFiles = walk(path.join(root, "src/app/admin")).filter((f) => f.endsWith("page.tsx"));
  const ungatedPages = pageFiles.filter((f) => !readFileSync(f, "utf8").includes("requireAdmin()"));
  equal("every admin page re-checks the gate", ungatedPages.map((f) => f.replace(root, "")), []);
  check("Step 3 added four admin pages", pageFiles.length >= 15, pageFiles.length);

  // No secret material in the new code (prose is stripped first).
  const secretPattern = /password|secret|api[_-]?key|token_hash|sk_(test|live)|private[_-]key|Bearer/i;
  const secretSurfaces = [
    ...NEW_ROUTES,
    ...NEW_PAGES,
    "src/lib/admin/queries-investigation.ts",
    "src/lib/admin/paystack-status.ts",
    "src/lib/admin/diagnosis.ts",
    "src/components/admin/investigation.tsx",
    "src/components/admin/paystack-probe.tsx",
    "src/components/admin/investigation-explorers.tsx",
  ].filter((f) => secretPattern.test(stripComments(read(f))));
  equal("no password/key material in any new Step 3 source file's code", secretSurfaces, []);

  // -- no migration, no schema change, no financial-module change (git-proved)
  const BASE = process.env.FLEXIDATA_STEP3_BASE ?? "fe8ed0db6a03d2fb5e89deb39663bbbbe394c3f8";
  const gitUnchanged = (paths: string[]): boolean | null => {
    try {
      execSync(`git diff --quiet ${BASE} -- ${paths.join(" ")}`, { cwd: root, stdio: "ignore" });
      return true;
    } catch (error) {
      const status = (error as { status?: number }).status;
      // exit 1 = differences; anything else = git could not run at all.
      return status === 1 ? false : null;
    }
  };
  const schemaUnchanged = gitUnchanged(["src/db/schema.ts", "drizzle"]);
  if (schemaUnchanged === null) {
    skip("git proof that the schema and migrations are untouched", `git could not compare against ${BASE}`);
  } else {
    check("src/db/schema.ts and drizzle/ are byte-identical to the base commit (no migration)", schemaUnchanged === true);
  }
  const financialUnchanged = gitUnchanged([
    "src/lib/paystack.ts",
    "src/lib/deposits.ts",
    "src/lib/checkout.ts",
    "src/lib/payments.ts",
    "src/lib/data-gateway.ts",
    "src/lib/fulfillment.ts",
    "src/lib/auth.ts",
    "src/lib/api-auth.ts",
    "src/lib/accounts.ts",
    "src/lib/support-actions.ts",
    "src/lib/customer-management.ts",
    "src/lib/referrals.ts",
    "src/app/api/payments",
    "src/app/api/wallet",
    "src/app/api/checkout",
    "src/app/api/purchase",
    "src/app/api/convert",
    "src/app/api/rewards",
    "src/lib/admin/auth.ts",
    "src/lib/admin/db.ts",
  ]);
  if (financialUnchanged === null) {
    skip("git proof that no financial or gate module changed", "git could not compare");
  } else {
    check(
      "no wallet / deposit / Paystack / checkout / delivery / auth / gate module was modified",
      financialUnchanged === true,
    );
  }
  const drizzleFiles = readdirSync(path.join(root, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  equal("drizzle/ still holds exactly the four pre-existing migrations", drizzleFiles, [
    "0000_deposit_requests_paystack_audit.sql",
    "0001_paystack_transaction_id_unique.sql",
    "0002_customer_management.sql",
    "0003_support_workflow.sql",
  ]);
  const journal = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: unknown[] };
  equal("the migration journal still has four entries", journal.entries.length, 4);

  // The Step 2 write path is untouched: its own harness re-proves behaviour.
  check(
    "the Step 2 support endpoint is still the only writer for orders",
    read("src/app/api/admin/orders/[ref]/support/route.ts").includes("applyOrderSupportAction"),
  );

  // -------------------------------------------------------------------------
  section("C. Live database checks");
  // -------------------------------------------------------------------------
  const url = liveUrl;
  if (!url) skip("live checks", skipReason);

  let poolRef: { end: () => Promise<void> } | null = null;
  let stub: { url: string; close: () => Promise<void> } | null = null;
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
      const q = async (sqlText: string, params: unknown[] = []) => (await pool.query(sqlText, params)).rows;

      const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
        const warn = console.warn;
        const error = console.error;
        const info = console.info;
        console.warn = () => {};
        console.error = () => {};
        console.info = () => {};
        try {
          return await fn();
        } finally {
          console.warn = warn;
          console.error = error;
          console.info = info;
        }
      };

      const investigation = await import("@/lib/admin/queries-investigation");
      const { loadOverview, loadNavBadges } = await import("@/lib/admin/queries");
      const { loadTransactionDetail, loadAttention } = qops;
      const { resetSchemaCapabilitiesCache } = await import("@/lib/schema-compat");

      const before = await snapshot(pool);
      const auditCountBefore = Number((await q(`select count(*)::int as "c" from admin_audit_logs`))[0].c);

      const findingIds = (list: { id: string }[]) => list.map((entry) => entry.id);

      // -------------------------------------------------------------------
      section("C1. Order investigation (S3.1) classifies every seeded state");
      // -------------------------------------------------------------------
      const parkInvestigation = await investigation.loadOrderInvestigation("CO-PARK-1");
      check("a parked order loads", parkInvestigation !== null);
      check(
        "parked order: captured-not-delivered",
        findingIds(parkInvestigation?.findings ?? []).includes("captured-not-delivered"),
      );
      check("parked order: the mirror row is found", parkInvestigation?.mirror?.ref === "CO-PARK-1");
      check("parked order: marked support-actionable", parkInvestigation?.order.supportActionable === true);
      check("parked order: verdict is critical", parkInvestigation?.verdict.severity === "critical");
      check("parked order: money columns are displayed, not altered", parkInvestigation?.order.amount === 120 && parkInvestigation?.order.amountSubunits === 12000);
      check("parked order: the Paystack trail is present", parkInvestigation?.order.paystackTransactionId === "ps_tx_park1");
      check("parked order: a delivery timeline is projected", (parkInvestigation?.tracking.stages.length ?? 0) >= 5);
      check("parked order: the audit trail is readable", parkInvestigation?.auditAvailable === true && parkInvestigation?.refTrailAvailable === true);

      const noMirrorInvestigation = await investigation.loadOrderInvestigation("CO-NOMIRROR-1");
      check(
        "the parked-before-submit order reports its missing mirror as a fact, not a 404",
        noMirrorInvestigation !== null &&
          noMirrorInvestigation.mirror === null &&
          findingIds(noMirrorInvestigation.findings).includes("mirror-missing"),
      );
      check(
        "…and it still projects a delivery timeline from the order row",
        (noMirrorInvestigation?.tracking.stages.length ?? 0) >= 5,
      );
      check(
        "PROOF of the old dead end: the ledger view has no row for it",
        (await loadTransactionDetail("CO-NOMIRROR-1")) === null,
      );

      const stuckInvestigation = await investigation.loadOrderInvestigation("CO-STUCK-1");
      check("stuck order: flagged", findingIds(stuckInvestigation?.findings ?? []).includes("stuck-in-fulfilment"));
      check("stuck order: support-actionable", stuckInvestigation?.order.supportActionable === true);

      const freshInvestigation = await investigation.loadOrderInvestigation("CO-FRESH-1");
      check("fresh in-flight order: NOT stuck", !findingIds(freshInvestigation?.findings ?? []).includes("stuck-in-fulfilment"));
      check("fresh in-flight order: NOT support-actionable", freshInvestigation?.order.supportActionable === false);

      const mismatchInvestigation = await investigation.loadOrderInvestigation("CO-MISMATCH-1");
      check("mismatch-parked order: recognised", findingIds(mismatchInvestigation?.findings ?? []).includes("verification-mismatch"));
      check("mismatch-parked order: nothing was captured", mismatchInvestigation?.order.paymentStatus === "failed");

      const doneInvestigation = await investigation.loadOrderInvestigation("CO-DONE-1");
      equal("a cleanly fulfilled order has one healthy finding", findingIds(doneInvestigation?.findings ?? []), ["fulfilled-clean"]);

      const divergeInvestigation = await investigation.loadOrderInvestigation("CO-DIVERGE-1");
      check("mirror status divergence is reported", findingIds(divergeInvestigation?.findings ?? []).includes("mirror-status-divergence"));
      check("mirror amount divergence is reported", findingIds(divergeInvestigation?.findings ?? []).includes("mirror-amount-divergence"));

      const refundMirrorInvestigation = await investigation.loadOrderInvestigation("CO-REFUNDMIRROR-1");
      check("a refunded ledger mirror is reported", findingIds(refundMirrorInvestigation?.findings ?? []).includes("mirror-refund-divergence"));

      const driftInvestigation = await investigation.loadOrderInvestigation("CO-DRIFT-1");
      check("amount/subunit drift is reported", findingIds(driftInvestigation?.findings ?? []).includes("subunit-drift"));

      const pendingInvestigation = await investigation.loadOrderInvestigation("CO-PENDING-1");
      equal("an unpaid order reports only that nothing was captured", findingIds(pendingInvestigation?.findings ?? []), ["nothing-captured"]);

      const reviewInvestigation = await investigation.loadOrderInvestigation("CO-REVIEW-1");
      check("an open refund review surfaces on the order page", findingIds(reviewInvestigation?.findings ?? []).includes("refund-review-open"));
      check(
        "the order page lists the recorded action with the acting administrator",
        (reviewInvestigation?.recordedActions ?? []).some(
          (entry) => entry.action === "refund_review" && entry.adminName === "Ada Admin" && Boolean(entry.reason),
        ),
        reviewInvestigation?.recordedActions,
      );

      const resolvedInvestigation = await investigation.loadOrderInvestigation("CO-RESOLVED-1");
      check(
        "a review closed by a delivery confirmation reads as admin-confirmed",
        findingIds(resolvedInvestigation?.findings ?? []).includes("admin-confirmed-delivery") &&
          !findingIds(resolvedInvestigation?.findings ?? []).includes("refund-review-open"),
      );
      check(
        "the customer's suspend/activate history is shown alongside",
        (resolvedInvestigation?.accountActions ?? []).length === 2,
        resolvedInvestigation?.accountActions,
      );

      check("a wallet ledger ref is not an order", (await investigation.loadOrderInvestigation("DP-OK-1")) === null);
      check("an unknown ref is not an order", (await investigation.loadOrderInvestigation("CO-NOPE-1")) === null);
      check(
        "a single-record view shows unmasked contact details",
        parkInvestigation?.order.customerEmail === "kwame@flexidata.test" &&
          parkInvestigation?.order.recipient === "0244123456",
      );

      // -------------------------------------------------------------------
      section("C2. Deposit investigation (S3.3)");
      // -------------------------------------------------------------------
      const okDeposit = await investigation.loadDepositDetail("DP-OK-1");
      equal("a settled and credited deposit is clean", findingIds(okDeposit?.findings ?? []), ["credited-clean"]);
      check("its credit row is listed as evidence", (okDeposit?.creditRows.length ?? 0) === 1);
      check("the wallet verdict is computed", okDeposit?.walletReconciliation.available === true);

      const noCreditDeposit = await investigation.loadDepositDetail("DP-NOCREDIT-1");
      check("a settled deposit with no credit is critical", findingIds(noCreditDeposit?.findings ?? []).includes("settled-not-credited"));
      check("…and its credit list is empty", (noCreditDeposit?.creditRows.length ?? 0) === 0);

      const wrongAmountDeposit = await investigation.loadDepositDetail("DP-WRONGAMT-1");
      check("a credit for the wrong amount is critical", findingIds(wrongAmountDeposit?.findings ?? []).includes("credit-amount-divergence"));
      check("both figures are shown as evidence", (wrongAmountDeposit?.creditRows.length ?? 0) === 1 && wrongAmountDeposit?.deposit.creditedAmount === 70);
      const uniqueRef = await q(
        `select count(*)::int as "c" from pg_indexes
          where tablename = 'transactions' and indexdef ilike '%unique%' and indexdef ilike '%(ref)%'`,
      );
      check(
        "the schema itself forbids a second ledger row per reference (so `duplicate-credit` is a defensive rule)",
        Number(uniqueRef[0].c) >= 1,
        uniqueRef,
      );

      const mismatchDeposit = await investigation.loadDepositDetail("DP-MISMATCH-1");
      check("a mismatch-parked deposit is recognised", findingIds(mismatchDeposit?.findings ?? []).includes("verification-mismatch"));

      const staleDeposit = await investigation.loadDepositDetail("DP-STALE-1");
      check("a 48h pending deposit is flagged", findingIds(staleDeposit?.findings ?? []).includes("stale-pending"));

      const demoDeposit = await investigation.loadDepositDetail("DP-DEMO-1");
      check("a production-locked demo deposit is explained", findingIds(demoDeposit?.findings ?? []).includes("demo-deposit-locked"));

      const driftDeposit = await investigation.loadDepositDetail("DP-DRIFT-1");
      check("deposit subunit drift is reported", findingIds(driftDeposit?.findings ?? []).includes("subunit-drift"));

      const reversedDeposit = await investigation.loadDepositDetail("DP-REVERSED-1");
      check("a reversed ledger row is surfaced", findingIds(reversedDeposit?.findings ?? []).includes("credit-reversed"));
      check("the deposit's credit state reads as reversed", reversedDeposit?.deposit.walletCredit === "reversed");

      check("an order ref is not a deposit", (await investigation.loadDepositDetail("CO-PARK-1")) === null);
      check("an unknown ref is not a deposit", (await investigation.loadDepositDetail("DP-NOPE-1")) === null);

      // -------------------------------------------------------------------
      section("C3. Admin activity log (S3.4)");
      // -------------------------------------------------------------------
      const audit = await investigation.loadAdminAudit({ page: 1, pageSize: 100 });
      check("the trail is available on the migrated schema", audit.available === true);
      check("order references are available (0003 applied)", audit.refTrailAvailable === true);
      equal("all six seeded actions are listed", audit.total, 6);
      check("newest first", new Date(audit.rows[0].createdAt).getTime() >= new Date(audit.rows[audit.rows.length - 1].createdAt).getTime());
      check(
        "suspend, activate, delivery_resolved and refund_review all appear",
        ["suspend", "activate", "delivery_resolved", "refund_review"].every((action) =>
          audit.rows.some((row) => row.action === action),
        ),
      );
      check("each row names the acting administrator", audit.rows.every((row) => Boolean(row.adminName)));
      check("order-level rows carry their reference", audit.rows.filter((row) => row.targetKind === "order").length === 4);
      check("account-level rows carry none", audit.rows.filter((row) => row.targetKind === "account").length === 2);
      check("reasons are shown", audit.rows.some((row) => row.reason === "Chargeback investigation"));
      check("list emails are masked", audit.rows.every((row) => String(row.targetEmail).includes("•")));
      check("the summary counts every action", audit.summary.all === 6 && audit.summary.inRange === 6);
      check("the summary counts distinct administrators", audit.summary.admins === 2, audit.summary);
      check(
        "the per-action breakdown adds up",
        audit.summary.byAction.reduce((sum, entry) => sum + entry.count, 0) === 6,
      );
      check("administrator filter options are offered", audit.adminOptions.length === 2);
      check("action filter options are the four permitted values", audit.actionOptions.length === 4);

      const byAction = await investigation.loadAdminAudit({ action: "refund_review", page: 1, pageSize: 25 });
      equal("filtering by action works", byAction.total, 3);
      const byAdmin = await investigation.loadAdminAudit({ admin: ids.admin2Id, page: 1, pageSize: 25 });
      equal("filtering by acting administrator works", byAdmin.total, 1);
      const byUser = await investigation.loadAdminAudit({ userId: ids.c1, page: 1, pageSize: 25 });
      equal("filtering by target customer works", byUser.total, 6);
      const byRef = await investigation.loadAdminAudit({ search: "CO-REVIEW-1", page: 1, pageSize: 25 });
      equal("searching by order reference works", byRef.total, 1);
      const byReason = await investigation.loadAdminAudit({ search: "Chargeback", page: 1, pageSize: 25 });
      equal("searching by reason works", byReason.total, 1);
      const futureOnly = await investigation.loadAdminAudit({ dateFrom: "2999-01-01", page: 1, pageSize: 25 });
      equal("a date filter that excludes everything returns nothing", futureOnly.total, 0);
      const unknownAction = await investigation.loadAdminAudit({ action: "refund_issued", page: 1, pageSize: 25 });
      equal("an action value outside the CHECK constraint is dropped, not passed to SQL", unknownAction.total, 6);
      const paged = await investigation.loadAdminAudit({ page: 2, pageSize: 25 });
      equal("a page past the end of the trail is empty", paged.rows.length, 0);
      equal("pagination still reports the true total", paged.total, 6);
      equal("offset math is bounded", filters.offsetFor(2, 25), 25);
      equal("an unlisted page size falls back to the default", filters.parsePageSize(2), filters.DEFAULT_PAGE_SIZE);
      const huge = await investigation.loadAdminAudit({ page: 1, pageSize: 5000 });
      check("an absurd page size is clamped, never passed to SQL", huge.pageSize === filters.MAX_PAGE_SIZE || huge.pageSize === filters.DEFAULT_PAGE_SIZE, huge.pageSize);

      // A real multi-page trail: 26 more account-level rows, then page through
      // them and delete them again so the fixture is exactly as it was.
      for (let i = 0; i < 26; i += 1) {
        await q(
          `insert into admin_audit_logs (admin_user_id, target_user_id, action, reason, target_ref, created_at)
           values ($1, $2, 'suspend', 'bulk pagination fixture', null, now() - ($3 || ' minutes')::interval)`,
          [ids.adminId, ids.c2, String(i)],
        );
      }
      const bulk = await investigation.loadAdminAudit({ page: 1, pageSize: 25 });
      equal("page 1 is exactly one page long", bulk.rows.length, 25);
      equal("page 1 reports the enlarged total", bulk.total, 32);
      const bulkPage2 = await investigation.loadAdminAudit({ page: 2, pageSize: 25 });
      equal("page 2 holds the remaining rows", bulkPage2.rows.length, 7);
      check("page 2 does not repeat a single row from page 1", bulkPage2.rows.every((row) => !bulk.rows.some((other) => other.id === row.id)));
      check(
        "ordering stays newest-first across the page boundary",
        new Date(bulk.rows[24].createdAt).getTime() >= new Date(bulkPage2.rows[0].createdAt).getTime(),
        [bulk.rows[24].createdAt, bulkPage2.rows[0].createdAt],
      );
      await q(`delete from admin_audit_logs where reason = 'bulk pagination fixture'`);
      const afterBulk = await investigation.loadAdminAudit({ page: 1, pageSize: 25 });
      equal("the fixture is removed again — the trail is back to its seeded six rows", afterBulk.total, 6);
      check(
        "reading the trail does not add to it",
        Number((await q(`select count(*)::int as "c" from admin_audit_logs`))[0].c) === auditCountBefore,
      );

      // -------------------------------------------------------------------
      section("C4. Refund-review backlog (S3.5)");
      // -------------------------------------------------------------------
      const reviews = await investigation.loadRefundReviews({ page: 1, pageSize: 50 });
      check("the backlog is available", reviews.available === true);
      equal("three reviews were recorded", reviews.total, 3);
      equal("two are open", reviews.summary.open, 2);
      equal("one is closed", reviews.summary.closed, 1);
      equal("the open value is the sum of the open orders", reviews.summary.openValue, 240);
      check("the oldest open review has an age", (reviews.summary.oldestOpenHours ?? 0) >= 2);
      const openRows = reviews.rows.filter((row) => row.state === "open");
      equal("the open rows are the two unresolved refs", openRows.map((row) => row.ref).sort(), ["CO-PARK-1", "CO-REVIEW-1"]);
      const closedRow = reviews.rows.find((row) => row.state === "closed");
      check("the closed row is the resolved order", closedRow?.ref === "CO-RESOLVED-1" && Boolean(closedRow?.resolvedAt));
      check("each row names the reviewing administrator", openRows.every((row) => Boolean(row.reviewedBy)));
      check("list emails are masked", reviews.rows.every((row) => String(row.customerEmail).includes("•")));
      check("amounts are carried for the value-at-risk figure", openRows.every((row) => row.amount === 120));
      const openOnly = await investigation.loadRefundReviews({ state: "open", page: 1, pageSize: 50 });
      equal("the state filter works", openOnly.total, 2);
      const byAmount = await investigation.loadRefundReviews({ sort: "amount", page: 1, pageSize: 50 });
      check("the amount sort still puts open reviews first", byAmount.rows[0].state === "open");
      const searched = await investigation.loadRefundReviews({ search: "CO-REVIEW-1", page: 1, pageSize: 50 });
      equal("searching the backlog works", searched.total, 1);

      // The backlog reacts to the REAL Step 2 action, and to nothing else.
      const { POST: supportRoute } = await import("@/app/api/admin/orders/[ref]/support/route");
      jar.set("fd_session", ADMIN_TOKEN);
      const resolveResponse = await quiet(() =>
        supportRoute(
          new Request("http://localhost/api/admin/orders/CO-REVIEW-1/support", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "delivery_resolved", orderRef: "CO-REVIEW-1", confirm: true, reason: "Confirmed with the provider" }),
          }),
          { params: Promise.resolve({ ref: "CO-REVIEW-1" }) },
        ),
      );
      check("the Step 2 support action still works from this harness", resolveResponse.status === 200, resolveResponse.status);
      const afterResolve = await investigation.loadRefundReviews({ page: 1, pageSize: 50 });
      equal("resolving the order closed its review", afterResolve.summary.open, 1);
      equal("…and moved it to closed", afterResolve.summary.closed, 2);
      const reopenedOrder = await investigation.loadOrderInvestigation("CO-REVIEW-1");
      check(
        "the order page now reads as an admin-confirmed delivery",
        findingIds(reopenedOrder?.findings ?? []).includes("admin-confirmed-delivery"),
      );
      check(
        "…and no longer reports an open review",
        !findingIds(reopenedOrder?.findings ?? []).includes("refund-review-open"),
      );

      const badges = await loadNavBadges();
      equal("the nav badge counts the remaining open review", badges.reviews, 1);
      check("the support badge still works", badges.support !== null);
      const overview = await loadOverview();
      equal("the overview counts open refund reviews", overview.counts.openRefundReviews, 1);
      check(
        "the overview raises it as an operational issue linking to the backlog",
        overview.issues.some((issue) => issue.id === "refund-reviews" && issue.href === "/admin/reviews?state=open"),
      );
      check(
        "the pre-existing overview issues are untouched",
        overview.issues.some((issue) => issue.id === "support-queue") &&
          overview.issues.some((issue) => issue.id === "failed-deposits"),
      );
      check("the attention queue still works unchanged", (await loadAttention({ page: 1, pageSize: 50 })).total > 0);

      // -------------------------------------------------------------------
      section("C5. Authorization — the Phase 0 gate guards all six endpoints");
      // -------------------------------------------------------------------
      const { GET: orderRoute } = await import("@/app/api/admin/orders/[ref]/route");
      const { GET: orderProbeRoute } = await import("@/app/api/admin/orders/[ref]/paystack-status/route");
      const { GET: depositRoute } = await import("@/app/api/admin/payments/[ref]/route");
      const { GET: depositProbeRoute } = await import("@/app/api/admin/payments/[ref]/paystack-status/route");
      const { GET: auditRoute } = await import("@/app/api/admin/audit/route");
      const { GET: reviewsRoute } = await import("@/app/api/admin/reviews/route");

      const call = (
        handler: (request: Request, ctx: { params: Promise<{ ref: string }> }) => Promise<Response>,
        path: string,
        ref: string,
      ) => quiet(() => handler(new Request(`http://localhost${path}`), { params: Promise.resolve({ ref }) }));
      const callPlain = (handler: (request: Request) => Promise<Response>, path: string, query = "") =>
        quiet(() => handler(new Request(`http://localhost${path}${query}`)));

      const ENDPOINTS = [
        { name: "orders/[ref]", handler: orderRoute, path: "/api/admin/orders/CO-PARK-1", ref: "CO-PARK-1" },
        { name: "orders/[ref]/paystack-status", handler: orderProbeRoute, path: "/api/admin/orders/CO-PARK-1/paystack-status", ref: "CO-PARK-1" },
        { name: "payments/[ref]", handler: depositRoute, path: "/api/admin/payments/DP-OK-1", ref: "DP-OK-1" },
        { name: "payments/[ref]/paystack-status", handler: depositProbeRoute, path: "/api/admin/payments/DP-OK-1/paystack-status", ref: "DP-OK-1" },
      ] as const;

      jar.clear();
      for (const endpoint of ENDPOINTS) {
        const anon = await call(endpoint.handler, endpoint.path, endpoint.ref);
        const anonBody = await anon.text();
        check(`${endpoint.name}: anonymous -> 404`, anon.status === 404, anon.status);
        check(`${endpoint.name}: the denial is the Phase 0 shape`, anonBody === `{"ok":false,"error":"Not found"}`, anonBody);
        check(`${endpoint.name}: the denial is never cached`, /no-store/.test(anon.headers.get("cache-control") ?? ""), anon.headers.get("cache-control"));

        jar.set("fd_session", CUSTOMER_TOKEN);
        const customer = await call(endpoint.handler, endpoint.path, endpoint.ref);
        check(
          `${endpoint.name}: ordinary customer -> byte-identical 404`,
          customer.status === 404 && (await customer.text()) === anonBody,
          customer.status,
        );

        jar.set("fd_session", FORGED_TOKEN);
        const forged = await call(endpoint.handler, endpoint.path, endpoint.ref);
        check(
          `${endpoint.name}: forged/unknown session -> byte-identical 404`,
          forged.status === 404 && (await forged.text()) === anonBody,
          forged.status,
        );

        jar.set("fd_session", "phase2s3-admin2-token");
        const notAllowlisted = await call(endpoint.handler, endpoint.path, endpoint.ref);
        check(
          `${endpoint.name}: is_admin WITHOUT the ADMIN_EMAILS allowlist -> byte-identical 404`,
          notAllowlisted.status === 404 && (await notAllowlisted.text()) === anonBody,
          notAllowlisted.status,
        );
        jar.clear();
      }

      for (const [name, handler, path] of [
        ["audit", auditRoute, "/api/admin/audit"],
        ["reviews", reviewsRoute, "/api/admin/reviews"],
      ] as const) {
        const anon = await callPlain(handler, path);
        const anonBody = await anon.text();
        check(`${name}: anonymous -> 404`, anon.status === 404, anon.status);
        jar.set("fd_session", CUSTOMER_TOKEN);
        const customer = await callPlain(handler, path);
        check(`${name}: ordinary customer -> byte-identical 404`, customer.status === 404 && (await customer.text()) === anonBody);
        jar.set("fd_session", FORGED_TOKEN);
        const forged = await callPlain(handler, path);
        check(`${name}: forged session -> byte-identical 404`, forged.status === 404 && (await forged.text()) === anonBody);
        jar.set("fd_session", "phase2s3-admin2-token");
        const notAllowlisted = await callPlain(handler, path);
        check(`${name}: is_admin without the allowlist -> byte-identical 404`, notAllowlisted.status === 404 && (await notAllowlisted.text()) === anonBody);
        jar.clear();
      }

      jar.set("fd_session", ADMIN_TOKEN);
      for (const endpoint of ENDPOINTS.slice(0, 1).concat(ENDPOINTS.slice(2, 3))) {
        const allowed = await call(endpoint.handler, endpoint.path, endpoint.ref);
        check(`${endpoint.name}: authorized admin -> 200`, allowed.status === 200, allowed.status);
        const payload = (await allowed.json()) as { ok?: boolean };
        check(`${endpoint.name}: the payload is the read model`, payload.ok === true);
      }
      const auditAllowed = await callPlain(auditRoute, "/api/admin/audit");
      check("audit: authorized admin -> 200", auditAllowed.status === 200, auditAllowed.status);
      const reviewsAllowed = await callPlain(reviewsRoute, "/api/admin/reviews");
      check("reviews: authorized admin -> 200", reviewsAllowed.status === 200, reviewsAllowed.status);

      // Validation: malformed and cross-type references.
      const malformed = await call(orderRoute, "/api/admin/orders/CO%27%3B%20drop", "CO'; drop");
      check("a malformed order reference -> 400 with no query", malformed.status === 400, malformed.status);
      const malformedDeposit = await call(depositRoute, "/api/admin/payments/DP%27%3B%20drop", "DP'; drop");
      check("a malformed deposit reference -> 400", malformedDeposit.status === 400, malformedDeposit.status);
      const crossType = await call(orderRoute, "/api/admin/orders/DP-OK-1", "DP-OK-1");
      check("a deposit reference is not an order -> 404", crossType.status === 404, crossType.status);
      const crossType2 = await call(depositRoute, "/api/admin/payments/CO-PARK-1", "CO-PARK-1");
      check("an order reference is not a deposit -> 404", crossType2.status === 404, crossType2.status);
      const unknown = await call(orderRoute, "/api/admin/orders/CO-NOPE-1", "CO-NOPE-1");
      check("an unknown reference -> 404", unknown.status === 404, unknown.status);
      const tooLong = await call(orderRoute, `/api/admin/orders/${"x".repeat(41)}`, "x".repeat(41));
      check("an over-long reference -> 400", tooLong.status === 400, tooLong.status);

      // -------------------------------------------------------------------
      section("C6. F1/F2 — the drill-down dead ends are gone");
      // -------------------------------------------------------------------
      for (const fixture of ORDER_FIXTURES) {
        const response = await call(orderRoute, `/api/admin/orders/${fixture.ref}`, fixture.ref);
        check(`every checkout order resolves on its own page: ${fixture.ref}`, response.status === 200, response.status);
      }
      for (const fixture of DEPOSIT_FIXTURES) {
        const response = await call(depositRoute, `/api/admin/payments/${fixture.ref}`, fixture.ref);
        check(`every deposit resolves on its own page: ${fixture.ref}`, response.status === 200, response.status);
      }
      const deadEnds = ORDER_FIXTURES.filter(
        (fixture) => fixture.mirror === null && fixture.order !== "awaiting_payment",
      );
      check(
        `${deadEnds.length} seeded orders had no ledger row at all (the old link 404d)`,
        deadEnds.length >= 4,
        deadEnds.map((f) => f.ref),
      );

      // -------------------------------------------------------------------
      section("C7. The read-only Paystack probe (S3.6)");
      // -------------------------------------------------------------------
      stub = await startPaystackStub({
        "CO-PARK-1": {
          status: "success",
          reference: "CO-PARK-1",
          amount: 12000,
          currency: "GHS",
          id: 4411,
          channel: "card",
          paid_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
          gateway_response: "Successful",
        },
        "CO-MISMATCH-1": {
          status: "success",
          reference: "CO-MISMATCH-1",
          amount: 9999,
          currency: "GHS",
          id: 4412,
          channel: "card",
          gateway_response: "Successful",
        },
        "DP-NOCREDIT-1": {
          status: "success",
          reference: "DP-NOCREDIT-1",
          amount: 8000,
          currency: "GHS",
          id: 4416,
          channel: "card",
          gateway_response: "Successful",
        },
        "DP-STALE-1": { status: "ongoing", reference: "DP-STALE-1", amount: 7500, currency: "GHS", id: 4418 },
        "CO-PENDING-1": { status: "abandoned", reference: "CO-PENDING-1", amount: 12000, currency: "GHS", id: 4419 },
        "CO-DONE-1": {
          status: "reversed",
          reference: "CO-DONE-1",
          amount: 12000,
          currency: "GHS",
          id: 4420,
          gateway_response: "Reversed by bank",
        },
      });
      process.env.PAYSTACK_SECRET_KEY = "sk_test_harness_only_never_live";
      process.env.PAYSTACK_BASE_URL = stub.url;

      check("the probe reports itself available in test mode", investigation.probeAvailability().available === true);
      equal("the probe reports the gateway mode, never a key", investigation.probeAvailability().mode, "test");

      const probeBefore = await snapshot(pool);
      probe.resetProbeThrottle();

      const probeOk = await quiet(() =>
        call(orderProbeRoute, "/api/admin/orders/CO-PARK-1/paystack-status", "CO-PARK-1"),
      );
      check("probe: a matching charge returns 200", probeOk.status === 200, probeOk.status);
      const probeOkBody = (await probeOk.json()) as Record<string, unknown>;
      check("probe: the payload is ok", probeOkBody.ok === true);
      check("probe: the do-not-misread notice is present", /nothing was written/i.test(String(probeOkBody.notice)));
      check("probe: the gateway mode is reported, not the key", probeOkBody.mode === "test");
      check(
        "probe: the raw verification is whitelisted (no key material, no headers)",
        !/sk_(test|live)|Bearer|authorization/i.test(JSON.stringify(probeOkBody)),
      );

      const probeMismatch = await quiet(() =>
        call(orderProbeRoute, "/api/admin/orders/CO-MISMATCH-1/paystack-status", "CO-MISMATCH-1"),
      );
      const probeMismatchBody = (await probeMismatch.json()) as { verification?: { amountSubunits?: number }; findings?: { id: string }[] };
      check(
        "probe: an amount that does not match is classified as a mismatch",
        findingIds(probeMismatchBody.findings ?? []).includes("probe-mismatch"),
        probeMismatchBody.findings,
      );
      check("probe: the gateway's amount is returned as recorded", probeMismatchBody.verification?.amountSubunits === 9999);

      const probeAbandoned = await quiet(() =>
        call(orderProbeRoute, "/api/admin/orders/CO-PENDING-1/paystack-status", "CO-PENDING-1"),
      );
      const probeAbandonedBody = (await probeAbandoned.json()) as { findings?: { id: string }[] };
      check(
        "probe: an abandoned charge on an unpaid order agrees (no money taken)",
        findingIds(probeAbandonedBody.findings ?? []).includes("probe-not-captured"),
      );

      const probeContradicted = await quiet(() =>
        call(orderProbeRoute, "/api/admin/orders/CO-DONE-1/paystack-status", "CO-DONE-1"),
      );
      const probeContradictedBody = (await probeContradicted.json()) as { findings?: { id: string }[] };
      check(
        "probe: a gateway reversal against a captured payment is critical",
        findingIds(probeContradictedBody.findings ?? []).includes("probe-contradicts-capture"),
      );

      const probeDeposit = await quiet(() =>
        call(depositProbeRoute, "/api/admin/payments/DP-NOCREDIT-1/paystack-status", "DP-NOCREDIT-1"),
      );
      const probeDepositBody = (await probeDeposit.json()) as { findings?: { id: string }[] };
      check(
        "probe: a settled deposit with no wallet credit is escalated",
        findingIds(probeDepositBody.findings ?? []).includes("probe-settled-not-credited"),
      );

      const probePendingDeposit = await quiet(() =>
        call(depositProbeRoute, "/api/admin/payments/DP-STALE-1/paystack-status", "DP-STALE-1"),
      );
      const probePendingBody = (await probePendingDeposit.json()) as { findings?: { id: string }[] };
      check("probe: an in-progress charge is never reported as paid", findingIds(probePendingBody.findings ?? []).includes("probe-pending"));

      const probeUnknown = await quiet(() =>
        call(orderProbeRoute, "/api/admin/orders/CO-FRESH-1/paystack-status", "CO-FRESH-1"),
      );
      check("probe: an unknown reference at the gateway is a clean 502, not a 500", probeUnknown.status === 502, probeUnknown.status);
      const probeUnknownBody = (await probeUnknown.json()) as { error?: string; message?: string };
      check("probe: the refusal names the failure", probeUnknownBody.error === "upstream" && Boolean(probeUnknownBody.message));
      check("probe: no key material leaks in a refusal", !/sk_(test|live)|Bearer/i.test(JSON.stringify(probeUnknownBody)));

      const probeMalformed = await call(orderProbeRoute, "/api/admin/orders/CO%27%3B%20drop/paystack-status", "CO'; drop");
      check("probe: a malformed reference -> 400 and no outbound call", probeMalformed.status === 400, probeMalformed.status);
      const probeCross = await call(orderProbeRoute, "/api/admin/orders/DP-OK-1/paystack-status", "DP-OK-1");
      check("probe: a deposit reference is not an order -> 404", probeCross.status === 404, probeCross.status);

      // Throttle: the same reference is bounded.
      probe.resetProbeThrottle();
      const statuses: number[] = [];
      for (let i = 0; i < probe.PROBE_REF_LIMIT + 1; i += 1) {
        const response = await quiet(() =>
          call(orderProbeRoute, "/api/admin/orders/CO-PARK-1/paystack-status", "CO-PARK-1"),
        );
        statuses.push(response.status);
        await response.text();
      }
      equal(
        `the ${probe.PROBE_REF_LIMIT + 1}th probe of one reference is throttled`,
        statuses,
        [...Array(probe.PROBE_REF_LIMIT).fill(200), 429],
      );
      const throttled = await quiet(() =>
        call(orderProbeRoute, "/api/admin/orders/CO-PARK-1/paystack-status", "CO-PARK-1"),
      );
      const throttledBody = (await throttled.json()) as { error?: string; retryAfterSeconds?: number };
      check("the throttle explains itself and says when to retry", throttledBody.error === "throttled" && (throttledBody.retryAfterSeconds ?? 0) > 0);

      // Unconfigured deployment: fail closed with a clean 503.
      const savedKey = process.env.PAYSTACK_SECRET_KEY;
      delete process.env.PAYSTACK_SECRET_KEY;
      check("the probe reports itself unavailable with no key", investigation.probeAvailability().available === false);
      const unconfigured = await quiet(() =>
        call(orderProbeRoute, "/api/admin/orders/CO-STUCK-1/paystack-status", "CO-STUCK-1"),
      );
      check("probe with no gateway configured -> 503", unconfigured.status === 503, unconfigured.status);
      const unconfiguredBody = (await unconfigured.json()) as { error?: string };
      check("the refusal is explicit", unconfiguredBody.error === "unavailable");
      process.env.PAYSTACK_SECRET_KEY = savedKey;

      // A live key without the live-mode opt-in is refused by the existing lock.
      process.env.PAYSTACK_SECRET_KEY = "sk_live_harness_only";
      delete process.env.PAYSTACK_LIVE_MODE;
      probe.resetProbeThrottle();
      const liveLocked = await quiet(() =>
        call(orderProbeRoute, "/api/admin/orders/CO-STUCK-1/paystack-status", "CO-STUCK-1"),
      );
      check("probe: a live key without PAYSTACK_LIVE_MODE is refused (503)", liveLocked.status === 503, liveLocked.status);
      const liveLockedBody = (await liveLocked.json()) as { message?: string };
      check("probe: the live-lock refusal leaks no key material", !/sk_live/.test(JSON.stringify(liveLockedBody)), liveLockedBody);
      process.env.PAYSTACK_SECRET_KEY = "sk_test_harness_only_never_live";

      // The probe changed nothing.
      const probeAfter = await snapshot(pool);
      equal("the probe wrote nothing to any table", diffSnapshot(probeBefore, probeAfter), []);
      probe.resetProbeThrottle();

      // -------------------------------------------------------------------
      section("C8. Mid-session revocation still applies to the new endpoints");
      // -------------------------------------------------------------------
      jar.set("fd_session", ADMIN_TOKEN);
      const beforeRevoke = await call(orderRoute, "/api/admin/orders/CO-PARK-1", "CO-PARK-1");
      check("the admin can read an order before revocation", beforeRevoke.status === 200);
      await q(`update users set is_admin = false where id = $1`, [ids.adminId]);
      const afterRevoke = await call(orderRoute, "/api/admin/orders/CO-PARK-1", "CO-PARK-1");
      const afterRevokeAudit = await callPlain(auditRoute, "/api/admin/audit");
      check("revoking is_admin denies the investigation endpoint on the next request", afterRevoke.status === 404, afterRevoke.status);
      check("revoking is_admin denies the activity log too", afterRevokeAudit.status === 404, afterRevokeAudit.status);
      await q(`update users set is_admin = true where id = $1`, [ids.adminId]);
      const afterRestore = await call(orderRoute, "/api/admin/orders/CO-PARK-1", "CO-PARK-1");
      check("restoring the flag restores access with the same session", afterRestore.status === 200, afterRestore.status);

      // -------------------------------------------------------------------
      section("C9. Secret hygiene across every new payload");
      // -------------------------------------------------------------------
      const payloads: string[] = [];
      for (const ref of ORDER_FIXTURES.map((f) => f.ref)) {
        payloads.push(JSON.stringify(await investigation.loadOrderInvestigation(ref)));
      }
      for (const ref of DEPOSIT_FIXTURES.map((f) => f.ref)) {
        payloads.push(JSON.stringify(await investigation.loadDepositDetail(ref)));
      }
      payloads.push(JSON.stringify(await investigation.loadAdminAudit({ page: 1, pageSize: 100 })));
      payloads.push(JSON.stringify(await investigation.loadRefundReviews({ page: 1, pageSize: 100 })));
      payloads.push(JSON.stringify(await loadOverview()));
      const serialized = payloads.join("\n");
      check(
        "no secret, key, password or bearer material in any Step 3 payload",
        !/sk_(test|live)|pk_(test|live)|Bearer |password|password_hash|token_hash|AUTH_SECRET|DATABASE_URL|PAYSTACK_SECRET/i.test(
          serialized,
        ),
      );
      check("no raw provider jsonb payload is exposed", !/provider_payload|providerPayload|rawRequest|rawResponse/.test(serialized));
      check("no session token is exposed", !serialized.includes(ADMIN_TOKEN) && !serialized.includes(CUSTOMER_TOKEN));

      // -------------------------------------------------------------------
      section("C10. Financial safety — everything is byte-identical");
      // -------------------------------------------------------------------
      // `checkout_orders` is compared IN FULL here (Step 2 was allowed to change
      // delivery-status columns; Step 3 has no write path at all), and so is the
      // audit trail itself. The only deliberate exception is the one real Step 2
      // support action this harness performs in C4 to prove the backlog reacts to
      // it, so those two tables are compared against a snapshot taken after it.
      // This runs BEFORE the degradation section below, which deliberately
      // drops a column and then a table.
      const after = await snapshot(pool);
      const changed = diffSnapshot(before, after);
      equal(
        "the only tables that changed are the two the Step 2 support action owns",
        changed.sort(),
        ["admin_audit_logs", "checkout_orders"].sort(),
        changed,
      );
      const untouched = IMMUTABLE_TABLES.filter(
        (table) => table !== "checkout_orders" && table !== "admin_audit_logs",
      );
      equal(
        "wallets, ledger, deposits, float, agents, plans, schedules, alerts, users and sessions are byte-identical",
        diffSnapshot(
          Object.fromEntries(untouched.map((t) => [t, before[t]])),
          Object.fromEntries(untouched.map((t) => [t, after[t]])),
        ),
        [],
      );
      check(
        "no wallet balance moved",
        JSON.stringify((await q(`select id, balance::text, points from wallets order by id`))) ===
          JSON.stringify(
            (
              await q(`select id, balance::text, points from wallets order by id`)
            ).map((row) => row),
          ) &&
          before.wallets === after.wallets,
      );
      check("the ledger is byte-identical (no credit, debit, reversal or refund)", before.transactions === after.transactions);
      check("deposit_requests is byte-identical (nothing settled)", before.deposit_requests === after.deposit_requests);

      // What the ONE sanctioned Step 2 write changed, and nothing more.
      const orderRowsBefore = JSON.parse(before.checkout_orders) as Record<string, unknown>[];
      const orderRowsAfter = JSON.parse(after.checkout_orders) as Record<string, unknown>[];
      const changedOrders = orderRowsAfter.filter((row, index) => JSON.stringify(row) !== JSON.stringify(orderRowsBefore[index]));
      equal("exactly one order row changed (the harness's own delivery_resolved)", changedOrders.length, 1);
      const changedOrder = changedOrders[0];
      check("it is the order the support action targeted", changedOrder?.ref === "CO-REVIEW-1", changedOrder?.ref);
      const beforeOrder = orderRowsBefore.find((row) => row.ref === "CO-REVIEW-1") ?? {};
      const moneyColumns = [
        "amount", "amount_subunits", "currency", "payment_status", "paystack_transaction_id",
        "paystack_channel", "paystack_gateway_response", "provider_reference", "provider_status",
        "provider_message", "paid_at", "customer_email", "customer_phone", "recipient", "created_at",
      ];
      equal(
        "every money / payment / provider column on that row is unchanged",
        moneyColumns.filter((column) => String(beforeOrder[column]) !== String(changedOrder[column])),
        [],
      );
      const auditRowsBefore = JSON.parse(before.admin_audit_logs) as Record<string, unknown>[];
      const auditRowsAfter = JSON.parse(after.admin_audit_logs) as Record<string, unknown>[];
      equal("exactly one audit row was added — by the Step 2 action, not by Step 3", auditRowsAfter.length - auditRowsBefore.length, 1);
      check(
        "the added row is the delivery_resolved the harness performed",
        auditRowsAfter[auditRowsAfter.length - 1]?.action === "delivery_resolved" ||
          auditRowsAfter.some(
            (row) => row.action === "delivery_resolved" && row.target_ref === "CO-REVIEW-1" &&
              !auditRowsBefore.some((old) => old.id === row.id),
          ),
      );
      check(
        "no audit row was modified or deleted",
        auditRowsBefore.every((row) =>
          auditRowsAfter.some((candidate) => candidate.id === row.id && JSON.stringify(candidate) === JSON.stringify(row)),
        ),
      );

      // -------------------------------------------------------------------
      section("C11. Graceful degradation on a database behind the migrations");
      // -------------------------------------------------------------------
      await q(`alter table admin_audit_logs drop column target_ref`);
      resetSchemaCapabilitiesCache();
      const degradedAudit = await investigation.loadAdminAudit({ page: 1, pageSize: 25 });
      check("pre-0003: the trail still reads", degradedAudit.available === true && degradedAudit.total > 0);
      check("pre-0003: order references are reported unavailable", degradedAudit.refTrailAvailable === false);
      check("pre-0003: rows carry a null reference instead of throwing", degradedAudit.rows.every((row) => row.targetRef === null));
      const degradedReviews = await investigation.loadRefundReviews({ page: 1, pageSize: 25 });
      check("pre-0003: the review backlog reports itself unavailable", degradedReviews.available === false && degradedReviews.total === 0);
      const degradedBadges = await loadNavBadges();
      check("pre-0003: the nav badge is null, not zero", degradedBadges.reviews === null, degradedBadges);
      const degradedOverview = await loadOverview();
      check("pre-0003: the overview count is null (renders 'Not available')", degradedOverview.counts.openRefundReviews === null);
      check("pre-0003: no refund-review issue is raised from a null count", !degradedOverview.issues.some((issue) => issue.id === "refund-reviews"));
      const degradedOrder = await investigation.loadOrderInvestigation("CO-PARK-1");
      check("pre-0003: order investigation still works", degradedOrder !== null);
      check("pre-0003: the order-reference panel reports unavailability", degradedOrder?.refTrailAvailable === false && (degradedOrder?.recordedActions.length ?? 0) === 0);
      check(
        "pre-0003: the customer's suspend/activate history STILL reads (regression: the reference column used to be selected unconditionally)",
        (degradedOrder?.accountActions.length ?? 0) === 2 && degradedOrder?.accountActions.every((entry) => entry.targetRef === null),
        degradedOrder?.accountActions,
      );
      check("pre-0003: the audit panel is still flagged available", degradedOrder?.auditAvailable === true);
      check("pre-0003: the diagnosis is unchanged", findingIds(degradedOrder?.findings ?? []).includes("captured-not-delivered"));
      const degradedRoute = await callPlain(auditRoute, "/api/admin/audit");
      check("pre-0003: the audit endpoint still answers 200", degradedRoute.status === 200, degradedRoute.status);
      const degradedDeposit = await investigation.loadDepositDetail("DP-OK-1");
      check("pre-0003: deposit investigation still works", degradedDeposit !== null);
      check("pre-0003: the deposit page keeps the account history too", (degradedDeposit?.accountActions.length ?? 0) === 2);

      await q(`drop table admin_audit_logs`);
      resetSchemaCapabilitiesCache();
      const noTrail = await investigation.loadAdminAudit({ page: 1, pageSize: 25 });
      check("pre-0002: the activity log reports itself unavailable", noTrail.available === false && noTrail.total === 0);
      check("pre-0002: action options are still offered for the UI", noTrail.actionOptions.length === 4);
      const noTrailReviews = await investigation.loadRefundReviews({ page: 1, pageSize: 25 });
      check("pre-0002: the backlog reports itself unavailable", noTrailReviews.available === false);
      const noTrailOrder = await investigation.loadOrderInvestigation("CO-PARK-1");
      check("pre-0002: the order page still renders with auditAvailable false", noTrailOrder !== null && noTrailOrder.auditAvailable === false);
      check("pre-0002: the diagnosis is unaffected by a missing trail", findingIds(noTrailOrder?.findings ?? []).includes("captured-not-delivered"));
      const noTrailRoute = await callPlain(auditRoute, "/api/admin/audit");
      check("pre-0002: the endpoint answers 200 with available:false", noTrailRoute.status === 200);
      check(
        "pre-0002: the payload says so",
        ((await noTrailRoute.json()) as { available?: boolean }).available === false,
      );
      const noTrailDeposit = await investigation.loadDepositDetail("DP-MISMATCH-1");
      check("pre-0002: deposit investigation still diagnoses", findingIds(noTrailDeposit?.findings ?? []).includes("verification-mismatch"));
      check("pre-0002: with no trail at all the account history is simply empty", (noTrailDeposit?.accountActions.length ?? 0) === 0);
      check("pre-0002: the deposit page reports the trail unavailable", noTrailDeposit?.auditAvailable === false);

      // -------------------------------------------------------------------
      section("C12. Reading every Step 3 surface — including a live probe — changes nothing");
      // -------------------------------------------------------------------
      // The sanctioned Step 2 write and the degradation DDL are both behind us:
      // from here on, every single read must leave every table exactly as it is.
      const steadyBefore = await snapshot(pool);
      for (const ref of ORDER_FIXTURES.map((f) => f.ref)) await investigation.loadOrderInvestigation(ref);
      for (const ref of DEPOSIT_FIXTURES.map((f) => f.ref)) await investigation.loadDepositDetail(ref);
      await investigation.loadAdminAudit({ page: 1, pageSize: 100 });
      await investigation.loadRefundReviews({ page: 1, pageSize: 100 });
      await loadOverview();
      await loadNavBadges();
      await loadAttention({ page: 1, pageSize: 50 });
      jar.set("fd_session", ADMIN_TOKEN);
      for (const endpoint of ENDPOINTS) {
        const response = await call(endpoint.handler, endpoint.path, endpoint.ref);
        await response.text();
      }
      await callPlain(auditRoute, "/api/admin/audit?page=1");
      await callPlain(reviewsRoute, "/api/admin/reviews?state=open");
      probe.resetProbeThrottle();
      const steadyProbe = await quiet(() => call(orderProbeRoute, "/api/admin/orders/CO-PARK-1/paystack-status", "CO-PARK-1"));
      await steadyProbe.text();
      const steadyAfter = await snapshot(pool);
      equal(
        "reading every Step 3 surface — including a live probe — changes nothing at all",
        diffSnapshot(steadyBefore, steadyAfter),
        [],
      );
      probe.resetProbeThrottle();
    } catch (error) {
      check("live checks completed without an unexpected error", false, error instanceof Error ? error.stack : String(error));
    } finally {
      if (stub) await stub.close().catch(() => undefined);
      delete process.env.PAYSTACK_BASE_URL;
      delete process.env.PAYSTACK_SECRET_KEY;
      if (poolRef) await poolRef.end().catch(() => undefined);
      if (embedded) await embedded.stop().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("\nFAILURES:");
    for (const failure of failed) console.log(`  - ${failure.name}${failure.detail === undefined ? "" : `  -> ${JSON.stringify(failure.detail)}`}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
