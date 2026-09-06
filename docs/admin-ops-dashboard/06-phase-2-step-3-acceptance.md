# Phase 2, Step 3 — Investigation & Accountability Layer: Acceptance Report

**Status:** complete and verified. **Phase 2, Step 3 only** — nothing further in
Phase 2 (refund execution, reversals, balance corrections, delivery retries,
support cases, admin management) has been started.
Branch `arena/01a07495-flexidata`, base commit `fe8ed0d` (current `main`,
includes the merged Phase 2 Step 1, PR #28, and Step 2, PR #29).

Steps 1 and 2 gave administrators a **queue** and two **actions**. This step
gives them the thing that was missing between the two: an **investigation
surface** — one page per record that answers *"what actually happened here, what
does the evidence say, and who already touched it?"* — plus an **accountability
trail** (who did what, when, why) and a **backlog view** for the refund reviews
Step 2 can record but nothing could count.

It is 100 % diagnosis, review and status. **Zero schema change, zero writes.**
Every new endpoint is a `GET`, every new loader runs inside
`SET TRANSACTION READ ONLY`, and the only financial module this step touches is
the Paystack client — and only its read-only `paystackVerifyTransaction()`.

---

## 1. What was built

| Area | Files |
|---|---|
| Diagnosis engine (pure) | `flexiData/src/lib/admin/diagnosis.ts` (913 lines) — no `@/db`, no `@/lib/paystack`, no settlement module, no HTTP, no clock capture; every rule takes facts and returns findings |
| Investigation read layer | `flexiData/src/lib/admin/queries-investigation.ts` (1 068 lines) — `loadOrderInvestigation`, `loadDepositDetail`, `loadAdminAudit`, `loadRefundReviews`, `probeAvailability`; all four loaders inside `withReadOnlyTx` |
| Paystack status probe | `flexiData/src/lib/admin/paystack-status.ts` (311 lines) — `probePaystackStatus` + the pure `probeThrottleDecision`; imports **only** `paystackVerifyTransaction`, `paystackMode`, `isPaystackConfigured`, `PaystackConfigError`, `PaystackRequestError` |
| Types | `flexiData/src/lib/admin/types.ts` (+249 lines) — `AdminOrderInvestigation`, `AdminDepositInvestigation`, `AdminPaystackProbeResult` / `…Refusal`, `AdminAuditRow` / `…Result`, `AdminRefundReviewRow` / `…Result`, `AdminRecordedAction`, `openRefundReviews` on `AdminOverviewCounts` |
| Reference parsing | `flexiData/src/lib/admin/filters.ts` (+28) — `parseRef` (`MIN_REF_LENGTH` 4, `MAX_REF_LENGTH` 40, `[A-Za-z0-9_-]`), proved identical to Step 2's `normalizeOrderRef` on a 14-value matrix |
| APIs (6, all `GET`, all `force-dynamic`) | `/api/admin/orders/[ref]`, `/api/admin/orders/[ref]/paystack-status`, `/api/admin/payments/[ref]`, `/api/admin/payments/[ref]/paystack-status`, `/api/admin/audit`, `/api/admin/reviews` |
| Pages (4) | `/admin/orders/[ref]`, `/admin/payments/[ref]`, `/admin/audit`, `/admin/reviews` |
| UI | `flexiData/src/components/admin/investigation.tsx` (server panels: verdict banner, findings, delivery timeline, recorded actions, facts, support-workflow link), `paystack-probe.tsx` (client, **GET only**), `investigation-explorers.tsx` (`AuditExplorer`, `RefundReviewsExplorer`) |
| Navigation & overview | `flexiData/src/components/admin/nav.tsx` (+Refund reviews with an amber badge, +Admin activity), `src/app/admin/layout.tsx` (badge fallback, write-surface footer), `src/app/admin/page.tsx` (+“Open refund reviews” tile), `src/lib/admin/queries.ts` (+69: `openRefundReviewCountSql()` shared by tile / badge / page, `refund-reviews` issue, `loadNavBadges().reviews`) |
| Drill-down fixes (F1/F2) | `flexiData/src/components/admin/explorers.tsx` (+41) — data-order and attention rows now route to the record that actually exists; deposits now open their own page |
| Verification | `flexiData/scripts/verify-admin-phase2-step3.ts` (new, **382 checks**), `package.json` (`verify:admin-ops`) |

Totals: **17 new files (6 838 lines)**, **8 modified files (+425 / −13)**.

Nothing in `src/db/schema.ts`, `drizzle/**`, `src/lib/paystack.ts`,
`deposits.ts`, `checkout.ts`, `payments.ts`, `data-gateway.ts`, `fulfillment.ts`,
`auth.ts`, `api-auth.ts`, `accounts.ts`, `support-actions.ts`,
`customer-management.ts`, `referrals.ts`, `src/lib/admin/auth.ts`,
`src/lib/admin/db.ts` or any non-admin API route was modified — proved
mechanically with `git diff --quiet` against the base commit inside the harness
(section 7), not by inspection.

## 2. Zero schema change (Option A, as approved)

The approved scope required **no migration**, and none was written:

| Guarantee | Proof |
|---|---|
| `src/db/schema.ts` byte-identical to base | `git diff --quiet fe8ed0d -- src/db/schema.ts drizzle` inside the harness |
| `drizzle/` still exactly 4 `.sql` files, journal still 4 entries | harness lists the directory and parses `drizzle/meta/_journal.json` |
| No new column, table, index or enum value is read that the schema does not already have | every capability check goes through the existing `hasTableColumns()` / `hasSupportSchema()` probes; a database *behind* migration 0003 (or 0002) degrades instead of failing — 25 live checks cover exactly that |
| Investigation notes, cases or “refund approved” states | **deliberately not built** — they would need a migration (the rejected Option B). Nothing in this step invents a column to store an opinion |

Consequence worth stating plainly: because no state is stored, the refund-review
backlog is **derived** — “open” means a `refund_review` audit row with no
`delivery_resolved` recorded at or after it. The same predicate lives in the
pure `hasOpenRefundReview()`, in the CTE behind `/admin/reviews`, in the
overview tile and in the nav badge, so the four can never disagree (asserted
live: resolving an order through Step 2's real endpoint moves the backlog from
2 open → 1 open on the next read).

## 3. The diagnosis engine

`diagnosis.ts` is pure by construction: it accepts **facts** (`OrderFacts`,
`MirrorFacts`, `RecordedActionFacts`, `DepositFacts`, `WalletCreditFacts`,
`PaystackProbeView` + `ProbeSubject`) and returns `DiagnosisFinding[]`
(`id`, `severity`, `label`, `detail`, `guidance`). `summarizeFindings()` reduces
them to the one banner the page shows (`critical` > `attention` > `unknown` >
`healthy`). It never sees a database handle, so it cannot write, and it is
unit-testable without a cluster.

Order rules (evaluation order is the operational priority order):

| id | severity | fires when |
|---|---|---|
| `captured-not-delivered` | critical | payment captured **and** `order_status = fulfillment_failed` |
| `stuck-in-fulfilment` | critical | captured, `paid`/`fulfilling`, untouched for > `DIAGNOSIS_STUCK_AFTER_MS` (2 h) |
| `verification-mismatch` | critical | gateway response matches `MISMATCH_SIGNATURE` (`/did not match/i`) |
| `subunit-drift` | critical | `round(amount × 100) ≠ amount_subunits` |
| `gateway-id-without-capture` | attention | a Paystack transaction id is stored but nothing was captured |
| `mirror-missing` | attention | captured/in-flight/fulfilled order with no ledger mirror row |
| `mirror-status-divergence` / `mirror-amount-divergence` / `mirror-refund-divergence` / `mirror-direction` | critical / critical / attention / attention | the mirror row disagrees with the order it mirrors |
| `refund-review-open` | attention | `hasOpenRefundReview(recordedActions)` |
| `admin-confirmed-delivery` | healthy | a `delivery_resolved` is recorded at/after the last review |
| `nothing-captured` | healthy | no payment was captured and no finding above fired |
| `fulfilled-clean` | healthy | delivered, mirror present and agreeing |

Deposit rules: `settled-not-credited`, `duplicate-credit`,
`credit-amount-divergence`, `subunit-drift`, `verification-mismatch`
(critical) · `demo-deposit-locked`, `stale-pending` (> 24 h),
`credit-reversed`, `gateway-id-without-settle` (attention) · `credited-clean`,
`not-settled` (healthy).

Probe rules (S3.6): `probe-mismatch`, `probe-captured-not-settled`,
`probe-settled-not-credited`, `probe-contradicts-capture` (critical) ·
`probe-pending` (attention/unknown) · `probe-agrees`, `probe-not-captured`
(healthy).

Three rules were written to **agree with code that already exists**, because a
second opinion that contradicts the first is worse than none:

* `isOrderSupportActionable()` is a pure mirror of `isSupportableOrder()`
  (`src/lib/support-actions.ts`, the write path) and
  `isAttentionRowActionable()` (`queries-operations.ts`, the queue). The harness
  runs a 9-row matrix through all three and asserts zero divergence.
* `DIAGNOSIS_STUCK_AFTER_MS` = `SUPPORT_STUCK_AFTER_MS` = `STUCK_AFTER_MS`
  (2 h) and `DIAGNOSIS_STALE_DEPOSIT_MS` = `STALE_DEPOSIT_MS` (24 h) — asserted
  by value, so a future edit to one constant fails the harness.
* `orderToTrackable()` feeds the **existing** `buildTrackingInfo()` from
  `src/lib/fulfillment.ts`, so the admin timeline and the customer timeline are
  the same projection — and it still renders when the mirror row does not exist,
  which is precisely the parked case.
* The probe comparison reuses the settlement paths' three predicates
  (reference / integer pesewas / currency), including `deposits.ts`'s tolerance
  for a missing reference and `checkout.ts`'s strict equality. A probe can
  therefore never report “matches” for a charge the settlement path would have
  refused.

## 4. The surfaces

| Surface | What it shows | What it cannot do |
|---|---|---|
| `/admin/orders/[ref]` | verdict banner · findings with evidence and guidance · order facts (money, Paystack trail, provider trail, timestamps) · ledger mirror + divergence · delivery timeline · recorded actions for this ref · the customer's suspend/activate history · link into Step 2's support workflow · probe button | write anything. The support workflow link goes to the **existing** Step 2 modal; no new writer was added |
| `/admin/payments/[ref]` | verdict banner · findings · deposit facts · every ledger row carrying the ref (evidence) · stored-vs-calculated wallet verdict from the existing `classifyReconciliation()` rule · account history · probe button | credit, settle, reverse or re-verify. The wallet's balance is displayed, never touched |
| `/admin/audit` | the whole `admin_audit_logs` trail, newest first, filterable by acting admin / action / target customer / free text (ref, reason, name, email) / date range, paginated 25–50–100, with a summary (total, in range, distinct admins, per-action breakdown). Emails and phones are masked in the list | export, delete or amend a row. Reading the trail is asserted not to add to it |
| `/admin/reviews` | open and closed refund reviews derived from the trail + `checkout_orders`: customer (masked), bundle, amount, order/payment status, review count, first/last review, who recorded it, why, age in hours; summary of open count and **GHS at risk**; sortable oldest / recent / amount | approve or execute a refund. There is no refund primitive in this step |
| `/admin` (overview) | one new tile, “Open refund reviews”, and one new operational issue linking to `/admin/reviews?state=open`. Pre-existing tiles and issues unchanged (asserted) | — |
| Nav | “Refund reviews” (amber badge, count of open reviews) and “Admin activity” | — |

Single-record views deliberately show **unmasked** contact details (an
investigation of one opened record is the point), while every list stays masked
— the same convention `queries.ts` established in Phase 1, asserted for both.

Degradation is explicit, never silent: on a database without `target_ref`
(pre-0003) the activity log still reads with `refTrailAvailable: false` and null
references, the backlog and its badge/count read `null` (rendered “Not
available”, never a misleading `0`), and no refund-review issue is raised. On a
database without `admin_audit_logs` at all (pre-0002) every audit-backed panel
reports `available: false` and the diagnosis itself is unaffected — the findings
come from the record, not from the trail.

## 5. The read-only Paystack status probe (S3.6)

The gap: the only code that asks Paystack about a reference is
`reconcileCheckoutOrder()` / `reconcileDeposit()`, and both **settle**. An
administrator facing an order parked by the verification-mismatch guard had no
way to learn whether the gateway really took the money without moving it.

`GET /api/admin/{orders,payments}/[ref]/paystack-status` closes that gap and
nothing else:

* calls `paystackVerifyTransaction()` **only** — no settlement, credit, submit
  or fulfilment symbol is imported (the harness asserts the exact import list);
* **`GET`, not `POST`** (the approved design): it writes nothing, so it must not
  become a third browser write surface. The write surface is still exactly the
  two Step 1/2 confirmation modals, re-asserted by both harnesses;
* no database import in the module that performs the call, and no write API
  anywhere under `src/lib/admin` (re-proved with the Phase 1 scan over 14 files);
* order of operations: **gate → `parseRef` → the record must exist in our own
  database** (the stored values the comparison uses come from that read) **→
  throttle → time-bounded outbound call**;
* throttle (pure `probeThrottleDecision`, so the window arithmetic is testable
  without waiting): ≤ `PROBE_REF_LIMIT` 3 probes per admin per reference and
  ≤ `PROBE_ADMIN_LIMIT` 10 per admin inside `PROBE_WINDOW_MS` 5 min → `429` with
  `retryAfterSeconds`;
* `PROBE_TIMEOUT_MS` 8 s via `Promise.race` → `504`, never a hung request;
* failure taxonomy instead of 500 s: `400` malformed ref · `404` unknown/cross-type
  ref · `429` throttled · `502` Paystack could not confirm · `503` unconfigured
  or locked · `504` timeout;
* the existing **TEST-mode lock is inherited, not bypassed**: a `sk_live_` key
  without `PAYSTACK_LIVE_MODE=true` is refused by `paystackSecretKey()` inside
  `@/lib/paystack` and surfaces as `503` with no key material in the response
  (asserted live);
* the response is a whitelist (`status`, `rawStatus`, `reference`,
  `amountSubunits`, `currency`, `transactionId`, `channel`, `paidAt`,
  `gatewayResponse`) plus findings, verdict, `mode`, `elapsedMs` and a `notice`
  restated on **every** response: the probe is a status check and nothing was
  written;
* one structured `console.info` line per probe (admin id, kind, ref, mode,
  status, elapsed) — no key, no payload, no customer email;
* the whole probe sweep is wrapped in a byte-identical snapshot: **every table,
  every row, unchanged**.

## 6. Security model

Unchanged from Phase 0, and re-proved for all six endpoints:

* every route calls `requireAdminApi()` **first**; every page calls
  `requireAdmin()`; the gate re-reads `users.is_admin` and the `ADMIN_EMAILS`
  allowlist on every request, so revocation applies on the next request (asserted
  live, then restored);
* denials are `404` with the identical Phase 0 body and `no-store` — anonymous,
  logged-in customer, forged cookie, and `is_admin = true` **without** the
  allowlist are byte-identical to each other on all six endpoints;
* `force-dynamic` + `no-store` on every new route and page: nothing is cached,
  prerendered or prefetched;
* references are validated by `parseRef` before any query and always bound as
  parameters; malformed input is `400` with no statement executed;
* secret hygiene: no password / key / token material in the code of any new file
  (comments stripped before scanning), in any serialized payload, or in any
  refusal message; raw `provider_payload` / `provider_response` jsonb is never
  selected; session tokens never appear in a payload.

## 7. Financial safety — guarantees, not promises

| Guarantee | How it is proved |
|---|---|
| No wallet balance moves | byte-identical `select *` snapshots of `wallets` before/after the whole sweep |
| No credit, debit, reversal or refund | `transactions` byte-identical |
| Nothing settles | `deposit_requests` and `checkout_orders` byte-identical — and unlike Step 2, `checkout_orders` is compared **in full**, because Step 3 has no write path at all |
| No float, plan, schedule, alert, user or session side effect | `provider_float_balances`, `agent_profiles`, `bundle_plans`, `scheduled_topups`, `price_alerts`, `users`, `sessions` all byte-identical |
| Reading the trail does not write the trail | `admin_audit_logs` row count re-checked after the audit sweep, and the table is in the byte-identical set |
| The read layer *cannot* write | `SET TRANSACTION READ ONLY` + `assertReadOnlyStatement` + the SQLSTATE 25006 backstop (existing `withReadOnlyTx`), all four loaders inside it (counted by the harness), plus the Phase 1 mutation scan over `src/lib/admin/**` |
| The probe cannot settle | exact-import-list assertion, no settlement symbol anywhere in the module, and a byte-identical snapshot around a full probe sweep including a throttled refusal |
| No financial module was edited | `git diff --quiet` against the base commit for 20 paths (paystack, deposits, checkout, payments, data-gateway, fulfillment, auth, api-auth, accounts, support-actions, customer-management, referrals, `/api/payments`, `/api/wallet`, `/api/checkout`, `/api/purchase`, `/api/convert`, `/api/rewards`, `admin/auth.ts`, `admin/db.ts`) |
| The one write in the harness is Step 2's, not Step 3's | the harness performs a real `delivery_resolved` through Step 2's endpoint to prove the backlog reacts, then shows **exactly one** order row changed, **every money / payment / provider column on it unchanged**, **exactly one** audit row added, and **no** audit row modified or deleted |

## 8. Defects found and fixed

Six defects in the existing dashboard motivated this step; all six are closed:

| # | Defect | Fix |
|---|---|---|
| F1 | Data-order and attention rows linked to `/admin/transactions/[ref]`, which **404 s** whenever no ledger mirror exists — i.e. exactly for the parked-before-submit orders an admin most needs to open | `hrefForAttentionRow()` routes by source: checkout → `/admin/orders/[ref]`, deposit → `/admin/payments/[ref]`, wallet → `/admin/transactions/[ref]`; checkout rows in the data view link to the order page and wallet rows to the ledger. Proved live: 5 seeded orders had no ledger row at all, and all 12 order refs + all 8 deposit refs now resolve `200` |
| F2 | Deposit rows “drilled down” by re-searching the payments list instead of opening the record | `/admin/payments/[ref]` + its API |
| F3 | `admin_audit_logs` was written by Steps 1–2 but **no screen ever read it** | `/admin/audit` + `/api/admin/audit`, plus per-record trails on both investigation pages |
| F4 | Step 2 could record a `refund_review`, and nothing could count, age or total them | `/admin/reviews` + `/api/admin/reviews`, overview tile, nav badge, `refund-reviews` issue |
| F5 | No safe way to see what Paystack holds for a parked reference | the read-only probe (section 5) |
| F6 | Failure knowledge was scattered across `checkout.ts`, `deposits.ts`, `queries-operations.ts` and `support-actions.ts`, so every screen re-derived “is this bad?” differently | one pure engine, three-way agreement asserted against the existing rules |

**A seventh defect was found by this step's own harness, in this step's own
code:** `loadAccountActions()` selected `admin_audit_logs.target_ref`
unconditionally while being gated only on the audit *table* existing. On a
database sitting between migrations 0002 and 0003 — a state the whole read layer
is built to survive — the suspend/activate history on both investigation pages
would have thrown instead of degrading. Fixed with `auditRefColumn(refTrail)`,
the same conditional projection `queries.ts` already uses via
`ADMIN_AUDIT_REF_COLUMNS`; three live checks now drop the column and assert the
history still reads with `targetRef: null`.

Also fixed on the way: `SupportWorkflowLink` accepted a prop named `ref`, which
React reserves for element references — renamed to `orderRef`.

## 9. Verification — exact results

New suite `flexiData/scripts/verify-admin-phase2-step3.ts`
(`npm run verify:admin-ops`) — **382/382 checks passed**:
**71** pure-function, **70** source-level, **241** live-database. The live
section boots a throwaway `embedded-postgres` cluster, applies the full journal
(0000→0003), seeds 12 checkout orders / 8 deposits / 6 audit rows across 4 users
and 3 wallets, imports the **actual route handlers**, and stands up a local
Paystack stub to exercise the probe end to end.

| Live section | Checks |
|---|---|
| C1 order investigation (S3.1) | 31 |
| C2 deposit investigation (S3.3) | 16 |
| C3 admin activity log (S3.4) | 34 |
| C4 refund-review backlog (S3.5), incl. the real Step 2 action closing a review | 25 |
| C5 authorization on all six endpoints | 44 |
| C6 F1/F2 dead ends gone | 21 |
| C7 the read-only probe (S3.6) | 26 |
| C8 mid-session revocation | 4 |
| C9 secret hygiene across every payload | 3 |
| C10 financial safety, byte-identical | 11 |
| C11 graceful degradation (pre-0003, pre-0002) | 25 |
| C12 every surface re-read after all of it: nothing changed | 1 |

Existing suites, re-run against the final code of this step:

| Suite | Result |
|---|---|
| `npm run verify:admin-phase1` (read-only guarantees, write scan) | **248/248** |
| `npm run verify:admin-phase2` (Step 1, write-surface invariant) | **65/65** |
| `npm run verify:admin-support` (Step 2, support workflow) | **158/158** |
| `npm run verify:admin-access` (Phase 0 gate) | **40/40** |
| `npm run verify:security-fixes` | **27/27** |
| `npm run verify:auth-flow` | **37/37** |
| `npm run verify:signup` | **24/24** (against a throwaway cluster with the journal applied) |
| `npm run verify:seed-resilience` | **6/6 scenarios** |
| `npm run verify:schema-baseline` | **6/6 flows healthy** |
| `npm run verify:demo-deposit-cleanup` | **19/19, 2/2 scenarios** |
| `npm run verify:schema-compat` | **4/5** — identical to the base commit: the two `probedown` failures reproduce at `fe8ed0d` in a clean worktree, so they are pre-existing and unrelated to this step |
| `npm run lint` · `npx tsc --noEmit` · `npm run build` | all clean; the build emits all 6 new API routes and all 4 new pages as dynamic (`ƒ`), nothing prerendered |

Reproduce locally: `npm i --no-save embedded-postgres && npm run verify:admin-ops`.
The harness never connects to a database it was not explicitly told to use —
`DATABASE_URL` is only honoured together with `FLEXIDATA_ADMIN_TEST_DB=1`,
otherwise it boots its own throwaway cluster or skips the live section loudly.

## 10. Known limitations (disclosed)

* **Nothing in this step resolves anything.** It diagnoses, displays and records
  what is already recorded. Closing an order still means Step 2's two actions or
  an out-of-band settlement by finance; every finding's guidance says so
  explicitly, and the shared suffix `NO_MONEY` (“This dashboard cannot refund,
  reverse or adjust a balance”) is on every money-adjacent rule.
* **No investigation notes.** The rejected Option B would have stored an
  operator's conclusion; Option A stores nothing, so a finding's *resolution*
  lives only in Step 2's audit rows or outside the system. This is the direct
  consequence of the zero-migration choice, not an oversight.
* **The probe is in-memory throttled.** Counters live per server instance, so a
  multi-instance deployment multiplies the effective ceiling by the instance
  count. Deliberate: persisting probe calls would be a write, and a schema-free
  store was out of scope. The bound is still real per instance, and the probe is
  a `GET` against a rate-limited gateway.
* **`duplicate-credit` is defensive.** `transactions.ref` is `UNIQUE`, so two
  successful credits for one deposit reference cannot exist in this schema; the
  rule is proved in the pure layer and the unique index is asserted live. The
  reachable variant — a credit for the **wrong amount** — is covered end to end.
* **Probe availability is read from the environment, not the database.** A
  deployment with no `PAYSTACK_SECRET_KEY` sees the button disabled with the
  reason, and the endpoint answers `503`; a `sk_live_` key without
  `PAYSTACK_LIVE_MODE` is refused by the existing lock, also `503`.
* **The activity log shows administrators only.** There is no customer-facing
  audit and no `admin_users` table; `is_admin` + allowlist remains the whole
  notion of an administrator, unchanged from Phase 0.
* **Pre-0003 / pre-0002 databases lose reference-level detail, not the page.**
  Order/deposit investigation, findings and the timeline are unaffected; only
  ref-keyed panels and the backlog report themselves unavailable.
* The attention queue, data view and payments list are unchanged apart from
  where their rows link; their own queries, counts and masking were not touched.

## 11. Stop point

Phase 2, Step 3 ends here. The next step remains the one Step 2 named: the
**real refund execution path** — it requires touching payment/refund logic, a
stored review state (i.e. a migration), and its own safety review, and must be
scoped and approved separately. Balance corrections, reversals, delivery
retries, support cases and admin management also remain un-started. The Phase 0
gate, Step 1's suspend/activate, Step 2's support workflow, and every
pre-existing customer flow are untouched and green.
