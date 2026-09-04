/**
 * FlexiData comprehensive wallet audit (READ ONLY).
 *
 * This script intentionally reads DATABASE_URL only from the process environment.
 * It does not load .env files, print the URL, or call any application code that
 * can repair/migrate the schema or write data.
 *
 * Every database statement is either transaction control explicitly required for
 * a read-only transaction or a SELECT. PostgreSQL's SET TRANSACTION READ ONLY
 * is the final server-side safeguard against accidental writes.
 *
 * Usage from the flexiData directory:
 *   DATABASE_URL='provided-by-your-secure-secret-manager' \
 *     npx tsx scripts/report-wallet-audit.ts
 */
import { Pool, type QueryResult } from "pg";

const PROTECTED_REF = "DP-MTMZN2P8SSBR";
const PROTECTED_PAYSTACK_ID = "6525254338";
const PROTECTED_AMOUNT = 5;

const WALLET_SQL = `
SELECT id, user_id, balance, number, name, created_at
FROM wallets
WHERE id IN (
  SELECT wallet_id FROM deposit_requests WHERE ref = '${PROTECTED_REF}'
)
ORDER BY id
`;

const LEDGER_SQL = `
SELECT
  id, ref, wallet_id, type, status, direction, amount, title, subtitle,
  provider, provider_reference, provider_status, provider_message,
  charged_at, refunded_at, created_at
FROM transactions
WHERE wallet_id = $1
ORDER BY created_at ASC NULLS FIRST, id ASC
`;

const DEPOSITS_SQL = `
SELECT
  d.id AS deposit_request_id,
  d.ref AS deposit_reference,
  d.wallet_id,
  w.user_id,
  d.provider,
  d.method AS payment_method,
  d.amount,
  d.currency,
  d.status,
  d.provider_reference,
  d.paystack_transaction_id,
  d.paystack_channel,
  d.paystack_gateway_response,
  d.provider_payload,
  d.initiated_at,
  d.completed_at,
  d.paid_at,
  d.verified_at,
  d.created_at,
  t.id AS wallet_transaction_id,
  t.status AS wallet_transaction_status,
  t.direction AS wallet_transaction_direction,
  t.amount AS wallet_transaction_amount,
  t.type AS wallet_transaction_type,
  t.created_at AS wallet_transaction_created_at
FROM deposit_requests d
JOIN wallets w ON w.id = d.wallet_id
LEFT JOIN transactions t
  ON t.wallet_id = d.wallet_id
 AND t.ref = d.ref
WHERE d.wallet_id = $1
  AND d.provider = 'paystack'
  AND d.status = 'successful'
ORDER BY d.created_at ASC NULLS FIRST, d.id ASC
`;

const READ_ONLY_STATEMENTS = [WALLET_SQL, LEDGER_SQL, DEPOSITS_SQL];

function assertSelect(statement: string): void {
  const stripped = statement.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!/^select\b/i.test(stripped)) throw new Error("Refusing a non-SELECT audit statement");
  if (/\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|call|do)\b/i.test(stripped)) {
    throw new Error("Refusing an audit statement containing a write/DDL keyword");
  }
}

for (const statement of READ_ONLY_STATEMENTS) assertSelect(statement);

function money(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? Math.round(result * 100) / 100 : 0;
}

function amount(value: number): string {
  return `GH₵${value.toFixed(2)}`;
}

function iso(value: unknown): string {
  if (value == null) return "—";
  return value instanceof Date ? value.toISOString() : String(value);
}

function json(value: unknown): string {
  if (value == null) return "";
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function evidenceForMode(row: Record<string, unknown>): "LIVE" | "TEST" | "UNKNOWN" {
  if (
    String(row.deposit_reference) === PROTECTED_REF ||
    String(row.paystack_transaction_id ?? "") === PROTECTED_PAYSTACK_ID
  ) return "LIVE";

  const evidence = [
    row.paystack_gateway_response,
    row.provider_payload,
    row.provider_reference,
  ]
    .map(json)
    .join(" ")
    .toLowerCase();

  // This is evidence-based only. A normal Paystack ID/provider is not enough
  // to classify a transaction as test or live.
  if (/sk_test|test[_ -]?mode|mode["': =]+test|environment["': =]+test/.test(evidence)) return "TEST";
  if (/sk_live|live[_ -]?mode|mode["': =]+live|environment["': =]+live/.test(evidence)) return "LIVE";
  return "UNKNOWN";
}

type LedgerRow = Record<string, unknown> & { id: number; direction: string; status: string };
type Lot = { kind: "test" | "live" | "unknown"; remaining: number; ref: string; id: number };

function fifoAttribution(rows: LedgerRow[], depositRows: Record<string, unknown>[]) {
  const depositsByRef = new Map<string, "test" | "live" | "unknown">();
  for (const row of depositRows) {
    const classification = evidenceForMode(row);
    depositsByRef.set(String(row.deposit_reference), classification.toLowerCase() as "test" | "live" | "unknown");
  }

  const lots: Lot[] = [];
  for (const row of rows) {
    if (row.status !== "successful") continue;
    const value = money(row.amount);
    if (value <= 0) continue;
    if (row.direction === "in") {
      const kind = row.type === "deposit"
        ? (depositsByRef.get(String(row.ref)) ?? "unknown")
        : "unknown";
      lots.push({ kind, remaining: value, ref: String(row.ref), id: Number(row.id) });
    }
  }

  let testSpent = 0;
  let testRemaining = 0;
  let outgoingNotCovered = 0;
  const outgoing = rows.filter((row) => row.status === "successful" && row.direction === "out");
  for (const row of outgoing) {
    let toSpend = money(row.amount);
    while (toSpend > 0.005) {
      const lot = lots.find((candidate) => candidate.remaining > 0.005);
      if (!lot) {
        outgoingNotCovered += toSpend;
        break;
      }
      const used = Math.min(toSpend, lot.remaining);
      lot.remaining = Math.round((lot.remaining - used) * 100) / 100;
      toSpend = Math.round((toSpend - used) * 100) / 100;
      if (lot.kind === "test") testSpent += used;
    }
  }
  for (const lot of lots) if (lot.kind === "test") testRemaining += lot.remaining;
  return {
    testSpent: Math.round(testSpent * 100) / 100,
    testRemaining: Math.round(testRemaining * 100) / 100,
    outgoingNotCovered: Math.round(outgoingNotCovered * 100) / 100,
    attributionPolicy: "FIFO over successful incoming ledger lots; unknown/non-deposit inflows are retained as unknown lots",
  };
}

function printRows(title: string, rows: Record<string, unknown>[], columns: string[]): void {
  console.log(`\n${title} (${rows.length})`);
  if (!rows.length) return;
  console.table(rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))));
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not available in the process environment. No database query was attempted.");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    application_name: "flexidata-wallet-audit-read-only",
  });

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    console.log("FlexiData wallet audit (READ ONLY)");
    console.log("Database credentials are not printed.");

    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SET TRANSACTION READ ONLY");

    const protectedResult: QueryResult<Record<string, unknown>> = await client.query(
      "SELECT id, wallet_id, paystack_transaction_id, amount, status FROM deposit_requests WHERE ref = $1",
      [PROTECTED_REF],
    );
    const protectedWalletIds = [...new Set(protectedResult.rows.map((row) => Number(row.wallet_id)).filter(Number.isFinite))];
    if (protectedWalletIds.length !== 1) {
      console.log(`Protected reference ${PROTECTED_REF} did not identify exactly one wallet.`);
      console.log("No wallet-wide audit was selected; this is an audit discrepancy requiring review.");
      await client.query("COMMIT");
      transactionOpen = false;
      return;
    }

    const walletId = protectedWalletIds[0];
    const walletResult: QueryResult<Record<string, unknown>> = await client.query(WALLET_SQL);
    const wallet = walletResult.rows.find((row) => Number(row.id) === walletId);
    const ledgerResult: QueryResult<LedgerRow> = await client.query(LEDGER_SQL, [walletId]);
    const depositResult: QueryResult<Record<string, unknown>> = await client.query(DEPOSITS_SQL, [walletId]);

    const incoming = ledgerResult.rows.filter((row) => row.status === "successful" && row.direction === "in");
    const outgoing = ledgerResult.rows.filter((row) => row.status === "successful" && row.direction === "out");
    const failedOrReversed = ledgerResult.rows.filter((row) => row.status === "failed" || row.status === "reversed");
    const incomingTotal = incoming.reduce((sum, row) => sum + money(row.amount), 0);
    const outgoingTotal = outgoing.reduce((sum, row) => sum + money(row.amount), 0);
    const expected = Math.round((incomingTotal - outgoingTotal) * 100) / 100;
    const stored = money(wallet?.balance);
    const difference = Math.round((stored - expected) * 100) / 100;

    type DepositAuditRow = Record<string, unknown> & {
      classification: "LIVE" | "TEST" | "UNKNOWN";
      protected: boolean;
      credited_to_wallet: boolean;
    };
    const deposits: DepositAuditRow[] = depositResult.rows.map((row): DepositAuditRow => ({
      ...row,
      classification: evidenceForMode(row),
      protected: String(row.deposit_reference) === PROTECTED_REF || String(row.paystack_transaction_id ?? "") === PROTECTED_PAYSTACK_ID,
      credited_to_wallet: row.wallet_transaction_id != null && row.wallet_transaction_status === "successful" && row.wallet_transaction_direction === "in",
      gateway_response: row.paystack_gateway_response ?? "—",
      paid_at: iso(row.paid_at),
      verified_at: iso(row.verified_at),
    }));

    const confirmedTest = deposits.filter((row) => row.classification === "TEST" && row.credited_to_wallet);
    const confirmedLive = deposits.filter((row) => row.classification === "LIVE" && row.credited_to_wallet);
    const unknown = deposits.filter((row) => row.classification === "UNKNOWN");
    const testTotal = confirmedTest.reduce((sum, row) => sum + money(row["amount"]), 0);
    const liveTotal = confirmedLive.reduce((sum, row) => sum + money(row["amount"]), 0);
    const attribution = fifoAttribution(ledgerResult.rows, deposits);

    console.log(`\nWallet ID: ${walletId}`);
    console.log(`User ID: ${wallet?.user_id ?? "—"}`);
    console.log(`Stored wallet balance: ${amount(stored)}`);
    console.log(`Ledger incoming total: ${amount(incomingTotal)}`);
    console.log(`Ledger outgoing total: ${amount(outgoingTotal)}`);
    console.log(`Expected balance from successful ledger: ${amount(expected)}`);
    console.log(`Stored minus ledger difference: ${amount(difference)}`);
    console.log(`Successful incoming transactions: ${incoming.length}`);
    console.log(`Successful outgoing transactions: ${outgoing.length}`);
    console.log(`Failed/reversed transactions: ${failedOrReversed.length}`);

    printRows("All successful incoming wallet transactions", incoming, ["id", "ref", "type", "amount", "direction", "title", "provider", "created_at"]);
    printRows("All successful outgoing wallet transactions", outgoing, ["id", "ref", "type", "amount", "direction", "title", "provider", "created_at"]);
    printRows("Successful Paystack deposits", deposits, [
      "deposit_request_id", "wallet_transaction_id", "deposit_reference", "amount", "payment_method", "paystack_transaction_id",
      "provider", "status", "gateway_response", "paid_at", "verified_at", "classification", "protected", "credited_to_wallet",
    ]);

    console.log("\nPaystack deposit totals");
    console.log(`Confirmed LIVE credited: ${amount(liveTotal)}`);
    console.log(`Confirmed TEST/DEMO credited: ${amount(testTotal)}`);
    console.log(`UNKNOWN deposits: ${unknown.length}`);
    console.log(`Test credits already spent (FIFO attribution): ${amount(attribution.testSpent)}`);
    console.log(`Test credit remaining (FIFO attribution): ${amount(attribution.testRemaining)}`);
    console.log(`Successful outgoing not covered by recorded incoming lots: ${amount(attribution.outgoingNotCovered)}`);
    console.log(`Attribution policy: ${attribution.attributionPolicy}`);

    console.log("\nProtected transaction assertion");
    const protectedRows = deposits.filter((row) => row.protected);
    console.log(`Reference ${PROTECTED_REF}: ${protectedRows.length === 1 ? "present and excluded from cleanup" : "NOT uniquely present — REVIEW REQUIRED"}`);
    console.log(`Paystack ID ${PROTECTED_PAYSTACK_ID}: ${protectedRows.some((row) => String(row["paystack_transaction_id"]) === PROTECTED_PAYSTACK_ID) ? "present and excluded from cleanup" : "NOT found — REVIEW REQUIRED"}`);
    console.log(`Protected amount check: ${protectedRows.some((row) => money(row["amount"]) === PROTECTED_AMOUNT) ? "GH₵5.00" : "MISMATCH — REVIEW REQUIRED"}`);

    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be gone */ }
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Audit failed: ${message}`);
  process.exitCode = 1;
});
