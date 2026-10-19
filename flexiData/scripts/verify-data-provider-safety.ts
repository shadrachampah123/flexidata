/**
 * Part 6.1 + 6.2 verification — production mock-provider lock and health
 * visibility.
 *
 * This harness is DB-free (the shared in-memory schema simulator backs the real
 * route handlers) and NETWORK-FREE (the real-provider paths are driven through
 * an injected `fetch` stub; no aggregator, Paystack, or external host is ever
 * contacted).
 *
 * It proves:
 *   1. Production rejects an unset/mock data provider BEFORE any wallet debit,
 *      ledger write, or float snapshot.
 *   2. Production cannot produce a simulated "delivered" gateway result.
 *   3. A real provider that is missing/misconfigured/unreachable never falls
 *      back to mock, in production or development.
 *   4. Development/test mock simulation still debits once and reports delivered;
 *      a simulated provider failure still refunds atomically.
 *   5. /api/health identifies provider safety for every case above while
 *      preserving its existing fields/readiness behavior.
 *   6. Health output never contains a key, token, secret, or webhook secret.
 *   7. The configured real-provider request shape (URL, method, auth, payload)
 *      and result normalization are unchanged.
 */

import { createHmac } from "node:crypto";
import { installSim } from "./schema-sim";

const env = process.env as unknown as Record<string, string | undefined>;
const checks: { name: string; ok: boolean; detail: unknown }[] = [];

function check(name: string, ok: boolean, detail: unknown = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  — ${JSON.stringify(detail)}`}`);
}

function jsonRequest(url: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ENV_KEYS = [
  "NODE_ENV",
  "DATA_API_PROVIDER",
  "DATA_API_BASE_URL",
  "DATA_API_PURCHASE_PATH",
  "DATA_API_PURCHASE_METHOD",
  "DATA_API_AUTH_TYPE",
  "DATA_API_KEY",
  "DATA_API_SECRET",
  "DATA_API_TOKEN",
  "DATA_API_ACCOUNT_ID",
  "DATA_API_CALLBACK_URL",
  "DATA_API_WEBHOOK_SECRET",
  "DATA_API_TIMEOUT_MS",
  "DATA_API_SYNC_FLOAT_ON_PURCHASE",
  "DATA_MOCK_RESULT",
  "DATA_API_SCHEMA_FALLBACKS",
  "FLEXIDATA_TEST_USER_ID",
  "AUTH_SECRET",
] as const;

const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = env[key];

function clearDataProviderEnv() {
  delete env.DATA_API_PROVIDER;
  delete env.DATA_API_BASE_URL;
  delete env.DATA_API_PURCHASE_PATH;
  delete env.DATA_API_PURCHASE_METHOD;
  delete env.DATA_API_AUTH_TYPE;
  delete env.DATA_API_KEY;
  delete env.DATA_API_SECRET;
  delete env.DATA_API_TOKEN;
  delete env.DATA_API_ACCOUNT_ID;
  delete env.DATA_API_CALLBACK_URL;
  delete env.DATA_API_WEBHOOK_SECRET;
  delete env.DATA_API_TIMEOUT_MS;
  delete env.DATA_API_SYNC_FLOAT_ON_PURCHASE;
  delete env.DATA_MOCK_RESULT;
  delete env.DATA_API_SCHEMA_FALLBACKS;
  delete env.FLEXIDATA_TEST_USER_ID;
}

function resetEnv(options: { nodeEnv: string; provider?: string | null }) {
  clearDataProviderEnv();
  env.NODE_ENV = options.nodeEnv;
  if (options.provider) env.DATA_API_PROVIDER = options.provider;
  env.AUTH_SECRET = "harness-auth-secret-not-a-real-value-0123456789";
  env.DATA_API_SCHEMA_FALLBACKS = "true";
}

type FetchCall = { url: string; init: RequestInit };

/**
 * Replace the process-wide fetch with a deterministic recorder. Every call is
 * captured; no socket is opened.
 */
function installFetchStub(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown })?.url ?? "");
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof globalThis.fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function failFetch(url: string): never {
  throw new Error(`unexpected external call to ${url}`);
}

const SENTINELS = {
  key: "KEY-SENTINEL-do-not-leak-9f3a",
  secret: "SECRET-SENTINEL-do-not-leak-7b1c",
  token: "TOKEN-SENTINEL-do-not-leak-4d2e",
  account: "ACCOUNT-SENTINEL-do-not-leak-1a5f",
  webhook: "WEBHOOK-SENTINEL-do-not-leak-8c6d",
};

function serializedContainsSecrets(value: unknown): string[] {
  const text = JSON.stringify(value ?? "");
  return Object.entries(SENTINELS)
    .filter(([, sentinel]) => text.includes(sentinel))
    .map(([name]) => name);
}

async function main() {
  const { pool } = installSim({ migrated: true });
  const schemaCompat = require("@/lib/schema-compat") as typeof import("@/lib/schema-compat");
  schemaCompat.resetSchemaCapabilitiesCache();

  // Seed through the app's own idempotent seeder, then add the authenticated
  // fixture account/wallet and a deterministic MTN plan.
  const { ensureSeeded } = require("@/lib/seed") as typeof import("@/lib/seed");
  await ensureSeeded().catch((error) => {
    console.warn("seed fixture skipped:", error instanceof Error ? error.message : error);
  });

  const rows = pool().rows;
  if (!rows.users.some((row) => row.id === 1)) {
    rows.users.push({
      id: 1,
      name: "Provider Safety Probe",
      email: "provider-safety@flexidata.app",
      phone: "0244123456",
      password_hash: "scrypt:x:x",
      referral_code: "FD-P6-0001",
      referred_by: null,
      referral_rewarded_at: null,
      email_verified_at: null,
      notify_promos: true,
      notify_tx: true,
      is_admin: false,
      status: "active",
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
  if (!rows.wallets.some((row) => row.id === 1)) {
    rows.wallets.push({
      id: 1,
      user_id: 1,
      name: "Provider Safety Probe",
      number: "0244123456",
      balance: "100.00",
      points: 50,
      is_agent: false,
      agent_tier: null,
      referral_code: "FD-P6-0001",
      created_at: new Date(),
    });
  }
  const plan = {
    id: 9001,
    network: "MTN",
    category: "up2u",
    label: "1GB",
    validity: "No expiry",
    price: "10.00",
    retail_price: "10.50",
    badge: null,
    sort_order: 1,
    provider_product_code: "MTN-UP2U-1GB",
  };
  const existingPlan = rows.bundle_plans.findIndex(
    (row) => row.network === plan.network && row.category === plan.category && row.label === plan.label,
  );
  if (existingPlan >= 0) rows.bundle_plans[existingPlan] = { ...rows.bundle_plans[existingPlan], ...plan };
  else rows.bundle_plans.push(plan);

  const purchaseRoute = require("@/app/api/purchase/route") as typeof import("@/app/api/purchase/route");
  const checkoutRoute = require("@/app/api/checkout/route") as typeof import("@/app/api/checkout/route");
  const callbackRoute = require("@/app/api/purchase/callback/route") as typeof import("@/app/api/purchase/callback/route");
  const healthRoute = require("@/app/api/health/route") as typeof import("@/app/api/health/route");
  const gateway = require("@/lib/data-gateway") as typeof import("@/lib/data-gateway");

  function wallet() {
    return rows.wallets.find((row) => row.id === 1)!;
  }
  function setWalletBalance(value: string) {
    wallet().balance = value;
  }
  function txCount() {
    return rows.transactions.length;
  }
  function lastTx() {
    return rows.transactions[rows.transactions.length - 1];
  }
  function purchaseBody() {
    return {
      kind: "data",
      network: "MTN",
      category: plan.category,
      planLabel: plan.label,
      recipient: "0244123456",
    };
  }

  // =========================================================================
  // 1. Status matrix — production refuses mock/unset/incomplete providers
  // =========================================================================
  resetEnv({ nodeEnv: "production" });
  let status = gateway.getDataProviderRuntimeStatus();
  check(
    "production + DATA_API_PROVIDER unset: resolves to mock but reports unsafe/unavailable",
    status.provider === "mock" &&
      status.configured === false &&
      status.mode === "mock" &&
      status.safe === false &&
      status.status === "unavailable" &&
      status.missing.includes("provider"),
    status,
  );

  resetEnv({ nodeEnv: "production", provider: "mock" });
  status = gateway.getDataProviderRuntimeStatus();
  check(
    "production + DATA_API_PROVIDER=mock: unsafe/unavailable even though explicitly configured",
    status.provider === "mock" &&
      status.configured === true &&
      status.safe === false &&
      status.status === "unavailable" &&
      status.missing.includes("real_provider"),
    status,
  );

  resetEnv({ nodeEnv: "production", provider: "mock" });
  env.DATA_API_BASE_URL = "https://aggregator.invalid";
  env.DATA_API_AUTH_TYPE = "bearer";
  env.DATA_API_TOKEN = SENTINELS.token;
  status = gateway.getDataProviderRuntimeStatus();
  check(
    "production + mock with a full real-provider config still refuses mock",
    status.safe === false && status.status === "unavailable",
    status,
  );

  resetEnv({ nodeEnv: "production", provider: "yenkodata" });
  status = gateway.getDataProviderRuntimeStatus();
  check(
    "production + real provider without a base URL: unsafe (no mock fallback)",
    status.safe === false && status.missing.includes("base_url"),
    status,
  );

  resetEnv({ nodeEnv: "production", provider: "yenkodata" });
  env.DATA_API_BASE_URL = "https://aggregator.invalid";
  env.DATA_API_AUTH_TYPE = "bearer";
  status = gateway.getDataProviderRuntimeStatus();
  check(
    "production + real provider without credentials: unsafe/unavailable",
    status.safe === false && status.missing.includes("credentials"),
    status,
  );

  resetEnv({ nodeEnv: "production", provider: "yenkodata" });
  env.DATA_API_BASE_URL = "https://aggregator.invalid";
  env.DATA_API_AUTH_TYPE = "bearer";
  env.DATA_API_TOKEN = SENTINELS.token;
  status = gateway.getDataProviderRuntimeStatus();
  check(
    "production + fully configured real provider: safe/ready",
    status.safe === true && status.status === "ready" && status.mode === "live" && status.missing.length === 0,
    status,
  );

  for (const provider of ["techlink", "techlink_gh", "techlink-gh", "techlinkgh"]) {
    resetEnv({ nodeEnv: "test", provider });
    env.DATA_API_BASE_URL = "https://api.techlinkgh.com/api/v1";
    env.DATA_API_AUTH_TYPE = "headers";
    env.DATA_API_KEY = SENTINELS.key;
    status = gateway.getDataProviderRuntimeStatus();
    check(
      `${provider} never falls through the generic adapter before an explicit verified adapter exists`,
      status.provider === provider &&
        status.safe === false &&
        status.status === "unavailable" &&
        status.missing.includes("rollout_approval") &&
        String(status.warning).includes("documented adapter contract"),
      status,
    );
  }

  resetEnv({ nodeEnv: "test", provider: "techlink" });
  env.DATA_API_BASE_URL = "https://api.techlinkgh.com/api/v1";
  env.DATA_API_AUTH_TYPE = "headers";
  env.DATA_API_KEY = SENTINELS.key;
  let techlinkGuardError: unknown = null;
  try {
    gateway.assertDataProviderRuntimeSafe();
  } catch (error) {
    techlinkGuardError = error;
  }
  check(
    "techlink generic activation fails closed before any request",
    techlinkGuardError instanceof gateway.DataProviderConfigError &&
      (techlinkGuardError as Error).message.includes("documented adapter contract") &&
      serializedContainsSecrets((techlinkGuardError as Error).message).length === 0,
    techlinkGuardError instanceof Error ? techlinkGuardError.message : techlinkGuardError,
  );

  setWalletBalance("100.00");
  const txBeforeTechlink = txCount();
  const techlinkRouteFetch = installFetchStub((url) => failFetch(url));
  const techlinkRoute = await purchaseRoute.POST(jsonRequest("/api/purchase", purchaseBody()));
  const techlinkRouteBody = await techlinkRoute.json();
  techlinkRouteFetch.restore();
  check(
    "techlink purchase route rejects before wallet debit, ledger write or provider call",
    techlinkRoute.status === 503 &&
      techlinkRouteBody.code === "provider_unavailable" &&
      wallet().balance === "100.00" &&
      txCount() === txBeforeTechlink &&
      techlinkRouteFetch.calls.length === 0 &&
      serializedContainsSecrets(techlinkRouteBody).length === 0,
    {
      status: techlinkRoute.status,
      body: techlinkRouteBody,
      wallet: wallet().balance,
      txCount: txCount(),
      fetchCalls: techlinkRouteFetch.calls.length,
    },
  );

  for (const nodeEnv of ["development", "test"]) {
    resetEnv({ nodeEnv, provider: "mock" });
    status = gateway.getDataProviderRuntimeStatus();
    check(
      `${nodeEnv} + mock provider: safe/ready simulation`,
      status.safe === true && status.status === "ready" && status.mode === "mock",
      status,
    );
  }

  resetEnv({ nodeEnv: "development", provider: "yenkodata" });
  status = gateway.getDataProviderRuntimeStatus();
  check(
    "development + misconfigured real provider: unsafe (never silently becomes mock)",
    status.safe === false && status.status === "unavailable" && status.mode === "live",
    status,
  );

  // The guard itself must throw the repository's config error, with no secrets.
  resetEnv({ nodeEnv: "production", provider: "mock" });
  env.DATA_API_TOKEN = SENTINELS.token;
  let guardError: unknown = null;
  try {
    gateway.assertDataProviderRuntimeSafe();
  } catch (error) {
    guardError = error;
  }
  check(
    "assertDataProviderRuntimeSafe throws DataProviderConfigError with a safe message in production mock",
    guardError instanceof gateway.DataProviderConfigError &&
      (guardError as Error).message.includes("mock data provider is disabled in production") &&
      serializedContainsSecrets((guardError as Error).message).length === 0,
    guardError instanceof Error ? guardError.message : guardError,
  );

  // =========================================================================
  // 2. Production mock cannot deliver — gateway and route, before wallet debit
  // =========================================================================
  resetEnv({ nodeEnv: "production", provider: "mock" });
  env.DATA_MOCK_RESULT = "successful";
  env.DATA_API_TOKEN = SENTINELS.token;
  env.DATA_API_SECRET = SENTINELS.secret;
  setWalletBalance("100.00");
  const txBeforeProdMock = txCount();
  const floatBeforeProdMock = rows.provider_float_balances.length;
  const prodMockFetch = installFetchStub((url) => failFetch(url));
  let prodMockGatewayError: unknown = null;
  try {
    await gateway.submitDataBundleOrder({
      reference: "FD-P6-PROD-MOCK",
      walletId: 1,
      network: "MTN",
      recipient: "0244123456",
      planLabel: plan.label,
      category: plan.category,
      providerProductCode: plan.provider_product_code,
      amount: 10,
    });
  } catch (error) {
    prodMockGatewayError = error;
  }
  const prodMockRoute = await purchaseRoute.POST(jsonRequest("/api/purchase", purchaseBody()));
  const prodMockRouteBody = await prodMockRoute.json();
  prodMockFetch.restore();

  check(
    "production mock: submitDataBundleOrder throws (no simulated 'delivered' result) and makes no provider call",
    prodMockGatewayError instanceof gateway.DataProviderConfigError && prodMockFetch.calls.length === 0,
    {
      error: prodMockGatewayError instanceof Error ? prodMockGatewayError.message : prodMockGatewayError,
      fetchCalls: prodMockFetch.calls.length,
    },
  );
  check(
    "production mock: POST /api/purchase rejects 503 BEFORE auth/wallet debit/ledger/float writes",
    prodMockRoute.status === 503 &&
      prodMockRouteBody.ok === false &&
      prodMockRouteBody.code === "provider_unavailable" &&
      wallet().balance === "100.00" &&
      txCount() === txBeforeProdMock &&
      rows.provider_float_balances.length === floatBeforeProdMock,
    {
      status: prodMockRoute.status,
      body: prodMockRouteBody,
      wallet: wallet().balance,
      txCount: txCount(),
      floatRows: `${floatBeforeProdMock}→${rows.provider_float_balances.length}`,
    },
  );
  check(
    "production mock: purchase response is safe (no key/token/secret/webhook sentinel)",
    serializedContainsSecrets(prodMockRouteBody).length === 0,
    prodMockRouteBody,
  );

  // Unset provider defaults to mock, so it must be rejected identically.
  resetEnv({ nodeEnv: "production" });
  env.DATA_MOCK_RESULT = "successful";
  setWalletBalance("100.00");
  const txBeforeProdUnset = txCount();
  const prodUnsetFetch = installFetchStub((url) => failFetch(url));
  const prodUnsetRoute = await purchaseRoute.POST(jsonRequest("/api/purchase", purchaseBody()));
  const prodUnsetBody = await prodUnsetRoute.json();
  prodUnsetFetch.restore();
  check(
    "production provider unset: POST /api/purchase 503, wallet untouched, no ledger/provider call",
    prodUnsetRoute.status === 503 &&
      prodUnsetBody.code === "provider_unavailable" &&
      wallet().balance === "100.00" &&
      txCount() === txBeforeProdUnset &&
      prodUnsetFetch.calls.length === 0,
    { status: prodUnsetRoute.status, body: prodUnsetBody, wallet: wallet().balance, txCount: txCount() },
  );

  // Real provider missing configuration: no fallback, no debit.
  resetEnv({ nodeEnv: "production", provider: "yenkodata" });
  setWalletBalance("100.00");
  const txBeforeProdMissingBase = txCount();
  const prodMissingBaseFetch = installFetchStub((url) => failFetch(url));
  const prodMissingBaseRoute = await purchaseRoute.POST(jsonRequest("/api/purchase", purchaseBody()));
  const prodMissingBaseBody = await prodMissingBaseRoute.json();
  prodMissingBaseFetch.restore();
  check(
    "production real provider missing base URL: 503, wallet untouched, no provider call (no mock fallback)",
    prodMissingBaseRoute.status === 503 &&
      prodMissingBaseBody.code === "provider_unavailable" &&
      wallet().balance === "100.00" &&
      txCount() === txBeforeProdMissingBase &&
      prodMissingBaseFetch.calls.length === 0,
    { status: prodMissingBaseRoute.status, body: prodMissingBaseBody, wallet: wallet().balance },
  );

  // Real provider credentials missing: same fail-closed behavior.
  resetEnv({ nodeEnv: "production", provider: "yenkodata" });
  env.DATA_API_BASE_URL = "https://aggregator.invalid";
  env.DATA_API_AUTH_TYPE = "bearer";
  setWalletBalance("100.00");
  const txBeforeProdNoCreds = txCount();
  const prodNoCredsFetch = installFetchStub((url) => failFetch(url));
  const prodNoCredsRoute = await purchaseRoute.POST(jsonRequest("/api/purchase", purchaseBody()));
  const prodNoCredsBody = await prodNoCredsRoute.json();
  prodNoCredsFetch.restore();
  check(
    "production real provider missing credentials: 503, wallet untouched, no provider call",
    prodNoCredsRoute.status === 503 &&
      prodNoCredsBody.code === "provider_unavailable" &&
      wallet().balance === "100.00" &&
      txCount() === txBeforeProdNoCreds &&
      prodNoCredsFetch.calls.length === 0,
    { status: prodNoCredsRoute.status, body: prodNoCredsBody, wallet: wallet().balance },
  );

  // The authenticated provider callback is another delivery-reporting path: a
  // production callback must not turn a legacy mock/simulated order into a
  // delivered one, but failure callbacks must keep reconciling.
  resetEnv({ nodeEnv: "production", provider: "mock" });
  env.DATA_API_WEBHOOK_SECRET = SENTINELS.webhook;
  setWalletBalance("100.00");
  const callbackTxId = 7001;
  rows.transactions.push({
    id: callbackTxId,
    ref: "FD-P6-CALLBACK-MOCK",
    wallet_id: 1,
    type: "data",
    status: "pending",
    fulfillment_status: "processing",
    direction: "out",
    title: "MTN 1GB Data",
    subtitle: "To 024 41 23 456",
    amount: "10.00",
    points: 0,
    network: "MTN",
    recipient: "0244123456",
    provider: "mock",
    provider_product_code: plan.provider_product_code,
    provider_reference: "mock-FD-P6-CALLBACK-MOCK",
    provider_status: "pending",
    provider_message: null,
    fulfillment_attempts: 1,
    charged_at: null,
    fulfilled_at: null,
    refunded_at: null,
    last_provider_sync_at: new Date(),
    provider_payload: null,
    provider_response: null,
    created_at: new Date(),
  });
  const callbackRaw = JSON.stringify({ clientReference: "FD-P6-CALLBACK-MOCK", status: "successful" });
  const callbackSignature = createHmac("sha256", SENTINELS.webhook).update(callbackRaw).digest("hex");
  const mockCallback = await callbackRoute.POST(
    new Request("http://localhost/api/purchase/callback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-data-api-signature": callbackSignature },
      body: callbackRaw,
    }),
  );
  const mockCallbackBody = await mockCallback.json();
  const mockCallbackTx = rows.transactions.find((row) => row.id === callbackTxId)!;
  check(
    "production callback cannot report a simulated/mock order as delivered (409, transaction stays pending)",
    mockCallback.status === 409 &&
      mockCallbackBody.ok === false &&
      mockCallbackBody.code === "simulated_delivery_disabled" &&
      mockCallbackTx.status === "pending" &&
      mockCallbackTx.fulfillment_status === "processing" &&
      mockCallbackTx.fulfilled_at == null &&
      mockCallbackTx.charged_at == null &&
      wallet().balance === "100.00",
    { status: mockCallback.status, body: mockCallbackBody, tx: mockCallbackTx },
  );
  check(
    "production callback refusal is safe (no key/token/secret/webhook sentinel)",
    serializedContainsSecrets(mockCallbackBody).length === 0,
    mockCallbackBody,
  );

  // The same mock transaction's REVERSAL is still allowed (refunds and
  // reconciliation must keep working while delivery reporting is locked).
  mockCallbackTx.status = "successful";
  mockCallbackTx.charged_at = new Date();
  mockCallbackTx.points = 20;
  const reversalRaw = JSON.stringify({ clientReference: "FD-P6-CALLBACK-MOCK", status: "reversed" });
  const reversalSignature = createHmac("sha256", SENTINELS.webhook).update(reversalRaw).digest("hex");
  const reversal = await callbackRoute.POST(
    new Request("http://localhost/api/purchase/callback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-data-api-signature": reversalSignature },
      body: reversalRaw,
    }),
  );
  check(
    "production callback still processes a reversal/refund for a mock legacy order",
    reversal.status === 200 && mockCallbackTx.status === "reversed" && mockCallbackTx.refunded_at != null,
    { status: reversal.status, tx: mockCallbackTx },
  );

  // Checkout (real Paystack charge path) refuses an unsafe provider before any
  // order row or Paystack initialization. Auth is still required, so an
  // unauthenticated request stops at 401 — which itself proves the provider
  // guard did NOT reject a safe-but-unauthenticated caller. The service-level
  // guard is exercised directly below.
  resetEnv({ nodeEnv: "production", provider: "mock" });
  const checkoutOrdersBefore = rows.checkout_orders?.length ?? 0;
  const checkoutRouteRes = await checkoutRoute.POST(jsonRequest("/api/checkout", purchaseBody()));
  check(
    "production mock: /api/checkout never reaches order creation or Paystack (401 auth gate; provider guard is inside createCheckoutOrder)",
    checkoutRouteRes.status === 401 && (rows.checkout_orders?.length ?? 0) === checkoutOrdersBefore,
    checkoutRouteRes.status,
  );
  let checkoutServiceError: unknown = null;
  try {
    const { createCheckoutOrder } = require("@/lib/checkout") as typeof import("@/lib/checkout");
    await createCheckoutOrder({
      userId: 1,
      walletId: 1,
      customerEmail: "provider-safety@flexidata.app",
      customerPhone: "0244123456",
      network: "MTN",
      category: plan.category,
      planLabel: plan.label,
      recipient: "0244123456",
      requestOrigin: null,
    });
  } catch (error) {
    checkoutServiceError = error;
  }
  check(
    "production mock: createCheckoutOrder fails closed before creating the order (no Paystack charge possible)",
    checkoutServiceError instanceof gateway.DataProviderConfigError &&
      (rows.checkout_orders?.length ?? 0) === checkoutOrdersBefore,
    {
      error: checkoutServiceError instanceof Error ? checkoutServiceError.message : checkoutServiceError,
      checkoutOrders: rows.checkout_orders?.length ?? 0,
    },
  );

  // =========================================================================
  // 3. No mock fallback when a configured real provider is unreachable
  // =========================================================================
  resetEnv({ nodeEnv: "production", provider: "yenkodata" });
  env.DATA_API_BASE_URL = "https://aggregator.invalid";
  env.DATA_API_AUTH_TYPE = "bearer";
  env.DATA_API_TOKEN = SENTINELS.token;
  env.DATA_API_SYNC_FLOAT_ON_PURCHASE = "false";
  const unavailableFetch = installFetchStub(() => {
    throw new Error("synthetic network unavailable");
  });
  let unavailableError: unknown = null;
  try {
    await gateway.submitDataBundleOrder({
      reference: "FD-P6-REAL-UNAVAILABLE",
      walletId: 1,
      network: "MTN",
      recipient: "0244123456",
      planLabel: plan.label,
      category: plan.category,
      providerProductCode: plan.provider_product_code,
      amount: 10,
    });
  } catch (error) {
    unavailableError = error;
  }
  unavailableFetch.restore();
  check(
    "production real provider unreachable: throws DataProviderRequestError, one real call, NO mock delivery fallback",
    unavailableError instanceof gateway.DataProviderRequestError &&
      unavailableFetch.calls.length === 1 &&
      !(unavailableError instanceof gateway.DataProviderConfigError),
    {
      error: unavailableError instanceof Error ? unavailableError.message : unavailableError,
      fetchCalls: unavailableFetch.calls.length,
    },
  );

  // =========================================================================
  // 4. Development/test simulation still works (debit, delivered, refund)
  // =========================================================================
  resetEnv({ nodeEnv: "development", provider: "mock" });
  env.DATA_MOCK_RESULT = "successful";
  env.FLEXIDATA_TEST_USER_ID = "1";
  setWalletBalance("100.00");
  const txBeforeDevSuccess = txCount();
  const devFetch = installFetchStub((url) => failFetch(url));
  const devSuccess = await purchaseRoute.POST(jsonRequest("/api/purchase", purchaseBody()));
  const devSuccessBody = await devSuccess.json();
  devFetch.restore();
  const devTx = lastTx();
  check(
    "development mock success: purchase succeeds, wallet debited once (100→90), ledger shows delivered",
    devSuccess.status === 200 &&
      devSuccessBody.ok === true &&
      devSuccessBody.status === "successful" &&
      devSuccessBody.provider === "mock" &&
      devSuccessBody.fulfillmentStatus === "delivered" &&
      wallet().balance === "90.00" &&
      txCount() === txBeforeDevSuccess + 1 &&
      devTx?.status === "successful" &&
      devTx?.fulfillment_status === "delivered" &&
      devTx?.charged_at != null &&
      devTx?.fulfilled_at != null &&
      devFetch.calls.length === 0,
    {
      status: devSuccess.status,
      body: devSuccessBody,
      wallet: wallet().balance,
      tx: devTx,
    },
  );

  resetEnv({ nodeEnv: "test", provider: "mock" });
  env.DATA_MOCK_RESULT = "successful";
  env.FLEXIDATA_TEST_USER_ID = "1";
  setWalletBalance("100.00");
  const txBeforeTestSuccess = txCount();
  const testSuccess = await purchaseRoute.POST(jsonRequest("/api/purchase", purchaseBody()));
  const testSuccessBody = await testSuccess.json();
  check(
    "test-environment mock simulation still works (NODE_ENV=test, not treated as production)",
    testSuccess.status === 200 &&
      testSuccessBody.ok === true &&
      testSuccessBody.provider === "mock" &&
      wallet().balance === "90.00" &&
      txCount() === txBeforeTestSuccess + 1,
    { status: testSuccess.status, body: testSuccessBody, wallet: wallet().balance },
  );

  // Simulated provider failure must still debit-then-refund (existing atomic
  // debit/refund behavior preserved by the new preflight).
  resetEnv({ nodeEnv: "development", provider: "mock" });
  env.DATA_MOCK_RESULT = "failed";
  env.FLEXIDATA_TEST_USER_ID = "1";
  setWalletBalance("100.00");
  const txBeforeDevFailure = txCount();
  const devFailure = await purchaseRoute.POST(jsonRequest("/api/purchase", purchaseBody()));
  const devFailureBody = await devFailure.json();
  const devFailedTx = lastTx();
  check(
    "development mock failure: atomic debit is refunded (balance back to 100), ledger failed/not charged",
    devFailure.status === 200 &&
      devFailureBody.ok === true &&
      devFailureBody.status === "failed" &&
      wallet().balance === "100.00" &&
      txCount() === txBeforeDevFailure + 1 &&
      devFailedTx?.status === "failed" &&
      devFailedTx?.charged_at == null &&
      devFailedTx?.fulfilled_at == null,
    { status: devFailure.status, body: devFailureBody, wallet: wallet().balance, tx: devFailedTx },
  );

  // A misconfigured REAL provider in development must not be rescued by mock.
  resetEnv({ nodeEnv: "development", provider: "yenkodata" });
  env.FLEXIDATA_TEST_USER_ID = "1";
  setWalletBalance("100.00");
  const txBeforeDevMisconfig = txCount();
  const devMisconfigFetch = installFetchStub((url) => failFetch(url));
  const devMisconfig = await purchaseRoute.POST(jsonRequest("/api/purchase", purchaseBody()));
  const devMisconfigBody = await devMisconfig.json();
  devMisconfigFetch.restore();
  check(
    "development real provider misconfigured: 503 before debit, no mock fallback",
    devMisconfig.status === 503 &&
      devMisconfigBody.code === "provider_unavailable" &&
      wallet().balance === "100.00" &&
      txCount() === txBeforeDevMisconfig &&
      devMisconfigFetch.calls.length === 0,
    { status: devMisconfig.status, body: devMisconfigBody, wallet: wallet().balance },
  );

  // =========================================================================
  // 5. Configured real-provider interface is unchanged (stubbed fetch only)
  // =========================================================================
  resetEnv({ nodeEnv: "production", provider: "yenkodata" });
  env.DATA_API_BASE_URL = "https://aggregator.invalid";
  env.DATA_API_AUTH_TYPE = "bearer";
  env.DATA_API_TOKEN = SENTINELS.token;
  env.DATA_API_SYNC_FLOAT_ON_PURCHASE = "false";
  env.DATA_API_TIMEOUT_MS = "5000";
  const realCalls = installFetchStub(
    () =>
      new Response(
        JSON.stringify({
          ok: true,
          status: "successful",
          reference: "AGG-REF-1",
          message: "Bundle delivered",
          balance: 8123.45,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const realResult = await gateway.submitDataBundleOrder({
    reference: "FD-P6-REAL-OK",
    walletId: 1,
    network: "MTN",
    recipient: "0244123456",
    planLabel: plan.label,
    category: plan.category,
    providerProductCode: plan.provider_product_code,
    amount: 10,
  });
  realCalls.restore();
  const realCall = realCalls.calls[0];
  const realHeaders = (realCall?.init.headers ?? {}) as Record<string, string>;
  const realBody = JSON.parse(String(realCall?.init.body ?? "{}")) as Record<string, unknown>;
  check(
    "configured real provider in production: exact URL/method/bearer auth/payload preserved",
    realCall?.url === "https://aggregator.invalid/api/v1/data/purchase" &&
      realCall?.init.method === "POST" &&
      realHeaders.Authorization === `Bearer ${SENTINELS.token}` &&
      realBody.reference === "FD-P6-REAL-OK" &&
      realBody.network === "MTN" &&
      realBody.bundleCode === plan.provider_product_code &&
      realBody.amount === 10,
    {
      url: realCall?.url,
      method: realCall?.init.method,
      authShape: realHeaders.Authorization ? "Bearer <redacted>" : null,
      body: realBody,
    },
  );
  check(
    "configured real provider result normalization unchanged (delivered + provider reference + float)",
    realResult.status === "successful" &&
      realResult.fulfillmentStatus === "delivered" &&
      realResult.providerCode === "yenkodata" &&
      realResult.providerReference === "AGG-REF-1" &&
      realResult.floatBalance === 8123.45 &&
      serializedContainsSecrets(realResult).length === 0,
    {
      status: realResult.status,
      fulfillmentStatus: realResult.fulfillmentStatus,
      providerCode: realResult.providerCode,
      providerReference: realResult.providerReference,
      floatBalance: realResult.floatBalance,
    },
  );

  // =========================================================================
  // 6. /api/health visibility and secrecy
  // =========================================================================
  async function healthFor(options: { nodeEnv: string; provider?: string | null }, extra?: () => void) {
    resetEnv({ nodeEnv: options.nodeEnv, provider: options.provider });
    env.DATA_API_KEY = SENTINELS.key;
    env.DATA_API_SECRET = SENTINELS.secret;
    env.DATA_API_TOKEN = SENTINELS.token;
    env.DATA_API_ACCOUNT_ID = SENTINELS.account;
    env.DATA_API_WEBHOOK_SECRET = SENTINELS.webhook;
    extra?.();
    const response = await healthRoute.GET();
    const body = await response.json();
    return { response, body };
  }

  let health = await healthFor({ nodeEnv: "production", provider: "mock" });
  check(
    "health production mock: provider mock, mode mock, unsafe/unavailable, existing fields and ok preserved",
    health.response.status === 200 &&
      health.body.ok === true &&
      health.body.database === "connected" &&
      health.body.dataGateway.provider === "mock" &&
      health.body.dataGateway.providerMode === "mock" &&
      health.body.dataGateway.providerConfigured === true &&
      health.body.dataGateway.providerSafe === false &&
      health.body.dataGateway.providerStatus === "unavailable" &&
      health.body.dataGateway.schema !== undefined &&
      typeof health.body.dataGateway.providerWarning === "string",
    { status: health.response.status, dataGateway: health.body.dataGateway },
  );
  check(
    "health production mock: response contains no key/token/secret/account/webhook secret",
    serializedContainsSecrets(health.body).length === 0,
    serializedContainsSecrets(health.body),
  );

  health = await healthFor({ nodeEnv: "production" });
  check(
    "health production provider unset: reported as unsafe/unavailable, not healthy configuration",
    health.body.ok === true &&
      health.body.dataGateway.provider === "mock" &&
      health.body.dataGateway.providerConfigured === false &&
      health.body.dataGateway.providerSafe === false &&
      health.body.dataGateway.providerStatus === "unavailable" &&
      health.body.dataGateway.providerMissing.includes("provider"),
    health.body.dataGateway,
  );
  check(
    "health production provider unset: no secrets leaked",
    serializedContainsSecrets(health.body).length === 0,
    serializedContainsSecrets(health.body),
  );

  health = await healthFor({ nodeEnv: "production", provider: "yenkodata" });
  check(
    "health production real provider missing base URL: unsafe/unavailable",
    health.body.dataGateway.provider === "yenkodata" &&
      health.body.dataGateway.providerSafe === false &&
      health.body.dataGateway.providerStatus === "unavailable" &&
      health.body.dataGateway.providerMissing.includes("base_url"),
    health.body.dataGateway,
  );

  health = await healthFor(
    { nodeEnv: "test", provider: "techlink" },
    () => {
      env.DATA_API_BASE_URL = "https://api.techlinkgh.com/api/v1";
      env.DATA_API_AUTH_TYPE = "headers";
      env.DATA_API_KEY = SENTINELS.key;
    },
  );
  check(
    "health techlink: explicitly unavailable rather than generic-ready",
    health.body.dataGateway.provider === "techlink" &&
      health.body.dataGateway.providerMode === "live" &&
      health.body.dataGateway.providerSafe === false &&
      health.body.dataGateway.providerStatus === "unavailable" &&
      health.body.dataGateway.providerMissing.includes("rollout_approval") &&
      String(health.body.dataGateway.providerWarning ?? "").includes("documented adapter contract"),
    health.body.dataGateway,
  );
  check(
    "health techlink: no key/token/secret/account/webhook secret",
    serializedContainsSecrets(health.body).length === 0,
    serializedContainsSecrets(health.body),
  );

  health = await healthFor(
    { nodeEnv: "production", provider: "yenkodata" },
    () => {
      env.DATA_API_BASE_URL = "https://aggregator.invalid";
      env.DATA_API_AUTH_TYPE = "bearer";
    },
  );
  check(
    "health production configured real provider: safe/ready, provider identity exposed",
    health.body.dataGateway.provider === "yenkodata" &&
      health.body.dataGateway.providerMode === "live" &&
      health.body.dataGateway.providerConfigured === true &&
      health.body.dataGateway.providerSafe === true &&
      health.body.dataGateway.providerStatus === "ready" &&
      health.body.dataGateway.providerWarning === undefined,
    health.body.dataGateway,
  );
  check(
    "health configured real provider: no key/token/secret/account/webhook secret",
    serializedContainsSecrets(health.body).length === 0,
    serializedContainsSecrets(health.body),
  );

  for (const nodeEnv of ["development", "test"]) {
    health = await healthFor({ nodeEnv, provider: "mock" });
    check(
      `health ${nodeEnv} mock: safe/ready simulation with a clear non-production warning`,
      health.body.dataGateway.provider === "mock" &&
        health.body.dataGateway.providerSafe === true &&
        health.body.dataGateway.providerStatus === "ready" &&
        String(health.body.dataGateway.providerWarning ?? "").includes("SIMULATED"),
      health.body.dataGateway,
    );
    check(
      `health ${nodeEnv} mock: no secrets leaked`,
      serializedContainsSecrets(health.body).length === 0,
      serializedContainsSecrets(health.body),
    );
  }

  // =========================================================================
  // Results
  // =========================================================================
  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\nchecks=${checks.length}  failed=${failed.length}`);
  if (failed.length > 0) {
    for (const entry of failed) console.log(`  FAILED: ${entry.name} -> ${JSON.stringify(entry.detail)}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete env[key];
      else env[key] = savedEnv[key];
    }
  });
