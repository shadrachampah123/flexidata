/**
 * Techlink adapter tests. Every response and request is a local fixture; no
 * Techlink host, database, payment provider or wallet is contacted. The first
 * section exercises the contract-injected lifecycle seam; the second section
 * exercises the confirmed HTTP adapter through a local fetch queue.
 */
import assert from "node:assert/strict";
import {
  createTechlinkTestAdapter,
  describeTechlinkApiError,
  describeTechlinkContractError,
  describeTechlinkTransportError,
  fetchTechlinkTransport,
  type TechlinkContract,
  type TechlinkHttpRequest,
  type TechlinkHttpResponse,
  fetchTechlinkCatalogue,
  fetchTechlinkBundle,
  lookupTechlinkSandbox,
  submitTechlinkPurchase,
  TechlinkApiError,
  TechlinkContractError,
  TechlinkTransportError,
  getTechlinkRuntimeStatus,
  unresolvedTechlinkStatus,
} from "../src/lib/techlink";
import {
  TECHLINK_CATALOGUE,
  lookupExplicitProviderProductCode,
  lookupTechlinkProductCode,
} from "../src/lib/provider-catalogue";

const env = process.env as Record<string, string | undefined>;
const saved = {
  nodeEnv: env.NODE_ENV,
  vercelEnv: env.VERCEL_ENV,
  provider: env.DATA_API_PROVIDER,
  key: env.TECHLINK_TEST_API_KEY,
  mode: env.TECHLINK_MODE,
  allowPurchases: env.TECHLINK_ALLOW_PURCHASES,
};
const savedFetch = globalThis.fetch;
const fixtureKey = "fixture-key-never-sent-to-a-provider";
const order = {
  reference: "FIXTURE-ORDER-1",
  walletId: 1,
  network: "MTN" as const,
  recipient: "0244123456",
  planLabel: "fixture-plan",
  category: "fixture-category",
  providerProductCode: "fixture-product-id",
  amount: 10,
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function fixtureContract(): TechlinkContract {
  return {
    buildSubmissionRequest(input, context): TechlinkHttpRequest {
      return {
        method: "POST",
        path: "fixture-submit-path",
        headers: { "X-Fixture-Key": context.apiKey },
        body: {
          fixtureClientReference: input.reference,
          fixtureProductId: input.providerProductCode,
          fixtureRecipient: input.recipient,
        },
      };
    },
    parseSubmission(response) {
      const body = object(response.body);
      const outcome = body.fixtureOutcome;
      return {
        outcome: outcome === "accepted" || outcome === "rejected" ? outcome : "unknown",
        providerReference: typeof body.fixtureProviderReference === "string" ? body.fixtureProviderReference : null,
        providerStatus: typeof body.fixtureStatus === "string" ? body.fixtureStatus : null,
        providerMessage: typeof body.fixtureMessage === "string" ? body.fixtureMessage : null,
        auditResponse: { fixtureOutcome: outcome, fixtureProviderReference: body.fixtureProviderReference },
      };
    },
    buildLookupRequest(context): TechlinkHttpRequest {
      return {
        method: "GET",
        path: `fixture-lookup-path/${context.providerReference}`,
        headers: { "X-Fixture-Key": context.apiKey },
      };
    },
    parseLookup(response, context) {
      const body = object(response.body);
      const outcome = body.fixtureOutcome;
      return {
        outcome: outcome === "delivered" || outcome === "failed" || outcome === "pending" ? outcome : "unknown",
        clientReference: typeof body.fixtureClientReference === "string" ? body.fixtureClientReference : context.clientReference,
        providerReference: typeof body.fixtureProviderReference === "string" ? body.fixtureProviderReference : context.providerReference,
        trusted: body.fixtureTrusted === true,
        providerStatus: typeof body.fixtureStatus === "string" ? body.fixtureStatus : null,
        providerMessage: typeof body.fixtureMessage === "string" ? body.fixtureMessage : null,
        auditResponse: { fixtureOutcome: outcome, fixtureTrusted: body.fixtureTrusted },
      };
    },
    // Deliberately absent: no callback is accepted without a documented
    // Techlink authenticity contract.
  };
}

async function main() {
  env.DATA_API_PROVIDER = "techlink";
  env.TECHLINK_MODE = "sandbox";
  env.TECHLINK_TEST_API_KEY = fixtureKey;
  delete env.TECHLINK_ALLOW_PURCHASES;

  // Vercel Preview uses NODE_ENV=production. It must permit only the
  // authenticated read-only catalogue, while ordinary/Production runtimes
  // remain blocked and missing sandbox variables still fail closed.
  env.NODE_ENV = "production";
  env.VERCEL_ENV = "preview";
  let runtime = getTechlinkRuntimeStatus();
  assert.equal(runtime.readOnlySafe, true);
  assert.equal(runtime.safe, false);
  assert(runtime.missing.includes("purchase_opt_in"));
  console.log("PASS Vercel Preview with sandbox variables is read-only catalogue-safe despite NODE_ENV=production");

  env.VERCEL_ENV = "production";
  runtime = getTechlinkRuntimeStatus();
  assert.equal(runtime.readOnlySafe, false);
  assert(runtime.missing.includes("rollout_approval"));
  console.log("PASS Vercel Production remains blocked");

  delete env.VERCEL_ENV;
  runtime = getTechlinkRuntimeStatus();
  assert.equal(runtime.readOnlySafe, false);
  assert(runtime.missing.includes("rollout_approval"));
  console.log("PASS non-Vercel NODE_ENV=production remains blocked");

  env.NODE_ENV = "test";
  delete env.TECHLINK_MODE;
  runtime = getTechlinkRuntimeStatus();
  assert.equal(runtime.readOnlySafe, false);
  assert(runtime.missing.includes("mode"));
  env.TECHLINK_MODE = "sandbox";
  delete env.TECHLINK_TEST_API_KEY;
  runtime = getTechlinkRuntimeStatus();
  assert.equal(runtime.readOnlySafe, false);
  assert(runtime.missing.includes("credentials"));
  console.log("PASS missing TECHLINK_MODE or TECHLINK_TEST_API_KEY fails closed");

  env.TECHLINK_TEST_API_KEY = fixtureKey;
  const calls: TechlinkHttpRequest[] = [];
  const responses: TechlinkHttpResponse[] = [];
  const transport = async (request: TechlinkHttpRequest): Promise<TechlinkHttpResponse> => {
    calls.push(request);
    const next = responses.shift();
    if (!next) throw new Error("fixture transport exhausted");
    return next;
  };
  const adapter = createTechlinkTestAdapter({
    baseUrl: "https://fixture.invalid",
    contract: fixtureContract(),
    transport,
    timeoutMs: 1000,
  });

  responses.push({ status: 202, body: {
    fixtureOutcome: "accepted", fixtureProviderReference: "FIXTURE-PROVIDER-1", fixtureStatus: "fixture-accepted",
    fixtureMessage: "accepted fixture",
  } });
  const accepted = await adapter.submit(order);
  assert.equal(accepted.status, "pending");
  assert.equal(accepted.fulfillmentStatus, "processing");
  assert.equal(accepted.providerReference, "FIXTURE-PROVIDER-1");
  assert.equal(accepted.providerStatus, "accepted");
  assert.notEqual(accepted.fulfillmentStatus, "delivered");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "fixture-submit-path");
  assert.equal(JSON.stringify(accepted).includes(fixtureKey), false);
  console.log("PASS accepted submission remains pending and is sent once");

  responses.push({ status: 401, body: {
    fixtureOutcome: "rejected", fixtureProviderReference: "FIXTURE-PROVIDER-401", fixtureStatus: "fixture-unauthorized",
  } });
  const unauthorized = await adapter.submit({ ...order, reference: "FIXTURE-ORDER-401" });
  assert.equal(unauthorized.status, "pending");
  assert.equal(unauthorized.providerStatus, "unknown");
  console.log("PASS HTTP 401 remains unresolved and is not retried or treated as rejection");

  responses.push({ status: 200, body: {
    fixtureOutcome: "rejected", fixtureProviderReference: "FIXTURE-PROVIDER-2", fixtureStatus: "fixture-rejected",
    fixtureMessage: "rejected fixture",
  } });
  const rejected = await adapter.submit({ ...order, reference: "FIXTURE-ORDER-2" });
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.fulfillmentStatus, "failed");
  console.log("PASS explicitly parsed fixture rejection is failed without retry");

  responses.push({ status: 200, body: {
    fixtureOutcome: "delivered", fixtureClientReference: order.reference,
    fixtureProviderReference: "FIXTURE-PROVIDER-1", fixtureTrusted: true, fixtureStatus: "fixture-terminal",
  } });
  const delivered = await adapter.lookup(order.reference, "FIXTURE-PROVIDER-1");
  assert.equal(delivered.status, "successful");
  assert.equal(delivered.fulfillmentStatus, "delivered");
  assert.equal(delivered.providerStatus, "delivered");
  console.log("PASS only a correlated trusted fixture lookup can deliver");

  responses.push({ status: 200, body: {
    fixtureOutcome: "delivered", fixtureClientReference: "WRONG-CLIENT",
    fixtureProviderReference: "FIXTURE-PROVIDER-1", fixtureTrusted: true,
  } });
  const mismatch = await adapter.lookup(order.reference, "FIXTURE-PROVIDER-1");
  assert.equal(mismatch.status, "pending");
  assert.equal(mismatch.fulfillmentStatus, "processing");
  console.log("PASS mismatched fixture correlation remains unresolved");

  responses.push({ status: 200, body: {
    fixtureOutcome: "pending", fixtureClientReference: order.reference,
    fixtureProviderReference: "FIXTURE-PROVIDER-1", fixtureTrusted: true, fixtureStatus: "fixture-pending",
  } });
  const pending = await adapter.lookup(order.reference, "FIXTURE-PROVIDER-1");
  assert.equal(pending.status, "pending");
  console.log("PASS nonterminal fixture lookup remains pending");

  responses.push({ status: 200, body: {
    fixtureOutcome: "failed", fixtureClientReference: order.reference,
    fixtureProviderReference: "FIXTURE-PROVIDER-1", fixtureTrusted: true, fixtureStatus: "fixture-failed",
  } });
  const failed = await adapter.lookup(order.reference, "FIXTURE-PROVIDER-1");
  assert.equal(failed.status, "failed");
  assert.equal(failed.fulfillmentStatus, "failed");
  assert.equal(failed.providerStatus, "rejected");
  console.log("PASS correlated trusted fixture failure is terminally failed");

  responses.push({ status: 200, body: { malformed: true } });
  const malformed = await adapter.lookup(order.reference, "FIXTURE-PROVIDER-1");
  assert.equal(malformed.status, "pending");
  assert.equal(malformed.fulfillmentStatus, "processing");
  console.log("PASS malformed fixture response remains unresolved");

  const timeoutAdapter = createTechlinkTestAdapter({
    baseUrl: "https://fixture.invalid",
    contract: fixtureContract(),
    transport: async () => { throw new Error("synthetic timeout"); },
  });
  const uncertain = await timeoutAdapter.submit(order);
  assert.equal(uncertain.status, "pending");
  assert.equal(uncertain.providerReference, null);
  console.log("PASS transport failure is uncertain with no automatic resubmission");

  assert.equal(adapter.verifyCallback(order.reference, "FIXTURE-PROVIDER-1", { fixture: true }), null);
  console.log("PASS callback is refused when no authenticity contract is supplied");

  assert.equal(TECHLINK_CATALOGUE.length, 0);
  assert.equal(lookupTechlinkProductCode({ network: "MTN", category: "fixture-category", label: "fixture-plan" }), null);
  const fixtureCatalogue = [{
    network: "MTN", category: "fixture-category", label: "fixture-plan", providerProductCode: "fixture-explicit-id",
  }] as const;
  assert.equal(lookupExplicitProviderProductCode(fixtureCatalogue, fixtureCatalogue[0]), "fixture-explicit-id");
  assert.equal(lookupExplicitProviderProductCode(fixtureCatalogue, { ...fixtureCatalogue[0], label: "different" }), null);
  console.log("PASS catalogue resolver accepts only exact explicit entries; Techlink catalogue remains empty");

  // Exercise the confirmed HTTP contract through the real server-only adapter,
  // but replace fetch with a local queue. No Techlink host is contacted.
  const officialResponses: Array<{ status: number; body: unknown }> = [];
  const officialCalls: Array<{ input: string; init: RequestInit | undefined }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    officialCalls.push({ input: String(input), init });
    const next = officialResponses.shift();
    if (!next) throw new Error("official fixture transport exhausted");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  env.TECHLINK_MODE = "sandbox";
  env.NODE_ENV = "production";
  delete env.VERCEL_ENV;
  await assert.rejects(fetchTechlinkCatalogue("MTN", order.recipient), (error: unknown) =>
    error instanceof Error && error.name === "TechlinkConfigurationError",
  );
  assert.equal(officialCalls.length, 0);
  console.log("PASS the reported production-style configuration failure is reproduced without a provider call");
  // Reproduce the Vercel Preview runtime: NODE_ENV is production, but the
  // read-only catalogue must still be allowed with the sandbox variables.
  env.NODE_ENV = "production";
  env.VERCEL_ENV = "preview";
  delete env.TECHLINK_ALLOW_PURCHASES;

  officialResponses.push({ status: 200, body: {
    success: true,
    provider: "fixture-techlink",
    bundles: [{ id: "live-bundle-1", name: "Fixture 1GB", size: "1GB", price: 12.5, validity: "7 days" }],
  } });
  const liveCatalogue = await fetchTechlinkCatalogue("MTN", "0240940228");
  assert.equal(liveCatalogue.bundles[0].id, "live-bundle-1");
  const catalogueCall = officialCalls[0];
  const catalogueUrl = new URL(catalogueCall.input);
  assert.equal(catalogueUrl.origin, "https://api.techlinkgh.com");
  assert.equal(catalogueUrl.pathname, "/api/v1/data/bundles");
  assert.equal(catalogueUrl.search, "?network=MTN&phone=233240940228");
  const catalogueHeaders = new Headers(catalogueCall.init?.headers);
  assert.equal(catalogueHeaders.get("accept"), "application/json");
  assert.equal(catalogueHeaders.get("x-api-key"), fixtureKey);
  console.log("PASS Preview catalogue uses the documented /data/bundles path, MTN/233 query, and x-api-key header");

  env.NODE_ENV = "test";
  delete env.VERCEL_ENV;
  env.TECHLINK_ALLOW_PURCHASES = "true";

  officialResponses.push({ status: 200, body: {
    success: true,
    provider: "fixture-techlink",
    bundles: [{ id: "live-bundle-1", name: "Fixture 1GB", size: "1GB", price: 12.5, validity: "7 days" }],
  } });
  assert.equal((await fetchTechlinkBundle("MTN", order.recipient, "live-bundle-1")).price, 12.5);
  console.log("PASS purchase resolution rechecks the exact ID against a fresh catalogue");

  officialResponses.push({ status: 200, body: { success: true, provider: "fixture-techlink", bundles: [{ id: "x" }] } });
  await assert.rejects(fetchTechlinkCatalogue("MTN", order.recipient), (error: unknown) =>
    error instanceof TechlinkContractError && error.httpStatus === 200,
  );
  assert.deepEqual(describeTechlinkContractError(new TechlinkContractError(200)), {
    category: "contract",
    code: "techlink_response_invalid",
    message: "Techlink catalogue response could not be verified",
    upstreamStatus: 200,
    responseStatus: 502,
  });
  assert.deepEqual(describeTechlinkTransportError(new TechlinkTransportError("timeout")), {
    category: "timeout",
    code: "techlink_timeout",
    message: "Techlink catalogue request timed out",
    upstreamStatus: null,
    responseStatus: 503,
  });
  assert.equal(JSON.stringify(describeTechlinkTransportError(new TechlinkTransportError("network"))).includes(fixtureKey), false);
  console.log("PASS malformed response preserves HTTP status; timeout/network diagnostics are safe and categorized");

  officialResponses.push({ status: 401, body: { success: false, message: "unauthorized fixture" } });
  await assert.rejects(fetchTechlinkCatalogue("MTN", order.recipient), (error: unknown) =>
    error instanceof TechlinkApiError && error.httpStatus === 401,
  );
  const authenticationError = new TechlinkApiError(401, "provider detail is never returned", "authentication");
  assert.deepEqual(describeTechlinkApiError(authenticationError), {
    category: "authentication",
    code: "techlink_authentication_failed",
    message: "Techlink authentication failed",
    upstreamStatus: 401,
    responseStatus: 503,
  });
  officialResponses.push({ status: 403, body: null });
  await assert.rejects(fetchTechlinkCatalogue("MTN", order.recipient), (error: unknown) =>
    error instanceof TechlinkApiError &&
      error.httpStatus === 403 &&
      error.category === "authorization",
  );
  assert.equal(describeTechlinkApiError(new TechlinkApiError(403, "provider detail is never returned", "authorization")).upstreamStatus, 403);
  officialResponses.push({ status: 200, body: { success: false, message: "provider rejection fixture" } });
  await assert.rejects(fetchTechlinkCatalogue("MTN", order.recipient), (error: unknown) =>
    error instanceof TechlinkApiError &&
      error.httpStatus === 200 &&
      error.category === "provider_rejected",
  );
  const rejectedEnvelope = new TechlinkApiError(200, "provider detail is never returned", "provider_rejected");
  const rejectedDiagnostic = describeTechlinkApiError(rejectedEnvelope);
  assert.equal(rejectedDiagnostic.category, "provider_rejected");
  assert.equal(rejectedDiagnostic.upstreamStatus, 200);
  assert.equal(rejectedDiagnostic.responseStatus, 502);
  assert.equal(JSON.stringify(rejectedDiagnostic).includes(fixtureKey), false);
  assert.equal(JSON.stringify(rejectedDiagnostic).includes(order.recipient), false);
  console.log("PASS HTTP 401 and HTTP 200 provider rejection retain safe category/status diagnostics without secrets or phone");

  officialResponses.push({ status: 201, body: {
    success: true, message: "accepted fixture", orderId: "techlink-order-1", newBalance: 98.5,
  } });
  const acceptedOfficial = await submitTechlinkPurchase(order);
  assert.equal(acceptedOfficial.status, "pending");
  assert.equal(acceptedOfficial.providerReference, "techlink-order-1");
  assert.equal(acceptedOfficial.fulfillmentStatus, "processing");
  const purchaseCall = officialCalls[officialCalls.length - 1];
  assert.equal(new URL(purchaseCall.input).pathname, "/api/v1/data/purchase");
  assert.deepEqual(JSON.parse(String(purchaseCall.init?.body)), {
    network: "MTN",
    phone: "233244123456",
    bundleId: "fixture-product-id",
  });
  console.log("PASS HTTP 201 plus success is accepted evidence, never delivery; purchase body is exact");

  officialResponses.push({ status: 400, body: { success: false, message: "insufficient balance" } });
  const insufficientOfficial = await submitTechlinkPurchase({ ...order, reference: "INSUFFICIENT" });
  assert.equal(insufficientOfficial.status, "failed");
  assert.equal(insufficientOfficial.providerStatus, "rejected");
  console.log("PASS explicit insufficient-balance rejection is surfaced without retry");

  globalThis.fetch = (async () => { throw new Error("synthetic timeout"); }) as typeof fetch;
  const timedOutOfficial = await submitTechlinkPurchase({ ...order, reference: "TIMEOUT" });
  assert.equal(timedOutOfficial.status, "pending");
  assert.equal(timedOutOfficial.providerReference, null);
  console.log("PASS purchase timeout remains ambiguous and is not blindly retried");

  globalThis.fetch = previousFetch;
  officialResponses.push({ status: 200, body: {
    success: true, orderId: "techlink-order-1", status: "fixture-final-status", changed: true, message: "verified fixture",
  } });
  // Reinstall the fixture fetch only for the verification read.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    officialCalls.push({ input: String(input), init });
    const next = officialResponses.shift();
    if (!next) throw new Error("official fixture transport exhausted");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const finalStatus = await lookupTechlinkSandbox("FIXTURE-ORDER-1", "techlink-order-1");
  assert.equal(finalStatus.status, "pending");
  assert.equal(unresolvedTechlinkStatus("fixture-final-status"), "unknown");
  console.log("PASS undocumented final-status vocabulary remains unresolved");
  globalThis.fetch = previousFetch;

  delete env.TECHLINK_TEST_API_KEY;
  delete env.TECHLINK_MODE;
  delete env.TECHLINK_ALLOW_PURCHASES;
  assert.throws(() => createTechlinkTestAdapter({
    baseUrl: "https://fixture.invalid", contract: fixtureContract(), transport,
  }), /TECHLINK_TEST_API_KEY/);
  console.log("PASS absent test credential fails closed without exposing a value");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (saved.nodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = saved.nodeEnv;
    if (saved.vercelEnv === undefined) delete env.VERCEL_ENV; else env.VERCEL_ENV = saved.vercelEnv;
    if (saved.provider === undefined) delete env.DATA_API_PROVIDER; else env.DATA_API_PROVIDER = saved.provider;
    if (saved.key === undefined) delete env.TECHLINK_TEST_API_KEY; else env.TECHLINK_TEST_API_KEY = saved.key;
    if (saved.mode === undefined) delete env.TECHLINK_MODE; else env.TECHLINK_MODE = saved.mode;
    if (saved.allowPurchases === undefined) delete env.TECHLINK_ALLOW_PURCHASES; else env.TECHLINK_ALLOW_PURCHASES = saved.allowPurchases;
    globalThis.fetch = savedFetch;
  });
