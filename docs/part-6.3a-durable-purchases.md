# Part 6.3A — Durable purchases and reconciliation

Scope: engineering only, 2026-10-17. **Reloadly customer activation remains
code-locked in all runtimes. No deployment, production migration, real purchase,
provider/payment API call or production environment change is part of this work.**
This is not completion of all Part 6.3 prerequisites.

## Contract and scope

Real-provider wallet data purchases now require `Idempotency-Key` (1–100 ASCII
letters/digits/underscore/hyphen). Missing key: 400; invalid/reused key with different
purchase identity: 409; insufficient balance: 402. Same wallet + same key returns
the original reference and current ledger/wallet summary, not a new debit or POST.
Identity includes recipient, network, plan/category/SKU, price and funding source.
A new intentional purchase needs a new key. The UI retains its key across network
errors and tab reloads using session storage; dismissing a result WITH an order
reference explicitly starts a new purchase. Different devices must reuse the same
key to identify the same intent; matching phone/plan alone is not deduplication.

Non-production mock simulation retains the old route/checkout simulator and its
existing test contracts. It is not evidence for real purchase durability. Production
mock rejection still precedes authentication/debit; no mock activation was added.
Airtime purchases, deposits, withdrawals, prices and admin features are unchanged.

Checkout uses its unique paid order reference as the claim key. The paid →
fulfilling transition, pending ledger insertion and attempt creation are atomic.
Externally paid checkout NEVER debits or refunds the wallet. Definitive checkout
rejection parks `fulfillment_failed`; any Paystack refund is an operator/payment
reconciliation task, not a new refund API or speculative wallet credit.

Generic provider submission responses are no longer accepted as delivery/failure
proof for these new durable orders. No authoritative generic status contract was
verified, so they remain pending/unknown and require operator review. Legacy
callbacks cannot settle new durable rows (identified by their reserved `[durable]`
ledger subtitle prefix); old rows retain their existing callback contract. Reloadly
callbacks remain unconditionally refused. This conservative compatibility change
is intentional: arbitrary HTTP-success heuristics cannot safely settle money.
Do not configure a generic provider slug as a way around the Reloadly code lock.

## Invariants and state machine

`purchase_attempts` is a claim/control record referencing the **existing** unique
transaction `ref`, not a new wallet ledger. The immutable sanitized request JSON
contains the exact customer order, wallet ID, SKU and original client reference;
provider and provider reference are persisted separately. No credentials or raw
remote response/error strings are stored in this table.

- `created`: wallet row lock + conditional debit + pending ledger + unique
  `(wallet_id,request_key)` claim in ONE PostgreSQL transaction. Checkout instead
  claims a verified paid order, without wallet debit. Failure rolls everything back.
- `submitted`: single-winner conditional update committed BEFORE POST. Submission
  uses the persisted request, not mutable caller input. Exactly one application
  submission call is permitted; there are no POST retries.
- `pending`: provider returned a reference; acceptance is NOT delivery.
- `unknown`: response loss, timeout, exception, malformed result, status mismatch,
  unknown status or outage. Funds remain charged/reserved. No speculative refund.
- `delivered` / `failed`: only correlated authoritative status reads can produce
  these terminal states in the real-provider path. Terminal states are immutable.
  A failed wallet purchase credits the original amount once and sets `refunded_at`.
  Success awards loyalty points once. The existing referral claim, reward points
  and referral ledger can participate in that SAME transaction. Checkout order,
  attempt and ledger updates participate in the terminal transaction too.

A unique `(provider,provider_reference)` index rejects cross-order ID reuse.
Terminal settlement conditionally consumes the current lease token and nonterminal
state; its wallet/points/refund/ledger effects commit together or roll back together.
Stale workers are fenced by a fresh UUID even after lease expiry. Database deadlocks
or outages may fail a request/read, but never authorize resubmission; retry the
customer request with its original key or wait for a later status-read lease.

Crash after debit/claim, before submission leaves `created` visible. Crash before
or after POST but before reference persistence leaves `submitted`/`unknown` without
an ID, visible in the report. Neither is automatically resubmitted/refunded.
A restart with a persisted ID resumes reads. A late correlated success from unknown
settles once. Without an ID, operator/provider account-history evidence is required;
there is deliberately no unauthenticated/manual-force-settlement endpoint.

For generic providers the existing GHS float projection is reserved atomically
when a snapshot exists: available decreases/reserved increases once. Final success
releases the reservation; failure restores available and releases reserved, in the
same settlement transaction. Missing float snapshots remain missing (not invented).
Reloadly retail GHS price is NOT a verified provider denomination/currency. No
Reloadly float conversion/projection is invented; verified catalogue, denomination
and float policy remain activation prerequisites.

## Reloadly contract and operations

The official sources/contract evidence are listed in
[Part 6.3 readiness](part-6.3-provider-readiness.md). This change reuses the existing
sandbox transport and its strict fixture tests: GET `/topups/{transactionId}/status`,
matching nested numeric transaction ID AND `customIdentifier`, exact consistent
`SUCCESSFUL`/`FAILED` only. Top-level flags, HTTP 200, substrings and unknown values
cannot deliver/refund. Token failure, redirects, malformed bodies and timeouts are
unknown. No documented purchase idempotency/custom-reference lookup guarantee or
product callback signature/replay contract has been established. Do not invent one.
Official provider hosts are outside this workspace's allowed outbound hosts;
there was no new account-backed or live documentation/API access in this task.

There is **no scheduled worker deployed**. A trusted operator/scheduler must invoke:

```
# Existing server DATABASE_URL, never a credential pasted into chat/Git
npm run reconcile:purchases -- --report
# Non-production sandbox configuration/test credentials required for actual reads
npm run reconcile:purchases -- --poll
```

`--report` is read-only (up to 500 unresolved rows, oldest first; no recipient,
credentials, token or raw response); reconcile before backlog exceeds that cap.
`--poll` claims up to 20 due rows using `FOR UPDATE SKIP LOCKED`; two-minute leased,
fenced, at most 12 reads per attempt. Failed/unknown reads back off exponentially
from 60 seconds to one hour. Each transport call retains the existing 20-second
request deadlines. Reads are sequential within a batch; stale lease results are
ignored. No-ID rows, generic-provider rows, created rows and exhausted attempts
remain in the report for manual investigation. Report access belongs only to
operators with database permissions. No public reconciliation endpoint is added.
The CLI performs no purchase submission and cannot unlock Reloadly production.

## Migration and rollout safety

`flexiData/drizzle/0011_purchase_attempts.sql` is additive: new table, checks,
foreign keys and indexes only. It neither backfills old transactions nor changes
existing balances/statuses. It is registered in the existing Drizzle journal and
represented in `schema.ts`. Apply via the existing reviewed migration process
BEFORE deploying the new real-provider path; take normal backups/review privileges.
Absent table/required ledger columns fails the entire transaction closed; there
is no schema-compat fallback to a debit without a claim. No production migration
was run. Legacy orders are not silently adopted; use existing support procedures.

## Verification evidence

- `npm ci`: passed, unchanged lockfile; 9 existing dependency vulnerabilities
  (8 high, 1 critical) remain for a separately scoped security update.
- Lint, typecheck, fake-CI-URL production build: passed.
- Repaired `verify:schema-compat`: 5/5; `verify:seed-resilience`: 6/6.
- DB-free/stub suites: security fixes 27/27; data-provider safety 39/39;
  Reloadly 30/30; auth flow 37/37; admin access 40/40;
  withdrawals-disabled 76 checks; withdrawal lifecycle 81/81;
  demo-deposit cleanup 19/19 checks, 2/2 scenarios.
- `verify:purchase-lifecycle`: **real disposable PostgreSQL 18.4**, 19 scenario
  groups, synthetic provider functions and network blocked. Actual migration is
  applied over schema exported from current application models. Refuses a
  non-loopback host, any DB name except `purchase_lifecycle_test`, or a nonempty
  database; does not drop existing tables. Tests concurrent duplicate requests,
  claim-before-send, one submission, submission success != delivery, restart,
  post-acceptance timeout, unknown/no-ID reporting, late success, exact refund,
  concurrent workers, callback/poll races with rejected callbacks, mismatched IDs,
  unknown statuses, stale leases/budget, insufficient funds, post-debit rollback,
  checkout claims/no wallet refund, crash mid-refund + 20 concurrent settlements,
  float reservation/release and transactional referral reward.
- CI retains all existing DB-free checks and adds a dedicated disposable
  PostgreSQL 18 service job for that suite. These tests establish DB behavior,
  NOT live provider fulfillment, sandbox purchases or deployed scheduling.

## Remaining activation blockers

Account-backed sandbox transaction/status evidence, test credentials via approved
secret storage, current Ghana DATA coverage (especially Telecel), approved SKU /
provider-denomination mapping, commercial approval, provider float currency/policy,
provider evidence for no-ID response-loss cases, scheduling/alert ownership, review
and explicit rollout approval remain required. Production Reloadly remains locked.
Part 6.3 as a whole is NOT complete. Never retry ambiguous POSTs to bypass a blocker.
