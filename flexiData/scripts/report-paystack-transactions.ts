/**
 * READ-ONLY diagnostic report of Paystack deposits in the database.
 *
 * Purpose: list every Paystack deposit request and every Paystack-flavoured
 * wallet transaction so test/demo rows can be told apart from genuine live
 * charges.
 *
 * Safety properties (this script cannot change data):
 *   1. Every statement runs inside a `SET TRANSACTION READ ONLY` transaction, so
 *      PostgreSQL itself rejects any INSERT / UPDATE / DELETE even if a query
 *      were ever mistyped.
 *   2. Both statements are verified to start with SELECT before they are sent.
 *   3. The connection string is never printed. Only a redacted host + database
 *      name are shown.
 *
 * Usage:
 *   npm run report:paystack-transactions
 *   DATABASE_URL=postgresql://… npx tsx scripts/report-paystack-transactions.ts
 *
 * Note on test vs. live: Paystack mode is derived at runtime from the key
 * prefix (`sk_test_` / `sk_live_` — see src/lib/paystack.ts) and is NOT
 * persisted, so no column in this schema can definitively label a row
 * "test" or "live". The report therefore surfaces the discriminator signals
 * (`provider`, `paystack_transaction_id`, `paystack_channel`) and lets you
 * cross-check against the Paystack dashboard.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type QueryResult } from "pg";

/**
 * Next.js loads `.env.local` automatically; a bare `tsx` script does not. Load
 * it here — same precedence as Next.js (`.env.local` wins over `.env`) — so the
 * report picks up the same DATABASE_URL the app uses. A variable already
 * exported by the shell is never overridden. The value is never printed.
 */
function loadEnvFiles(): void {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    try {
      // Built in since Node 20.12; does not overwrite existing env vars.
      (process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile(path);
    } catch {
      // A malformed env file must not mask the real error below.
    }
  }
}

loadEnvFiles();

/* -------------------------------------------------------------------------- */
/* Queries — exactly as specified (SELECT only)                                */
/* -------------------------------------------------------------------------- */

const DEPOSIT_REQUESTS_SQL = `
SELECT
  d.id,
  d.ref AS reference,
  d.wallet_id,
  w.user_id,
  d.provider,
  d.method AS payment_method,
  d.amount,
  d.amount_subunits,
  d.currency,
  d.status,
  d.paystack_transaction_id,
  d.paystack_channel,
  d.paystack_gateway_response,
  d.provider_reference,
  d.initiated_at,
  d.paid_at,
  d.verified_at,
  d.created_at
FROM deposit_requests d
JOIN wallets w ON w.id = d.wallet_id
WHERE d.provider = 'paystack'
   OR d.provider_reference ILIKE '%paystack%'
ORDER BY d.created_at DESC
`;

const TRANSACTIONS_SQL = `
SELECT
  t.id,
  t.ref AS reference,
  t.wallet_id,
  w.user_id,
  t.type,
  t.status,
  t.direction,
  t.title,
  t.subtitle,
  t.amount,
  t.provider,
  t.provider_reference,
  t.created_at
FROM transactions t
JOIN wallets w ON w.id = t.wallet_id
WHERE t.provider ILIKE '%paystack%'
   OR t.provider_reference ILIKE '%paystack%'
   OR t.ref ILIKE '%paystack%'
ORDER BY t.created_at DESC
`;

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

/** Fail loudly rather than ever sending anything that is not a plain SELECT. */
function assertReadOnly(sql: string, label: string): void {
  const stripped = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!/^select\b/i.test(stripped)) {
    throw new Error(`Refusing to run ${label}: statement is not a SELECT.`);
  }
}

/** Host/db only — credentials are never rendered. */
function describeTarget(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const db = u.pathname.replace(/^\//, "") || "(default)";
    return `${u.hostname}:${u.port || "5432"}/${db}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

function buildSslOption(rawUrl: string): { rejectUnauthorized: boolean } | undefined {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const mode = (u.searchParams.get("sslmode") ?? "").toLowerCase();
  if (mode === "disable") return undefined;
  if (mode === "verify-full" || mode === "verify-ca") return { rejectUnauthorized: true };
  if (mode === "require" || mode === "prefer") return { rejectUnauthorized: false };
  const isLocal = ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(u.hostname);
  // Managed providers (Neon, Supabase, Vercel Postgres…) require TLS.
  return isLocal ? undefined : { rejectUnauthorized: false };
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

function cell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return value.toISOString().replace("T", " ").slice(0, 19);
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value);
  return s.length === 0 ? "(empty)" : s;
}

function printTable(rows: Record<string, unknown>[], columns: string[]): void {
  if (rows.length === 0) return;
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => cell(r[c]).length)),
  );
  const line = (parts: string[]) =>
    "  " + parts.map((p, i) => p.padEnd(widths[i])).join(" │ ");

  console.log(line(columns));
  console.log("  " + widths.map((w) => "─".repeat(w)).join("─┼─"));
  for (const row of rows) console.log(line(columns.map((c) => cell(row[c]))));
}

function printSection(title: string): void {
  console.log(`\n${"═".repeat(78)}\n${title}\n${"═".repeat(78)}`);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl || databaseUrl.trim() === "") {
    console.error("\n✗ No database connection is available.\n");
    console.error("  DATABASE_URL is not set, so there is nothing to query.\n");
    console.error("  This script reads DATABASE_URL from (in order of precedence):");
    console.error("    1. the shell / CI environment");
    console.error("    2. flexiData/.env.local   <- git-ignored, the file the app uses");
    console.error("    3. flexiData/.env\n");
    console.error("  To fix it, create flexiData/.env.local containing:");
    console.error("    DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require\n");
    console.error("  Then re-run:  npm run report:paystack-transactions\n");
    console.error("  The value is never printed by this script.\n");
    process.exitCode = 1;
    return;
  }

  assertReadOnly(DEPOSIT_REQUESTS_SQL, "query 1 (deposit_requests)");
  assertReadOnly(TRANSACTIONS_SQL, "query 2 (transactions)");

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: buildSslOption(databaseUrl),
    max: 1,
    connectionTimeoutMillis: 10_000,
    application_name: "flexidata-paystack-report (read-only)",
  });

  const client = await pool.connect();
  try {
    console.log("FlexiData — Paystack transaction report (READ ONLY)");
    console.log(`Target:   ${describeTarget(databaseUrl)}`);
    console.log(`Run at:   ${new Date().toISOString()}`);

    // Hard guarantee: the server rejects any write inside this transaction.
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");

    const deposits: QueryResult<Record<string, unknown>> =
      await client.query(DEPOSIT_REQUESTS_SQL);
    const txs: QueryResult<Record<string, unknown>> =
      await client.query(TRANSACTIONS_SQL);

    await client.query("COMMIT");

    /* ---- Section 1: deposit_requests ---------------------------------- */
    printSection("1. Paystack deposit_requests  (joined to wallets)");

    if (deposits.rowCount === 0) {
      console.log("  No rows matched.");
    } else {
      console.log(`  ${deposits.rowCount} row(s)\n`);
      console.log("  Key fields:");
      printTable(deposits.rows, [
        "id",
        "amount",
        "currency",
        "provider",
        "status",
        "paystack_transaction_id",
        "reference",
        "created_at",
      ]);

      console.log("\n  Full detail:");
      for (const [i, row] of deposits.rows.entries()) {
        console.log(`\n  ── deposit #${i + 1} ──────────────────────────────`);
        for (const [k, v] of Object.entries(row)) {
          console.log(`    ${k.padEnd(26)} ${cell(v)}`);
        }
      }
    }

    /* ---- Section 2: transactions -------------------------------------- */
    printSection("2. Wallet transactions  (joined to wallets)");

    if (txs.rowCount === 0) {
      console.log("  No rows matched.");
    } else {
      console.log(`  ${txs.rowCount} row(s)\n`);
      console.log("  Key fields:");
      printTable(txs.rows, [
        "id",
        "amount",
        "provider",
        "status",
        "type",
        "direction",
        "reference",
        "created_at",
      ]);

      console.log("\n  Full detail:");
      for (const [i, row] of txs.rows.entries()) {
        console.log(`\n  ── transaction #${i + 1} ──────────────────────────`);
        for (const [k, v] of Object.entries(row)) {
          console.log(`    ${k.padEnd(26)} ${cell(v)}`);
        }
      }
    }

    /* ---- Interpretation notes ----------------------------------------- */
    printSection("How to read this");
    console.log([
      "  • provider = 'mock'                -> simulated deposit, NO real money moved (demo).",
      "  • paystack_transaction_id present  -> a real Paystack charge was verified.",
      "    Test vs. live is NOT stored in the database: the mode comes from the key",
      "    prefix (sk_test_ / sk_live_) at runtime (src/lib/paystack.ts). Confirm by",
      "    matching paystack_transaction_id against your Paystack dashboard.",
      "  • status = 'successful' + verified_at set -> the wallet was actually credited.",
      "  • amount_subunits is pesewas; paystack_channel shows momo vs card.",
    ].join("\n"));
    console.log();
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection already gone */
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n✗ Query failed: ${message}\n`);
    if (/relation ".+" does not exist/i.test(message)) {
      console.error("  The table is missing — run `npx drizzle-kit push` to create the schema.");
    } else if (/column ".+" does not exist/i.test(message)) {
      console.error("  A column is missing — the database schema is older than this script expects.");
    } else if (/password|authentication|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(message)) {
      console.error("  Could not reach/authorise against the database. Check DATABASE_URL and network access.");
    }
    console.error();
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  // Never let a connection error dump the URL.
  console.error(`\n✗ Fatal: ${message.replace(/postgresql:\/\/[^\s'"]+/g, "postgresql://***")}\n`);
  process.exitCode = 1;
});
