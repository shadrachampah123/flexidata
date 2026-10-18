/**
 * Part 6.4 go/no-go automation. Network-free, database-free, zero provider calls.
 * It proves the things that MUST be true before any operator considers live
 * fulfillment: the Reloadly lock holds in every runtime and credential shape,
 * refusal happens before any network or database access, and the four
 * representations of the purchase claim table (Drizzle schema, migration SQL,
 * migration runner, health probe) agree. It does NOT prove provider evidence,
 * catalogue approval, commercial approval or deployment readiness: see
 * docs/part-6.4-production-readiness.md section "External prerequisites".
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getTableColumns } from "drizzle-orm";

const ROOT = resolve(__dirname, "..");
const env = process.env as Record<string, string | undefined>;
const originalFetch = globalThis.fetch;
let checks = 0;
const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };
const info = (name: string) => console.log(`INFO ${name}`);

const SECRET = "readiness-only-secret-sentinel";
const MANAGED_KEYS = [
  "NODE_ENV", "DATABASE_URL", "DATA_API_PROVIDER", "DATA_API_BASE_URL", "DATA_API_AUTH_TYPE", "DATA_API_TOKEN",
  "RELOADLY_MODE", "RELOADLY_CLIENT_ID", "RELOADLY_CLIENT_SECRET", "WITHDRAWALS_ENABLED",
];

/** Applies managed env vars for the duration of fn (sync or async), then restores them. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of MANAGED_KEYS) saved[key] = env[key];
  try {
    for (const key of MANAGED_KEYS) delete env[key];
    for (const [key, value] of Object.entries(vars)) if (value !== undefined) env[key] = value;
    return await fn();
  } finally {
    for (const key of MANAGED_KEYS) {
      if (saved[key] === undefined) delete env[key]; else env[key] = saved[key];
    }
  }
}

async function main() {
  // Dummy URL only: `@/db` creates a lazy pool and this verifier never queries it.
  env.DATABASE_URL = "postgresql://readiness:readiness@127.0.0.1:5432/readiness_static_only";
  const gateway = require("../src/lib/data-gateway") as typeof import("../src/lib/data-gateway");
  const reloadly = require("../src/lib/reloadly") as typeof import("../src/lib/reloadly");
  const lifecycleModule = require("../src/lib/purchase-lifecycle") as typeof import("../src/lib/purchase-lifecycle");
  const runner = require("./apply-purchase-attempts-migration") as typeof import("./apply-purchase-attempts-migration");

  // --- A. Reloadly live-fulfillment lock: every runtime x credential shape ---
  let lockedCases = 0;
  for (const nodeEnv of [undefined, "development", "test", "production"]) {
    for (const mode of [undefined, "sandbox", "live"]) {
      for (const credentials of [false, true]) {
        const vars = {
          NODE_ENV: nodeEnv,
          DATA_API_PROVIDER: "reloadly",
          DATA_API_BASE_URL: "https://topups-sandbox.reloadly.com",
          DATA_API_AUTH_TYPE: "bearer",
          DATA_API_TOKEN: credentials ? SECRET : undefined,
          RELOADLY_MODE: mode,
          RELOADLY_CLIENT_ID: credentials ? SECRET : undefined,
          RELOADLY_CLIENT_SECRET: credentials ? SECRET : undefined,
          WITHDRAWALS_ENABLED: "true",
        };
        await withEnv(vars, () => {
          const status = gateway.getDataProviderRuntimeStatus();
          assert.equal(status.safe, false, `reloadly must be unsafe (${nodeEnv}/${mode}/${credentials})`);
          assert.equal(status.status, "unavailable");
          assert.deepEqual(status.missing, ["rollout_approval"]);
          assert.throws(() => gateway.assertDataProviderRuntimeSafe(), gateway.DataProviderConfigError);
          assert.ok(!JSON.stringify(status).includes(SECRET), "health must never expose credentials");
          lockedCases++;
        });
      }
    }
  }
  pass(`Reloadly is code-locked in all ${lockedCases} runtime x mode x credential combinations (no approval flag exists)`);

  // --- B. Mock never ships to production; unset is treated the same ---
  await withEnv({ NODE_ENV: "production", DATA_API_PROVIDER: "mock" }, () => {
    assert.equal(gateway.getDataProviderRuntimeStatus().safe, false);
    assert.throws(() => gateway.assertDataProviderRuntimeSafe(), gateway.DataProviderConfigError);
  });
  await withEnv({ NODE_ENV: "production" }, () => {
    const status = gateway.getDataProviderRuntimeStatus();
    assert.equal(status.safe, false);
    assert.deepEqual(status.missing, ["provider"]);
  });
  await withEnv({ NODE_ENV: "development", DATA_API_PROVIDER: "mock" }, () => assert.equal(gateway.getDataProviderRuntimeStatus().safe, true));
  pass("mock and unset providers are unsafe in production and default-deny; development mock stays available for local work");

  // Known, documented residual risk: a configured generic HTTP provider reports
  // ready. It is not Reloadly, and it cannot settle durable purchases (no
  // authoritative status contract). It is a go/no-go item, not silently changed here.
  await withEnv({ NODE_ENV: "production", DATA_API_PROVIDER: "generic-example", DATA_API_BASE_URL: "https://provider.example.invalid",
    DATA_API_AUTH_TYPE: "bearer", DATA_API_TOKEN: SECRET }, () => {
    info(`generic configured provider in production reports safe=${gateway.getDataProviderRuntimeStatus().safe}; approval of any real generic slug is an explicit go/no-go item`);
  });

  // --- C. Transport and lifecycle refuse BEFORE any network or database touch ---
  let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls++; throw new Error("network must not be reached"); }) as typeof fetch;
  try {
    for (const vars of [
      { NODE_ENV: "production", RELOADLY_MODE: "sandbox", RELOADLY_CLIENT_ID: SECRET, RELOADLY_CLIENT_SECRET: SECRET },
      { NODE_ENV: "test", RELOADLY_MODE: "live", RELOADLY_CLIENT_ID: SECRET, RELOADLY_CLIENT_SECRET: SECRET },
      { NODE_ENV: "test", RELOADLY_MODE: "sandbox" },
    ]) {
      await withEnv(vars, async () => {
        await assert.rejects(reloadly.lookupReloadlySandbox("ref", "123"), reloadly.ReloadlyConfigurationError);
        await assert.rejects(reloadly.submitReloadlySandbox({ reference: "ref", operatorId: 1, localAmount: 1, recipient: "233241234567" }),
          reloadly.ReloadlyConfigurationError);
      });
    }
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  pass("sandbox transport refuses production, live mode and missing credentials with zero network calls");

  const touched: string[] = [];
  const untouchableDatabase = {
    connect: async () => { touched.push("connect"); throw new Error("database must not be reached"); },
    query: async () => { touched.push("query"); throw new Error("database must not be reached"); },
  };
  const lifecycle = new lifecycleModule.PurchaseLifecycle(untouchableDatabase as unknown as import("pg").Pool);
  const order = { reference: "READINESS-1", walletId: 1, network: "MTN" as const, recipient: "0244123456",
    planLabel: "1GB", category: "data", providerProductCode: "readiness", amount: 10 } as unknown as import("../src/lib/data-gateway").DataBundleOrder;
  await withEnv({ NODE_ENV: "test", DATA_API_PROVIDER: "reloadly", DATA_API_BASE_URL: "https://x.example.invalid" }, async () => {
    await assert.rejects(lifecycle.create(order, "readiness-key"), gateway.DataProviderConfigError);
    await assert.rejects(lifecycle.submit(order, async () => { throw new Error("must not send"); }), gateway.DataProviderConfigError);
  });
  assert.deepEqual(touched, [], "lock must precede every database access");
  pass("durable purchase create and submit refuse under the Reloadly lock before any database access or provider send");

  // --- D. Schema agreement: Drizzle schema == migration 0011 == runner == health probe ---
  const schema = require("../src/db/schema") as typeof import("../src/db/schema");
  const compat = require("../src/lib/schema-compat") as typeof import("../src/lib/schema-compat");
  const drizzleColumns = Object.values(getTableColumns(schema.purchaseAttempts));
  const drizzleNames = drizzleColumns.map(c => c.name).sort();
  assert.deepEqual(drizzleNames, [...compat.PURCHASE_ATTEMPTS_COLUMNS].sort(), "health probe must list every purchase_attempts column");
  assert.deepEqual(drizzleNames, runner.EXPECTED_COLUMNS.map(([name]) => name).sort(), "runner expectations must match schema.ts");
  for (const [name, , nullable] of runner.EXPECTED_COLUMNS) {
    const column = drizzleColumns.find(c => c.name === name)!;
    assert.equal(column.notNull, !nullable, `nullability of ${name} must match migration 0011`);
  }
  const sql = readFileSync(resolve(ROOT, "drizzle/0011_purchase_attempts.sql"), "utf8");
  assert.deepEqual(runner.auditPurchaseAttemptsSql(sql), [], "migration 0011 must pass the additive audit");
  assert.ok(runner.auditPurchaseAttemptsSql(`${sql}\nDROP TABLE wallets;`).length > 0, "audit must reject a destructive mutation");
  assert.ok(sql.includes(`poll_count BETWEEN 0 AND ${lifecycleModule.MAX_PURCHASE_POLLS}`), "poll budget constant must match the migration CHECK");
  pass("purchase_attempts agrees across schema.ts, migration 0011, runner audit and health probe; poll budget matches the CHECK");

  // --- E. Migration journal integrity (drizzle-kit migrate depends on it) ---
  const journal = JSON.parse(readFileSync(resolve(ROOT, "drizzle/meta/_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  const sqlFiles = readdirSync(resolve(ROOT, "drizzle")).filter(f => f.endsWith(".sql")).map(f => f.replace(/\.sql$/, "")).sort();
  const tags = journal.entries.map(e => e.tag).sort();
  assert.deepEqual(tags, sqlFiles, "every journal tag needs a committed .sql file and vice versa");
  assert.equal(journal.entries.at(-1)?.tag, "0011_purchase_attempts");
  const orderedWhen = journal.entries.every((entry, index, all) => index === 0 || entry.when >= all[index - 1].when);
  if (!orderedWhen) {
    info("journal hazard: entry timestamps are not monotonic (0009 precedes 0008). drizzle-kit migrate must NOT be used for production; use the guarded runners");
  }
  pass("migration journal and SQL files are one-to-one; 0011 is the registered latest migration");

  // --- F. Monitoring classification is pure and conservative ---
  const quiet = { unresolved: 0, byState: {}, pollable: 0, overdue: 0, exhausted: 0, withoutProviderReference: 0,
    staleCreated: 0, oldestUnresolvedAt: null, truncated: false };
  assert.deepEqual(lifecycleModule.reconcileAttention(quiet), []);
  assert.deepEqual(lifecycleModule.reconcileAttention({ ...quiet, overdue: 1 }), ["reconciliation_overdue"]);
  assert.deepEqual(lifecycleModule.reconcileAttention({ ...quiet, exhausted: 1, truncated: true }), ["retry_budget_exhausted", "backlog_exceeds_report_cap"]);
  assert.deepEqual(lifecycleModule.reconcileAttention({ ...quiet, withoutProviderReference: 1, staleCreated: 1 }),
    ["unresolved_without_provider_reference", "created_not_submitted"]);
  pass("attention classification: quiet system is ok; every backlog category produces an operator action");

  // --- G. Runbook presence (the go/no-go checklist must not silently disappear) ---
  const runbook = resolve(ROOT, "../docs/part-6.4-production-readiness.md");
  assert.ok(existsSync(runbook), "docs/part-6.4-production-readiness.md is required");
  const text = readFileSync(runbook, "utf8");
  for (const heading of ["## Go/no-go checklist", "## Migration rollout", "## Reconciliation operations",
    "## External prerequisites", "## Rollback and recovery", "## Security hygiene"]) {
    assert.ok(text.includes(heading), `runbook missing section: ${heading}`);
  }
  pass("production-readiness runbook contains every required go/no-go section");

  console.log(`${checks} production-readiness checks passed; zero network, database or provider calls. Live fulfillment remains LOCKED.`);
}

main().catch(error => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
}).finally(() => {
  globalThis.fetch = originalFetch;
});
