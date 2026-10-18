# FlexiData release roadmap

**Last updated:** 2026-10-18  
**Documentation baseline:** PR #52 was reported squash-merged to `main` at `03a54830525772f0d664c3b86232f54ae562b2b8`; its post-merge CI and Vercel Production deployment were reported successful. PR #51 was merged at `6a40be3548d00789a493e828d641853c90d501b9`. This page records the evidence and outstanding gates known at this checkpoint; it is not, by itself, a fresh live production audit.

## Release summary

FlexiData has completed the current code/documentation milestones through Part 6.5B's **hold-only ambiguous-purchase safeguards**. It is **not yet cleared for live fulfillment or a full operational release**. The remaining critical path is: establish an approved and evidenced non-production restore rehearsal; close the provider/purchase-recovery policy gates; qualify the provider safely; approve operational ownership and monitoring; then make a separate, explicit release decision.

### Status at a glance

| Part | Current status | What counts as completion | Blocking dependency / next action |
| --- | --- | --- | --- |
| 6.4 — production readiness | Implementation merged; production migration application and verification were reported in the owner/session handoff. | Runbook evidence is retained; all operational readiness checklist items are independently verified, not inferred from migration success. | Review [Part 6.4 runbook](part-6.4-production-readiness.md) for backup/restore, provider coverage, scheduler ownership, alerting and rollout approval. |
| 6.5A — recovery guidance | Merged in PR #51 and reported deployed to Production; post-merge CI passed. | Health/readiness behavior and recovery guidance are verified against the deployed revision and operational runbook. | No additional code gate is currently recorded. Do not treat a green health endpoint as proof of full operational readiness. |
| 6.5B — ambiguous purchase recovery | Merged in PR #51 and reported deployed to Production as hold-only safeguards. | Evidence requirements and policy are approved before any terminal, money-changing recovery operation is implemented. | Provider correlation/finality, float/refund policy, and evidence ownership/retention remain unresolved. |
| 6.6 — restore-plan preflight and non-production rehearsal | Offline preflight exists in unpublished local commit `18daf03`; not included in `main`. Synthetic checks do not constitute a restore rehearsal. No rehearsal has been run. | Preflight reviewed and published separately; a real non-production rehearsal is executed only after approvals, with integrity, isolation and cleanup evidence recorded. | Obtain an owner-approved non-production source/target pair, backup artifact and integrity baseline, isolation proof, restore tooling, and cleanup authorization. |
| 6.7 — monitoring and operational ownership | Adapter exists in unpublished local commit `40710d7`; disabled by default and not included in `main`. | Named owner, least-privilege read-only runtime/database access, approved alert destination and transport, documented response procedure, and verified delivery path. | Confirm ownership and permissions first. Do not activate monitoring until the prerequisites are explicitly approved and verified. |
| 6.8 — provider qualification and fulfillment readiness | Incomplete. Reloadly live fulfillment remains locked; purchases remain fail-closed. | Provider-specific qualification evidence, safe sandbox tests, correlation/finality behavior and failure/reconciliation handling are reviewed. | Complete qualification without live fulfillment or real customer/payment actions. Synthetic-provider success is not live-provider qualification. |
| 6.9 — release decision | Pending; no general live-fulfillment approval is implied by prior merges. | A recorded go/no-go decision reviews all evidence, unresolved risks, owners, rollback/incident readiness and the precise scope being enabled. | Requires restore and operational evidence plus provider and policy gates. Live fulfillment needs a separate explicit owner decision. |

## Ordered execution plan

### 1. Preserve the verified baseline

- Use current `main` and the merged PR history as the authoritative repository baseline; confirm the actual current head before starting new implementation work.
- PR #51 merge: `6a40be3548d00789a493e828d641853c90d501b9`.
- PR #52 merge: `03a54830525772f0d664c3b86232f54ae562b2b8` (reported by the Arena handoff; post-merge CI and Production deployment were reported successful).
- Keep remote CI evidence, production deployment evidence, owner-reported operational actions, and local-only test results clearly distinguished.
- The prior PR #52 report recorded five successful PR checks, three successful post-merge CI checks, and a successful Vercel Production deployment. These are handoff-reported results, not a guarantee that the deployment remains current or healthy at the time this document is read.

### 2. Part 6.6 — review preflight, then prepare a safe rehearsal

**Current artifact:** offline restore-plan preflight in unpublished local commit `18daf03`. Reported behavior includes refusal to execute a synthetic plan: a complete synthetic plan remains `plan_complete_unverified`, `executionPermitted:false`, and `rehearsalRun:false`. Reported local checks included 10 scenario groups, production-readiness checks 8/8, lint/typecheck, an incomplete-template CLI exit of 2, and refusal of `--apply` with exit 1. These results must be re-run/reviewed in the intended branch/CI before being treated as release evidence.

**Next actions, in order:**

1. Review the unpublished diff against current `main`; verify it changes only the intended preflight scope and preserves the non-execution boundary.
2. Decide whether to publish the preflight as a focused PR. Do not bundle unrelated local commits.
3. Before any rehearsal, record explicit owner approval for the non-production source and target; verify neither resolves to production.
4. Identify the backup artifact, its creation time/source, integrity/checksum baseline, and the checks that will prove the restored target is consistent.
5. Verify environment isolation, credentials, network boundaries, restore tooling/version, access scope and expected cost.
6. Approve cleanup steps and who may execute them. Define abort conditions and what evidence must be captured.
7. Execute a rehearsal only after all prerequisites are evidenced and the owner explicitly authorizes execution. Capture timestamps, operator, source/target identity, artifact/checksum, command/tool versions, results, deviations, cleanup and post-cleanup verification.
8. Mark the rehearsal complete only after integrity and isolation checks pass and cleanup is verified. A plan, dry run, synthetic test or successful CI job alone is not a rehearsal.

**Stop conditions:** unknown source/target identity; production target or ambiguous environment; missing backup/integrity baseline; insufficient isolation; unapproved credentials or cost; missing cleanup authorization; unexpected writes; failed integrity checks. Stop and report—do not improvise around a failed gate.

### 3. Part 6.5B — resolve policy before building terminal recovery

The production behavior remains deliberately conservative: ambiguous purchases are held unresolved. Do not mark an ambiguous purchase successful, failed, refunded or safe to resubmit solely to clear an operational queue.

Required decisions/evidence:

- **Provider correlation:** define stable identifiers and the evidence chain linking a local attempt to a provider transaction, including retries and duplicate/late callbacks.
- **Provider finality:** document which provider statuses are authoritative, how long to wait, how to handle stale/inconsistent responses, and how finality is independently established.
- **Float/refund policy:** approve how funds, partial fulfillment, duplicate charges, reversals, refunds and reconciliation discrepancies are handled; identify the authorized decision-maker.
- **Evidence ownership and retention:** name the owner responsible for collecting, reviewing, retaining and deleting incident evidence; set retention/access rules and auditability.
- **Safe state transitions:** document allowed transitions, idempotency and concurrency requirements, and how a second operator/reviewer is involved for money-changing decisions.
- **Operational runbook:** define escalation, evidence sufficiency, timeout handling, customer communication ownership and conditions that must remain unresolved.

Until these are approved, keep the hold-only path. No override endpoint, UI, direct SQL recovery path, or migration should be introduced as a shortcut.

### 4. Part 6.7 — monitoring and operational ownership

**Current artifact:** disabled-by-default, read-only monitoring adapter in unpublished local commit `40710d7`; a documentation correction exists in unpublished commit `2dd996f`. Neither commit was included in PR #51 or PR #52.

Before publication or activation:

- Review the local diff and tests against current `main`; verify no provider polling, fulfillment, settlement, purchase mutation, or other write path has been introduced.
- Name a primary owner and backup/escalation contact, and document response expectations.
- Approve least-privilege, read-only runtime/database access and verify the adapter cannot mutate purchase, wallet, withdrawal, provider or billing state.
- Approve the alert destination, transport, message contents and failure behavior; avoid exposing secrets or unnecessary customer data.
- Verify deduplication, rate limiting, actionable alert criteria, health of the alert path and a documented runbook using synthetic events only.
- Keep activation as a separate, explicit decision after review and successful verification. A merged adapter does not mean monitoring is active.

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

These local commits were explicitly excluded from PR #51 and must not be accidentally included in unrelated PRs:

| Commit | Known scope | Publication/activation state |
| --- | --- | --- |
| `18daf03` | Part 6.6 DB-free restore-plan preflight and execution refusal safeguards | Unpublished; requires diff review and focused publication decision. No restore rehearsal executed. |
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

## Related runbooks

- [Part 6.4 — production readiness](part-6.4-production-readiness.md)
- [Part 6.5 — verification record](part-6.5-verification.md)
- [Part 6.5B — ambiguous-purchase recovery](part-6.5b-ambiguous-purchase-recovery.md)
