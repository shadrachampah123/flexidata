# FlexiData release roadmap

**Last updated:** 2026-10-18

**Latest repository evidence checkpoint:** `main` at `e48d45a20bcf0efccb755096cd005d3fa65d9256`, verified as the merge of [PR #69](https://github.com/shadrachampah123/flexidata/pull/69). Its post-merge CI run [39126289032](https://github.com/shadrachampah123/flexidata/actions/runs/39126289032) passed the three CI jobs: lint/typecheck/build plus DB-free verification, guarded disposable-PostgreSQL migration checks, and the synthetic-provider purchase lifecycle. GitHub recorded [Vercel deployment](https://vercel.com/shadrachampah123s-projects/flexidata/CcBbJNTBMLbTXAiWFatte6BkiCnu) `7154372743` with `environment=Production`, `state=success`, and environment URL `https://flexidata-f7rtypju6-shadrachampah123s-projects.vercel.app`; its status description was "Deployment has completed". These are revision-scoped facts, not current production health or operational approval. Phase 3–6 safe-progress evidence is recorded in [08-phases-3-6-safe-progress.md](admin-ops-dashboard/08-phases-3-6-safe-progress.md). GHSA-vfj7-8cjw-p6xm / CVE-2026-93687 remains unresolved and **not fixed** after the current recheck (see the [audit report](../flexiData/docs/security/dependency-audit-cve-2026-93687-2026-10-18.md): full `npm audit` exits 1 with five highs, while `npm audit --omit=dev` exits 0 with zero vulnerabilities). The concise Parts 6.5B–6.9 evidence matrix is in [production-readiness-evidence-2026-10-18.md](production-readiness-evidence-2026-10-18.md). Earlier PR #53–68 merge/deployment details below remain historical checkpoint facts; do not treat them as current health evidence.

## Release summary

FlexiData has completed the current code/documentation milestones through Part 6.5B's **fail-closed ambiguous-purchase safeguards**. It is **not yet cleared for live fulfillment or a full operational release**. PR #60 documented the unresolved dependency advisory but did not fix it; the full npm audit still reports five high-severity records, and no safe compatible published fix was available during that investigation. Keep the finding tracked until a reviewed compatible fix is published. The remaining operational critical path is: establish an approved and evidenced non-production restore rehearsal; close the provider/purchase-recovery policy gates; qualify the provider safely; approve operational ownership and monitoring; then make a separate, explicit release decision.

### Status at a glance

| Part | Current status | What counts as completion | Blocking dependency / next action |
| --- | --- | --- | --- |
| Dependency security — GHSA-vfj7-8cjw-p6xm / CVE-2026-93687 | **Unresolved; documented, not fixed** by [PR #60](https://github.com/shadrachampah123/flexidata/pull/60). No safe compatible published fix was available during the investigation. Five high npm audit records trace to one advisory; the full audit exits 1 and `npm audit --omit=dev` reports zero. | A reviewed, compatible published fix is available, the smallest safe dependency edge is updated, and the full audit passes. | Keep the finding tracked and revisit on a safe published fix. Do not downgrade Next.js, suppress the finding, or force an unsafe upgrade. See the [audit report](../flexiData/docs/security/dependency-audit-cve-2026-93687-2026-10-18.md). |
| 6.4 — production readiness | Implementation merged; production migration application and verification were reported in the owner/session handoff. | Runbook evidence is retained; all operational readiness checklist items are independently verified, not inferred from migration success. | Review [Part 6.4 runbook](part-6.4-production-readiness.md) for backup/restore, provider coverage, scheduler ownership, alerting and rollout approval. |
| 6.5A — recovery guidance | Merged in PR #51 and reported deployed to Production; post-merge CI passed. | Health/readiness behavior and recovery guidance are verified against the deployed revision and operational runbook. | No additional code gate is currently recorded. Do not treat a green health endpoint as proof of full operational readiness. |
| 6.5B — ambiguous purchase recovery | **Pending owner/provider decisions; all eight policy gates remain unchecked.** Hold-only/fail-closed safeguards were merged in PR #51 and reported deployed at that checkpoint; ambiguous outcomes remain unresolved and no terminal recovery is enabled. | Owners approve the evidence and policy gates before any terminal, money-changing recovery operation is implemented. | Provider correlation/finality and callback semantics, float/refund/reversal policy, evidence ownership/retention, legal transitions and hold semantics, idempotency/concurrency, independent approval, and escalation/customer communications remain unresolved. Preserve the existing safeguards; no approval is implied. See the [owner decision checklist](part-6.5b-ambiguous-purchase-recovery.md). |
| 6.6 — restore-plan preflight and non-production rehearsal | **Blocked.** The original `18daf03` source was not recovered. A fresh DB-free metadata-only replacement is merged in PR #57 at `ad543d6465f64aa454030525f8595650b3aa5ea4`; it is not claimed to be the original. No rehearsal has been run. | The replacement validates declared metadata only and unconditionally refuses `--apply`; it is not execution authority. A real non-production rehearsal remains blocked until all owner approvals and independently verified prerequisites exist. | Obtain explicit owner approvals and independent review for the exact approved non-production source/target pair; verified backup artifact and known-good checksum; isolation proof; approved tooling, least-privilege access and cost ceiling; abort criteria; separate cleanup authorization; and verification/sign-off criteria. See [Part 6.6 readiness checklist](part-6.6-restore-rehearsal-readiness.md). |
| 6.7 — monitoring and operational ownership | **Not activated.** Repository-only readiness analysis was merged in PR #59 at `cce98338c1986c0848fb60b7f6ac245d5a06dffe`. `main` has aggregate purchase summaries and an operator CLI, but no approved monitoring adapter, scheduler, alert transport/destination, read-only principal, or assigned on-call owner. The cited `40710d7` is unpublished and unavailable. | Assign an accountable owner; approve dedicated least-privilege read-only access, scheduler/cadence, alert transport/destination/content, dedupe/rate limits and failure handling; pass synthetic tests; then obtain a separate activation decision. | Monitoring stays disabled until all operational prerequisites are approved and evidenced. Do not run `--poll` as monitoring or activate a scheduler. See [Part 6.7](part-6.7-monitoring-readiness.md). |
| 6.8 — provider qualification and fulfillment readiness | Incomplete. Reloadly live fulfillment remains locked; purchases remain fail-closed. | Provider-specific qualification evidence, safe sandbox tests, correlation/finality behavior and failure/reconciliation handling are reviewed. | Complete qualification without live fulfillment or real customer/payment actions. Synthetic-provider success is not live-provider qualification. |
| 6.9 — release decision | Pending; no general live-fulfillment approval is implied by prior merges. | A recorded go/no-go decision reviews all evidence, unresolved risks, owners, rollback/incident readiness and the precise scope being enabled. | Requires restore and operational evidence plus provider and policy gates. Live fulfillment needs a separate explicit owner decision. |

## Next safe priorities

1. **Track dependency security first.** Keep GHSA-vfj7-8cjw-p6xm / CVE-2026-93687 unresolved and visible until a reviewed, compatible published fix is available. Recheck upstream release/advisory status before making a minimal compatible update; do not downgrade Next.js, suppress the finding, or force an unsafe upgrade.
2. **Continue only repository-level work that does not require operational approvals.** Documentation, static source review and synthetic/DB-free verification may proceed within their stated scope. A merge, CI pass or deployment is not an operational approval or proof of production readiness.
3. **Keep the Part 6.6 restore rehearsal blocked** until the owner approvals, independent review and all verified non-production prerequisites listed below are present. Do not claim or attempt a rehearsal before then.
4. **Keep Part 6.5B decisions pending.** Preserve all eight unresolved owner/provider policy gates and the current fail-closed behavior; do not enable terminal recovery, resubmission, refunds or state overrides without approved policy and evidence.
5. **Keep Part 6.7 monitoring not activated** until an accountable owner, approved read-only access, an approved scheduler/cadence and alert transport/destination, tested failure handling, and a separate activation decision are all evidenced.

## Ordered execution plan

### 1. Preserve the verified baseline

- Use current `main` and the merged PR history as the authoritative repository baseline; confirm the actual current head before starting new implementation work.
- PR #51 merge: `6a40be3548d00789a493e828d641853c90d501b9`.
- PR #52 merge: `03a54830525772f0d664c3b86232f54ae562b2b8` (reported by the Arena handoff; post-merge CI and Production deployment were reported successful).
- Historical PR #58 checkpoint (superseded by the current PR #60 checkpoint): merged at `f10ec9ea691194a7b7ca75ab943eff2874dc4778`; its three post-merge CI jobs passed in [run 39095537201](https://github.com/shadrachampah123/flexidata/actions/runs/39095537201), and its Vercel Production deployment was reported successful at [deployment BXS61HE2L5CXbXhTe3yQHv7s4tpQ](https://vercel.com/shadrachampah123s-projects/flexidata/BXS61HE2L5CXbXhTe3yQHv7s4tpQ). This is historical revision evidence only, not current health evidence.
- Keep remote CI evidence, production deployment evidence, owner-reported operational actions, and local-only test results clearly distinguished.
- The prior PR #52 report recorded five successful PR checks, three successful post-merge CI checks, and a successful Vercel Production deployment. These are handoff-reported results, not a guarantee that the deployment remains current or healthy at the time this document is read.

### 2. Part 6.6 — metadata preflight merged; rehearsal remains blocked

**Artifact status:** the cited original `18daf03` was not found in the accessible local history, refs, branches, pull-request refs, worktrees or GitHub commit lookup. Its exact diff and prior reported test results remain unverified. A fresh replacement was reviewed and merged in [PR #57](https://github.com/shadrachampah123/flexidata/pull/57) at `ad543d6465f64aa454030525f8595650b3aa5ea4`; it is explicitly not the recovered original.

The replacement is DB/provider/payment/restore/cleanup-free. It checks in-plan identities and evidence metadata, requires explicit role-scoped approvals tied to a scope fingerprint, and refuses `--apply` before reading a plan. It does not fetch/authenticate owner evidence, verify a backup payload checksum, authorize execution or report a rehearsal complete. Its synthetic tests and CI are software evidence only.

**Next action:** remain at the readiness gate. The account/release owner must assign an exercise owner and reviewer and approve one exact non-production source/target pair. The backup/data owner and security/data owner must supply the artifact and known-good integrity baseline. Infrastructure/security and database/platform owners must evidence isolation and approve the exact tool/procedure; access/security and budget owners must approve access and cost. Exercise/database owners must approve abort criteria; target/data/release owners must separately authorize cleanup; database/platform and independent reviewer must approve verification criteria. Keep all sensitive evidence in the restricted evidence store. See the [Part 6.6 readiness checklist](part-6.6-restore-rehearsal-readiness.md).

**Stop conditions:** missing or ambiguous source/target identity; any production source/target or production credential; missing backup/integrity baseline; failed isolation or unexpected egress; unapproved access/cost; missing separate cleanup authorization; unexpected writes/provider/payment activity; tool error/warning; failed integrity or post-restore checks. Stop and escalate—do not improvise around a failed gate. No restore/rehearsal/cleanup operation is authorized by the preflight.

### 3. Part 6.5B — resolve policy before building terminal recovery

**Status remains pending:** all eight gates in the [Part 6.5B owner decision checklist](part-6.5b-ambiguous-purchase-recovery.md) are unchecked and awaiting owner/provider decisions; no named approver or approval is recorded in this repository. Existing behavior remains fail-closed: ambiguous outcomes stay unresolved, and eligible rows may continue only through the existing bounded, correlated status-read path. `unknown` is not a new persistent hold flag, and no manual terminal-resolution workflow is available. Do not mark an ambiguous purchase successful, failed, refunded or safe to resubmit solely to clear an operational queue.

The open gates are provider correlation/lookup guarantees; authoritative finality and delayed/duplicate outcomes; float, refund, reversal and partial-fulfillment policy; evidence ownership/retention; legal state transitions and persistent hold semantics; future resolution idempotency/concurrency; independent approval; and escalation/customer communications.

Until these decisions are approved, preserve the current fail-closed behavior: do not retry an ambiguous provider POST, bypass the existing callback refusal, or apply a terminal decision without authoritative evidence and approved policy. No override endpoint, UI, direct SQL recovery path, migration, forced purchase state, refund, or wallet/withdrawal behavior change should be introduced as a shortcut.

### 4. Part 6.7 — read-only monitoring readiness analysis; activation blocked

A repository-only assessment is recorded in [Part 6.7 monitoring readiness](part-6.7-monitoring-readiness.md). It found that `reportSummary()` and `reconcileAttention()` provide aggregate purchase attention data, while `--report` exposes up to 500 row references and `--check` returns an attention exit code. There is no alert transport, scheduler, dedicated read-only database role, owner roster or delivery test in current `main`. No production database connection or operational `--report`/`--check` run was made for the assessment; CI tests use disposable PostgreSQL and synthetic data.

The operator `--poll` mode is not a monitoring-only check: it claims rows, changes lease/poll metadata and performs Reloadly sandbox status reads. Keep it out of any alert schedule. The reported unpublished `40710d7` adapter was not recovered or reviewed and is not included; `2dd996f` and unrelated work also remain separate.

**Next actions:**

- Assign a primary/backup incident owner, response targets and escalation path.
- Approve a dedicated least-privilege read-only database principal and prove it cannot write; prefer explicit read-only transactions in any future adapter.
- Approve the scheduler/job owner, cadence and stale-data behavior, plus aggregate-only alert content, destination/transport, privacy/retention, dedupe/rate limits and delivery-failure behavior.
- Verify every signal, repeated event, stale data, outage, redaction and delivery failure against synthetic summaries and an isolated fake sink only.
- Keep monitoring disabled until a separate, explicit activation decision is approved. A code merge, test, deployment or checklist does not activate monitoring.

### 5. Part 6.8 — provider qualification and fulfillment readiness

- Keep Reloadly live fulfillment locked and purchases fail-closed while qualification is incomplete.
- Complete approved sandbox-only verification for success, rejection, timeout, duplicate request/callback, delayed finality, provider outage, reconciliation mismatch and ambiguous outcomes.
- Demonstrate stable correlation from purchase attempt through provider response and reconciliation without assuming transport success equals fulfillment success.
- Verify idempotency and that retries cannot double-fulfill or silently create a second financial action.
- Document provider coverage, limitations, escalation and the exact evidence supporting qualification.
- Keep synthetic-provider results, mocked tests, sandbox evidence and live-provider evidence labelled separately. Do not make live calls or enable production fulfillment as part of a qualification-only task.

### 6. Part 6.9 — formal release decision

Prepare a concise decision packet containing:

- Exact code commit(s), CI results and production deployment identity.
- Verified migration/schema state and operational health evidence, with timestamps and source.
- Restore rehearsal report and cleanup confirmation, or a clearly stated no-go if missing.
- Provider qualification results and unresolved provider limitations.
- Approved purchase ambiguity, float/refund and incident evidence policies.
- Monitoring owner, alert path, runbook and activation status.
- Open risks, rollback/containment plan, customer impact, and named decision owner.
- Explicit scope of the decision: documentation/code release, sandbox qualification, or live fulfillment are different decisions.

Record **GO**, **CONDITIONAL GO** or **NO-GO**, with owner and date. A conditional decision must list restrictions, owners and deadlines. No code merge, green CI, deployment success or roadmap edit independently authorizes live fulfillment.

## Unpublished local work — keep separate

These short SHAs were described in prior handoffs as unpublished and were excluded from PR #51. Do not include them in unrelated PRs; resolve each exact object and review its scope before acting:

| Commit | Known scope | Publication/activation state |
| --- | --- | --- |
| `18daf03` | Reported Part 6.6 DB-free restore-plan preflight and execution refusal safeguards | Original source remains unavailable and unreviewed; a fresh replacement, not this commit, is merged in PR #57. No restore rehearsal executed. |
| `40710d7` | Part 6.7 read-only monitoring adapter with synthetic sink | Unpublished; disabled by default. No monitoring activated. |
| `2dd996f` | Documentation correction for 6.5A test count/evidence provenance and local-vs-remote distinction | Unpublished; review and include only in a deliberately scoped documentation change if still accurate. |

Do not assume these short SHAs identify the current branch head or that local test results remain reproducible. Resolve each commit against the current repository before acting. Do not merge them wholesale as a bundle.

## Current safety posture and non-goals

- Live Reloadly fulfillment remains locked; purchases remain fail-closed.
- Ambiguous purchase outcomes remain unresolved until authoritative evidence and approved policy permit a decision.
- Withdrawals and their behavior/settings remain unchanged.
- Monitoring remains disabled.
- No restore rehearsal has been performed.
- Do not run production migrations, change production configuration, activate monitoring, run restore/cleanup operations, or call live providers/payment systems without the specific authorization and prerequisites for that action.
- No win-rate, fulfillment reliability or operational-readiness claim should be inferred from code completion or synthetic tests alone.

## Evidence and status conventions

- **Merged/deployed:** cite the PR/commit and deployment evidence; distinguish reported handoff evidence from independently refreshed status.
- **Local/unpublished:** not in `main`; local test results are not remote CI results.
- **Implemented:** code exists, but may not be reviewed, merged, deployed, configured or activated.
- **Verified:** state exactly what was tested, where, and with what result; do not generalize beyond that scope.
- **Blocked:** state the missing approval/artifact/decision and the next concrete action.
- **Complete:** close a part only when its stated acceptance criteria and required evidence are satisfied.

## Admin verification (DB-free) — 2026-10-18 checkpoint

**Baseline:** `main` `e48d45a20bcf0efccb755096cd005d3fa65d9256` (PR #69 merge). The DB-free admin harnesses and safe-progress boundary are part of this baseline; their evidence remains revision-scoped and does not close Phases 3–6 or prove database-backed behavior.

| Admin phase | Evidence | Result | CI |
|---|---|---|---|
| Phase 0 gate | `npm run verify:admin-access` | **40/40** — two-signal gate, byte-identical 404 denial, fail-closed, seam lock, no writes | ✅ enforced |
| Phase 1 read-only dashboard | `npm run verify:admin-phase1` | **167/167 at this baseline** — existing read-only, masking, statement-guard and allowlisted-write checks; the two additional admin policy modules remain read-only | ✅ enforced |
| Phase 2.1 customer management | `npm run verify:admin-phase2` | **20/20** (was 19/20) — suspend/activate + audit, conditional audit, admin-self-protect | ✅ enforced in current CI |
| Phase 2.2 support workflow | `npm run verify:admin-support` | **63/63** (was 60/62) — eligibility, write-surface, migration 0003, typed-ref | ✅ enforced in current CI |
| Phase 2.3 investigation & accountability | `npm run verify:admin-ops` | **140/140** (was 136/139) — pure diagnosis, Paystack probe read-only, 6 GET routes, no writes | ✅ enforced in current CI |
| Withdrawal lifecycle + kill-switch | `npm run verify:withdrawal-lifecycle` / `verify:withdrawals-disabled` | **81/81** + **76/76** — fail-closed flag, amount/method/phone validation | existing CI |
| Withdrawal security (W1–W4) | `npm run verify:withdrawal-security` | **213/213** DB-free — in-flight guard, body shape, idempotency, audit | documented; DB live needs `DATABASE_URL` |
| Payout reconciliation | `npm run verify:payout-reconciliation` | **18/18** DB-free — detection-only, 7 exception types, read-only | documented |
| Safe Phase 3–6 boundaries | `npm run verify:admin-phase3-6` | **33/33 DB-free** — same-origin request provenance (headerless requests fail closed), typed existing-audit values/reference compatibility, support race guard, existing withdrawal kill switch; no unapproved schemas | ✅ enforced in current CI; does not complete Phases 3–6 |

Stale causes fixed: `withdrawals-explorer.tsx` (`POST /api/admin/withdrawals/[id]/action`, `withdrawalsDisabled` + `confirm`/`prompt`+`reason` UX) and `payout-reconciliation/explorer.tsx` (`POST /api/admin/payout-reconciliation`, `Run`/`Resolve` with `confirm`/`prompt`) added to the 4-entry `WRITE_SURFACES` allowlist in all four harnesses; migration assertions relaxed from `===4` to `≥4` with explicit `0000–0003` presence (repo now has 12 migrations `0000–0011`, `_journal.json` 12 entries — see `flexiData/drizzle/meta/_journal.json`). The broadened confirmation check accepts `confirm:true` **or** `window.confirm`/`prompt`+`reason` to cover withdrawal/reconciliation flows; PUT/PATCH/DELETE remain prohibited. Full inventory, acceptance criteria, failing-test history, security boundaries (auth/authz, write surfaces, input, audit, destructive, fail-closed) and blockers (RBAC, support cases, emergency controls, live payouts — require owner approval) are in [`docs/admin-ops-dashboard/07-inventory-and-security-review.md`](admin-ops-dashboard/07-inventory-and-security-review.md).Lint/typecheck/build pass; DB-required phases B/C require approved non-prod `DATABASE_URL`+`BASE_URL` and stay labelled `SKIP` in DB-free CI — no mocks claimed as live proof.

## Related runbooks

- [Part 6.4 — production readiness](part-6.4-production-readiness.md)
- [Part 6.5 — verification record](part-6.5-verification.md)
- [Part 6.5B — ambiguous-purchase recovery](part-6.5b-ambiguous-purchase-recovery.md)
- [Part 6.6 — restore-rehearsal readiness](part-6.6-restore-rehearsal-readiness.md)
- [Part 6.7 — monitoring readiness](part-6.7-monitoring-readiness.md)
