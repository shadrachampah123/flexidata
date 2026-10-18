/** Execute the real route with isolated, DB-free dependency stubs. No self-heal IO. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as guidance from "../src/lib/health-recovery";

const probes = {
  gateway: "describeSchemaCompatibility",
  checkout: "describeCheckoutCompatibility",
  signup: "describeSignupCompatibility",
  withdrawal: "describeWithdrawalCompatibility",
  adminAudit: "describeAdminAuditCompatibility",
  purchaseAttempts: "describePurchaseAttemptsCompatibility",
  auth: "describeAuthCompatibility",
} as const;
type Probe = keyof typeof probes;
type State = "current" | "missing" | "legacy" | "drifted" | "unknown";
type States = Record<Probe, State>;
const states = (status: State, overrides: Partial<States> = {}): States => ({
  gateway: status, checkout: status, signup: status, withdrawal: status,
  adminAudit: status, purchaseAttempts: status, auth: status, ...overrides,
});

/** Assert field-local semantics, independently of the imported guidance constants.
 * Whole-response searches can pass even when two fields have swapped guidance. */
function assertRecovery(value: unknown, kind: "general" | "audit" | "purchase", field: string) {
  assert.equal(typeof value, "string", field);
  const text = value as string;
  assert.ok(text.includes("docs/part-6.4-production-readiness.md"), `${field}: runbook`);
  assert.ok(text.includes("Do not use drizzle-kit push or drizzle-kit migrate in production"), `${field}: production prohibition`);
  assert.ok(!text.includes("npx drizzle-kit"), `${field}: no inherited unsafe instructions`);
  const commands = [...text.matchAll(/migrate:[a-z-]+/g)].map(match => match[0]);
  const migrations = [...text.matchAll(/migration (\d{4})/g)].map(match => match[1]);
  if (kind === "general") {
    assert.deepEqual(commands, [], `${field}: no unrelated guarded runner`);
    assert.deepEqual(migrations, [], `${field}: no unrelated migration`);
    assert.ok(text.includes("No general guarded runner"), `${field}: no invented runner`);
    assert.ok(text.includes("inspect schema drift") && text.includes("approved, targeted recovery plan"), `${field}: investigate first`);
  } else {
    const command = kind === "audit" ? "migrate:admin-audit-actions" : "migrate:purchase-attempts";
    assert.deepEqual(commands, [command], `${field}: only the intended guarded runner`);
    assert.deepEqual(migrations, [kind === "audit" ? "0007" : "0011"], `${field}: only the intended migration`);
    assert.ok(text.includes(`guarded npm run ${command}`), `${field}: guarded procedure`);
    assert.ok(text.includes("dry-run report and approval requirements before applying"), `${field}: review before apply`);
    if (kind === "audit") {
      assert.ok(text.includes("stop on drift"), `${field}: never apply to drift`);
    } else {
      assert.ok(text.includes("drifted table requires investigation, not reapplication"), `${field}: investigate drift`);
      assert.ok(text.includes("Data purchases remain fail-closed"), `${field}: purchase lock`);
    }
  }
}

async function main() {
  let checks = 0;
  const uniformStates: State[] = ["current", "missing", "legacy", "drifted", "unknown"];
  const fixtures = [
    // Keep every original uniform-state scenario and its aggregate assertions.
    ...uniformStates.map(status => ({ name: status, uniform: status, states: states(status) })),
    // Each probe is independently missing while every other probe stays current.
    // In particular: purchase missing/audit current, and audit missing/purchase current.
    ...Object.keys(probes).map(probe => ({ name: `${probe} alone missing`, uniform: undefined, states: states("current", { [probe]: "missing" }) })),
    { name: "purchase drift with audit missing and mixed general schemas", uniform: undefined,
      states: states("current", { purchaseAttempts: "drifted", adminAudit: "missing", gateway: "legacy", signup: "missing", auth: "unknown" }) },
    { name: "audit drift with purchase missing and mixed general schemas", uniform: undefined,
      states: states("current", { adminAudit: "drifted", purchaseAttempts: "missing", checkout: "legacy", withdrawal: "drifted" }) },
  ];
  for (const fixture of fixtures) {
    const status = fixture.uniform;
    const expected = fixture.states;
    const compatibility = (state: State) => ({
      status: state,
      hint: state === "current" ? undefined : "Run `npx drizzle-kit push` against this database.",
      table: false, missing: [], requiredMissing: state === "current" ? [] : ["fixture"], fallbacks: [],
    });
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
      "@/lib/schema-compat": {
        ...Object.fromEntries(Object.entries(probes).map(([probe, name]) =>
          [name, async () => compatibility(expected[probe as Probe])])),
        resetSchemaCapabilitiesCache: () => {},
      },
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
    assert.equal(body.gatewaySchema, expected.gateway);
    assert.equal(body.withdrawals.enabled, false);
    assert.equal(body.dataGateway.providerSafe, false);
    assert.equal(body.dataGateway.provider, "reloadly");
    assert.equal(body.dataGateway.providerConfigured, false);
    assert.equal(body.dataGateway.providerStatus, "unavailable");
    for (const [key, probe] of Object.entries({
      checkoutSchema: "checkout", signupSchema: "signup", withdrawalSchema: "withdrawal",
      adminAuditSchema: "adminAudit", purchaseAttemptsSchema: "purchaseAttempts",
    } as const)) {
      assert.equal(body[key].status, expected[probe], `${fixture.name}: ${key}`);
      assert.deepEqual(body[key].missing, []);
      assert.equal("hint" in body[key], expected[probe] !== "current");
      if (expected[probe] !== "current") {
        assertRecovery(body[key].hint, probe === "adminAudit" ? "audit" : probe === "purchaseAttempts" ? "purchase" : "general", `${key}.hint`);
      }
    }
    assert.equal(body.auth.schema.status, expected.auth);
    assert.deepEqual(body.auth.schema.missing, []);
    assert.equal("hint" in body.auth.schema, expected.auth !== "current");
    if (expected.auth !== "current") assertRecovery(body.auth.schema.hint, "general", "auth.schema.hint");
    assert.equal(body.dataGateway.schema, expected.gateway);
    assert.equal("hint" in body.dataGateway, expected.gateway === "legacy");
    if (expected.gateway === "legacy") assertRecovery(body.dataGateway.hint, "general", "dataGateway.hint");
    assert.equal("warning" in body, expected.gateway === "legacy");
    assert.equal(body.signupSchema.blocked, expected.signup !== "current");
    assert.equal(body.auth.schema.blocked, expected.auth !== "current");
    assert.equal(body.withdrawalSchema.blocked, expected.withdrawal === "missing"); // preserve existing compatibility
    assert.equal(body.adminAuditSchema.blocked, ["legacy", "missing"].includes(expected.adminAudit));
    assert.equal(body.purchaseAttemptsSchema.blocked, expected.purchaseAttempts !== "current");
    assert.equal("signupWarning" in body, expected.signup !== "current");
    assert.equal("authWarning" in body, expected.auth !== "current");
    assert.equal("withdrawalWarning" in body, ["missing", "drifted"].includes(expected.withdrawal));
    assert.equal("adminAuditWarning" in body, ["legacy", "missing"].includes(expected.adminAudit));
    assert.equal("purchaseAttemptsWarning" in body, expected.purchaseAttempts !== "current");
    for (const field of ["signupWarning", "authWarning", "withdrawalWarning"]) {
      if (field in body) assertRecovery(body[field], "general", field);
    }
    if ("adminAuditWarning" in body) assertRecovery(body.adminAuditWarning, "audit", "adminAuditWarning");
    if ("purchaseAttemptsWarning" in body) assertRecovery(body.purchaseAttemptsWarning, "purchase", "purchaseAttemptsWarning");
    const text = JSON.stringify(body);
    assert.ok(!text.includes("npx drizzle-kit"), "No inherited unsafe command instructions");
    if (status !== undefined && status !== "current") {
      assert.ok(text.includes("migrate:purchase-attempts"));
      assert.ok(text.includes("migrate:admin-audit-actions"));
      assert.ok(text.includes("docs/part-6.4-production-readiness.md"));
      assert.ok(text.includes("No general guarded runner"));
      assert.ok(text.includes("Do not use drizzle-kit push or drizzle-kit migrate in production"));
    }
    console.log(`PASS ${fixture.name}: field-specific recovery guidance, conditional fields, readiness and response compatibility`);
    checks++;
  }
  console.log(`${checks} scenarios passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
