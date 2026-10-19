/**
 * Contract-injected Techlink adapter tests. Every response and request is a
 * local fixture; no Techlink host, database, payment provider or wallet is
 * contacted. The fixture names are not Techlink API fields or statuses.
 */
import assert from "node:assert/strict";
import {
  createTechlinkTestAdapter,
  type TechlinkContract,
  type TechlinkHttpRequest,
  type TechlinkHttpResponse,
} from "../src/lib/techlink";
import {
  TECHLINK_CATALOGUE,
  lookupExplicitProviderProductCode,
  lookupTechlinkProductCode,
} from "../src/lib/provider-catalogue";

const env = process.env as Record<string, string | undefined>;
const saved = { nodeEnv: env.NODE_ENV, key: env.TECHLINK_TEST_API_KEY };
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
  env.NODE_ENV = "test";
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

  delete env.TECHLINK_TEST_API_KEY;
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
    if (saved.key === undefined) delete env.TECHLINK_TEST_API_KEY; else env.TECHLINK_TEST_API_KEY = saved.key;
  });
