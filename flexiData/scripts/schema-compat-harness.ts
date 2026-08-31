/**
 * Verification harness for the data-gateway schema compatibility fallbacks.
 *
 * Scenarios (SCENARIO env var):
 *   current    — database already migrated for the data gateway
 *   legacy     — database without the gateway objects (the failure this fix targets)
 *   probedown  — legacy database whose catalog cannot be read (reactive fallback)
 *   strict     — legacy database with DATA_API_SCHEMA_FALLBACKS=false (kill switch)
 *   heal       — legacy database that is migrated mid-process (self-healing)
 *
 * Run with: npm run verify:schema-compat   (all scenarios), or
 *           SCENARIO=legacy npx tsx scripts/schema-compat-harness.ts
 */
import { BASE_TX, GATEWAY_TX, BASE_PLANS, FLOAT_COLS, installSim } from "./schema-sim";

const SCENARIOS = ["legacy", "current", "probedown", "strict", "heal"];

function runAllScenarios() {
  const { spawnSync } = require("node:child_process");
  let failures = 0;
  for (const name of SCENARIOS) {
    console.log(`\n───────── SCENARIO=${name} ─────────`);
    const run = spawnSync("npx", ["tsx", __filename], {
      env: { ...process.env, SCENARIO: name },
      stdio: "inherit",
    });
    if (run.status !== 0) failures += 1;
  }
  console.log(`\n${SCENARIOS.length - failures}/${SCENARIOS.length} scenarios green`);
  process.exitCode = failures > 0 ? 1 : 0;
}

const scenario = process.env.SCENARIO ?? "all";
const strictMode = scenario === "strict";
const healMode = scenario === "heal";
const migrated = scenario === "current";
const breakCatalog = scenario === "probedown";

const { pool: getPool, schema } = installSim({ migrated, breakCatalog });

const results: { name: string; ok: boolean; detail?: unknown }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail });
}

function jsonRequest(url: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main() {
  const { ensureSeeded } = require("@/lib/seed");
  const {
    getSchemaCapabilities,
    describeSchemaCompatibility,
    resetSchemaCapabilitiesCache,
  } = require("@/lib/schema-compat");
  const { getAllTransactions, getPlans } = require("@/lib/data");
  const purchaseRoute = require("@/app/api/purchase/route");
  const callbackRoute = require("@/app/api/purchase/callback/route");
  const healthRoute = require("@/app/api/health/route");

  const pool = getPool();

  if (strictMode) {
    // Seed with the fallbacks on so demo data exists, then flip the kill
    // switch: with DATA_API_SCHEMA_FALLBACKS=false the app must refuse to
    // degrade quietly rather than writing a partial row.
    await ensureSeeded();
    const rowsBefore = pool.captured.filter((c) => c.kind === "insert" && c.table === "transactions").length;
    process.env.DATA_API_SCHEMA_FALLBACKS = "false";
    resetSchemaCapabilitiesCache();

    // Strict mode only disables the *degradation*; the narrow UI reads the fix
    // uses are schema-agnostic and must keep working.
    let strictPlans: unknown[] | null = null;
    let strictReadError: unknown = null;
    try {
      strictPlans = await getPlans();
    } catch (error) {
      strictReadError = error;
    }
    check("strict: narrow UI reads unaffected", strictPlans !== null && (strictPlans as unknown[]).length === 34, String(strictReadError ?? (strictPlans as unknown[])?.length));

    const strictPurchase = await purchaseRoute.POST(
      jsonRequest("/api/purchase", { kind: "data", network: "MTN", category: "up2u", planLabel: "1GB", recipient: "0244123456" }),
    );
    const strictBody = await strictPurchase.json();
    check("strict: purchase errors instead of degrading", strictPurchase.status === 500 && strictBody.ok === false, {
      status: strictPurchase.status,
      body: strictBody,
    });
    const rowsAfter = pool.captured.filter((c) => c.kind === "insert" && c.table === "transactions").length;
    check("strict: no degraded ledger row written", rowsAfter === rowsBefore, { rowsBefore, rowsAfter });

    const strictHealth = await (await healthRoute.GET()).json();
    check(
      "strict: health still reports the drift",
      strictHealth.gatewaySchema === "legacy" && strictHealth.dataGateway.fallbacks === "disabled",
      strictHealth.dataGateway ?? strictHealth,
    );

    const strictFailed = results.filter((r) => !r.ok);
    console.log(`\nSCENARIO=${scenario}  checks=${results.length}  failed=${strictFailed.length}`);
    for (const r of results) console.log(`${r.ok ? "  PASS" : "  FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.detail)}`}`);
    if (strictFailed.length > 0) process.exitCode = 1;
    return;
  }

  // 1. Seeding must never explode on an unmigrated database.
  let seedError: unknown = null;
  try {
    await ensureSeeded();
  } catch (error) {
    seedError = error;
  }
  check("seed completes", seedError === null, seedError instanceof Error ? `${seedError.message} :: ${String((seedError as any).cause ?? "")}` : String(seedError ?? ""));
  check("bundle plans seeded", pool.rows.bundle_plans.length === 34, pool.rows.bundle_plans.length);
  check("transactions seeded", pool.rows.transactions.length === 11, pool.rows.transactions.length);

  const caps = await getSchemaCapabilities();
  if (migrated) {
    check("float ledger seeded", pool.rows.provider_float_balances.length === 2, pool.rows.provider_float_balances.length);
    const seeded = pool.rows.transactions[0] ?? {};
    check("gateway columns persisted", seeded.fulfillment_status != null && "provider" in seeded, seeded.fulfillment_status);
    check("caps: float table present", caps.floatTable === true, caps.floatTable);
    check("caps: schema not drifted", caps.drifted === false, caps.drifted);
  } else {
    const seeded = pool.rows.transactions[0] ?? {};
    check(
      "gateway columns skipped on legacy",
      !("fulfillment_status" in seeded) && !("provider" in seeded) && seeded.ref != null,
      Object.keys(seeded),
    );
    check(
      "float rows not attempted",
      pool.captured.every((c) => c.table !== "provider_float_balances"),
      pool.captured.filter((c) => c.table === "provider_float_balances"),
    );
    if (breakCatalog) {
      check("caps: recovered via error-driven downgrade", caps.floatTable === false && caps.transactions.size === 0, {
        probed: caps.probed,
        floatTable: caps.floatTable,
        tx: [...caps.transactions],
      });
    } else {
      check("caps: legacy detected by probe", caps.probed === true && caps.drifted === true, { probed: caps.probed, drifted: caps.drifted });
    }
  }

  // 2. Reads that the mobile UI depends on.
  let plansError: unknown = null;
  let plans: any[] = [];
  try {
    plans = await getPlans();
  } catch (error) {
    plansError = error;
  }
  check("getPlans ok", plansError === null, String(plansError ?? ""));
  check("plans readable", plans.length === 34, plans.length);
  let historyError: unknown = null;
  let history: any[] = [];
  try {
    history = await getAllTransactions();
  } catch (error) {
    historyError = error;
  }
  check("history ok", historyError === null, String(historyError ?? ""));
  check("history readable", history.length === 11 && Boolean(history[0].date), history.length);

  // 3. Purchase through the gateway, then the ledger write.
  const purchaseResponse = await purchaseRoute.POST(
    jsonRequest("/api/purchase", {
      kind: "data",
      network: "MTN",
      category: "up2u",
      planLabel: "1GB",
      recipient: "0244123456",
    }),
  );
  const purchase = await purchaseResponse.json();
  check("purchase returns 200", purchaseResponse.status === 200, purchase);
  check("purchase ok", purchase.ok === true, purchase);
  const dataWrites = pool.captured.filter((c) => c.kind === "insert" && c.table === "transactions");
  const lastWrite = dataWrites[dataWrites.length - 1] ?? { kind: "none", table: "none", columns: [] };
  check("purchase recorded a transaction", pool.rows.transactions.length === 12, pool.rows.transactions.length);
  if (migrated) {
    check(
      "purchase persisted provider fields",
      lastWrite.columns.includes("provider_reference") && lastWrite.columns.includes("fulfillment_status"),
      lastWrite.columns,
    );
    const txRow = pool.rows.transactions[11];
    check("provider reference stored", typeof txRow.provider_reference === "string" && txRow.provider_reference.startsWith("mock-"), txRow.provider_reference);
  } else {
    check(
      "purchase skipped missing columns instead of failing",
      !lastWrite.columns.includes("provider_reference") && !lastWrite.columns.includes("fulfillment_status") && lastWrite.columns.includes("ref"),
      lastWrite.columns,
    );
  }

  // 4. Async provider callback, including a refund status.
  const ref = purchase.ref as string;
  const callbackResponse = await callbackRoute.POST(
    jsonRequest("/api/purchase/callback", {
      clientReference: ref,
      status: "reversed",
      message: "Operator reversed the bundle",
      floatBalance: 2400,
    }),
  );
  const callback = await callbackResponse.json();
  check("callback returns 200", callbackResponse.status === 200, callback);
  check("callback reconciled", callback.ok === true && callback.status === "reversed", callback);

  const updates = pool.captured.filter((c) => c.kind === "update" && c.table === "transactions");
  const lastUpdate = updates[updates.length - 1] ?? { kind: "none", table: "none", columns: [] };
  const stored = (pool.rows.transactions.find((r) => r.ref === ref) ?? { ref: "MISSING" }) as any;
  if (migrated) {
    check(
      "callback wrote provider columns",
      lastUpdate.columns.includes("provider_message") && lastUpdate.columns.includes("fulfillment_status"),
      lastUpdate.columns,
    );
    check("reversed status preserved", stored.status === "reversed", stored.status);
    check("refund recorded", stored.refunded_at != null, stored.refunded_at);
    const float = pool.rows.provider_float_balances[0];
    check("float synced from callback", float?.available_balance === "2400.00", float?.available_balance);
  } else {
    check(
      "callback skipped missing columns",
      !lastUpdate.columns.includes("provider_message") && !lastUpdate.columns.includes("refunded_at"),
      lastUpdate.columns,
    );
    check("reversed coerced to a value the legacy enum accepts", stored.status === "failed", stored.status);
    // status is coerced for the enum, but the customer-facing subtitle still
    // describes the real outcome (a refund), so it must have been rewritten.
    check("subtitle still updated", String(stored.subtitle).includes("Refunded"), stored.subtitle);
  }

  // 4b. Every other ledger writer must survive the same drift.
  for (const [name, mod, body] of [
    ["wallet/fund", "@/app/api/wallet/fund/route", { method: "momo_mtn", amount: 50 }],
    ["wallet/transfer", "@/app/api/wallet/transfer/route", { account: "0532118329", amount: 10 }],
    ["convert", "@/app/api/convert/route", { network: "MTN", phone: "0244123456", amount: 20 }],
    ["rewards/redeem", "@/app/api/rewards/redeem/route", { optionId: "air5" }],
    ["schedule", "@/app/api/schedule/route", { network: "MTN", planLabel: "1GB", price: 4.5, recipient: "0273456789", dayOfMonth: 5 }],
  ] as [string, string, Record<string, unknown>][]) {
    let outcome: unknown;
    try {
      const response = await require(mod).POST(jsonRequest(`/api/${name}`, body));
      outcome = { status: response.status, body: await response.json() };
    } catch (error) {
      outcome = { thrown: String(error) };
    }
    check(`${name} survives the schema`, (outcome as any).status === 200, outcome);
  }

  // 5. Wallet debit/credit path survived the fallbacks.
  const wallet = pool.rows.wallets[0] ?? {};
  check("wallet balance is numeric", Number.isFinite(Number(wallet.balance)), wallet.balance);

  // 6. Health reports the drift so operators know to migrate.
  const health = await (await healthRoute.GET()).json();
  const report = await describeSchemaCompatibility();
  if (migrated) {
    check("health: schema current", health.gatewaySchema === "current", health);
  } else {
    check("health: schema legacy", health.gatewaySchema === "legacy", health);
    check("health: lists missing objects", report.missing.includes("provider_float_balances"), report.missing);
    check("health: app still ok", health.ok === true, health.ok);
  }
  if (breakCatalog) {
    check("health: unknown schema when probe blocked", report.status === "legacy" || report.status === "unknown", report.status);
  }

  if (healMode) {
    // The operator now runs `npx drizzle-kit push`; the cached view of the
    // schema must expire and full gateway tracking resume without a redeploy.
    schema.tables.transactions.push(...GATEWAY_TX);
    schema.tables.bundle_plans.push("provider_product_code");
    schema.tables.provider_float_balances.push(...FLOAT_COLS);
    schema.enums.tx_status.push("reversed");
    schema.enums.fulfillment_status = ["queued", "submitted", "processing", "delivered", "failed", "refunded"];
    (require("@/lib/schema-compat") as any).resetSchemaCapabilitiesCache();

    const healed = await purchaseRoute.POST(
      jsonRequest("/api/purchase", { kind: "data", network: "MTN", category: "sme", planLabel: "1GB", recipient: "0273456789" }),
    );
    const healedBody = await healed.json();
    check("post-migration purchase ok", healed.status === 200 && healedBody.ok === true, healedBody);
    const healedWrites = pool.captured.filter((c) => c.kind === "insert" && c.table === "transactions");
    const healedColumns = healedWrites[healedWrites.length - 1]?.columns ?? [];
    check(
      "gateway columns resume after drizzle-kit push",
      healedColumns.includes("provider_reference") && healedColumns.includes("fulfillment_status"),
      healedColumns,
    );
    const healedHealth = await (await healthRoute.GET()).json();
    check("post-migration health is current", healedHealth.gatewaySchema === "current", healedHealth.dataGateway ?? healedHealth);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSCENARIO=${scenario}  checks=${results.length}  failed=${failed.length}`);
  for (const r of results) {
    console.log(`${r.ok ? "  PASS" : "  FAIL"}  ${r.name}${r.ok ? "" : `  -> ${JSON.stringify(r.detail)}`}`);
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

if (scenario === "all") {
  runAllScenarios();
} else {
  main().catch((error) => {
    console.error(`SCENARIO=${scenario} harness crashed:`, error);
    process.exitCode = 2;
  });
}
