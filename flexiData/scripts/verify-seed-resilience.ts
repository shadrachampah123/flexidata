/**
 * Regression harness for the shared-catalog seed taking auth down.
 *
 * `ensureSeeded()` runs on the sign-up / login / password-reset path. The seed
 * writes to a few shared catalog tables (bundle plans, provider float, price
 * alerts). A deployment whose database is one migration behind one of those
 * tables — `price_alerts` in particular — used to let the seed throw, reject the
 * `ensureSeeded()` promise, and surface *every* account creation as a bare
 * "Something went wrong. Please try again. (ref …)". The seed must degrade
 * around a missing table/column the same way the data gateway does, so a
 * lagging schema can never take sign-up down.
 *
 * Scenarios (SCENARIO env var):
 *   current          — fully migrated database
 *   legacy           — database without the data-gateway objects
 *   no-price-alerts  — database missing `price_alerts` (the reported regression)
 *   no-bundle-plans  — database missing `bundle_plans`
 *   no-sessions      — database missing `sessions` (sign-up must not touch it)
 *   no-required-col  — database missing a *required* sign-up column
 *
 * Run with: npm run verify:seed-resilience
 */
import { spawnSync } from "node:child_process";
import { installSim } from "./schema-sim";

const SCENARIOS = ["current", "legacy", "no-price-alerts", "no-bundle-plans", "no-sessions", "no-required-col"];

// A keyed-by-scenario expectation for registerUser: whether a user row is
// created (ok:true + userId) or a friendly, human-readable error is returned.
const EXPECT: Record<string, { ok: boolean; friendly?: boolean }> = {
  current: { ok: true },
  legacy: { ok: true },
  "no-price-alerts": { ok: true },
  "no-bundle-plans": { ok: true },
  "no-sessions": { ok: true },
  // Missing a required column is the one thing sign-up <em>cannot</em> work
  // around; the drift guard must still block it loudly but friendly.
  "no-required-col": { ok: false, friendly: true },
};

function runAllScenarios() {
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

async function main() {
  // The sim's "legacy" model keeps the catalog tables and only strips the
  // data-gateway objects; here we additionally model a database missing the
  // seed's own tables, which is the case the old code let crash sign-up.
  const { pool: getPool, schema } = installSim({ migrated: process.env.SCENARIO === "current" });
  const scenario = process.env.SCENARIO ?? "current";

  if (scenario === "no-price-alerts") delete schema.tables.price_alerts;
  if (scenario === "no-bundle-plans") delete schema.tables.bundle_plans;
  if (scenario === "no-sessions") delete schema.tables.sessions;
  if (scenario === "no-required-col") {
    // Rename away a REQUIRED sign-up column so the drift guard reports it.
    schema.tables.users = schema.tables.users.filter((c: string) => c !== "referral_code");
  }

  // Load app code only AFTER installSim has replaced pg.Pool, so @/db binds to
  // the in-memory pool for this process.
  const { registerUser } = require("@/lib/accounts");
  const { resetSchemaCapabilitiesCache } = require("@/lib/schema-compat");
  resetSchemaCapabilitiesCache();

  const expect = EXPECT[scenario];
  type RegistrationResult =
    | { ok: true; userId: number; walletId: number }
    | { ok: false; error: string; reason?: string };
  let result: RegistrationResult;

  try {
    result = await registerUser({
      name: "Ama Serwaa",
      email: `ama-${scenario}@flexidata-verify.test`,
      phone: "0241234567",
      password: "Passw0rd123",
      referralCode: null,
    });
  } catch (error) {
    console.error(`  FAIL  registerUser threw instead of returning: ${(error as Error)?.message ?? error}`);
    process.exitCode = 1;
    return;
  }

  const pool = getPool();
  function verify(label: string, pass: boolean, detail?: unknown) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${pass ? "" : ` -> ${JSON.stringify(detail)}`}`);
    if (!pass) process.exitCode = 1;
  }

  if (expect.ok) {
    const succeeded = result.ok && Number.isInteger(result.userId) && Number.isInteger(result.walletId);
    verify("registerUser returns both userId and walletId", succeeded, result);
    if (result.ok) {
      const user = pool.rows.users.find((row) => row.id === result.userId);
      const wallet = pool.rows.wallets.find((row) => row.id === result.walletId);
      verify("registered user row is persisted", Boolean(user && user.email === `ama-${scenario}@flexidata-verify.test`), user);
      verify("wallet is created for that user with zero starting balance", Boolean(
        wallet && wallet.user_id === result.userId && wallet.balance === "0.00",
      ), wallet);
      verify("agent profile is linked to the new wallet", pool.rows.agent_profiles.some((row) => row.wallet_id === result.walletId));
    } else {
      verify("failed registration creates no user or wallet", pool.rows.users.length === 0 && pool.rows.wallets.length === 0, {
        users: pool.rows.users.length, wallets: pool.rows.wallets.length,
      });
    }
  } else if (expect.friendly) {
    const pass = !result.ok && typeof result.error === "string" && !/ref/i.test(result.error);
    verify("missing required column blocks with a friendly message, not a 500", pass, result);
    verify("blocked registration creates no orphan user or wallet", pool.rows.users.length === 0 && pool.rows.wallets.length === 0, {
      users: pool.rows.users.length, wallets: pool.rows.wallets.length,
    });
  }
}

if (process.env.SCENARIO) {
  main().catch((e) => {
    console.error("crashed", e);
    process.exitCode = 1;
  });
} else {
  runAllScenarios();
}
