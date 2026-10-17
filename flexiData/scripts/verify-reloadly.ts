/** Network-free contract tests. Synthetic fixtures, NOT sandbox purchase evidence. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installSim } from "./schema-sim";
import { submitReloadlySandbox, lookupReloadlySandbox, assertReloadlySandboxConfiguration } from "../src/lib/reloadly";

const env = process.env as Record<string, string | undefined>;
const saved = { ...env };
const originalFetch = globalThis.fetch;
let count = 0;
function test(name: string, fn: () => void) { fn(); count++; console.log(`PASS ${name}`); }
const order = { reference: "FD-fixture-1", operatorId: 643, localAmount: 50, recipient: "233241234567" };
const secret = "test-only-client-secret-sentinel";
const calls: { url: string; init: RequestInit }[] = [];
let reply: unknown = { transactionId: 35059 };
let http = 200;
let failure = false;
function stub() {
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/oauth/token")) return Response.json({ access_token: "test-only-token-sentinel" });
    if (failure) throw reply === "timeout" ? new DOMException(secret, "AbortError") : new Error(secret);
    if (reply === "malformed") return new Response("not json", { status: 200 });
    return Response.json(reply, { status: http });
  }) as typeof fetch;
}
async function main() {
  const { pool } = installSim({ migrated: true });
  env.NODE_ENV = "test";
  env.RELOADLY_MODE = "sandbox";
  delete env.RELOADLY_CLIENT_ID;
  delete env.RELOADLY_CLIENT_SECRET;
  test("missing credentials fail closed", () => assert.throws(assertReloadlySandboxConfiguration));
  env.RELOADLY_CLIENT_ID = "test-only-id"; env.RELOADLY_CLIENT_SECRET = secret;
  test("sandbox test credentials pass local validation only", () => assert.doesNotThrow(assertReloadlySandboxConfiguration));
  env.NODE_ENV = "production";
  test("production transport is code-locked", () => assert.throws(assertReloadlySandboxConfiguration));
  env.NODE_ENV = "test";
  env.RELOADLY_MODE = "live";
  test("live transport cannot be enabled", () => assert.throws(assertReloadlySandboxConfiguration));
  env.RELOADLY_MODE = "sandbox"; stub();
  const submitted = await submitReloadlySandbox(order);
  test("async submission is pending, never delivered", () => {
    assert.equal(submitted.status, "pending"); assert.equal(submitted.providerReference, "35059");
  });
  test("documented OAuth audience, auth and purchase payload", () => {
    assert.equal(calls[0].url, "https://auth.reloadly.com/oauth/token");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      client_id: "test-only-id", client_secret: secret, grant_type: "client_credentials", audience: "https://topups-sandbox.reloadly.com",
    });
    assert.equal(calls[1].url, "https://topups-sandbox.reloadly.com/topups-async");
    assert.equal(new Headers(calls[1].init.headers).get("authorization"), "Bearer test-only-token-sentinel");
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { operatorId: 643, amount: 50, useLocalAmount: true,
      customIdentifier: order.reference, recipientPhone: { countryCode: "GH", number: order.recipient } });
    assert.equal(calls[1].init.redirect, "error");
  });
  reply = { status: "SUCCESSFUL", transaction: { transactionId: 35059, customIdentifier: order.reference, status: "SUCCESSFUL" } };
  const delivered = await lookupReloadlySandbox(order.reference, "35059");
  test("correlated authoritative status confirms delivery", () => assert.equal(delivered.status, "successful"));
  test("status lookup uses documented URL", () => assert.equal(calls.at(-1)?.url, "https://topups-sandbox.reloadly.com/topups/35059/status"));
  for (const status of ["PROCESSING", "PENDING", "future-state", "not delivered", "success"]) {
    reply = { status, transaction: { transactionId: 35059, customIdentifier: order.reference, status } };
    const result = await lookupReloadlySandbox(order.reference, "35059");
    test(`${status} is nonterminal`, () => assert.equal(result.status, "pending"));
  }
  reply = { status: "FAILED", transaction: { transactionId: 35059, customIdentifier: order.reference, status: "FAILED" } };
  const rejected = await lookupReloadlySandbox(order.reference, "35059");
  test("correlated failure normalizes as failed (no wallet effect in transport)", () => assert.equal(rejected.status, "failed"));
  reply = { status: "SUCCESSFUL", transaction: { transactionId: 1, customIdentifier: "other", status: "SUCCESSFUL" } };
  const mismatch = await lookupReloadlySandbox(order.reference, "35059");
  test("mismatched status cannot settle", () => assert.equal(mismatch.status, "pending"));
  for (const scenario of ["connection", "timeout", "malformed", "500", "409", "401", "missing-id"]) {
    failure = scenario === "connection" || scenario === "timeout";
    http = Number(scenario) || 200;
    reply = scenario === "timeout" ? "timeout" : scenario === "malformed" ? "malformed" : { message: secret, status: "SUCCESSFUL" };
    const before = calls.length;
    const result = await submitReloadlySandbox(order);
    test(`${scenario}: uncertain, no retry/refund/delivery or secret leakage`, () => {
      assert.equal(result.status, "pending"); assert.equal(calls.length - before, 2);
      assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes("token-sentinel"));
    });
  }
  failure = false; http = 200;
  env.DATA_API_PROVIDER = "reloadly";
  const gateway = require("../src/lib/data-gateway") as typeof import("../src/lib/data-gateway");
  const purchase = require("../src/app/api/purchase/route") as typeof import("../src/app/api/purchase/route");
  const checkout = require("../src/app/api/checkout/route") as typeof import("../src/app/api/checkout/route");
  for (const mode of ["production", "test"]) {
    env.NODE_ENV = mode;
    const before = calls.length;
    const response = await purchase.POST(new Request("http://localhost/api/purchase", { method: "POST", body: JSON.stringify({ kind: "data" }) }));
    test(`${mode}: purchase blocked before auth/debit/provider calls`, () => { assert.equal(response.status, 503); assert.equal(calls.length, before); });
    test(`${mode}: health source reports unavailable without secrets`, () => {
      const health = gateway.getDataProviderRuntimeStatus(); assert.equal(health.safe, false);
      assert.deepEqual(health.missing, ["rollout_approval"]); assert.ok(!JSON.stringify(health).includes(secret));
    });
  }
  const checkoutResponse = await checkout.POST(new Request("http://localhost/api/checkout", { method: "POST", body: "{}" }));
  test("checkout unauthenticated gate remains intact", () => assert.equal(checkoutResponse.status, 401));
  const { createCheckoutOrder } = require("../src/lib/checkout") as typeof import("../src/lib/checkout");
  await assert.rejects(createCheckoutOrder({ userId: 1, walletId: 1, customerEmail: "fixture@example.invalid",
    customerPhone: "0241234567", network: "MTN", category: "fixture", planLabel: "fixture",
    recipient: "0241234567", requestOrigin: null }), gateway.DataProviderConfigError);
  count++; console.log("PASS checkout service blocks before order creation/payment");
  env.DATA_API_WEBHOOK_SECRET = secret;
  pool().rows.transactions.push({ id: 987, ref: order.reference, wallet_id: 1, type: "data", status: "pending",
    provider: "reloadly", provider_reference: "35059", amount: "10.00", points: 0, subtitle: "fixture",
    network: "MTN", recipient: "0241234567", charged_at: new Date(), refunded_at: null, fulfilled_at: null });
  const callback = require("../src/app/api/purchase/callback/route") as typeof import("../src/app/api/purchase/callback/route");
  const payload = JSON.stringify({ clientReference: order.reference, status: "successful" });
  for (let replay = 0; replay < 2; replay++) {
    const response = await callback.POST(new Request("http://localhost/api/purchase/callback", { method: "POST", body: payload,
      headers: { "x-data-api-signature": createHmac("sha256", secret).update(payload).digest("hex") } }));
    test(`legacy signed callback/replay ${replay} cannot settle Reloadly`, () => {
      assert.equal(response.status, 409); assert.equal(pool().rows.transactions.at(-1)?.status, "pending");
    });
  }
  console.log(`${count} Reloadly checks passed; zero external network calls.`);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(env)) if (!(key in saved)) delete env[key];
  Object.assign(env, saved);
});
