/** Operator-only CLI, no HTTP exposure or automatic scheduling. */
process.env.DATABASE_URL ||= "";
async function main() {
  if (!process.argv.includes("--report") && !process.argv.includes("--poll")) {
    throw new Error("Use --report (read only) or --poll (bounded sandbox status reads only)");
  }
  const { PurchaseLifecycle } = await import("../src/lib/purchase-lifecycle");
  const lifecycle = new PurchaseLifecycle();
  if (process.argv.includes("--poll")) console.log("Status reads claimed:", await lifecycle.reconcile());
  console.log(JSON.stringify(await lifecycle.report(), null, 2));
}
main().catch(() => { console.error("Purchase reconciliation failed; inspect database/configuration. No submission was retried."); process.exitCode = 1; });
