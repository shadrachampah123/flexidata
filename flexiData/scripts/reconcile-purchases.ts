/**
 * Operator-only CLI for durable data-purchase reconciliation. No HTTP exposure,
 * no scheduling, no purchase submission. Exit codes:
 *   0  success (for --check: nothing needs attention)
 *   1  error (configuration, database, or settlement failure; details withheld)
 *   2  --check only: one or more attention categories are present
 *
 * Usage (from flexiData/, with the server DATABASE_URL exported explicitly):
 *   npm run reconcile:purchases -- --report   read-only: summary + up to 500 rows
 *   npm run reconcile:purchases -- --check    read-only: monitoring exit code
 *   npm run reconcile:purchases -- --poll     bounded sandbox status reads only
 *
 * See docs/part-6.4-production-readiness.md for ownership, cadence and recovery.
 */
process.env.DATABASE_URL ||= "";

const MODES = ["--report", "--check", "--poll"] as const;

async function main(): Promise<number> {
  const modes = MODES.filter(mode => process.argv.includes(mode));
  if (modes.length !== 1 || process.argv.length !== 3) {
    console.error("Use exactly one of --report (read only), --check (read only, monitoring exit code) or --poll (bounded sandbox status reads only).");
    return 1;
  }
  const { PurchaseLifecycle, reconcileAttention } = await import("../src/lib/purchase-lifecycle");
  const lifecycle = new PurchaseLifecycle();

  if (modes[0] === "--report") {
    const summary = await lifecycle.reportSummary();
    console.log(JSON.stringify({ summary, rows: await lifecycle.report() }, null, 2));
    return 0;
  }

  if (modes[0] === "--check") {
    const summary = await lifecycle.reportSummary();
    const attention = reconcileAttention(summary);
    console.log(JSON.stringify({ status: attention.length ? "attention" : "ok", attention, summary }, null, 2));
    return attention.length ? 2 : 0;
  }

  // --poll: the default lookup refuses (before claiming anything) unless sandbox
  // test configuration is present and the runtime is not production.
  const claimed = await lifecycle.reconcile();
  console.log(`Status reads claimed: ${claimed}`);
  console.log(JSON.stringify({ summary: await lifecycle.reportSummary() }, null, 2));
  return 0;
}

main().then(
  code => { process.exitCode = code; },
  error => {
    // Never print the error object: driver/provider messages may contain configuration.
    const name = error instanceof Error ? error.name : "Error";
    console.error(`Purchase reconciliation failed (${name}); inspect database/configuration. No submission was retried and no refund was issued.`);
    process.exitCode = 1;
  },
);
