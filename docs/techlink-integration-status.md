# Techlink GH mobile-data integration status

**Review checkpoint:** `arena/2616853a-flexidata` at the current working commit
**Status:** **Sandbox adapter and live-catalogue seam implemented; production and live
fulfillment remain disabled.**
**Scope:** server-only adapter, authenticated read-only catalogue path, durable
purchase wiring, conservative reconciliation, and networkless verification.

## Contract supplied for this implementation

The implementation uses only the provider facts supplied with the official
Postman contract request. The base URL is fixed to
`https://api.techlinkgh.com/api/v1` and the key is sent only server-side as
`x-api-key`.

Implemented paths:

| Operation | Contract used by the adapter |
| --- | --- |
| Catalogue | `GET /data/bundles?network={network}&phone={phone}`; validates `success` and each `bundles[]` entry's `id`, `name`, `size`, `price`, and `validity`. A top-level upstream `provider` field is optional; the adapter uses its trusted internal `techlink` identity instead. |
| Purchase | `POST /data/purchase` with exactly `{ network, phone, bundleId }`; HTTP 201 plus `success`, `message`, `orderId`, and `newBalance` is accepted/submitted evidence only. |
| History | `GET /orders?page=1&limit=25`, exposed as a validated JSON envelope for operator/reconciliation tooling. |
| Single order | `GET /orders/:id`, exposed as a validated JSON envelope. |
| Verification | `POST /orders/:orderId/verify`; validates `success`, `orderId`, `status`, `changed`, and `message`, then requires a separate status classifier before a terminal state can be produced. |

The first implementation incorrectly made `provider` a required catalogue
field. The available contract record identifies the `success` envelope and the
`bundles[]` fields below, but does not provide an independently captured
response example requiring a top-level provider value. The authenticated
read-only Preview diagnostic then returned HTTP 200 with `success` accepted and
`provider` absent. The parser now accepts that documented shape, still rejects a
malformed provider when the optional field is present, and derives the internal
provider identity from the trusted `TECHLINK_PROVIDER_CODE` constant rather than
from an upstream value.

The authenticated Preview response has since shown `bundles[].size` present with
an allowlisted `null` type on at least one bundle. The supplied contract does not
say whether null is permitted or define another size field, so the parser remains
fail-closed for null and reports only the affected bundle index plus types for a
small diagnostic-only allowlist of related field names. It does not invent a size
or accept an alternate field until the official contract confirms its meaning.

No generic provider response normalizer handles Techlink. `data-gateway.ts`
directs Techlink submissions to `src/lib/techlink.ts`, which uses one HTTPS
request, a timeout, no redirects, and no automatic retry. Provider error text and
credentials are not returned to clients or stored in raw form.

## Catalogue and purchase boundary

- `/api/data/catalogue` is authenticated and read-only. It uses the wallet's
  selected recipient phone and never exposes the API key.
- The data selector uses current catalogue rows when `DATA_API_PROVIDER` is a
  Techlink alias. Each displayed plan carries the exact `id` returned by that
  authenticated catalogue response; the local numeric UI ID is only a display
  key.
- Before wallet or Paystack fulfillment, the server fetches the current
  authenticated catalogue again and requires an exact `bundleId` match. It uses
  the live provider price and rejects a stale/missing ID; it never derives an ID
  from network, category, label, size, or price.
- Seeded `bundle_plans.provider_product_code` values and fixed FlexiData bundle
  categories are not treated as Techlink mappings. If a live catalogue cannot be
  read, the Techlink UI has no purchasable fallback.
- The same exact-ID/live-price resolution is used by the Paystack checkout path.
  Checkout still refuses to initialize when the provider runtime is not safely
  configured.

## Lifecycle and safety guarantees

- `PurchaseLifecycle` still creates the durable attempt and wallet debit before
  the one provider POST, marks the attempt submitted before network I/O, and
  never blindly retries an ambiguous timeout or malformed response.
- A Techlink HTTP 201/`success` response becomes `pending` with the correlated
  `orderId`; it is never marked delivered from submission evidence.
- Reconciliation uses the authenticated `/orders/:orderId/verify` endpoint and
  exact order-ID correlation. Callback processing is explicitly refused for
  Techlink because no documented callback signature, replay, or authenticity
  contract has been supplied.
- The provider runtime is enabled only when `TECHLINK_MODE=sandbox` and
  `TECHLINK_TEST_API_KEY` are present. Vercel Preview runs with
  `NODE_ENV=production`, so the adapter uses the Vercel system variable
  `VERCEL_ENV=preview` to permit the read-only catalogue only. Vercel Production
  and ordinary production runtimes still fail closed. Purchase submission
  additionally requires the explicit non-production
  `TECHLINK_ALLOW_PURCHASES=true` opt-in; Preview remains read-only even if that
  flag is accidentally set. No key value is printed, logged, committed, or
  returned.
- `mock`, Reloadly, Paystack, wallet accounting, float projection, idempotency,
  attempt leasing, audit rows, and generic-provider isolation remain intact.

## Remaining provider unknowns and deliberate conservative behavior

The supplied contract summary names the verification `status` field but does
not provide its exact status vocabulary or terminal semantics. The adapter
therefore preserves the provider status as an audit field and classifies it as
`unknown` by default. A terminal `delivered` or `failed` result can be enabled
only by passing an explicitly reviewed status classifier; no common words such
as `completed`, `successful`, or `failed` are guessed as Techlink facts.

Callback security, duplicate/idempotency semantics beyond FlexiData's durable
attempt lock, reversal behavior, and the denomination/business meaning of
`newBalance` are also not asserted beyond the fields in the supplied contract.
No callback has been enabled, no live order has been created, no wallet has
been funded, and no purchase has been sent from this workspace. The repository
still contains no Techlink secret.

## Verification performed

- `npm run verify:techlink`: networkless contract fixtures plus a local-fetch
  simulation of catalogue success, exact-ID revalidation, malformed response,
  HTTP 401, HTTP 201 acceptance, insufficient-balance rejection, timeout, and
  unresolved final status.
- `npm run verify:data-provider-safety`: provider isolation, fail-closed config,
  no-debit preflight, callback refusal, secret-safety, and existing generic/mock
  behavior.
- The opt-in adapter test uses only a local fetch queue. It does not run unless
  invoked by a test command and does not contact Techlink. A future sandbox
  catalogue smoke test must check only key presence and skip when
  `TECHLINK_TEST_API_KEY` is absent; it must never create an order.

See [techlink-support-request.md](techlink-support-request.md) for the remaining
questions to send to Techlink before any production rollout. Do not merge PR #72
or enable production Techlink from this change.
