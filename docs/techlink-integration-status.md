# Techlink GH mobile-data integration status

**Review checkpoint:** `main` at `e25dd547d7b0654cec8383f639a23e8faf8dd585`  
**Status:** **BLOCKED before adapter implementation; fail-closed guard added.**  
**Scope:** repository/code review and networkless safety work only.

## What was verified locally

- The checkout was clean before work began on `arena/2616853a-flexidata`.
- The current source had no Techlink adapter, Techlink-specific endpoint contract,
  catalogue mapping, status verifier, callback verifier, or Techlink test suite.
- `src/lib/data-gateway.ts` has a generic HTTP adapter with heuristic response
  normalization. Before this change, an arbitrary `DATA_API_PROVIDER=techlink`
  value could reach that generic path if a base URL and generic credentials were
  supplied. That was unsafe for an unverified asynchronous provider because an
  HTTP 200 or generic success flag must not be treated as delivery evidence.
- `PurchaseLifecycle.reconcile()` is currently Reloadly-specific and
  `verifiedState()` intentionally returns `unknown` for other providers. No
  Techlink order/reference reconciliation path exists.
- The existing `bundle_plans.provider_product_code` is a single generic field.
  No verified Techlink product-ID mapping is present, and deriving a code from a
  FlexiData label is not safe for Techlink.

## Safe change in this review

`DATA_API_PROVIDER` values `techlink`, `techlink_gh`, `techlink-gh`, and
`techlinkgh` now fail closed in the shared runtime guard with
`missing: ["rollout_approval"]`. They cannot fall through the generic adapter,
reach a Techlink endpoint, debit a wallet, initialize checkout fulfillment, or
be treated as delivered. The guard message contains no credentials or provider
response data. Networkless assertions cover both the health/configuration path
and the throwing guard.

Existing `mock`, Reloadly, and generic-provider compatibility behavior was not
changed. No schema or migration was added.

## External blockers

1. **Official documentation could not be verified in this workspace.** The
   requested documentation host is outside the sandbox's permitted outbound
   hosts. The supplied endpoint list is therefore treated as unverified input,
   not as an implementation contract. No endpoint method, body, response shape,
   status value, order-ID rule, catalogue field, or callback mechanism has been
   guessed.
2. **`TECHLINK_TEST_API_KEY` was absent at runtime.** Only an environment
   presence check was performed; no key value was printed, stored, or logged.
   Therefore no authenticated GET request was made.
3. **No Techlink purchase or wallet funding was performed.** No provider
   network request of any kind was made by this review.

## Required evidence before implementing the adapter

The integration owner must provide access to the official Techlink contract and
an approved test secret through the runtime environment. The adapter review then
needs the documented values for:

- test base URL and environment/credential rules;
- exact catalogue request, network identifiers, product/bundle ID field, price
  and denomination semantics;
- purchase request fields and the provider's actual order/reference field;
- accepted, queued, pending, successful, failed, reversed and unknown status
  values, including inconsistent-response behavior;
- authoritative order lookup/verification method and correlation requirements;
- callback signature/replay mechanism, if callbacks exist;
- timeout, duplicate-submission, idempotency and reversal semantics.

Only after that evidence is available should a dedicated adapter, explicit
provider-specific catalogue mapping, server-to-server reconciliation path and
mocked contract suite be added. Until then, keeping Techlink unavailable is the
safe behavior.

## Verification boundary

The new Techlink guard checks are part of
`npm run verify:data-provider-safety`. They are network-free and do not prove
Techlink connectivity, catalogue validity, delivery, database-backed acceptance,
or operational readiness.
