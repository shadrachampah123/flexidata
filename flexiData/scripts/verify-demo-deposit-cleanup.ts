/**
 * Automated proof for the demo-deposit cleanup tool (no real database needed).
 *
 * Drives `scripts/cleanup-demo-deposits.ts` against the in-memory schema
 * simulator (`scripts/schema-sim.ts`), proving that the tool:
 *
 *   - discovers every demo/mock wallet credit (modern `deposit_requests`
 *     provider=mock AND legacy ledger-only deposits) and none of the real
 *     Paystack deposits;
 *   - is a pure review (dry run) until `applyCleanup` is called — zero writes
 *     before apply;
 *   - reverses the wallet credit with SQL arithmetic (GREATEST-clamped, never
 *     an absolute write, never below zero) and reports the shortfall when the
 *     balance has since been spent;
 *   - parks demo `deposit_requests` rows as `failed` and marks demo ledger rows
 *     `reversed` (or `failed` on a pre-gateway `tx_status` enum);
 *   - NEVER touches real Paystack deposits, transfers (withdrawals),
 *     conversions (airtime→cash), data/airtime purchases, redemptions or
 *     referral rewards;
 *   - is idempotent (a second run finds nothing left to reverse);
 *   - refuses (classifies) production / remote database targets.
 *
 * Run with: npm run verify:demo-deposit-cleanup
 */
import { spawnSync } from "node:child_process";
import { installSim } from "./schema-sim";

const env = process.env as unknown as Record<string, string | undefined>;

const checks: { name: string; ok: boolean; detail: unknown }[] = [];
function check(name: string, ok: boolean, detail: unknown = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  — ${JSON.stringify(detail)}`}`);
}

function runAllScenarios() {
  let failures = 0;
  for (const scenario of ["current", "legacy"]) {
    console.log(`\n───────── SCENARIO=${scenario} ─────────`);
    const run = spawnSync("npx", ["tsx", __filename], {
      env: { ...process.env, SCENARIO: scenario },
      stdio: "inherit",
    });
    if (run.status !== 0) failures += 1;
  }
  console.log(`\n${2 - failures}/2 scenarios green`);
  process.exitCode = failures > 0 ? 1 : 0;
}

const D = (offsetMinutes = 0) => new Date(Date.now() - offsetMinutes * 60_000);

/** A fully-populated (migrated) transactions row; omit gateway fields in legacy mode. */
function txRow(overrides: Record<string, unknown>, migrated: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: overrides.id,
    ref: overrides.ref,
    wallet_id: overrides.wallet_id,
    type: overrides.type ?? "deposit",
    status: overrides.status ?? "successful",
    direction: overrides.direction ?? "in",
    title: overrides.title ?? "Wallet Top-up",
    subtitle: overrides.subtitle ?? "",
    amount: overrides.amount ?? "0.00",
    points: overrides.points ?? 0,
    network: overrides.network ?? null,
    recipient: overrides.recipient ?? null,
    created_at: overrides.created_at ?? D(),
  };
  if (!migrated) return base;
  return {
    ...base,
    fulfillment_status: overrides.fulfillment_status ?? "queued",
    provider: overrides.provider ?? null,
    provider_product_code: overrides.provider_product_code ?? null,
    provider_reference: overrides.provider_reference ?? null,
    provider_status: overrides.provider_status ?? null,
    provider_message: overrides.provider_message ?? null,
    fulfillment_attempts: overrides.fulfillment_attempts ?? 0,
    charged_at: overrides.charged_at ?? null,
    fulfilled_at: overrides.fulfilled_at ?? null,
    refunded_at: overrides.refunded_at ?? null,
    last_provider_sync_at: overrides.last_provider_sync_at ?? null,
    provider_payload: overrides.provider_payload ?? null,
    provider_response: overrides.provider_response ?? null,
  };
}

/** A fully-populated deposit_requests row. */
function depositRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: overrides.id,
    ref: overrides.ref,
    wallet_id: overrides.wallet_id,
    provider: overrides.provider ?? "mock",
    method: overrides.method ?? "momo_mtn",
    amount: overrides.amount ?? "0.00",
    amount_subunits: overrides.amount_subunits ?? 0,
    currency: overrides.currency ?? "GHS",
    status: overrides.status ?? "pending",
    provider_reference: overrides.provider_reference ?? null,
    paystack_transaction_id: overrides.paystack_transaction_id ?? null,
    paystack_channel: overrides.paystack_channel ?? null,
    paystack_gateway_response: overrides.paystack_gateway_response ?? null,
    initiated_at: overrides.initiated_at ?? D(),
    completed_at: overrides.completed_at ?? null,
    paid_at: overrides.paid_at ?? null,
    verified_at: overrides.verified_at ?? null,
    provider_payload: overrides.provider_payload ?? null,
    created_at: overrides.created_at ?? D(),
    updated_at: overrides.updated_at ?? D(),
  };
}

function walletRow(id: number, number: string, balance: string): Record<string, unknown> {
  return {
    id,
    user_id: id,
    name: `Wallet ${id}`,
    number,
    balance,
    points: 0,
    is_agent: false,
    agent_tier: null,
    referral_code: null,
    created_at: D(),
  };
}

async function main() {
  const migrated = process.env.SCENARIO !== "legacy";
  const { pool } = installSim({ migrated });

  // Load the cleanup tool only AFTER installSim has swapped pg.Pool, so `@/db`
  // binds to the in-memory pool (same pattern as verify-seed-resilience).
  const cleanup = require("./cleanup-demo-deposits") as typeof import("./cleanup-demo-deposits");
  const { resetSchemaCapabilitiesCache } = require("@/lib/schema-compat") as typeof import("@/lib/schema-compat");
  resetSchemaCapabilitiesCache();

  // --- Target classification / production guard -----------------------------
  const neon = cleanup.classifyTarget(
    "postgresql://user:pass@ep-xyz-abc.us-east-2.aws.neon.tech/neondb?sslmode=require",
  );
  check(
    "guard: a Neon (managed) database host is classified as production and refused by default",
    neon.requiresAcknowledgement === true && /neon\.tech/.test(neon.host),
    neon,
  );
  const local = cleanup.classifyTarget("postgresql://postgres:postgres@127.0.0.1:5432/app_db");
  check(
    "guard: a localhost database is classified as local (no acknowledgement needed)",
    local.isLocal === true && local.requiresAcknowledgement === false,
    local,
  );
  const prevNodeEnv = env.NODE_ENV;
  env.NODE_ENV = "production";
  const prodRuntime = cleanup.classifyTarget("postgresql://postgres:postgres@127.0.0.1:5432/app_db");
  if (prevNodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = prevNodeEnv;
  check(
    "guard: NODE_ENV=production requires acknowledgement even for a localhost target",
    prodRuntime.requiresAcknowledgement === true && prodRuntime.reasons.includes("NODE_ENV=production"),
    prodRuntime,
  );

  // --- Seed demo + real data -------------------------------------------------
  pool().rows.wallets.push(
    walletRow(1, "0244123456", "100.00"),
    walletRow(2, "0501234567", "10.00"),
    walletRow(3, "0556789012", "0.00"),
    walletRow(4, "0273456789", "500.00"),
  );

  pool().rows.deposit_requests.push(
    depositRow({ id: 1, ref: "DP-DEMO-1", wallet_id: 1, provider: "mock", amount: "50.00", amount_subunits: 5000, status: "successful" }),
    depositRow({ id: 2, ref: "DP-DEMO-2", wallet_id: 1, provider: "mock", amount: "20.00", amount_subunits: 2000, status: "successful" }),
    depositRow({ id: 3, ref: "DP-PAY-1", wallet_id: 4, provider: "paystack", amount: "100.00", amount_subunits: 10000, status: "successful", paystack_transaction_id: "ps-1" }),
    depositRow({ id: 4, ref: "DP-DEMO-3", wallet_id: 2, provider: "mock", amount: "25.00", amount_subunits: 2500, status: "successful" }),
    depositRow({ id: 5, ref: "DP-DEMO-4", wallet_id: 3, provider: "mock", amount: "30.00", amount_subunits: 3000, status: "successful" }),
    depositRow({ id: 6, ref: "DP-DEMO-PENDING", wallet_id: 1, provider: "mock", amount: "15.00", amount_subunits: 1500, status: "pending" }),
  );

  const tx = (o: Record<string, unknown>) => pool().rows.transactions.push(txRow(o, migrated));
  tx({ id: 1, ref: "DP-DEMO-1", wallet_id: 1, type: "deposit", amount: "50.00", subtitle: "MTN MoMo • 0244123456", provider: "mock", provider_reference: "mock-DP-DEMO-1" });
  tx({ id: 2, ref: "DP-DEMO-2", wallet_id: 1, type: "deposit", amount: "20.00", subtitle: "Telecel Cash • 0244123456", provider: "mock", provider_reference: "mock-DP-DEMO-2" });
  tx({ id: 3, ref: "FD-LEGACY-1", wallet_id: 1, type: "deposit", amount: "10.00", subtitle: "MTN MoMo", provider: null }); // pre-Paystack demo credit, no deposit_requests row
  tx({ id: 4, ref: "DP-PAY-1", wallet_id: 4, type: "deposit", amount: "100.00", subtitle: "Paystack • Visa / Mastercard • DP-PAY-1", provider: "paystack", provider_reference: "ps-1" });
  tx({ id: 5, ref: "DP-DEMO-3", wallet_id: 2, type: "deposit", amount: "25.00", subtitle: "MTN MoMo • 0501234567", provider: "mock" });
  tx({ id: 6, ref: "DP-DEMO-4", wallet_id: 3, type: "deposit", amount: "30.00", subtitle: "MTN MoMo • 0556789012", provider: "mock" });
  tx({ id: 7, ref: "TR-1", wallet_id: 1, type: "transfer", status: "successful", direction: "out", amount: "5.00", title: "Transfer", subtitle: "To Kofi", provider: "mock" });
  tx({ id: 8, ref: "CV-1", wallet_id: 1, type: "conversion", status: "successful", direction: "in", amount: "12.00", title: "Airtime → Cash", subtitle: "MTN 0244123456", provider: "mock" });
  tx({ id: 9, ref: "FD-DATA-1", wallet_id: 1, type: "data", status: "successful", direction: "out", amount: "40.00", title: "MTN 1GB Data", subtitle: "To 024 41 23 456", provider: "mock" });

  const plan = await cleanup.buildCleanupPlan();
  check(
    "discovery: finds all 5 demo credits (4 mock deposits + 1 legacy ledger-only) and 1 real Paystack deposit",
    plan.demoCreditCount === 5 && plan.paystackDepositCount === 1,
    { demoCreditCount: plan.demoCreditCount, paystackDepositCount: plan.paystackDepositCount },
  );
  check(
    "plan: totals match (GH₵ 135 demo credit; GH₵ 90 removable; GH₵ 45 shortfall)",
    plan.totalDemoCredit === 135 && plan.totalRemovable === 90 && plan.totalShortfall === 45,
    { totalDemoCredit: plan.totalDemoCredit, totalRemovable: plan.totalRemovable, totalShortfall: plan.totalShortfall },
  );

  const walletPlan = (id: number) => plan.wallets.find((w) => w.walletId === id);
  check(
    "plan: wallet #1 (balance 100) removes its full GH₵ 80 demo credit (50+20+10)",
    walletPlan(1)?.totalDemoCredit === 80 && walletPlan(1)?.removable === 80 && walletPlan(1)?.shortfall === 0 && walletPlan(1)?.resultingBalance === 20,
    walletPlan(1),
  );
  check(
    "plan: wallet #2 (balance 10, GH₵ 25 demo) clamps to zero and reports a GH₵ 15 shortfall",
    walletPlan(2)?.removable === 10 && walletPlan(2)?.resultingBalance === 0 && walletPlan(2)?.shortfall === 15,
    walletPlan(2),
  );
  check(
    "plan: wallet #3 (balance 0, GH₵ 30 demo) removes nothing and reports the full shortfall",
    walletPlan(3)?.removable === 0 && walletPlan(3)?.resultingBalance === 0 && walletPlan(3)?.shortfall === 30,
    walletPlan(3),
  );
  check(
    "plan: wallet #4 (only a real Paystack deposit) is not in the plan at all",
    walletPlan(4) === undefined,
  );
  check(
    "dry run: building the plan wrote nothing (pure review)",
    pool().captured.length === 0,
    { captured: pool().captured.length },
  );

  // --- Apply -----------------------------------------------------------------
  const result = await cleanup.applyCleanup(plan);
  const expectedLedgerStatus = migrated ? "reversed" : "failed";
  check(
    "apply: reports 3 wallets debited, 4 deposits parked, 5 ledger rows reversed, GH₵ 90 removed",
    result.walletsDebited === 3 &&
      result.depositsParked === 4 &&
      result.ledgerRowsReversed === 5 &&
      result.removed === 90,
    result,
  );

  const bal = (id: number) => pool().rows.wallets.find((w) => w.id === id)?.balance;
  check(
    "apply: wallet balances are debited exactly by demo credit (100→20, 10→0, 0→0) and the Paystack-only wallet is untouched (500)",
    bal(1) === "20.00" && bal(2) === "0.00" && bal(3) === "0.00" && bal(4) === "500.00",
    { w1: bal(1), w2: bal(2), w3: bal(3), w4: bal(4) },
  );

  const deposit = (ref: string) => pool().rows.deposit_requests.find((r) => r.ref === ref);
  check(
    "apply: demo deposit_requests rows are parked failed with the audit note",
    ["DP-DEMO-1", "DP-DEMO-2", "DP-DEMO-3", "DP-DEMO-4"].every(
      (ref) => deposit(ref)?.status === "failed" && String(deposit(ref)?.paystack_gateway_response).includes("reversed by cleanup"),
    ),
    ["DP-DEMO-1", "DP-DEMO-2", "DP-DEMO-3", "DP-DEMO-4"].map((ref) => deposit(ref)),
  );
  check(
    "apply: the real Paystack deposit and the unsettled pending demo deposit are untouched",
    deposit("DP-PAY-1")?.status === "successful" && deposit("DP-DEMO-PENDING")?.status === "pending",
    { pay: deposit("DP-PAY-1"), pending: deposit("DP-DEMO-PENDING") },
  );

  const ledger = (ref: string) => pool().rows.transactions.find((r) => r.ref === ref);
  check(
    `apply: demo ledger rows are marked "${expectedLedgerStatus}" and the Paystack ledger row stays successful`,
    ["DP-DEMO-1", "DP-DEMO-2", "FD-LEGACY-1", "DP-DEMO-3", "DP-DEMO-4"].every((ref) => ledger(ref)?.status === expectedLedgerStatus) &&
      ledger("DP-PAY-1")?.status === "successful" &&
      ledger("DP-PAY-1")?.subtitle === "Paystack • Visa / Mastercard • DP-PAY-1",
    { demo: ["DP-DEMO-1", "DP-DEMO-2", "FD-LEGACY-1", "DP-DEMO-3", "DP-DEMO-4"].map((r) => ledger(r)), pay: ledger("DP-PAY-1") },
  );
  check(
    "apply: transfers, conversions and data purchases are untouched (withdrawals / airtime-to-cash safe)",
    ledger("TR-1")?.status === "successful" &&
      ledger("CV-1")?.status === "successful" &&
      ledger("FD-DATA-1")?.status === "successful",
    { transfer: ledger("TR-1"), conversion: ledger("CV-1"), data: ledger("FD-DATA-1") },
  );

  const walletUpdates = pool().captured.filter((c) => c.kind === "update" && c.table === "wallets");
  check(
    "apply: the wallet mutation is GREATEST-clamped SQL arithmetic on the live row, never an absolute value",
    walletUpdates.length === 3 &&
      walletUpdates.every((w) => /GREATEST\s*\(\s*0\s*,\s*"wallets"\."balance"\s*-/i.test(w.sql ?? "")) &&
      walletUpdates.every((w) => !/"balance"\s*=\s*\$/i.test(w.sql ?? "")),
    walletUpdates.map((w) => w.sql),
  );

  // --- Idempotency -----------------------------------------------------------
  const again = await cleanup.buildCleanupPlan();
  check(
    "idempotency: a second review finds nothing left to reverse",
    again.demoCreditCount === 0 && again.totalDemoCredit === 0,
    { demoCreditCount: again.demoCreditCount, totalDemoCredit: again.totalDemoCredit },
  );
  const secondApply = await cleanup.applyCleanup(again);
  check(
    "idempotency: applying the empty plan changes nothing",
    secondApply.walletsDebited === 0 &&
      secondApply.depositsParked === 0 &&
      secondApply.ledgerRowsReversed === 0 &&
      bal(1) === "20.00" &&
      bal(4) === "500.00",
    { result: secondApply, w1: bal(1), w4: bal(4) },
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} demo-deposit-cleanup checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

if (process.env.SCENARIO) {
  main().catch((error) => {
    console.error("demo-deposit-cleanup verification crashed:", error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
} else {
  runAllScenarios();
}
