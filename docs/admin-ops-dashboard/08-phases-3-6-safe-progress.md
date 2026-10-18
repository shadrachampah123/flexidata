# Phases 3–6 — Safe progress, inactive boundaries, and owner decisions

**Evidence date:** 2026-10-18  
**Baseline verified before this work:** `main` at `c39717591fa235f43e9cf6b08e6e5f4a5c874bc0` (merge of PR #66)  
**Status:** safe repository work implemented; Phases 3–6 are **not complete** and no owner decision is implied.

This record separates what can be hardened against the currently shipped schema from
what would require a new data model or an authorization/policy decision. It is
intentionally conservative: a DB-free check is evidence for the checked invariant,
not evidence of database-backed behavior, deployment health, or operational approval.

## Implemented safe work

### Phase 3 — RBAC and audit accountability boundary

1. **Existing admin writes now require same-origin request provenance.**
   `src/lib/admin/request-policy.ts` checks `Sec-Fetch-Site: cross-site`, an
   opaque or mismatched `Origin`, and an absent/invalid provenance fallback after
   `requireAdminApi()` has already passed. The four existing admin POST routes use
   it before parsing request bodies or reaching their write logic:
   - customer status;
   - order support;
   - payout reconciliation;
   - withdrawal actions.

   The deployment/caller review found only same-origin browser components in
   `src/`, with no server-to-server admin write caller or separately documented
   external admin API contract. Normal POST fetches use `Origin`; same-origin
   `Sec-Fetch-Site` or a same-origin `Referer` is accepted only as a fallback.
   Completely headerless requests fail closed with 403. This is still a narrow
   request-boundary control, not a claim that an RBAC, session, or Origin allowlist
   has been approved. The existing admin gate remains first and unchanged.

2. **Current audit INSERT values have one typed boundary.**
   `src/lib/admin/audit-writer.ts` is a value builder, not a new writer or schema.
   It uses only the six action values already enforced by the shipped
   `admin_audit_logs` CHECK, validates the six actions at runtime as well as in
   TypeScript, validates server-controlled positive actor/target ids, bounds the
   existing 240-character reason column, and validates the existing
   target-reference shape. The six current central audit inserts now use it.
   The generated checkout `CO-…` and withdrawal `WDL-…` references fit the
   existing `varchar(40)`/4–40-character contract; the support normalizer uses the
   same charset and bounds. Customer/support reasons are clamped before the
   insert, withdrawal actions reject overlong reasons, and the writer remains the
   final 240-character boundary. Existing transaction boundaries, append-only
   behavior, partial uniqueness and idempotency are unchanged.

3. **No new role, permission, read-event, session, rate-limit, or step-up policy was
   invented.** The existing `is_admin` plus `ADMIN_EMAILS` gate remains the outer
   gate on every admin request.

### Phase 4 — support safety without a support-case schema

The already-shipped order support workflow remains the only active support write
surface. Its delivery-resolution UPDATE now repeats the full eligibility predicate
inside SQL: captured payment, plus either `fulfillment_failed` or a `paid`/`fulfilling`
row older than the existing two-hour stuck window. This closes the read/update race
where a fresh order could otherwise be resolved after its status changed between the
pre-read and conditional UPDATE.

No `support_cases` or `support_case_notes` table was created. The existing queue and
`delivery_resolved` / `refund_review` actions therefore remain distinct from the
unapproved general case-management product.

### Phase 5 — controlled financial actions remain inactive

No `wallet_adjustments` table, endpoint, target-balance setter, role cap, reason-code
catalog, approval state, or step-up implementation was added. Existing withdrawal
approval/rejection/refund behavior remains its separate, already-reviewed surface;
it is not represented as the requested generic maker-checker adjustment workflow.
No financial write path was broadened.

### Phase 6 — emergency/system controls remain inactive

No `system_controls` table or control-key vocabulary was created or consumed. The
existing `WITHDRAWALS_ENABLED` kill switch remains unchanged and DB-free verification
re-confirms that missing or non-`true` values block withdrawals. That existing flag
is not being re-described as the unapproved wallet-funding, purchase, network,
checkout, or maintenance-control system.

## DB-free evidence added in this change

`npm run verify:admin-phase3-6` checks:

- same-origin, cross-site, mismatched-origin, opaque-origin, same-origin fallback,
  and header-absent request decisions;
- the shipped audit action vocabulary, generated reference formats, and
  bounded/validated audit values;
- all six existing central `admin_audit_logs` inserts use the typed value builder;
- old/fresh/parked/unpaid support eligibility and the SQL race-safe age predicate;
- the existing withdrawal flag's missing/false/explicit-true behavior;
- the absence of unapproved Phase 3–6 table references in the schema/journal and the
  presence of this owner-decision record.

This suite does not connect to PostgreSQL, call Paystack or another provider, execute
migrations, perform a payout, or activate an operational control. The existing
Phase 0–2 and withdrawal/payout DB-free suites remain separate and retain their own
claims.

## Owner decisions still required

The affected features stay inactive until each decision is recorded by the owner and
reviewed against the current code/schema.

### Decision 3A — RBAC data model and permissions

Approve the exact additive schema for `admin_roles`, `admin_role_assignments`, and
`admin_audit_logs` expansion, including primary/foreign keys, uniqueness, revocation
semantics, append-only enforcement/DB privileges, retention, and whether existing
rows are backfilled. Approve the exact role names and powers, including who may view
PII, suspend/activate, create support cases, propose financial actions, approve them,
and operate emergency controls. Also approve the audit action vocabulary and the
required before/after/request metadata, admin-read events, IP/user-agent/request-id
handling, session lifetime/step-up mechanism, and auth/search rate-limit algorithm
and thresholds. No RBAC schema or role enforcement beyond the existing gate is
applied without this decision.

### Decision 4A — general support-case model

Approve the exact `support_cases` and `support_case_notes` columns, foreign keys,
visibility/redaction rules, status and assignment transitions, reopen/resolve
semantics, note authorship, idempotency/replay rules, audit events, retention, and
which approved role may create, assign, comment, resolve, or reopen a case. Confirm
whether an order/deposit/user may be linked by one reference or several references.
Until then, the existing failed-order queue is not called a case system and no new
case table or route is active.

### Decision 5A — maker-checker financial actions

Approve the exact `wallet_adjustments` schema and lifecycle (proposal, approval,
rejection, expiry/cancellation), the immutable adjustment/ledger reference model,
reason-code catalog, original-transaction reference requirement, idempotency key and
concurrency constraints, and DB privileges. Separately approve the role-to-action
mapping, per-role amount caps and currency, whether caps are per action/day/target,
step-up re-authentication method and freshness, proposer/approver distinctness and
conflict rules, escalation path, and treatment of reversals. Confirm that no API may
accept a target balance and that every financial mutation must use the existing
atomic SQL arithmetic plus ledger/audit transaction pattern. No proposal or approval
route is enabled until this is explicit.

### Decision 6A — emergency/system control contract

Approve the exact control keys and scope (wallet funding, data purchases, each
network, checkout, maintenance banner, and any other control), their data types,
normal/read behavior, fail-safe behavior when the control store is missing or
unreadable, mandatory reason/actor fields, expiry and re-confirmation semantics,
concurrency/idempotency, audit action names, and the single guard injection point in
each affected route. Confirm who may toggle each key and who may override/restore it.
No `system_controls` schema, keys, or guards are created or consumed before this
approval.

## Remaining operational blockers

These are separate from the code-safe work above:

- no approved non-production database/app pair was supplied for DB-backed admin
  acceptance;
- no production migration, provider/payment call, payout, restore rehearsal, cleanup,
  monitoring activation, or deployment verification was performed;
- CVE-2026-93687 / GHSA-vfj7-8cjw-p6xm remains tracked and was not suppressed or
  force-upgraded;
- the existing Part 6.5B policy gates, Part 6.6 restore approvals, Part 6.7
  monitoring ownership/activation, provider qualification, and formal release decision
  remain pending under their respective runbooks.

## Phase status after this change

| Phase | Status | Evidence in this change | What is still blocked |
| --- | --- | --- | --- |
| 3 — RBAC/audit accountability | **Partial safe hardening only** | request-boundary guard; typed boundary for existing audit rows; DB-free verifier | approved roles/schema/permissions, read auditing, step-up/session/rate-limit policy, DB-backed acceptance |
| 4 — support cases | **Existing order workflow hardened; general cases inactive** | race-safe eligibility predicate; existing support workflow unchanged | approved case schema/lifecycle/roles and DB-backed acceptance |
| 5 — maker-checker financial actions | **Inactive / not implemented** | explicit no-schema/no-route boundary; existing financial invariants preserved | all Decision 5A items and independent DB-backed/adversarial acceptance |
| 6 — emergency/system controls | **Inactive / not implemented** | existing withdrawal flag fail-closed behavior re-verified | all Decision 6A items and controlled guard/operational acceptance |

A merge, green CI, or deployment of this repository-level work must not be reported as
completion of any of these phases.
