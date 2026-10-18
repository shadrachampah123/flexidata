# FlexiData release roadmap

Baseline verified by fetching `origin/main`: `938313e1e4f353adb4571c5e081fe5ffdee114f6`.

| Part | Status | Remaining release gates |
| --- | --- | --- |
| 6.4 — production readiness | Implementation completed and merged. Production migration application/verification **reported by the owner in the session handoff**, not independently verified in this session. | Retain the unchecked operational checklist and external prerequisites in [the 6.4 runbook](part-6.4-production-readiness.md). The reported migration result does not establish backup/restore readiness, provider coverage, scheduler ownership, alerting or rollout approval. |
| 6.5A — recovery guidance | Implemented: production health recovery guidance, unchanged response keys/readiness behavior, and five DB-free route regression scenarios. | Local focused tests and broader CI-equivalent suite pass (see verification record); PR CI and operator review remain release gates. No production migration or deployment in this session. |
| 6.5B — ambiguous purchase recovery | Investigation complete; terminal manual resolution is blocked by unverified provider correlation/finality and float/refund policy. | [Recovery decision/runbook](part-6.5b-ambiguous-purchase-recovery.md): obtain evidence contracts and owner approval before implementing money-changing transitions. Insufficient evidence remains unresolved with no refund, success, failure or resubmission. |

Live Reloadly fulfillment remains locked. Purchases remain fail-closed. Withdrawal settings remain unchanged. No scheduler/poller activation or deployment is authorized by these statuses.

Local results: [6.5 verification record](part-6.5-verification.md).
