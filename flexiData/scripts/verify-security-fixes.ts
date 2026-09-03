/**
 * Focused security-fix verification for the FlexiData Paystack audit.
 *
 * This script is intentionally database-light:
 *   - The production mock-funding lock and the production convert lock are
 *     checked before any database/authentication code can run.
 *   - The purchase callback HMAC path is verified against the in-memory schema
 *     simulator (the real Postgres E2E suite covers the full money flows).
 *
 * It does NOT test the concurrent wallet-transfer query (that needs a real
 * Postgres row-lock/transaction run); that remains covered by the package's
 * Paystack E2E suite when a DATABASE_URL is available.
 */
import { createHmac } from "node:crypto";
import { installSim } from "./schema-sim";

const env = process.env as unknown as Record<string, string | undefined>;
const checks: { name: string; ok: boolean; detail: unknown }[] = [];
function check(name: string, ok: boolean, detail: unknown = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  — ${JSON.stringify(detail)}`}`);
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function main() {
  const originalNodeEnv = env.NODE_ENV;
  const originalSecret = env.DATA_API_WEBHOOK_SECRET;
  const originalProvider = env.PAYMENTS_PROVIDER;

  try {
    // --- 1. Production mock-funding lock (fail-closed before auth) ----------
    env.NODE_ENV = "production";
    env.PAYMENTS_PROVIDER = "mock";
    const { pool } = installSim({ migrated: true });
    const fundRoute = require("@/app/api/wallet/fund/route");
    const convertRoute = require("@/app/api/convert/route");
    const callbackRoute = require("@/app/api/purchase/callback/route");

    const fund = await fundRoute.POST(jsonRequest("/api/wallet/fund", { method: "momo_mtn", amount: 50 }));
    const fundBody = await fund.json();
    check(
      "production: PAYMENTS_PROVIDER=mock blocks wallet funding (503, no wallet credit)",
      fund.status === 503 && fundBody.ok === false && fundBody.code === "paystack_unconfigured",
      { status: fund.status, body: fundBody },
    );
    check(
      "production: mock funding response is generic (no key/config/stack details)",
      !JSON.stringify(fundBody).toLowerCase().includes("paystack_secret") &&
        !JSON.stringify(fundBody).toLowerCase().includes("sk_test_") &&
        !JSON.stringify(fundBody).toLowerCase().includes("sk_live_"),
      fundBody,
    );

    const convert = await convertRoute.POST(
      jsonRequest("/api/convert", { network: "MTN", phone: "0244123456", amount: 20 }),
    );
    const convertBody = await convert.json();
    check(
      "production: airtime→cash conversion is unavailable (503)",
      convert.status === 503 && convertBody.ok === false && convertBody.code === "conversion_unavailable",
      { status: convert.status, body: convertBody },
    );

    // --- 2. Production callback webhook-secret gate and HMAC ----------------
    delete env.DATA_API_WEBHOOK_SECRET;
    const missing = await callbackRoute.POST(
      jsonRequest("/api/purchase/callback", { clientReference: "UNKNOWN", status: "successful" }),
    );
    const missingBody = await missing.json();
    check(
      "production: missing DATA_API_WEBHOOK_SECRET rejects provider callback (401)",
      missing.status === 401 && missingBody.ok === false,
      { status: missing.status, body: missingBody },
    );

    env.DATA_API_WEBHOOK_SECRET = "test-webhook-secret";
    const callbackBody = JSON.stringify({ clientReference: "UNKNOWN", status: "successful" });
    const bad = await callbackRoute.POST(
      new Request("http://localhost/api/purchase/callback", {
        method: "POST",
        headers: { "content-type": "application/json", "x-data-api-signature": "invalid" },
        body: callbackBody,
      }),
    );
    check("production: invalid callback HMAC signature rejected (401)", bad.status === 401, bad.status);

    const expected = createHmac("sha256", env.DATA_API_WEBHOOK_SECRET!).update(callbackBody).digest("hex");
    const good = await callbackRoute.POST(
      new Request("http://localhost/api/purchase/callback", {
        method: "POST",
        headers: { "content-type": "application/json", "x-data-api-signature": expected },
        body: callbackBody,
      }),
    );
    // The unknown reference means 404 after passing HMAC; asserting not-401 is
    // enough to prove the HMAC auth gate accepted the signature.
    check("production: valid callback HMAC signature passes the auth gate", good.status !== 401, good.status);

    // --- 3. Unexpected fund errors are sanitized -----------------------------
    env.NODE_ENV = "development";
    env.FLEXIDATA_TEST_USER_ID = "1";
    env.PAYMENTS_PROVIDER = "mock";

    pool().rows.users.push({
      id: 1,
      name: "Security Probe",
      email: "security@flexidata.app",
      phone: "0244123456",
      password_hash: "scrypt:x:x",
      referral_code: "FD-SEC-0001",
      referred_by: null,
      referral_rewarded_at: null,
      email_verified_at: null,
      notify_promos: true,
      notify_tx: true,
      is_admin: false,
      created_at: new Date(),
      updated_at: new Date(),
    });
    pool().rows.wallets.push({
      id: 1,
      user_id: 1,
      name: "Security Probe",
      number: "0244123456",
      balance: "100.00",
      points: 0,
      is_agent: false,
      agent_tier: null,
      referral_code: "FD-SEC-0001",
      created_at: new Date(),
    });

    const fundDev = await fundRoute.POST(jsonRequest("/api/wallet/fund", { method: "momo_mtn", amount: 50 }));
    const fundDevBody = await fundDev.json();
    check(
      "non-production fund error responses are sanitized (generic code, no raw db/schema/message)",
      (fundDev.status === 500 || fundDev.status === 503) &&
        fundDevBody.ok === false &&
        !JSON.stringify(fundDevBody).includes("amount_subunits") &&
        !JSON.stringify(fundDevBody).includes("deposit_requests") &&
        !JSON.stringify(fundDevBody).includes("column ") &&
        !JSON.stringify(fundDevBody).includes("does not exist"),
      { status: fundDev.status, body: fundDevBody },
    );
  } finally {
    if (originalNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = originalNodeEnv;
    if (originalSecret === undefined) delete env.DATA_API_WEBHOOK_SECRET;
    else env.DATA_API_WEBHOOK_SECRET = originalSecret;
    if (originalProvider === undefined) delete env.PAYMENTS_PROVIDER;
    else env.PAYMENTS_PROVIDER = originalProvider;
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} security-fix checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("security verification crashed:", error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
