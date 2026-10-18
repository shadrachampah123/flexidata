# Part 6.4 — Production verification and controlled readiness

> **6.5 session status:** Part 6.4 implementation is merged. The owner reports
> production migration application and verification completed; this session has
> not independently verified that report and performed no production access.
> Unchecked operational checks and external prerequisites below remain open.
> See [roadmap](roadmap.md) and the [blocked manual-recovery decision](part-6.5b-ambiguous-purchase-recovery.md).

**Status: engineering readiness only. Live Reloadly fulfillment remains LOCKED.**
This document does not grant activation. It records what is verified, what is
not, the procedures an operator must follow, and the go/no-go gates that must
all be satisfied (with separate, explicit rollout approval) before anyone
considers live customer fulfillment.

Nothing in Part 6.4 performed a provider or payment call, purchased a data
bundle, changed a production environment setting, ran a production migration,
mutated production data, deployed, or started a scheduler. Every real-PostgreSQL
check used a disposable local database (`purchase_lifecycle_test`), never a
production URL.

Historical implementation starting point: `main` at `21ffc08bab591a49c1abc9c170fb05272904052a` (verified
before that work began). Current evidence is rechecked at `main`
`e48d45a20bcf0efccb755096cd005d3fa65d9256`; prerequisites: [Part 6.3 readiness](part-6.3-provider-readiness.md),
[Part 6.3A durable purchases](part-6.3a-durable-purchases.md).

## Scope and result

| # | Area | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Migration `0011_purchase_attempts.sql` rollout | Guarded, explicit applier added; `drizzle-kit push`/`migrate` **not** supported for this table | `npm run verify:purchase-attempts-migration` (real PostgreSQL 18.4, 10 scenarios) |
| 2 | Reconciliation operations | Hardened: no budget consumed on misconfiguration, batch isolation, monitoring summary, `--check` exit code | `npm run verify:purchase-lifecycle` (24 real-PostgreSQL scenarios) |
| 3 | Production configuration / fail-closed | Verified across 24 runtime/credential combinations; refusal precedes DB and network | `npm run verify:production-readiness` (DB-free) |
| 4 | External prerequisites | Documented precisely; **none are verified in this repository** | Section "External prerequisites" |
| 5 | Operational verification | Automated checks and go/no-go checklist below | Checklist + CI jobs |
| 6 | Security hygiene | Audit reduced from 1 critical + 8 high to 0 critical + 5 high (all dev-only, one with no upstream fix) | Section "Security hygiene" |

Files changed are listed in "Files and migration impact".

---

## Go/no-go checklist

A **GO** decision for any step below requires every gate in the category to be
checked and the evidence attached to the change record. A single unchecked
item in categories A–E keeps the answer at NO-GO. Category F items are
**external** and cannot be satisfied from this repository.

### A. Migration readiness
- [ ] A1. `0011_purchase_attempts` is reviewed; the SQL audit passes (`verify:production-readiness`).
- [ ] A2. Dry run against the target database reports `absent` or `current`, zero `FAIL` lines, and an unchanged row fingerprint (`migrate:purchase-attempts -- --dry-run`).
- [ ] A3. A backup or provider-level snapshot exists and its identifier is recorded.
- [ ] A4. Apply (`--apply --expect-database=<exact name>`) exits 0, followed by `--verify-only` exiting 0.
- [ ] A5. `/api/health` → `purchaseAttemptsSchema.status` is `"current"` with no `purchaseAttemptsWarning`.
- [ ] A6. Journal and SQL files agree (`verify:production-readiness`); no `drizzle-kit migrate` run against production.

### B. Provider lock
- [ ] B1. Production `DATA_API_PROVIDER` is either unset or `reloadly`. Both report unavailable. (`mock` and unset are blocked in production; `reloadly` is always locked.)
- [ ] B2. `/api/health` → `dataGateway.providerSafe` reflects the intended state. With `reloadly` it must be `false` with `providerStatus: "unavailable"`.
- [ ] B3. `RELOADLY_MODE`, `RELOADLY_CLIENT_ID`, `RELOADLY_CLIENT_SECRET` are **not** set in production. Sandbox credentials must never live in a production runtime.
- [ ] B4. If any *other* generic provider slug is configured in production, its approval is recorded by the account owner (see F-9). Without that approval, the answer is NO-GO. This verifier reports such a configuration as `safe=true`; it does not endorse it.
- [ ] B5. `WITHDRAWALS_ENABLED` is unchanged from the approved release configuration. This change does not alter it.
- [ ] B6. No code path in this release calls the Reloadly transport from a money-moving route (`verify:reloadly`, `verify:production-readiness`).

### C. Purchase reconciliation
- [ ] C1. `npm run reconcile:purchases -- --report` runs read-only against the target and its summary is recorded.
- [ ] C2. `--check` exits 0, or every reported attention item has a named owner and a documented action (section "Reconciliation operations").
- [ ] C3. The status-read scheduler is **either** deployed by an owner with alerting **or** the NO-GO state for real-provider rollout is recorded. Part 6.4 deploys no scheduler.
- [ ] C4. No row is in `created`, `submitted` without a reference, or `unknown` without a reference that has no decision recorded by an owner.

### D. Health visibility
- [ ] D1. `/api/health` responds `ok: true` and the existing schema fields are unchanged.
- [ ] D2. `purchaseAttemptsSchema` is present (`current`, `missing`, `drifted` or `unknown`). Any value other than `current` blocks data-purchase rollout.
- [ ] D3. Alerting exists for the `--check` exit code 2 (external; see F-8).

### E. Rollback and recovery
- [ ] E1. Code rollback plan confirmed: the previous release does not reference `purchase_attempts`, so the table may remain in place.
- [ ] E2. Database rollback is **not** routine. The recovery script refuses if any claim row exists.
- [ ] E3. Restore-from-backup test performed against a non-production copy (external; see F-10).
- [ ] E4. Named incident contact for money-state questions (external; see F-8).

### F. External prerequisites (cannot be satisfied in this repository)
- [ ] F-1. Reloadly test-mode credentials provided through an approved secret store, plus an account-backed sandbox transaction and status evidence.
- [ ] F-2. Current Ghana **data** operator catalogue, including Telecel data support confirmed by the provider.
- [ ] F-3. Approved SKU and provider-denomination mapping for every FlexiData plan, with commercial pricing validated.
- [ ] F-4. Commercial approval: onboarding, Ghana network permissions, limits, terms, and funds.
- [ ] F-5. Provider float policy: wallet currency, the GHS float projection, and reserve rules, all confirmed by the provider.
- [ ] F-6. Documented behavior for ambiguous no-reference outcomes (a lookup by `customIdentifier`, retention guarantees), and an approved operator procedure for them.
- [ ] F-7. Provider callback authentication, if callbacks are used at all. None is established; callbacks stay refused.
- [ ] F-8. Named owner for scheduling, alert destinations and on-call for money-state incidents.
- [ ] F-9. Written approval for any production generic provider (see B4).
- [ ] F-10. Tested backup/restore for the production database and an approved migration window.

**Live fulfillment decision:** GO is not implied by any checkbox above. Removing
the Reloadly code lock requires a separate code review and a written rollout
approval recorded outside this document. Part 6.4 itself leaves live
fulfillment locked.

---

## Migration rollout

### Why this table has a dedicated applier

Migration `flexiData/drizzle/0011_purchase_attempts.sql` creates the
`purchase_attempts` claim table (check constraints, unique and partial indexes,
and foreign keys to `transactions` and `wallets`). It is additive: it backfills
nothing and changes no balance, status or ledger row.

Two existing paths are **not** safe for it:

- `drizzle-kit push` diffs `src/db/schema.ts` against the live database in both
  directions. On a database holding tables outside the repository it requests
  table drops (see the README's PR #38 incident).
- `drizzle-kit migrate` applies only journal entries newer than the last
  recorded migration. In `drizzle/meta/_journal.json`, `0009_withdrawal_payout_system`
  has an earlier timestamp than `0008`. A database at `0008` would silently skip
  `0009`. The `verify:production-readiness` run reports this as a hazard.
  Do not use `drizzle-kit migrate` for production.

The supported path is `npm run migrate:purchase-attempts`, which reads the
same SQL file as the journal and the verifier, requires an explicit
`DATABASE_URL` (it never reads `.env`), and applies only within one transaction.

### Procedure

Run from `flexiData/`, in a low-traffic window, with the database URL exported
in your shell from your secret store. Never paste it into chat or Git.

```bash
# 1. Read-only preflight: catalog state, parents, row fingerprints. No DDL.
DATABASE_URL='postgresql://…?sslmode=require' npm run migrate:purchase-attempts -- --dry-run

# 2. Take and record a backup/snapshot of the target database (provider-specific).

# 3. Apply: DDL plus full verification in ONE transaction, lock_timeout 5s.
DATABASE_URL='postgresql://…?sslmode=require' npm run migrate:purchase-attempts -- --apply --expect-database=<exact database name>

# 4. Re-verify read-only (catalog only; no writes are attempted).
DATABASE_URL='postgresql://…?sslmode=require' npm run migrate:purchase-attempts -- --verify-only

# 5. Confirm /api/health → purchaseAttemptsSchema.status === "current".
```

`--apply` refuses unless `--expect-database` matches `current_database()` exactly.
Re-running it on an applied database reports `already applied` and changes
nothing. Exit code 0 is success; 1 means refused or rolled back.

### What the applier checks

- **Static SQL audit** before connecting. Only the four reviewed statements may
  appear: the table, its three indexes. Any `DROP`, `ALTER`, `UPDATE`,
  `DELETE`, `INSERT`, `TRUNCATE`, `GRANT`, trigger or function, or any foreign
  key to a table other than `transactions`/`wallets`, aborts the run.
- **Preflight** (read-only). Refuses on a missing or non-unique
  `transactions.ref`, a missing `wallets.id` primary key, missing ledger
  columns the durable lifecycle writes, a drifted or partial `purchase_attempts`,
  or any stray `purchase_attempt*` object.
- **Apply transaction.** DDL, then a full catalog comparison (columns,
  nullability, constraint definitions, `convalidated`, index definitions), then
  rolled-back probes proving that invalid state, out-of-budget `poll_count`,
  unknown source and a missing parent are each rejected. Any failure rolls back.
- **Fingerprints.** Wallet and transaction aggregates are compared before and
  after. A mismatch fails the run.

### Expected impact and locks

- New table and indexes only. Existing rows are untouched.
- The foreign keys take a `SHARE ROW EXCLUSIVE` lock on `transactions` and
  `wallets` for the (short) duration of the transaction. Concurrent writes to
  those tables wait up to 5 seconds, then the migration aborts and rolls back.
- Statement timeout 60 seconds.

### Ordering with code

Apply the migration **before** any real-provider path is enabled. Current code
fails closed when the table is absent: `PurchaseLifecycle.create` throws, and its
single transaction, including the wallet debit and ledger row, rolls back. A
wallet purchase cannot proceed without a durable claim. Today,
with the Reloadly lock, no customer purchase can reach that path anyway.

### Failure modes

| Output | Meaning | Action |
| --- | --- | --- |
| `FAIL SQL audit` | The reviewed SQL changed. | Stop. Review the migration change. |
| `FAIL parent prerequisite` | Schema is behind the repository. | Bring the schema up to the reviewed state first; do not hand-create columns. |
| `FAIL purchase_attempts matches migration 0011` | Drift or a stray object. | Stop. Investigate with the owner. The applier never repairs drift. |
| `transaction rolled back` | DDL or probe failed; nothing changed. | Read the reported check. Do not retry blindly. |
| `wallet and transaction fingerprints unchanged` FAIL | Unexpected row change during the run. | Stop and investigate before any further action. |

### Rollback

- **Code rollback**: safe. The previous release does not reference
  `purchase_attempts`; leave the table in place.
- **Database rollback**: operator-only, and only when the table is empty.
  `scripts/rollback-purchase-attempts-if-empty.sql` refuses (and changes nothing)
  if any claim row exists. A claim row is evidence of a debit or submission and
  must never be dropped. The script is verified in
  `verify:purchase-attempts-migration`.

---

## Reconciliation operations

### What the commands do

| Command | Writes? | Purpose |
| --- | --- | --- |
| `npm run reconcile:purchases -- --report` | No | Summary plus up to 500 unresolved rows, oldest first. No recipient, credentials, tokens or raw provider responses. |
| `npm run reconcile:purchases -- --check` | No | Same summary, classified as attention items. Exit `0` = nothing needs action, `2` = action needed, `1` = error. |
| `npm run reconcile:purchases -- --poll` | Yes (status reads only) | Claims up to 20 due Reloadly rows and performs bounded sandbox status reads. Never submits a purchase, never refunds directly. |

Exactly one mode flag is accepted. Errors print only a class name, never a
driver message, connection string or provider text.

### Rules the code enforces

- Only rows with `provider = 'reloadly'` and a provider transaction ID are polled.
  Generic-provider rows, `created` rows and rows without an ID are never polled.
- `--poll` checks Reloadly sandbox configuration **inside** the claim
  transaction. Without it (including `NODE_ENV=production`), a run with due rows
  fails and rolls back its claim. **No poll budget is consumed.**
- Each read is leased for 2 minutes with a fresh fencing token. Stale workers
  cannot settle.
- At most 12 reads per attempt (`poll_count` CHECK). Between reads the interval
  grows as `30 × 2^n` seconds, capped at one hour. Twelve reads therefore
  spread across roughly six hours.
- A failed or unknown read keeps the row nonterminal and never refunds.
- Settlement is single-winner. A terminal state is written once, and the wallet
  refund, points and float effects commit with it.
- A failed settlement in a batch does not stop the rest. The run then exits `1`
  so the failure is visible; the failing row keeps its lease and is retried after
  it expires.

### Attention categories (`--check`)

| Category | Meaning | Operator action |
| --- | --- | --- |
| `reconciliation_overdue` | A pollable row is more than 15 minutes past its due time. The scheduler is absent or lagging. | Run `--poll` manually once, then fix the scheduler. |
| `retry_budget_exhausted` | A nonterminal row used all 12 reads. Automatic reading has stopped. | Investigate manually (see Recovery). Do not resubmit. |
| `unresolved_without_provider_reference` | A `submitted` or `unknown` row has no provider ID. It can never be polled. | Investigate with provider account evidence (see Recovery). |
| `created_not_submitted` | A `created` row older than 15 minutes: debited, not submitted (typically a crash after the debit). | Decide with the owner. No automatic refund or resubmission exists. |
| `backlog_exceeds_report_cap` | More than 500 unresolved rows. | Work the backlog from the database directly. |

Thresholds are constants in `src/lib/purchase-lifecycle.ts`
(`MAX_PURCHASE_POLLS = 12`, `RECONCILE_ATTENTION_MINUTES = 15`,
`RECONCILE_REPORT_LIMIT = 500`), and `verify:production-readiness` checks
that the poll budget matches the migration CHECK.

### Scheduling, ownership and monitoring (NOT deployed)

- **Scheduler: not deployed.** No cron, worker or endpoint exists in this
  repository. The commands above are run by an operator today.
- **Owner: [to be named by the account owner; not assigned in this repository].**
- **Recommended pattern, to be implemented and owned outside this change:** a
  scheduled job every 5 minutes running `--poll`, followed by `--check`, with
  exit code 2 and exit code 1 both alerting the owner. The scheduler's
  environment must hold the sandbox secrets **only** in a non-production runtime.
  Sandbox polling in production is prohibited.
- **Health:** `/api/health` reports `purchaseAttemptsSchema`. It deliberately
  does not expose backlog counts on a public endpoint; use `--check` from an
  operator host.

### Recovery procedures

These are the states the lifecycle can leave behind. For every one of them the
rule is the same: **never resubmit a purchase, and never refund on an
uncertain outcome.** Automatic refund only follows a verified, correlated
provider `FAILED` status.

| State observed | What it means | Recovery |
| --- | --- | --- |
| `created` | Wallet debit committed, process stopped before submission. | Owner decision. The customer's retry with the same `Idempotency-Key` returns this original claim and never resubmits. No automated path exists. |
| `submitted`, no reference | Crash or response loss after the send was attempted; no provider ID was persisted. | Check Reloadly account history with `customIdentifier` = the FlexiData reference, if the provider exposes it (F-6). Record the evidence. Do not resubmit. Refund only on documented provider rejection evidence, through an approved, reviewed process. |
| `unknown`, no reference | Submission ended without a usable provider ID. | Same as above. |
| `pending` / `unknown` with reference, exhausted | 12 reads used without a terminal answer. | Look up the provider transaction ID in the provider dashboard or support. Record the terminal evidence and the decision outside this system. There is no in-app manual settlement tool, deliberately. |
| `delivered` / `failed` | Terminal. | No action. Immutable. |

Manual resolution has **no tooling** in this release. A reviewed, audited
resolution workflow is an open engineering gap and an external prerequisite (F-6).

### Crash and incident drills (covered by automated tests)

`verify:purchase-lifecycle` covers: crash after debit before submission; crash
after the submitted commit with no reference; a timeout after acceptance; a
late correlated success; rejection that refunds exactly once under 20 concurrent
settlements; a crash mid-refund that rolls back fully; mismatched IDs; expired
leases and fenced stale workers; a status outage with backoff; a failed
settlement inside a batch; and the misconfigured-poll refusal.

---

## Production configuration

### Required and forbidden values

| Variable | Production requirement | Why |
| --- | --- | --- |
| `DATABASE_URL` | The production database (set in the platform, never in Git). | Required by the app. |
| `DATA_API_PROVIDER` | Unset, or `reloadly` (locked). **Not `mock`.** | `mock` is hard-blocked in production. `reloadly` is always unavailable. |
| `RELOADLY_MODE`, `RELOADLY_CLIENT_ID`, `RELOADLY_CLIENT_SECRET` | **Not set.** | Sandbox only, and never in production (the transport refuses `NODE_ENV=production`). |
| `WITHDRAWALS_ENABLED` | Unchanged from the approved release. | Out of Part 6.4 scope. |

### Verified fail-closed behavior

| Configuration (production) | Result | Verified by |
| --- | --- | --- |
| `DATA_API_PROVIDER=reloadly` in any `NODE_ENV`, `RELOADLY_MODE` sandbox/live/unset, credentials present or absent | `safe: false`, `unavailable`, missing `rollout_approval`. Purchase and checkout refuse before any DB or network access. | `verify:production-readiness` (24 combinations), `verify:reloadly` |
| `DATA_API_PROVIDER=mock` or unset | `safe: false`; purchases refuse. | `verify:production-readiness` |
| `RELOADLY_MODE=live`, production, or missing credentials | Transport refuses with zero network calls. | `verify:production-readiness`, `verify:reloadly` |
| Migration `0011` absent | `create` throws; the debit and ledger row roll back; no ledger-only fallback. | `verify:purchase-lifecycle` ("missing migration fails closed") |
| `--poll` without sandbox configuration | Fails before claiming; no budget consumed. | `verify:purchase-lifecycle` |

### Known residual risk (go/no-go item B4)

A **generic** provider slug (anything other than `reloadly`/`mock`) with a
complete base URL and credentials reports `safe: true` in production. This is
pre-existing Part 5 behavior, and Part 6.4 deliberately does not change it,
because doing so would silently alter whatever production currently does. Such a
provider cannot settle durable purchases: its submission responses remain
`unknown` for operator review. Its approval is therefore an explicit go/no-go
decision (F-9), not something this repository can establish.

---

## Health visibility

`GET /api/health` now includes:

- `purchaseAttemptsSchema`: `{ status, blocked, table, missing, hint? }`.
  `status` is `current` only when the table exists with every expected column.
- `purchaseAttemptsWarning` whenever `status` is not `current`.

Unchanged: `ok`, `database`, `dataGateway` (including `providerSafe`,
`providerStatus`, `providerMissing`), and all existing schema probes. The probe
is read-only and never turns the response red.

---

## External prerequisites

**None of the following is verified in this repository.** Part 6.4 does not
claim any of them. Each is needed before any live-fulfillment decision.

| # | Prerequisite | Current state | Evidence needed |
| --- | --- | --- | --- |
| F-1 | Reloadly sandbox credentials and account evidence | **Unverified.** No credentials exist in the repository. Sandbox hosts are outside this workspace's allowed outbound hosts; no account-backed call was made. | Test-mode credentials from the account owner via the approved secret store; a recorded sandbox top-up and status lookup. |
| F-2 | Current Ghana data coverage, especially Telecel | **Unverified.** The public Ghana page covers airtime (MTN, Vodafone Ghana, AirtelTigo, Glo). Airtime coverage does not prove Telecel data support. | Provider confirmation of current Ghana data operators and Telecel data SKUs. |
| F-3 | Approved SKU and denomination mapping | **Unverified.** Historical operator 643 and the tutorial denominations are test fixtures, not an approved catalogue. | A validated plan-by-plan mapping with provider denominations and pricing. |
| F-4 | Commercial approval | **Unverified.** | Onboarding, permissions, limits, terms, and funding confirmation. |
| F-5 | Provider float policy | **Unverified.** Wallet currency and float projection for Reloadly are not established; no float conversion is invented. | Written provider float and currency policy. |
| F-6 | Ambiguous no-reference outcomes | **Unverified.** No documented lookup by `customIdentifier` or guaranteed retention. No manual-resolution tooling exists. | Provider evidence and retention guarantees; an approved, audited resolution procedure and tooling. |
| F-7 | Provider callback authentication | **Unverified.** No Reloadly callback contract established; Reloadly callbacks stay refused. | Documented signature and replay semantics, if callbacks are ever used. |
| F-8 | Scheduler, alert destination and on-call ownership | **Not deployed; not assigned.** | Named owner; deployed scheduler; alert route for `--check` exit 2. |
| F-9 | Approval for any production generic provider | **Unknown**: depends on the production configuration. | Owner decision recorded per B4. |
| F-10 | Restore test and migration window | **Not performed.** | Restore test on a non-production copy; approved maintenance window. |

---

## Rollback and recovery

Summarized from the sections above:

1. **Application rollback**: deploy the previous release. The table may remain.
2. **Schema rollback**: only through `scripts/rollback-purchase-attempts-if-empty.sql`,
   and only when empty. Otherwise leave the table and investigate.
3. **Money-state incidents**: follow the state table in "Recovery procedures".
   Preserve evidence first (report output, provider evidence, database snapshot),
   then decide. Do not resubmit and do not refund on an uncertain outcome.
4. **Database loss or restore**: restore from the approved backup, then rerun
   `--report` and `--check`. Any claim that existed before the restore point but
   whose provider evidence is now lost must be investigated as in the state table.

---

## Security hygiene

### Before Part 6.4 (baseline, `npm audit`)

9 vulnerabilities: **1 critical, 8 high**.

- Critical: `next` 16.0.0–16.3.7, including remote code execution in `next/og`
  `ImageResponse`, cache poisoning of SSG/ISR pages, SSRF in image optimization,
  and information disclosure.
- High: `eslint-config-next` and its chain (`@next/eslint-plugin-next`,
  `braces`, `fast-glob`, `micromatch`), `sharp` (via librsvg), `brace-expansion`,
  `source-map-js`.

### Changes in this release (separate commit, reviewable independently)

Exact lockfile diff against `main` (`flexiData/package.json` and `flexiData/package-lock.json` only):

| Package | Before | After | Reason |
| --- | --- | --- | --- |
| `next` (direct, exact pin) | `16.3.3` | `16.4.2` | Patches the critical advisories (`next` 16.0.0–16.3.7). Non-major. The advisories were not reachable through features this app uses (no `ImageResponse`, `next/image`, draft mode or `use cache`), but the patched release is the correct baseline. |
| `eslint-config-next` (direct devDependency, exact pin) | `16.3.3` | `16.4.2` | Matches the Next version. Development only. |
| `@next/env`, `@next/swc-*` (8 platform binaries), `@next/eslint-plugin-next` | `16.3.3` | `16.4.2` | Required companions of `next` / `eslint-config-next`, resolved by npm. |
| `sharp` (optional, image processing used by Next) | `0.35.4` | `0.35.5` | Patched release for the high advisory (librsvg, CVE-2026-96889). Resolved as a `next` dependency. |
| `@img/sharp-*` (16 platform packages), `@img/sharp-libvips-*` (13 platform packages) | `0.35.4` / `1.3.3` | `0.35.5` / `1.3.4` | Platform binaries that must match `sharp`. Optional; not used by any route in this app. |
| `brace-expansion` (transitive, two copies) | `1.1.18` / `5.0.9` | `1.1.21` / `5.0.12` | Patch-level fixes (quadratic-time and stack-exhaustion DoS advisories). |
| `source-map-js` (transitive) | `1.2.1` | `1.2.2` | Patch-level fix (event-loop DoS advisory). |

No package was added or removed, and no major version changed. Every change
above is a minor or patch update within the same major line (Next 16.3 → 16.4,
sharp 0.35.4 → 0.35.5, and so on).

### After (`npm audit`)

0 critical, 0 moderate, 0 low. **5 high**, all from one development-only chain
(`braces` ≤ 3.0.3 → `micromatch` → `fast-glob` → `@next/eslint-plugin-next` →
`eslint-config-next`). The registry has **no patched `braces` release** (3.0.3
is the latest, still flagged), so no version bump can resolve it. It is part of
the linting toolchain only: it is not shipped to the runtime, and it processes
only repository-controlled glob patterns, not user input.

**Accepted interim policy:** keep the advisory visible and reassess when a patched
`braces` release or compatible published parent release exists. Do not
force-override `micromatch`/`fast-glob` to unpatched forks. The current exact
evidence is maintained in the [dependency audit report](../flexiData/docs/security/dependency-audit-cve-2026-93687-2026-10-18.md).

Verification of the dependency change: the full CI mirror (lint, typecheck,
production build, all DB-free verifiers, both real-PostgreSQL suites) passed on
the exact lockfile, and a production-mode smoke run of the built app returned
`ok`, current schema probes, pages rendering, and the Reloadly purchase path
still refused with HTTP 503 before authentication.

---

## Verification evidence

Commands run in this repository (see the final report for exact results):

- `npm run lint`, `npm run typecheck`, `npm run build` (fake CI-only `DATABASE_URL`).
- DB-free: `verify:schema-compat`, `verify:seed-resilience`, `verify:security-fixes`,
  `verify:data-provider-safety`, `verify:reloadly`, `verify:auth-flow`,
  `verify:admin-access`, `verify:withdrawals-disabled`, `verify:withdrawal-lifecycle`,
  `verify:demo-deposit-cleanup`, **`verify:production-readiness` (new)**.
- Real PostgreSQL 18.4 (disposable `purchase_lifecycle_test`, loopback only):
  `verify:purchase-lifecycle` (24 scenarios, extended), **`verify:purchase-attempts-migration` (new, 10 scenarios)**.

None of these establishes provider behavior, sandbox purchases, deployment, or
scheduling. They establish code, schema and gate behavior only.

### Continuous safeguard verification (added 2026-10-18, after Part 6.4)

CI now runs the DB-free Phase A of three existing payout/withdrawal safeguard
suites on every pull request and `main` push:

| Command | What its Phase A proves |
| --- | --- |
| `npm run verify:withdrawal-security` | F1–F8 and W1–W4 rules: destination/method validation, idempotency and exact-money rules, admin reconciliation classification, `successful` remaining unreachable through the admin API, stored-data and malformed-input refusal. |
| `npm run verify:phase-b` | Payout fail-closed rules P1–P24 and migration ordering M1/M1b: no transfer path without explicit enablement, the mock provider cannot run in production, provider references are stable and single-use, and the journal keeps sequential indices with 0010 and the newest entry correctly ordered. 0008/0009 timestamps are pinned unchanged. |
| `npm run verify:payout-reconciliation` | R1 invariants: exactly the seven exception types, detection-only/read-only source guarantees, admin-gated API, and no wallet, ledger or withdrawal writes. |

These are synthetic source and rule checks. Their database and live-app phases
(Phase B/C) still need a disposable PostgreSQL and a locally started app server;
this workflow does **not** run them and does not represent them as passing. No
runtime code, migration, journal entry, schema or fail-closed behavior was
changed to add these steps, and nothing here is provider, production,
deployment or operational evidence.

Current admin verification status: the Phase 0–2 and safe Phase 3–6
harnesses are enforced in `.github/workflows/ci.yml` at the current baseline.
The current DB-free recheck is recorded in
[`docs/admin-ops-dashboard/07-inventory-and-security-review.md`](admin-ops-dashboard/07-inventory-and-security-review.md)
and the concise [Parts 6.5B–6.9 evidence matrix](production-readiness-evidence-2026-10-18.md).
Database-backed and live-app portions remain explicitly skipped without an
approved non-production `DATABASE_URL`/`BASE_URL` pair.

## Files and migration impact

**Migration impact: none to the repository schema.** No migration file was
added, changed, or renumbered. `0011_purchase_attempts.sql` is unchanged. Its
application to any database is a separate, operator-run step. No production
migration was run.

| Path | Change |
| --- | --- |
| `flexiData/src/lib/purchase-lifecycle.ts` | Misconfigured-poll refusal inside the claim transaction; per-row isolation with `PurchaseReconcileError`; `reportSummary()`; `reconcileAttention()`; shared constants. |
| `flexiData/src/lib/schema-compat.ts` | `describePurchaseAttemptsCompatibility()` and `PURCHASE_ATTEMPTS_COLUMNS`. |
| `flexiData/src/app/api/health/route.ts` | `purchaseAttemptsSchema` and `purchaseAttemptsWarning` (additive). |
| `flexiData/scripts/reconcile-purchases.ts` | Exactly-one-mode CLI; `--check`; exit codes; error classes only. |
| `flexiData/scripts/apply-purchase-attempts-migration.ts` | **New.** Guarded applier (dry-run, apply, verify-only). |
| `flexiData/scripts/rollback-purchase-attempts-if-empty.sql` | **New.** Operator-only recovery script. Refuses when claims exist. |
| `flexiData/scripts/verify-purchase-attempts-migration.ts` | **New.** Real-PostgreSQL verifier for the applier and recovery guard. |
| `flexiData/scripts/verify-production-readiness.ts` | **New.** DB-free go/no-go automation. |
| `flexiData/scripts/verify-purchase-lifecycle.ts` | Extended with reconciliation-hardening scenarios. Existing assertions unchanged. |
| `flexiData/package.json` | Added `migrate:purchase-attempts`, `verify:purchase-attempts-migration`, `verify:production-readiness`. |
| `.github/workflows/ci.yml` | Added readiness step and `migration-postgres` job. |
| `docs/part-6.4-production-readiness.md` | **New.** This runbook. |
| `README.md`, `docs/part-6.3a-durable-purchases.md` | Cross-references to this runbook. |

## Verdict

Engineering readiness improved and verified locally. **Live fulfillment remains
LOCKED.** Reconciliation scheduling was **not** deployed. External prerequisites
F-1 through F-10 remain unverified, and the go/no-go checklist's NO-GO state
stands until they are satisfied and a separate rollout approval is recorded.
