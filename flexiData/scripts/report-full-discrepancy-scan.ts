/**
 * READ-ONLY full wallet discrepancy scan for production demo cleanup.
 *
 * Purpose: List EVERY wallet where stored balance != ledger-derived balance,
 *          with breakdown of Paystack deposits vs other movements,
 *          so we can identify ALL wallets that still carry demo balance
 *          like Wallet #4's GH₵52.50.
 *
 * Safety:
 *  - SET TRANSACTION READ ONLY — PostgreSQL rejects any write
 *  - SELECT only — verified before execution
 *  - Never prints DATABASE_URL, only host
 *  - Preserves Paystack: explicitly counts provider='paystack' successful rows
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/report-full-discrepancy-scan.ts
 *   npx tsx scripts/report-full-discrepancy-scan.ts --wallet 4  (single wallet)
 */

import { Pool } from "pg";

const args = process.argv.slice(2);
const walletFilter = (() => {
  const idx = args.indexOf("--wallet");
  if (idx >= 0 && args[idx + 1]) {
    const v = Number(args[idx + 1]);
    if (Number.isInteger(v) && v > 0) return v;
  }
  return null;
})();

function describeTarget(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.hostname}:${u.port || "5432"}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "(unparseable)";
  }
}

function money(n: unknown): number {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL not set — cannot scan. This is expected in the sandbox.");
    console.error("The exact SQL that WILL be run in production is printed below for review.");
    console.log(`
-- FULL DISCREPANCY SCAN (READ-ONLY)
WITH ledger AS (
  SELECT
    t.wallet_id,
    COALESCE(SUM(t.amount) FILTER (WHERE t.direction='in' AND t.status='successful'),0) AS incoming,
    COALESCE(SUM(t.amount) FILTER (WHERE t.direction='out' AND t.status='successful'),0) AS outgoing,
    COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END) FILTER (WHERE t.status='successful'),0) AS ledger_balance,
    COUNT(*) FILTER (WHERE t.status='successful') AS tx_count
  FROM transactions t
  GROUP BY t.wallet_id
),
paystack AS (
  SELECT
    d.wallet_id,
    COUNT(*) FILTER (WHERE d.provider='paystack' AND d.status='successful') AS paystack_deposit_count,
    COALESCE(SUM(d.amount) FILTER (WHERE d.provider='paystack' AND d.status='successful'),0) AS paystack_deposit_total
  FROM deposit_requests d
  GROUP BY d.wallet_id
),
mock AS (
  SELECT
    d.wallet_id,
    COUNT(*) FILTER (WHERE d.provider != 'paystack' AND d.status='successful') AS mock_deposit_count,
    COALESCE(SUM(d.amount) FILTER (WHERE d.provider != 'paystack' AND d.status='successful'),0) AS mock_deposit_total
  FROM deposit_requests d
  GROUP BY d.wallet_id
)
SELECT
  w.id AS wallet_id,
  w.number AS wallet_number,
  w.user_id,
  w.balance AS stored_balance,
  COALESCE(l.ledger_balance,0) AS ledger_balance,
  (w.balance - COALESCE(l.ledger_balance,0)) AS difference,
  COALESCE(l.incoming,0) AS ledger_incoming,
  COALESCE(l.outgoing,0) AS ledger_outgoing,
  COALESCE(p.paystack_deposit_total,0) AS paystack_total,
  COALESCE(p.paystack_deposit_count,0) AS paystack_count,
  COALESCE(m.mock_deposit_total,0) AS mock_total,
  COALESCE(m.mock_deposit_count,0) AS mock_count,
  w.created_at
FROM wallets w
LEFT JOIN ledger l ON l.wallet_id = w.id
LEFT JOIN paystack p ON p.wallet_id = w.id
LEFT JOIN mock m ON m.wallet_id = w.id
WHERE ABS(w.balance - COALESCE(l.ledger_balance,0)) > 0.005
${walletFilter ? `AND w.id = ${walletFilter}` : ""}
ORDER BY ABS(w.balance - COALESCE(l.ledger_balance,0)) DESC;
`);
    console.log("\n-- For Wallet #4 specifically, with provided numbers:");
    console.log("-- Stored: 1268.00, Ledger: 1215.50 (1325.00 Paystack - 109.50 data), Demo: 52.50");
    console.log("-- Intended fix: UPDATE wallets SET balance='1215.50' WHERE id=4 AND balance='1268.00';");
    console.log("\n-- Resulting balances table (based on provided data only):");
    console.log("| Wallet | Before | Ledger Legit | Demo | After | Paystack Preserved |");
    console.log("| 4 | 1268.00 | 1215.50 | 52.50 | 1215.50 | Yes 1325.00 |");
    process.exitCode = 0;
    return;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: "flexidata-full-discrepancy-scan-readonly",
  });
  const client = await pool.connect();
  try {
    console.log(`FlexiData full discrepancy scan — Target: ${describeTarget(databaseUrl)}`);
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");

    const fullScanSQL = `
WITH ledger AS (
  SELECT
    t.wallet_id,
    COALESCE(SUM(t.amount) FILTER (WHERE t.direction='in' AND t.status='successful'),0) AS incoming,
    COALESCE(SUM(t.amount) FILTER (WHERE t.direction='out' AND t.status='successful'),0) AS outgoing,
    COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END) FILTER (WHERE t.status='successful'),0) AS ledger_balance
  FROM transactions t
  GROUP BY t.wallet_id
),
paystack AS (
  SELECT
    d.wallet_id,
    COUNT(*) FILTER (WHERE d.provider='paystack' AND d.status='successful') AS paystack_deposit_count,
    COALESCE(SUM(d.amount) FILTER (WHERE d.provider='paystack' AND d.status='successful'),0) AS paystack_deposit_total
  FROM deposit_requests d
  GROUP BY d.wallet_id
),
mock AS (
  SELECT
    d.wallet_id,
    COUNT(*) FILTER (WHERE d.provider != 'paystack' AND d.status='successful') AS mock_deposit_count,
    COALESCE(SUM(d.amount) FILTER (WHERE d.provider != 'paystack' AND d.status='successful'),0) AS mock_deposit_total
  FROM deposit_requests d
  GROUP BY d.wallet_id
)
SELECT
  w.id AS wallet_id,
  w.number AS wallet_number,
  w.user_id,
  w.balance,
  COALESCE(l.ledger_balance,0) AS ledger_balance,
  (w.balance - COALESCE(l.ledger_balance,0)) AS difference,
  COALESCE(l.incoming,0) AS ledger_incoming,
  COALESCE(l.outgoing,0) AS ledger_outgoing,
  COALESCE(p.paystack_deposit_total,0) AS paystack_total,
  COALESCE(p.paystack_deposit_count,0) AS paystack_count,
  COALESCE(m.mock_deposit_total,0) AS mock_total,
  COALESCE(m.mock_deposit_count,0) AS mock_count
FROM wallets w
LEFT JOIN ledger l ON l.wallet_id = w.id
LEFT JOIN paystack p ON p.wallet_id = w.id
LEFT JOIN mock m ON m.wallet_id = w.id
WHERE ABS(w.balance - COALESCE(l.ledger_balance,0)) > 0.005
${walletFilter ? `AND w.id = $1` : ""}
ORDER BY ABS(w.balance - COALESCE(l.ledger_balance,0)) DESC
`;

    const result = walletFilter
      ? await client.query(fullScanSQL, [walletFilter])
      : await client.query(fullScanSQL);

    console.log(`\nFound ${result.rows.length} wallet(s) with discrepancy > GH₵0.005`);
    if (result.rows.length === 0) {
      console.log("No discrepancies — all wallets match ledger.");
    } else {
      console.table(result.rows.map(r => ({
        wallet_id: r.wallet_id,
        stored: money(r.balance).toFixed(2),
        ledger: money(r.ledger_balance).toFixed(2),
        diff: money(r.difference).toFixed(2),
        paystack_total: money(r.paystack_total).toFixed(2),
        mock_total: money(r.mock_total).toFixed(2),
        incoming: money(r.ledger_incoming).toFixed(2),
        outgoing: money(r.ledger_outgoing).toFixed(2),
      })));

      console.log("\nIntended fixes (READ-ONLY preview):");
      for (const row of result.rows) {
        const stored = money(row.balance);
        const ledger = money(row.ledger_balance);
        const diff = money(row.difference);
        if (diff > 0.005) {
          console.log(`Wallet #${row.wallet_id}: ${stored.toFixed(2)} -> ${ledger.toFixed(2)} (remove ${diff.toFixed(2)} demo)`);
          console.log(`  SQL: UPDATE wallets SET balance = '${ledger.toFixed(2)}' WHERE id = ${row.wallet_id} AND balance = '${stored.toFixed(2)}';`);
        } else {
          console.log(`Wallet #${row.wallet_id}: stored ${stored.toFixed(2)} < ledger ${ledger.toFixed(2)} diff ${diff.toFixed(2)} — negative diff, requires investigation, NOT auto-corrected`);
        }
      }
    }

    // Detail for wallet 4 if requested or if it is in results
    const wallet4 = walletFilter === 4 || result.rows.some(r => Number(r.wallet_id) === 4) ? 4 : null;
    if (wallet4) {
      console.log("\n--- Wallet #4 detailed ledger ---");
      const ledgerRows = await client.query(
        `SELECT id, ref, type, status, direction, amount, provider, provider_reference, created_at
         FROM transactions WHERE wallet_id = $1 AND status='successful' ORDER BY created_at ASC`,
        [4]
      );
      console.table(ledgerRows.rows);
      const paystackRows = await client.query(
        `SELECT id, ref, provider, amount, status, paystack_transaction_id FROM deposit_requests WHERE wallet_id=$1 AND provider='paystack' AND status='successful' ORDER BY created_at ASC`,
        [4]
      );
      console.table(paystackRows.rows);
    }

    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error("Scan failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
