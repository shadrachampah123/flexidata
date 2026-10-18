/** Execute the real route with isolated, DB-free dependency stubs. No self-heal IO. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as guidance from "../src/lib/health-recovery";

async function main() {
  let checks = 0;
  for (const status of ["current", "missing", "legacy", "drifted", "unknown"]) {
    const hint = status === "current" ? undefined : "Run `npx drizzle-kit push` against this database.";
    const compatibility = { status, hint, table: false, missing: [], requiredMissing: status === "current" ? [] : ["fixture"], fallbacks: [] };
    const exports: Record<string, unknown> = {};
    const stubs: Record<string, unknown> = {
      "drizzle-orm": { sql: () => "select 1" },
      "@/db": { db: { execute: async () => undefined } },
      "@/lib/auth": { hasAuthSecret: () => true },
      "@/lib/notifications": { getPasswordResetEmailDeliveryStatus: () => ({ configured: false }) },
      "@/lib/payments": { paymentsProvider: () => "mock" },
      "@/lib/data-gateway": { getDataProviderRuntimeStatus: () => ({ provider: "reloadly", mode: "sandbox", configured: false, safe: false, status: "unavailable", missing: [] }) },
      "@/lib/paystack": { paystackMode: () => "unconfigured" },
      "@/lib/withdrawal-flag": { isWithdrawalsEnabled: () => false },
      "@/lib/seed": { repairCheckoutOrdersSchema: async () => {}, ensureWithdrawalSchema: async () => {} },
      "@/lib/health-recovery": guidance,
      "@/lib/schema-compat": Object.fromEntries([
        "describeAdminAuditCompatibility", "describeAuthCompatibility", "describeCheckoutCompatibility",
        "describePurchaseAttemptsCompatibility", "describeSchemaCompatibility", "describeSignupCompatibility",
        "describeWithdrawalCompatibility", "resetSchemaCapabilitiesCache",
      ].map(name => [name, async () => compatibility])),
    };
    const source = ts.transpileModule(readFileSync("src/app/api/health/route.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(source, { exports, Response, console, require: (id: string) => {
      assert.ok(id in stubs, `Unexpected dependency: ${id}`);
      return stubs[id];
    } });
    const response = await (exports.GET as () => Promise<Response>)();
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.database, "connected");
    assert.equal(body.gatewaySchema, status);
    assert.equal(body.withdrawals.enabled, false);
    assert.equal(body.dataGateway.providerSafe, false);
    for (const key of ["checkoutSchema", "signupSchema", "withdrawalSchema", "adminAuditSchema", "purchaseAttemptsSchema"]) {
      assert.equal(body[key].status, status);
      assert.deepEqual(body[key].missing, []);
      assert.equal("hint" in body[key], status !== "current");
    }
    assert.equal(body.signupSchema.blocked, status !== "current");
    assert.equal(body.auth.schema.blocked, status !== "current");
    assert.equal(body.withdrawalSchema.blocked, status === "missing"); // preserve existing compatibility
    assert.equal(body.purchaseAttemptsSchema.blocked, status !== "current");
    assert.equal("signupWarning" in body, status !== "current");
    assert.equal("authWarning" in body, status !== "current");
    assert.equal("withdrawalWarning" in body, ["missing", "drifted"].includes(status));
    assert.equal("adminAuditWarning" in body, ["legacy", "missing"].includes(status));
    assert.equal("purchaseAttemptsWarning" in body, status !== "current");
    const text = JSON.stringify(body);
    assert.ok(!text.includes("npx drizzle-kit"), "No inherited unsafe command instructions");
    if (status !== "current") {
      assert.ok(text.includes("migrate:purchase-attempts"));
      assert.ok(text.includes("migrate:admin-audit-actions"));
      assert.ok(text.includes("docs/part-6.4-production-readiness.md"));
      assert.ok(text.includes("No general guarded runner"));
      assert.ok(text.includes("Do not use drizzle-kit push or drizzle-kit migrate in production"));
    }
    console.log(`PASS ${status}: recovery guidance, conditional fields, readiness and response compatibility`);
    checks++;
  }
  console.log(`${checks} scenarios passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
