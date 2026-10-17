# Part 6.3 — Reloadly contract groundwork; activation BLOCKED

Review date: 2026-10-17. This is **not a completed customer fulfillment integration**.
No sandbox account calls, real purchases, production environment edits, deployments,
or customer activation were performed. All new test responses are synthetic fixtures.

## Provider decision and evidence

No concrete provider adapter was selected in the repository: `data-gateway.ts`
contained a configurable generic HTTP request and heuristic status parser. The
`yenkodata` slug in the Part 6.1/6.2 harness is a test fixture, not evidence of a
commercial integration. Default derived SKUs are not real supplier products.

Reloadly is the recommended candidate for further validation because its official
API contract and a Ghana **data** example are public:

- [API reference and downloadable OpenAPI](https://docs.reloadly.com/airtime/Top-ups)
  ([OpenAPI JSON](https://docs.reloadly.com/assets/api/airtime.json)).
- [OAuth and test credentials setup](https://developers.reloadly.com/airtime/quickstart).
- [Official Ghana data tutorial](https://www.reloadly.com/blog/how-to-make-a-data-top-up-to-an-international-phone-number/)
  explicitly distinguishes airtime operator 150 from **MTN Ghana Data**, historical
  operator 643, with fixed local denominations/descriptions. These historical
  values are test fixtures only, NOT an approved/current FlexiData catalogue.
- [Ghana coverage](https://operators.reloadly.com/mtn-airteltigo-vodafone-glo-ghana-airtime-api/)
  lists MTN, Vodafone Ghana, AirtelTigo and Glo. **Airtime coverage does not prove
  current Telecel data support.** No current Telecel data SKU or complete mapping
  of FlexiData plans has been verified. Do not sell Telecel based on this page.
- [Async submission and authoritative status lookup](https://www.reloadly.com/blog/how-to-track-the-status-of-each-top-up-you-make/).
- [Errors](https://developers.reloadly.com/airtime/error-codes).

Hubtel's [official developer portal](https://developers.hubtel.com/) advertises
Ghana data bundles across networks, but the accessible portal did not establish a
purchase/status contract. It was not used to invent a second adapter.

## Implemented boundary

`src/lib/reloadly.ts` is a sandbox-only transport, typed against the existing
`GatewayResult`. It is not a purchase orchestration service:

- `RELOADLY_MODE=sandbox`, `RELOADLY_CLIENT_ID`, `RELOADLY_CLIENT_SECRET` are
  required, server-side, with production hard-rejected. No live-host override.
- POST `https://auth.reloadly.com/oauth/token`, client-credentials grant,
  audience `https://topups-sandbox.reloadly.com`; Bearer authentication for API
  requests; versioned `Accept: application/com.reloadly.topups-v1+json`.
- POST `/topups-async`: `operatorId`, provider denomination `amount`,
  `useLocalAmount: true`, `customIdentifier`, `recipientPhone {countryCode,number}`.
  The retail price must NEVER be used as the provider denomination implicitly.
- Async `{transactionId}` means accepted/pending, not delivered. Preserve this
  ID and the client reference. GET `/topups/{transactionId}/status` must correlate
  the nested transaction ID and `customIdentifier` before terminal normalization.
- Only exact, mutually consistent `SUCCESSFUL` / `FAILED` terminal statuses are
  recognized. All other responses remain pending/unknown. HTTP success, status
  substrings, top-level success flags and provider error messages cannot deliver.
- Twenty-second abort deadline, no automatic retries (including token refresh /
  401 retries), no redirects. Timeout, connection loss, malformed reply, 409,
  5xx and uncorrelated status retain uncertain/pending outcomes. No automatic
  refund based on these. `customIdentifier` is NOT assumed to deduplicate purchases.
- Token responses, raw responses, remote error strings and credentials are not
  returned or logged. No provider wallet currency is assumed to be GHS float.
- No provider callback authentication contract was established. Legacy generic
  callbacks, even signed ones and replays, cannot settle a Reloadly ledger row.

`DATA_API_PROVIDER=reloadly` is recognized by the shared runtime gate used by
wallet purchase, checkout creation and health, and **always unavailable**, in
all runtimes. It reports missing category `rollout_approval` and an inert operator
warning. Adding credentials or environment flags cannot unlock it. It cannot
fall through to the generic gateway or mock. The transport is deliberately not
invoked from money-moving routes while prerequisites below are unresolved.
Existing generic gateway behavior is retained for compatibility, not endorsed as
an approved provider integration. Do not configure arbitrary slugs to bypass the
Reloadly lock. There is no new live-activation flag.

## Existing lifecycle trace and required work before activation

1. `/api/purchase` authenticates, resolves the plan, checks provider safety,
   atomically conditionally debits the wallet, checks float, calls the gateway,
   refunds definitive failure, then inserts the transaction/provider reference.
   **Gap:** debit + durable attempt are not one DB transaction; a crash/exception
   before ledger insertion leaves no durable reconciliation claim. There is no
   client idempotency key on wallet purchase; repeated HTTP POSTs get fresh refs.
2. Checkout creation calls the same provider guard before order insert/Paystack
   initialization. Verified paid orders use a conditional `paid -> fulfilling`
   claim, submit once, mirror to the ledger and park errors without auto-retry.
   **Gap:** Reloadly status polling/atomic final settlement is not implemented;
   checkout-to-ledger and loyalty transitions need concurrency/crash tests.
3. `/api/track/[ref]` reads the ledger; it is not a provider poller. Legacy
   `/api/purchase/callback` supports a generic shared-secret/HMAC contract, not
   an established Reloadly webhook protocol. Reloadly callbacks are now refused.
4. Existing mock delivery/refund tests remain intact. They do NOT establish that
   real-provider wallet refund/reconciliation is safe after uncertain submission.

### External blockers and exact next actions

| Blocker | Next action / evidence required |
| --- | --- |
| No legitimately available test credentials | Account owner obtains **test-mode** credentials from Reloadly dashboard; provide via approved server secret store, never chat/Git. Run account-backed sandbox contract tests without using production credentials. Sandbox host is also outside this workspace's allowed outbound hosts. |
| No verified Telecel data catalogue / plan mapping | Obtain current GH data operator catalogue, confirm Telecel data support with Reloadly, validate every plan denomination/description and commercial pricing. Do not use historical operator IDs or derived SKUs as approved products. If unavailable choose another documented supplier. |
| No evidence of business/commercial approval or production credentials | Account owner confirms provider onboarding, Ghana network permissions, limits, commercial terms and funds; record approval without secrets. Credentials merely being configurable is not approval. |
| No established deduplication or lookup after response loss | Obtain documented duplicate/custom-reference lookup semantics and retention guarantees from Reloadly. Until then keep ambiguous submissions parked; reconcile against provider account history/support, never blindly POST again or refund. |

### Engineering prerequisites (not external dependencies)

Implement a durable wallet debit + unique attempt claim in one transaction,
client retry idempotency, persistent pre-submission references, scheduled
status/history reconciliation, and single-winner finalization shared by wallet
and checkout. Handle crash-before/after-send, no-ID uncertain outcomes, provider
rejection/refund exactly once, points and float settlement, and terminal replay
races. Test with real PostgreSQL as well as networkless simulations. Review
schema needs separately; no migration was justified for this blocked groundwork.
A code review and explicit rollout approval are required before removing the
code lock. Do not interpret passing offline fixtures as those prerequisites.

## Verification

`npm run verify:reloadly` uses a global fetch stub and the existing schema simulator.
It covers configuration locks, exact OAuth/request payload, async pending,
correlated terminal lookup, unknown/pending/mismatched states, connection/abort,
malformed/HTTP error responses, zero automatic purchase retries, secret-safe
results, purchase/checkout preflight and signed legacy callback replay rejection.
It does not test live delivery, real sandbox access, database crash atomicity,
wallet duplicate submission protection or real-provider refunds. The unchanged
Part 5 and Part 6.1/6.2 harnesses continue to cover their existing regressions.

### Local verification results

- `npm ci`: passed; unchanged lockfile. npm audit reports **9 existing dependency
  vulnerabilities (8 high, 1 critical, including Next.js)**. No dependency
  upgrades were mixed into this provider-only patch; security remediation needs
  a separately scoped review.
- Lint, typecheck, production build with fake CI-only `DATABASE_URL`: passed.
- `verify:schema-compat`: 5/5 scenarios; `verify:seed-resilience`: 6/6.
- `verify:data-provider-safety`: 39/39; `verify:security-fixes`: 27/27.
- `verify:auth-flow`: 37/37; `verify:admin-access`: 40/40.
- `verify:withdrawals-disabled`: 76 checks, no failures (DB-backed phase skipped).
- `verify:withdrawal-lifecycle`: 81/81 (DB-free phase).
- `verify:demo-deposit-cleanup`: 19/19, 2/2 scenarios.
- `verify:reloadly`: 30/30 networkless contract/lock checks.

No existing assertions were removed or weakened. No database schema, migrations,
prices, deposits, withdrawal implementation, admin functionality or airtime-to-cash
were changed. The new CI step supplements the existing Part 5 checks.
