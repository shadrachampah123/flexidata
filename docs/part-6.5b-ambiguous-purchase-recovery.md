# Part 6.5B — ambiguous purchase recovery: BLOCKED / hold-only procedure

## Decision and inspected implementation

No terminal manual-resolution endpoint, UI, SQL override or migration is shipped.
This is a documented release blocker, **not a completed resolution workflow**.
No production database or provider account was inspected. See also Part 6.4 F-5,
F-6 and F-7. Owner-reported production migration verification is not evidence
that an ambiguous provider outcome can safely be resolved.

Inspected paths:

- `src/lib/purchase-lifecycle.ts`: atomic wallet debit/claim/ledger creation;
  submitted-before-network claim; no POST retry; leased, fenced status reads;
  terminal settlement couples ledger, wallet refund, float, points/referrals and
  checkout updates. Wallet failures refund; checkout failures do not credit the
  wallet and need a separate externally-paid refund procedure.
- `drizzle/0011_purchase_attempts.sql` and `src/db/schema.ts`: six states;
  provider-reference uniqueness; no manual hold flag or resolution evidence table.
  `unknown` is unresolved, **not** a dedicated persistent poller hold.
- `src/lib/admin/auth.ts`: branded, session-derived admin context and allowlist
  gate. Customer identity/test seams must never authorize money-changing actions.
- `src/lib/support-actions.ts`: existing checkout support actions are not durable
  purchase settlement. `delivery_resolved` must not be reused for ambiguous
  `purchase_attempts` outcomes.
- `admin_audit_logs` / migration 0007: constrained action vocabulary, short reason,
  checkout-oriented target ref, replay index. No purchase-resolution action or
  structured evidence/version history. Do not widen this ad hoc or overwrite an
  existing audit row.

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
  - **Approver:** named incident owner plus Security/Privacy/Data owner.
    **Status: awaiting decision/evidence.**

- [ ] **5. Safe state transitions and persistent hold semantics**
  - **Code fact:** the six persisted states are `created`, `submitted`, `pending`,
    `unknown`, `delivered` and `failed`. Submission commits `submitted` before
    network I/O and never retries the POST. Settlement requires the stored
    provider reference and a live lease token; terminal states are not eligible
    for another settlement. `unknown` is nonterminal and is **not** a dedicated
    persistent hold flag; referenced rows may still receive bounded status reads.
  - **Decision needed:** approve the complete legal transition graph, treatment
    of stale `created` and exhausted/no-reference rows, any future review-hold
    state and poller exclusion, and how late evidence after terminal state is
    handled.
  - **Safe interim:** no direct SQL/state forcing, no fabricated reference,
    refund or resubmission; preserve the existing guarded transitions only.
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
