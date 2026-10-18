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

## Missing facts that block terminal actions

1. Provider-approved lookup/correlation for a lost provider reference (including
   customIdentifier uniqueness, retention and the meaning of an absent result).
   A timeout, elapsed time, empty search or customer assertion proves neither
   delivery nor rejection.
2. Authoritative final status semantics, finality window and evidence provenance;
   late delivery and contradictory evidence handling. A submission receipt is
   not delivery proof.
3. Approved float currency/accounting policy and externally-paid refund policy.
   Manual failure would change balances; inventing policy risks double benefit.
4. Named approver, evidence retention/access policy and incident ownership.

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
