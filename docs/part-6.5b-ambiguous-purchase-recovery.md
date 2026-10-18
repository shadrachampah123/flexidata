# Part 6.5B — ambiguous purchase recovery: BLOCKED / hold-only procedure

**Current repository baseline:** `main` at `3882bd57434aa10f3eb40fda67c133fda9956c8c` (merge of PR #70).
**Gate status:** **BLOCKED / NOT VERIFIED (8/8 policy gates open).**
**Release posture:** **NO-GO for live fulfillment.**

## Decision and inspected implementation

No terminal manual-resolution endpoint, UI, SQL override or migration is shipped.
This is a documented release blocker, **not a completed resolution workflow**.
No production database or provider account was inspected. See also Part 6.4 F-5,
F-6 and F-7. Owner-reported production migration verification is not evidence
that an ambiguous provider outcome can safely be resolved.

Inspected paths:

- `flexiData/src/lib/reloadly.ts`: sandbox-only transport (`RELOADLY_MODE=sandbox`,
  `NODE_ENV !== "production"` enforced in `assertReloadlySandboxConfiguration()`).
  `submitReloadlySandbox()` sends `POST /topups-async` with `operatorId`,
  `amount: order.localAmount`, `useLocalAmount: true`, `customIdentifier: order.reference`,
  and `recipientPhone: { countryCode: "GH", number: order.recipient }`, with a
  20-second abort timeout, `redirect: "error"`, and zero retries. Even HTTP 200
  with a positive integer `transactionId` returns `providerStatus: "accepted"`
  (`status: "pending"`), never `"delivered"`. `lookupReloadlySandbox()` calls
  `GET /topups/{transactionId}/status` and returns `"delivered"` or `"rejected"`
  only when `response.ok` is true, `String(transaction.transactionId) === providerReference`,
  `transaction.customIdentifier === reference`, and both top-level `response.body.status`
  and nested `transaction.status` are mutually consistent (`"SUCCESSFUL"` or `"FAILED"`).
- `flexiData/src/lib/purchase-lifecycle.ts`: atomic wallet debit/claim/ledger creation
  (`PurchaseLifecycle.create()` locks `wallets FOR UPDATE`, checks `(wallet_id, request_key)`
  and SHA-256 payload `fingerprint`, debits `wallets.balance` or transitions
  `checkout_orders` `paid -> fulfilling`, optionally reserves generic GHS float,
  and inserts `transactions` + `purchase_attempts` in one PostgreSQL transaction);
  `submit()` commits `state = 'submitted'` before network I/O and performs at most
  one POST without retry; `reconcile()` claims up to 20 due Reloadly rows with
  `provider_reference IS NOT NULL`, `poll_count < 12`, and a 2-minute UUID lease
  (`FOR UPDATE SKIP LOCKED`); `settle()` requires matching `ref`, `provider_reference`,
  and `lease_token` and atomically settles ledger, wallet refund (`source = 'wallet'`
  only), generic float release, loyalty points/referrals, and `checkout_orders`.
  Checkout failures set `order_status = 'fulfillment_failed'` without crediting the
  customer wallet and need a separate externally-paid refund procedure.
- `flexiData/src/app/api/purchase/route.ts` and `flexiData/src/app/api/purchase/callback/route.ts`:
  `POST /api/purchase` runs `assertDataProviderRuntimeSafe()` before authentication or
  wallet access and requires `Idempotency-Key` (`^[A-Za-z0-9_-]{1,100}$`) for non-mock
  data purchases. `POST /api/purchase/callback` unconditionally rejects `tx.provider === "reloadly"`
  and any durable row (`tx.subtitle.startsWith("[durable] ")`) with HTTP `409`.
- `flexiData/drizzle/0011_purchase_attempts.sql` and `flexiData/src/db/schema.ts`: six states
  (`created`, `submitted`, `pending`, `unknown`, `delivered`, `failed`); unique
  `(wallet_id, request_key)` and partial unique `(provider, provider_reference) WHERE provider_reference IS NOT NULL`;
  `poll_count BETWEEN 0 AND 12`; no manual hold flag or resolution evidence table.
  `unknown` is unresolved, **not** a dedicated persistent poller hold.
- `flexiData/src/lib/admin/auth.ts` and `flexiData/src/lib/admin/request-policy.ts`:
  branded, session-derived two-signal admin gate (`users.is_admin = true` plus
  `ADMIN_EMAILS`) and same-origin write provenance check. Customer identity/test
  seams must never authorize money-changing actions.
- `flexiData/src/lib/support-actions.ts`: existing checkout support actions
  (`delivery_resolved`, `refund_review`) touch only `checkout_orders` delivery
  columns and `admin_audit_logs`; they are not durable purchase settlement and
  must not be reused for ambiguous `purchase_attempts` outcomes.
- `admin_audit_logs` / migration 0007 / `flexiData/src/lib/admin/audit-writer.ts`:
  constrained 6-action vocabulary (`suspend`, `activate`, `delivery_resolved`,
  `refund_review`, `approve_withdrawal`, `reject_withdrawal`), 240-character
  reason bound, 4–40-character target ref, partial replay index. No
  purchase-resolution action or structured evidence/version history. Do not widen
  this ad hoc or overwrite an existing audit row.

## Eight-gate classification summary (repository facts vs. external evidence vs. owner decisions)

| Gate | Priority focus | Verified in repository (`PASS` for hold boundary) | External Reloadly / provider account-owner evidence needed | Internal owner policy / design approval needed | Current status |
| --- | --- | --- | --- | --- | --- |
| **1. Provider correlation identifiers & missing-ID lookup** | Priority 1 (Part 6.4 F-1, F-6) | `submitReloadlySandbox` sends `customIdentifier = order.reference`; `lookupReloadlySandbox` requires exact `transactionId` + `customIdentifier` match; DB enforces partial unique `(provider, provider_reference)`; no-reference rows are never polled (`verify:purchase-lifecycle`). | Written contract/confirmation and sandbox trace for `customIdentifier` uniqueness, lookup method when `transactionId` is missing (timeout/response loss), retention window, duplicate mapping, and empty-search semantics. | Integration owner + Reloadly account owner sign-off on the versioned correlation/lookup contract and rule that empty/expired search is never proof of failure. | **BLOCKED / NOT VERIFIED** |
| **2. Authoritative finality, callbacks & delayed outcomes** | Priority 2 (Part 6.4 F-6, F-7) | Only mutually consistent `SUCCESSFUL` or `FAILED` on `GET /topups/{id}/status` settles a row; HTTP 200 on `/topups-async` is `pending`; `/api/purchase/callback` returns HTTP 409 for Reloadly and `[durable]` rows (`verify:reloadly`, `verify:purchase-lifecycle`). | Written provider confirmation of status state machine, maximum finality window, post-`SUCCESSFUL` reversal or post-`FAILED` late delivery behavior, and webhook signature/replay/delivery contract (if callbacks are ever proposed). | Integration/Security owner + provider technical owner approval of the terminal-evidence matrix, finality window, and callback lock policy. | **BLOCKED / NOT VERIFIED** |
| **3. Duplicate requests, retries, float, refunds, reversals & partial fulfillment** | Priority 3 (Part 6.4 F-3, F-5) | `(wallet_id, request_key)` + SHA-256 fingerprint prevent duplicate client debits; `submit()` never retries POST; failed wallet purchases refund exactly once; failed checkout purchases never credit the wallet; Reloadly skips generic GHS float projection (`verify:purchase-lifecycle`). | Reloadly account currency, wholesale pricing/discount/fee schedule, denomination mapping (`useLocalAmount: true`), duplicate-submission behavior on identical `customIdentifier`, and provider reversal/partial-fulfillment rules. | Finance/Treasury owner, Paystack/payment owner, and provider account owner approval of float accounting, wallet vs. checkout refund funding/authority, partial fulfillment, and late-success-after-refund handling. | **BLOCKED / NOT VERIFIED** |
| **4. Evidence ownership, access & retention** | Policy / Governance | `purchase_attempts` stores sanitized request JSON and provider reference only (no secrets or raw error payloads); `admin_audit_logs` is constrained to 6 existing actions (`verify:admin-phase3-6`). | Confirmation of which provider dashboard/API fields and support ticket artefacts may be retained as immutable audit evidence. | Security/Privacy/Data owner + Incident owner approval of restricted store, custodian, retention/deletion schedule, and digest-only linkage in DB/GitHub. | **BLOCKED / NOT VERIFIED** |
| **5. Safe state transitions & persistent hold semantics** | Engineering / Data Integrity | 6 persisted states (`created`, `submitted`, `pending`, `unknown`, `delivered`, `failed`); lease token fencing; terminal immutability; `unknown` with a reference remains pollable up to `MAX_PURCHASE_POLLS = 12`. | None beyond Gates 1–2 finality windows. | Engineering/data-integrity owner + release owner approval of legal transition graph, treatment of stale `created` and exhausted/no-reference rows, and persistent review-hold state that excludes pollers. | **BLOCKED / NOT VERIFIED** |
| **6. Idempotency & concurrency for future resolution** | Engineering / Database | Existing purchase creation and settlement use row locks (`FOR UPDATE`), unique constraints, and UUID lease fencing; 20-way concurrent settlement tests pass (`verify:purchase-lifecycle`). | None (internal database/API invariant). | Engineering/database owner + Finance/Treasury owner approval of resolution-event schema, idempotency key/fingerprint rules, expected-state/version locking, and opposite-decision conflict rejection. | **BLOCKED / NOT VERIFIED** |
| **7. Reviewer & approval requirements (maker-checker)** | Security / Finance / Governance | Two-signal admin gate (`requireAdminApi()`) and same-origin request provenance (`adminWriteRequestDecision()`) exist, but admin power is binary (`is_admin`) with no maker-checker purchase table (`docs/admin-ops-dashboard/08-phases-3-6-safe-progress.md`). | None (internal governance/authorization). | Account/release owner, Finance/Treasury owner, and Security owner approval of two-person control (`requester != approver`), per-role thresholds, and server-side transactional enforcement. | **BLOCKED / NOT VERIFIED** |
| **8. Escalation, SLAs & customer communication** | Operations / Support | `reconcile:purchases -- --report` and `--check` classify 5 attention categories (`reconciliation_overdue`, `retry_budget_exhausted`, `unresolved_without_provider_reference`, `created_not_submitted`, `backlog_exceeds_report_cap`) read-only (`verify:production-readiness`). | Provider support escalation contact, ticket SLA, and dispute-resolution window for stuck or unreferenced top-ups. | Operations/incident owner, Customer Support owner, Finance owner, and release owner approval of on-call roster, response SLAs, escalation thresholds, and non-promissory customer message templates. | **BLOCKED / NOT VERIFIED** |

## Owner decision checklist — all policy gates unresolved

The following code facts were checked in the current source, but **none of the
external provider/business decisions or named owner approvals is recorded in
this repository**. The roles below are required approvers to assign, not claims
that particular people are appointed. A safe interim proposal is not an
approved policy. Until the relevant owners decide and evidence it, keep
ambiguous outcomes unresolved and do not implement terminal overrides.

- [ ] **1. Provider correlation identifiers**
  - **Code fact:** `submitReloadlySandbox` sends the FlexiData purchase reference
    as `customIdentifier` and stores a numeric provider `transactionId` when
    returned. `lookupReloadlySandbox` trusts a status only when both the stored
    ID and exact `customIdentifier` match. The code explicitly does not treat
    `customIdentifier` as a provider idempotency guarantee.
  - **Decision needed:** confirm identifier uniqueness, lookup method and
    coverage for a lost provider ID, retention period, duplicate mapping rules,
    and what an absent search result means. A timeout, elapsed time, empty
    result or customer assertion proves neither delivery nor rejection.
  - **Safe interim:** never retry/resubmit an ambiguous POST; a missing or
    uncorrelated reference remains unresolved.
  - **Evidence required:** provider contract or dated written support confirmation; sandbox
    trace for ID creation, lookup by stored ID and `customIdentifier`, uniqueness, no-ID
    lookup, retention window and empty-result semantics. No live provider call is authorized.
  - **Acceptance criteria:** both owners sign a versioned correlation/lookup contract that
    states which outcomes are authoritative and confirms an empty, absent or expired lookup
    is not proof of failure. Tests preserve an unresolved state when correlation is missing.
  - **Approver:** Reloadly account/provider technical owner and FlexiData
    integration owner. **Status: awaiting decision/evidence.**

- [ ] **2. Authoritative finality, delayed/duplicate outcomes and callbacks**
  - **Code fact:** only a correlated status lookup with both provider status
    fields exactly `SUCCESSFUL` or exactly `FAILED` becomes terminal; other,
    inconsistent or unavailable results remain `unknown`. The callback route
    rejects Reloadly and durable purchase rows with HTTP 409. Reconciliation is
    leased and fenced; terminal settlement is single-winner.
  - **Decision needed:** identify authoritative status semantics, finality
    window, reversals/late final statuses, and the handling of duplicate or
    out-of-order events. If callbacks are ever proposed, separately establish
    signature authentication, replay protection and provider delivery
    guarantees. A submission receipt is not delivery proof.
  - **Safe interim:** keep callbacks refused and use only the existing
    correlated status-read path; conflicting or delayed evidence stays
    unresolved for review. Do not reopen a terminal row by direct mutation.
  - **Evidence required:** provider documentation/support confirmation of finality and
    reversal windows; dated examples for late, duplicate and out-of-order outcomes; callback
    signature, replay and delivery guarantees if callbacks are proposed.
  - **Acceptance criteria:** owners approve a terminal-evidence matrix for every status/event
    and a finality window; late/duplicate/conflicting events cannot reopen terminal rows.
    Callback ingestion remains disabled until its independent authentication/replay gate is
    proven and reviewed.
  - **Approver:** provider/account technical owner plus FlexiData
    integration/security owner. **Status: awaiting decision/evidence.**

- [ ] **3. Float, refund, reversal and partial-fulfillment policy**
  - **Code fact:** a verified failed wallet purchase returns the wallet debit in
    the settlement transaction. A failed checkout purchase does **not** credit
    the wallet; any externally paid refund is separate. Existing GHS float
    reservation/release applies to generic providers; Reloadly denomination,
    currency conversion and float accounting are not established here.
  - **Decision needed:** approve provider denomination/currency and float
    accounting, who funds and authorizes wallet vs. checkout refunds, partial
    fulfillment, duplicate charges, chargebacks/reversals, and what happens if
    a late success follows a refund. No such policy is established by this code.
  - **Safe interim:** do not infer Reloadly spend from customer retail price;
    do not refund or mark failed on uncertainty, and do not resubmit. Keep
    external checkout refunds outside this purchase path.
  - **Evidence required:** approved Reloadly denomination/currency and fee schedule;
    reconciled float examples; Finance/Treasury policy for wallet refunds, partial fulfillment
    and late success; payment-owner rules for Paystack checkout refunds, reversals and
    chargebacks.
  - **Acceptance criteria:** a signed scenario matrix defines funding, ledger/float treatment
    and who authorizes each wallet or external checkout refund, including partial/duplicate/
    late outcomes. Synthetic tests demonstrate approved accounting invariants; no real
    payment or provider operation is part of acceptance.
  - **Approver:** Finance/Treasury owner and provider account owner; Paystack or
    payment owner for checkout refunds. **Status: awaiting decision/evidence.**

- [ ] **4. Evidence ownership, access and retention**
  - **Code fact:** `purchase_attempts` has no evidence/resolution-event history.
    Existing `admin_audit_logs` has a constrained vocabulary and checkout/account
    semantics; it is not an evidence store. No evidence retention owner/policy
    is recorded.
  - **Decision needed:** define acceptable evidence and provenance, who captures
    and independently reviews it, restricted storage/access, retention and
    deletion schedule, auditability, and what may be referenced by digest only.
  - **Safe interim:** preserve original artifacts in an approved restricted
    incident record; record references/digests and reviewers, not secrets, raw
    provider payloads or unnecessary customer data in GitHub. Missing evidence
    means no terminal decision.
  - **Evidence required:** named record custodian; approved evidence schema/provenance
    rules; restricted-store access list; retention/deletion schedule; audit and legal/privacy
    review; rules for references/digests versus source payloads.
  - **Acceptance criteria:** the approved process keeps original evidence immutable with
    timestamps, actor/reviewer and provenance; limits access and retention; preserves an
    auditable reference from each decision; and forbids secrets/raw customer payloads in
    GitHub. Missing or unverifiable evidence cannot support terminal resolution.
  - **Approver:** named incident owner plus Security/Privacy/Data owner.
    **Status: awaiting decision/evidence.**

- [ ] **5. Safe state transitions and persistent hold semantics**
  - **Code fact:** the six persisted states are `created`, `submitted`, `pending`,
    `unknown`, `delivered` and `failed`. Submission commits `submitted` before
    network I/O and never retries the POST. Settlement requires the stored
    provider reference and the matching stored lease token; a later poll claim
    replaces that token and fences the earlier worker. Terminal states are not
    eligible for another settlement. `unknown` is nonterminal and is **not** a
    dedicated persistent hold flag; referenced rows may still receive bounded
    status reads.
  - **Decision needed:** approve the complete legal transition graph, treatment
    of stale `created` and exhausted/no-reference rows, any future review-hold
    state and poller exclusion, and how late evidence after terminal state is
    handled.
  - **Safe interim:** no direct SQL/state forcing, no fabricated reference,
    refund or resubmission; preserve the existing guarded transitions only.
  - **Evidence required:** versioned transition table for every persisted and proposed hold
    state, including stale `created`, no-reference/exhausted rows, poll eligibility, late
    evidence and terminal records; reviewed worker-exclusion/lease-fencing design.
  - **Acceptance criteria:** engineering/data-integrity and release owners approve the legal
    graph and persistent-hold semantics. A hold survives every poll/worker path, cannot
    settle or trigger a POST/refund, and can be released only through an approved transition;
    terminal states remain immutable. Tests cover every allowed and refused edge.
  - **Approver:** FlexiData engineering/data-integrity owner and release owner.
    **Status: awaiting decision/evidence.**

- [ ] **6. Idempotency and concurrency for any future resolution**
  - **Code fact:** wallet purchase claims are unique by wallet/request key and
    payload fingerprint; changed-payload reuse conflicts. Provider references
    are unique; polling uses leases/fencing; settlement effects are transactional
    and replay-safe. These safeguards do not define a manual resolution API.
  - **Decision needed:** specify resolution-event identity/key, exact replay
    response, changed-evidence conflict behavior, stale expected-state/version
    handling, and simultaneous opposite-decision handling.
  - **Safe interim:** preserve current purchase idempotency; any future resolution
    must make identical retries a no-op/replay and reject changed or competing
    decisions before money moves. Never replay the provider POST.
  - **Evidence required:** reviewed resolution-event/API design, key/fingerprint rules,
    expected-state/version fields, lease invalidation order and transaction/locking design;
    disposable PostgreSQL concurrency and rollback test results.
  - **Acceptance criteria:** identical retry returns the same recorded decision without
    repeating money effects; changed payload, stale version or competing opposite decision
    is rejected before settlement; only one winner can commit; original provider evidence
    remains immutable. No provider POST or payment API is called.
  - **Approver:** FlexiData engineering/database owner and Finance/Treasury
    owner. **Status: awaiting decision/design approval.**

- [ ] **7. Reviewer and approval requirements**
  - **Code fact:** a session-derived admin gate exists, but there is no purchase
    resolution endpoint, second-approver workflow, or suitable append-only
    purchase evidence schema. The existing admin log is not sufficient.
  - **Decision needed:** assign who may request, independently review and approve
    each evidence-based decision; specify thresholds, separation of duties and
    whether provider/finance approval is additionally required.
  - **Safe interim:** propose two-person control for every future money-changing
    resolution (requester and approver must differ), with Finance and release
    owner sign-off; no single-person override or direct SQL. This proposal is
    not yet approved.
  - **Evidence required:** role/threshold matrix for requester, evidence reviewer and
    money-changing approver; server-side authority model; append-only audit/evidence design;
    conflict-of-interest and separation rules.
  - **Acceptance criteria:** a requester cannot approve their own decision; independent
    approval is enforced server-side and within the mutation transaction; missing/expired
    authority fails closed; audit history is append-only. Authorization tests cover
    unauthorized, same-person, revoked-role and stale-session cases. This proposal remains
    unapproved until the owners sign it.
  - **Approver:** account/release owner, Finance/Treasury owner and Security
    owner. **Status: awaiting decision/owner assignment.**

- [ ] **8. Escalation, service levels and customer communication**
  - **Code fact:** `--report` and `--check` are read-only and classify attention
    cases; no scheduler, monitoring activation, on-call owner or provider
    escalation procedure is established. No-reference rows cannot be status-read
    by the current poller.
  - **Decision needed:** name primary/backup incident owners, response targets,
    provider-support and finance escalation paths, customer communication owner,
    and escalation thresholds for no-reference, exhausted, contradictory and
    late outcomes.
  - **Safe interim:** alert/escalate through an already approved incident
    process if one exists; age, customer pressure or a missed response target
    never turns an unknown outcome into success, failure, refund or resubmission.
  - **Evidence required:** named primary/backup contacts and response targets; provider,
    release and Finance escalation paths; escalation thresholds; customer-communication
    owner; approved message templates and privacy review; synthetic tabletop record if
    required by the owners.
  - **Acceptance criteria:** an approved runbook names an accountable owner for each signal
    and customer update, gives response/escalation deadlines, and states uncertainty without
    promising delivery/refund or inviting resubmission. Review uses synthetic scenarios only;
    no live provider/customer message is required for this documentation gate.
  - **Approver:** Operations/incident owner, account/release owner, Finance and
    Customer Support owner. **Status: awaiting owner assignment/decision.**

Owner/provider confirmation must be retained in an access-controlled incident
record before revisiting the implementation. Do not place secrets, raw payloads,
phone numbers, payment credentials or database URLs in GitHub or public health.

## Operator runbook — available now, no terminal writes

1. Assign an incident owner. Record an incident ID, purchase ref, source, current
   state, timestamps, existing provider reference if any, poll count/lease, and
   correlation to the ledger in restricted storage. Preserve original artifacts;
   do not edit provider_reference, provider_status, request or raw outcomes.
2. Collect existing provider evidence through the approved incident process.
   This session authorizes no provider calls. Distinguish independently verified
   final evidence from reports/assumptions. Record who reviewed it and when.
3. Missing, conflicting or uncorrelated evidence: **leave unresolved for review**.
   Do not resubmit, create a replacement purchase, refund, award points, mark
   successful/failed or set a fabricated provider reference. Do not reset poll
   counts or manufacture a settlement lease.
4. No-reference and exhausted rows are not automatically polled. Other unresolved
   rows remain subject to the existing bounded poller if one is independently
   activated; this release adds no persistent hold control. If an incident needs
   a hard pause, escalate to the release owner for the approved operational
   procedure; do not improvise database edits. No scheduler is activated here.
5. Escalate sufficient-looking evidence to the owner; terminal resolution is still
   blocked until the contracts above and reviewed tooling exist. Existing
   `settle()` is an internal reconciliation primitive, not an operator API.
6. Recheck the restricted incident record for late evidence. Keep every review
   append-only, including unsuccessful decisions. No evidence means no terminal
   decision, irrespective of age or customer pressure.

## Required implementation once unblocked (not an executable procedure)

- Server-side session admin gate on each action, origin/CSRF protection matching
  admin routes, no customer/test-seam authorization; deny on missing audit schema.
  Revalidate authority within the mutation transaction; record stable actor ID.
- Additive, separately reviewed resolution-event schema: immutable event ID,
  purchase FK, actor, incident/evidence references and digest, reason, decision,
  expected version/state, before/after snapshots, timestamps and idempotency key.
  Never overwrite original provider outcomes or use an admin decision as a
  provider response. Insufficient evidence records review only, no settlement.
- Explicit legal transitions: unresolved to review hold; review hold to delivered
  or failed only with approved correlated final evidence; terminal states immutable.
  Define hold lifecycle and status-worker exclusion before releasing the tool.
- Lock purchase then ledger in consistent order; invalidate/fence existing leases;
  compare expected version/state. Atomic event + settlement or full rollback.
  Unique idempotency key/fingerprint: same request returns same result, changed
  payload conflicts; simultaneous conflicting decisions cannot both win.
- Exactly-once wallet refund, float release, points/referral and checkout updates
  using reviewed settlement semantics; never invoke fulfillment POST or payment
  API. External checkout refunds remain separate and audited.
- Disposable PostgreSQL tests required: unauthorized/CSRF/stale actor denial,
  missing/contradictory evidence, legal/illegal transitions, evidence retention,
  idempotent replay and payload conflict, simultaneous opposite decisions,
  stale poll worker race, duplicate refund/reward prevention, checkout separation,
  transaction rollback and preservation of original outcomes/audit history.
- A new additive migration needs a guarded runner, drift/refusal tests and
  disposable-only verification. No production application in this task.

## Verification scope

The existing real-PostgreSQL lifecycle suite is extended to demonstrate that a
no-reference ambiguous purchase remains unchanged across concurrent reconciliation
and attempted resubmission; it also checks evidence-free settlement cannot match
a lease/reference. These are **hold invariants**, not tests of a manual workflow.
The broader suite covers existing lease fencing, terminal replay, rollback,
refund/points exactly once and callback refusal. CI runs synthetic providers only.

---

## Provider-evidence request packet (Reloadly / account owner)

Submit the questions and sandbox trace requests below to Reloadly technical
support or the authorized Reloadly account owner. Store raw responses, sandbox
logs, and commercial documents in the restricted evidence store; record only
versioned document references and SHA-256 digests in repository records. Every
item below is currently **`BLOCKED / NOT VERIFIED`**.

### Section P-1 — Correlation identifiers & lookup when `transactionId` is missing (Gate 1 / Part 6.4 F-1, F-6)

| Item | Question / required artifact from Reloadly | Current status |
| --- | --- | --- |
| **P-1.1 `customIdentifier` contract** | Confirm the exact character set, maximum length, and persistence guarantee for `customIdentifier` on `POST /topups-async` (FlexiData currently sends `^[A-Za-z0-9_-]{1,100}$` purchase `ref`). Confirm that `GET /topups/{transactionId}/status` always echoes `transaction.customIdentifier` verbatim. | **BLOCKED / NOT VERIFIED** |
| **P-1.2 Server-side deduplication on `customIdentifier`** | Does Reloadly enforce uniqueness or idempotency on `customIdentifier` (rejecting or replaying a second `POST /topups-async` with the same `customIdentifier`), or will a second POST execute a second billable top-up? (FlexiData currently assumes **no** provider deduplication and never retries `POST /topups-async`.) | **BLOCKED / NOT VERIFIED** |
| **P-1.3 Lookup when `transactionId` is lost** | When `POST /topups-async` times out or drops the connection before FlexiData receives `transactionId`, what API endpoint (e.g., `GET /topups/reports/transactions?customIdentifier=...`) or dashboard search locates the attempt by `customIdentifier` alone? Provide an account-backed sandbox trace demonstrating lookup by `customIdentifier` without `transactionId`. | **BLOCKED / NOT VERIFIED** |
| **P-1.4 Indexing lag & empty-search semantics** | After `POST /topups-async` is accepted by Reloadly, what is the maximum indexing delay before a transaction appears in history/search or status lookup? After what elapsed window (if ever) does an empty `customIdentifier` search prove Reloadly never received the request? | **BLOCKED / NOT VERIFIED** |
| **P-1.5 Retention window & duplicate mapping** | How long are `transactionId` and `customIdentifier` retained in Reloadly status and report endpoints, and how does the search API behave if multiple transactions ever share a `customIdentifier`? | **BLOCKED / NOT VERIFIED** |

### Section P-2 — Authoritative transaction finality, callbacks & delayed status behavior (Gate 2 / Part 6.4 F-6, F-7)

| Item | Question / required artifact from Reloadly | Current status |
| --- | --- | --- |
| **P-2.1 Status state machine & dual-field agreement** | Confirm the complete set of possible values for top-level `status` and nested `transaction.status` on `GET /topups/{transactionId}/status` (e.g., `SUCCESSFUL`, `FAILED`, `PROCESSING`, `PENDING`, `REFUNDED`). Can top-level `status` and `transaction.status` ever disagree, and what does each combination mean? | **BLOCKED / NOT VERIFIED** |
| **P-2.2 Maximum finality window** | What is the maximum time an async Ghana data top-up can remain in `PROCESSING` / `PENDING` before reaching a terminal `SUCCESSFUL` or `FAILED` state? (FlexiData's poller currently performs at most 12 reads over ~6 hours.) | **BLOCKED / NOT VERIFIED** |
| **P-2.3 Post-terminal reversals or late delivery** | Can a transaction reported as `SUCCESSFUL` later transition to `FAILED` / `REFUNDED` (operator clawback), or can a transaction reported as `FAILED` later deliver data to the recipient? If so, within what window and how is it surfaced? | **BLOCKED / NOT VERIFIED** |
| **P-2.4 Webhook / callback contract (if ever used)** | Does Reloadly provide authenticated webhooks for `/topups-async`? If so, provide the exact signature header, signing algorithm, timestamp/replay window, retry schedule, and payload schema. (Until independently verified and approved, `/api/purchase/callback` refuses all Reloadly and durable rows with HTTP `409`.) | **BLOCKED / NOT VERIFIED** |

### Section P-3 — Duplicate requests, retries, refunds, reversals, partial fulfillment & float (Gate 3 / Part 6.4 F-2, F-3, F-4, F-5)

| Item | Question / required artifact from Reloadly | Current status |
| --- | --- | --- |
| **P-3.1 Ghana data catalogue & Telecel coverage** | Provide the current authenticated Reloadly operator catalogue (`operatorId`, supported local denominations, bundle descriptions) for MTN Ghana Data and Telecel Ghana Data. Confirm whether Telecel Ghana **data** bundles are supported in sandbox and production. | **BLOCKED / NOT VERIFIED** |
| **P-3.2 Account currency, wholesale pricing & float deduction** | Confirm the Reloadly wallet billing currency, FX/discount calculation when `useLocalAmount: true` is sent, when Reloadly debits account float (on `POST /topups-async` acceptance vs. `SUCCESSFUL`), and when/how Reloadly credits float back on `FAILED`. | **BLOCKED / NOT VERIFIED** |
| **P-3.3 Partial fulfillment & denomination mismatch** | Can a Ghana data top-up ever partially fulfill (delivering a smaller bundle or airtime credit instead of the requested data bundle), and how is that represented in the status response and account ledger? | **BLOCKED / NOT VERIFIED** |
| **P-3.4 Provider support escalation & dispute SLA (Gate 8)** | Provide the Reloadly support channel, required fields (`transactionId`, `customIdentifier`, UTC timestamp, operator), response SLA, and dispute-resolution window for stuck or unreferenced transactions. | **BLOCKED / NOT VERIFIED** |

---

## Owner decision and sign-off template — leave blank until verified

Keep completed records and underlying provider/financial artifacts in the
restricted evidence store. Record only immutable reference IDs and SHA-256
digests here; never commit secrets, raw customer phone numbers, database URLs,
or unredacted provider payloads to Git. Do **not** fill in synthetic values or
treat this template as an approval.

```text
Part 6.5B decision record ID:
Repository baseline SHA: 3882bd57434aa10f3eb40fda67c133fda9956c8c
Overall Part 6.5B gate status: BLOCKED / NOT VERIFIED
Live fulfillment release posture: NO-GO (locked in code and policy)

GATE 1 — PROVIDER CORRELATION IDENTIFIERS & MISSING-ID LOOKUP
  Status: BLOCKED / NOT VERIFIED
  Reloadly technical owner / contact reference:
  FlexiData integration owner (person ID / role):
  Provider contract / support confirmation reference & SHA-256 digest:
  Sandbox trace reference (stored ID + customIdentifier + missing-ID lookup):
  Approved minimum wait window before treating absent customIdentifier lookup as non-received:
  Signed-off timestamp (UTC):

GATE 2 — AUTHORITATIVE FINALITY, DELAYED OUTCOMES & CALLBACK POLICY
  Status: BLOCKED / NOT VERIFIED
  Provider technical owner + FlexiData integration/security owner (person IDs / roles):
  Approved terminal status matrix reference & SHA-256 digest:
  Maximum finality window (hours/days) and post-terminal reversal policy:
  Callback posture (KEEP DISABLED HTTP 409 / SEPARATE AUTH GATE REFERENCE):
  Signed-off timestamp (UTC):

GATE 3 — DUPLICATE REQUESTS, RETRIES, FLOAT, REFUNDS, REVERSALS & PARTIAL FULFILLMENT
  Status: BLOCKED / NOT VERIFIED
  Finance/Treasury owner (person ID / role):
  Reloadly account owner (person ID / role):
  Paystack / payment owner for external checkout refunds (person ID / role):
  Approved Ghana data SKU & denomination schedule reference & SHA-256 digest:
  Approved Reloadly float currency/accounting & reconciliation rules reference:
  Wallet refund vs. external Paystack checkout refund authorization matrix reference:
  Treatment of partial fulfillment and late-success-after-refund:
  Signed-off timestamp (UTC):

GATE 4 — EVIDENCE OWNERSHIP, ACCESS & RETENTION
  Status: BLOCKED / NOT VERIFIED
  Named incident record custodian (person ID / role):
  Security/Privacy/Data owner (person ID / role):
  Restricted evidence store location & access-control policy reference:
  Retention / deletion schedule & digest-only GitHub rule reference:
  Signed-off timestamp (UTC):

GATE 5 — SAFE STATE TRANSITIONS & PERSISTENT HOLD SEMANTICS
  Status: BLOCKED / NOT VERIFIED
  FlexiData engineering/data-integrity owner (person ID / role):
  Account/release owner (person ID / role):
  Approved state transition table reference (created, submitted, pending, unknown, review_hold, delivered, failed):
  Worker-exclusion / lease-fencing specification for review_hold rows:
  Signed-off timestamp (UTC):

GATE 6 — IDEMPOTENCY & CONCURRENCY FOR FUTURE MANUAL RESOLUTION
  Status: BLOCKED / NOT VERIFIED
  FlexiData engineering/database owner (person ID / role):
  Finance/Treasury owner (person ID / role):
  Approved resolution-event schema & idempotency-key/fingerprint specification reference:
  Expected-state/version locking & opposite-decision rejection test plan reference:
  Signed-off timestamp (UTC):

GATE 7 — REVIEWER & APPROVAL REQUIREMENTS (MAKER-CHECKER)
  Status: BLOCKED / NOT VERIFIED
  Account/release owner (person ID / role):
  Finance/Treasury owner (person ID / role):
  Security owner (person ID / role):
  Two-person control matrix (requester != approver, role caps, step-up freshness) reference:
  Alignment with Admin Phase 3 (Decision 3A) and Phase 5 (Decision 5A) reference:
  Signed-off timestamp (UTC):

GATE 8 — ESCALATION, SERVICE LEVELS & CUSTOMER COMMUNICATION
  Status: BLOCKED / NOT VERIFIED
  Operations/incident owner (primary & backup person IDs / roles):
  Customer Support owner (person ID / role):
  Finance escalation contact (person ID / role):
  Approved SLA thresholds (no-reference, exhausted, stale-created, overdue) & runbook reference:
  Approved non-promissory customer communication templates reference:
  Signed-off timestamp (UTC):

OVERALL SIGN-OFF TO BEGIN PART 6.5B TOOLING IMPLEMENTATION (GATES 1–8 ALL REQUIRED)
  Decision: BLOCKED — DO NOT IMPLEMENT TERMINAL RECOVERY OR UNLOCK LIVE FULFILLMENT
  Account/release owner signature / reference / timestamp (UTC):
```
