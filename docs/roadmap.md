# FlexiData release roadmap

Last updated after PR #51 squash-merge. Verified release baseline: `main` at merge commit `6a40be3548d00789a493e828d641853c90d501b9`. PR #51 is merged and its Vercel Production deployment was reported successful.

| Part | Status | Remaining release gates |
| --- | --- | --- |
| 6.4 — production readiness | Implementation completed and merged. Production migration application and verification were reported by the owner in the session handoff; retain the runbook evidence as the record. | Operational readiness is not fully closed by migration success alone. Preserve the unchecked items in [the 6.4 runbook](part-6.4-production-readiness.md), including backup/restore readiness, provider coverage, scheduler ownership, alerting and rollout approval. |
| 6.5A — recovery guidance | **Merged in PR #51 and deployed to Production.** Health recovery guidance and compatible readiness/response behavior are included. Post-merge CI passed. | No further code gate recorded for this part. Continue to distinguish health/readiness checks from proof of full operational readiness. |
| 6.5B — ambiguous purchase recovery | **Merged in PR #51 and deployed to Production as hold-only safeguards.** Manual terminal purchase resolution remains blocked; no override endpoint, UI, SQL path or migration was introduced. | Before any money-changing recovery implementation, establish provider correlation and finality guarantees, settle float/refund policy, and approve evidence ownership/retention. Insufficient evidence must remain unresolved: no refund, success, failure or resubmission. See [the recovery decision/runbook](part-6.5b-ambiguous-purchase-recovery.md). |
| 6.6 — restore-plan preflight and non-production rehearsal | Offline restore-plan preflight is implemented in an **unpublished local commit** and has synthetic-only checks; it is not part of `main`. No restore rehearsal has been executed. | First obtain an owner-approved non-production source/target pair, backup artifact and integrity baseline, environment isolation, restore tooling, and cleanup authorization. Then rehearse and record evidence. A complete synthetic plan is not proof of a successful rehearsal. |
| 6.7 — monitoring and operational ownership | Monitoring adapter exists in an **unpublished local commit**, disabled by default; no monitoring has been activated. | Assign a named operational owner; approve read-only runtime/database access, alert destination and notification transport. Keep monitoring disabled until those prerequisites are explicitly approved and verified. |
| 6.8 — provider qualification and fulfillment readiness | Not complete. Live Reloadly fulfillment remains locked; purchases remain fail-closed. | Complete provider qualification, correlation/finality evidence and safe sandbox verification before any live fulfillment decision. Do not treat transport groundwork or synthetic tests as live-provider validation. |
| 6.9 — release decision | Pending. | Reassess only after restore/operational evidence and provider gates are documented. Any enablement of live fulfillment requires a separate explicit owner decision. |

## Current safety posture

- Live Reloadly fulfillment remains locked.
- Purchases remain fail-closed; ambiguous outcomes are held rather than manually forced to a terminal state.
- Withdrawal behavior/settings remain unchanged.
- Monitoring remains disabled.
- No restore rehearsal has been performed.
- PR #51 did not include unpublished local commits `40710d7`, `2dd996f`, or `18daf03`.
- No production migration, production configuration change, monitoring activation, or provider/payment call was performed as part of the PR #51 merge.

See [Part 6.5 verification record](part-6.5-verification.md), [Part 6.4 production-readiness runbook](part-6.4-production-readiness.md), and [Part 6.5B ambiguous-purchase recovery](part-6.5b-ambiguous-purchase-recovery.md).
