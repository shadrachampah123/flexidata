# Part 6.7 — monitoring and operational ownership readiness

**Status: DISABLED — repository-only analysis completed.** No monitoring adapter,
scheduler, alert transport, production database/runtime connection, alert delivery,
provider call, or customer communication was executed or activated for this review.
This file
records code facts and owner gates; it does not grant approval to run a query,
start a scheduler, send an alert, or activate monitoring.

## Review scope and evidence

Reviewed current `main` at `3882bd57434aa10f3eb40fda67c133fda9956c8c` and the
repository implementation only. No production database, runtime, alert service,
credential store, owner roster, or external environment was queried.

### Present in the repository

- `PurchaseLifecycle.reportSummary()` performs aggregate `SELECT` queries over
  unresolved purchase attempts and returns counts/by-state, pollable/overdue,
  exhausted, no-reference and stale-created counts, oldest unresolved timestamp,
  and a truncation flag. `reconcileAttention()` maps those counts to five
  attention categories. These functions classify repository data; they do not
  send alerts.
- `PurchaseLifecycle.report()` is a separate `SELECT` that returns up to 500
  unresolved rows, including purchase/provider references and state. Do not
  forward its full output to a public alert channel.
- `scripts/reconcile-purchases.ts` exposes operator-only `--report` and
  `--check` modes that perform reads, and a distinct `--poll` mode. `--poll` is
  **not read-only**: it claims rows, changes lease/poll metadata, and performs
  Reloadly sandbox status reads. It must not be treated as an alert-only check
  or scheduled by this analysis.
- The existing purchase lifecycle and production-readiness tests exercise
  summary classification against a disposable local PostgreSQL database and
  synthetic data. They are software tests, not monitoring delivery or production
  evidence.
- Part 6.4 already records F-8 as external/not deployed and says no scheduler,
  worker or monitoring endpoint is in the repository.

### Not present or not evidenced

- No purchase-monitoring adapter, cron/worker, alert destination/transport,
  alert delivery test, on-call owner, response SLA, approved message contract,
  or monitoring activation evidence was found in `main`.
- `reportSummary()` uses the application `Pool` and issues `SELECT`s, but it does
  not itself establish a dedicated read-only database role or wrap calls in an
  explicit `READ ONLY` transaction. A monitoring process must not rely on
  query-text intent alone as its security boundary.
- No access grant, credential expiry/revocation record, alert deduplication or
  rate-limit policy, transport failure behavior, data-retention rule, or
  customer-communication owner is evidenced here.
- The roadmap references an unpublished adapter as `40710d7`; the short SHA is
  not present in the local object database and GitHub could not resolve it. That
  work was not recovered, reviewed, copied, or included. `2dd996f` and all other
  unpublished work remain separate.

## Operational decision register — all gates remain blocked

The roles below are accountable owner roles to assign, not named people or
recorded approvals. Keep every gate disabled until evidence and explicit
approval exist.

| Gate | Accountable owner role(s) | Evidence required | Conservative interim behavior | Acceptance criteria |
| --- | --- | --- | --- | --- |
| Ownership and response | Operations/incident owner; account/release owner | Named primary and backup, escalation chain, response targets, service hours, and incident/runbook reference. | No scheduler or alerting; use only an already approved incident process if one exists. | Owners accept the rota and response SLA; a synthetic incident walkthrough identifies who acknowledges, investigates and escalates each category. |
| Read-only data access | Database/platform owner; Security owner | Dedicated principal identity, explicit `SELECT`-only grants for approved objects, access expiry/revocation, network scope, and proof writes/DDL are denied. | Do not run `--report`/`--check` against any environment in this task; no production credentials or job. | A disposable-only test proves the principal can read the minimum data and cannot mutate it; access is time-bounded and revoked/renewed by an owner. Prefer an explicit read-only transaction in any future adapter. |
| Signal and schedule | Engineering owner; Operations/incident owner | Approved categories/thresholds, cadence, lookback, stale-data behavior, dedupe key, rate limits, suppression and backlog policy. | Do not add a cron or call `--poll`; do not turn a missing/late check into a green result. | Synthetic tests cover every category, repeated events, threshold edges, stale/missing source data, dedupe, rate limits and bounded resource use. |
| Alert content and privacy | Security/Privacy owner; Customer Support owner; release owner | Approved destination, message schema, data minimization, access/retention, customer communication policy and redaction review. | No alerts or customer messages. If later approved, send counts/category only; do not expose purchase/provider references, phone numbers, raw payloads, credentials or database details. | A reviewed synthetic payload contains only approved fields; privacy/access/retention owners approve the content and destination. Customer-facing copy preserves uncertainty and never promises a purchase outcome. |
| Delivery and failure handling | Infrastructure/Operations owner; Security owner | Destination ownership, secret-management reference, delivery/retry limits, outage/dead-letter behavior, health and escalation path. | No transport, secret, webhook, email or chat integration is configured or used. | An isolated synthetic sink proves success, duplicate delivery, rate-limit, timeout and transport failure behavior without contacting a real provider, customer or production alert channel. |
| Separate activation decision | Account/release owner; Security and Operations owners | Reviewed code diff, CI evidence, approved runbook and alert destination, tested read-only access, named owners, and explicit change approval for a specific environment/window. | Monitoring remains disabled, regardless of code merge or CI status. | A separate written activation decision names scope, owner, rollback/disable steps and expiry. Activation is not part of this PR or this analysis. |

## Safe follow-up sequence

1. Assign accountable owners and decide which of the existing attention
   categories are operationally actionable. Do not change the purchase state
   machine or infer provider finality from an alert.
2. Design a minimal aggregate-only read path around a dedicated read-only
   principal and explicit read-only transaction/session. Keep `--poll` out of the
   monitoring path; it mutates leases/poll counts and performs sandbox status
   reads.
3. Agree on thresholds, schedule, dedupe/rate limits, stale-data handling,
   alert contents, destination, retention and escalation before implementing a
   transport. The normal report contains row references and must not be copied
   into alert messages by default.
4. Verify behavior using synthetic summaries and an isolated fake alert sink,
   including duplicate, outage and redaction cases. Label these as synthetic;
   they do not prove production delivery.
5. Keep activation as a separate, explicit owner decision after code review and
   evidence. Until then, monitoring stays disabled and withdrawals, purchase
   state, provider calls and customer messaging remain unchanged.

**No monitoring was enabled or run for this analysis.** The next smallest action
is for the account/release owner to assign a primary and backup operational
owner and approve whether the read-only, aggregate-only monitoring design may
proceed. No production access is needed to make that decision.
