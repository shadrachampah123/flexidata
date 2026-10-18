# Part 6.6 — non-production restore-rehearsal readiness

**Status: BLOCKED — preparation only. No restore rehearsal has been run.** This
checklist is not an execution plan or authorization. It does not authorize
production access, restore, cleanup, or provider/payment activity. No rehearsal,
restore command, cleanup operation, or production operation may be performed as
part of this readiness work.

## Evidence rechecked against current `main`

The repository baseline for this review is `main` at
`c66aa21dcff8b12aa095b7f670be66cfbdefd1f7` (PR #68 merge).

**Evidence actually present in the repository:**

- In `docs/part-6.4-production-readiness.md`, E-3 is unchecked, F-10 is
  unchecked, and the F-10 status table says the restore test was **not
  performed**. It calls for a restore test on a non-production copy and an
  approved migration window.
- The tracked `flexiData/drizzle/meta/*_snapshot.json` files are Drizzle schema
  snapshots. They describe schema state; they are **not database backup
  artifacts** and provide no backup checksum or restore evidence.
- The release roadmap says no restore rehearsal has been performed. No test or
  CI result is treated as restore evidence.
- This checkout contains no database dump/backup payload, backup artifact
  reference, known-good checksum, approved source/target identities, isolation
  proof, tool/access/cost approval, or owner approval record. The repository
  search found no such evidence in tracked files or local project files.

**Evidence not available to this review:** no external backup/evidence store,
cloud account, database, or owner was queried. “Missing” above means **not
present in the checked repository/session**, not proof that no artifact exists
elsewhere. No owner approval is inferred or invented.

## Original preflight source and replacement

The prior handoff attributed an offline preflight to short SHA `18daf03`. It was
not recoverable from this checkout's shallow/grafted commit history, local refs,
remote branch or pull-request refs, advertised pull requests, or available local
worktrees. GitHub's commit endpoint could not resolve that short SHA; the exact
source diff and previously reported tests therefore remain unavailable and are
not treated as verified.

This change adds a **fresh replacement**, not the recovered original:

- `flexiData/scripts/restore-plan-preflight.ts` reads one local JSON plan file;
  its validation core has no database, provider, payment, restore, cleanup, or
  environment connection code.
- `npm run verify:restore-plan-preflight` exercises incomplete and ambiguous
  plans, production refusal, approvals, artifact integrity metadata, isolation,
  access/cost/tool gates, abort conditions, cleanup authorization and the
  execution-refusal boundary.
- A structurally complete plan reports **`PLAN METADATA: COMPLETE` only**. The
  tool does not fetch, authenticate, or independently verify evidence references
  or owner approvals. It does not grant authority or claim a rehearsal passed.
- `--apply` is refused unconditionally **before reading the plan**. No execution
  workflow exists; a future execution workflow requires separate design, review,
  owner authorization and an explicitly approved change. A plan file cannot
  enable execution.

The preflight's SHA-256 check compares declared expected/observed checksum
metadata; it does not open or hash a backup artifact. Its other identity,
approval, access, cost and isolation checks validate declared values and
references only. They do not prove the referenced evidence is genuine. Keep any
real plan and evidence references in the approved restricted store, not Git.

## Owner approval and evidence gates

Every gate below is **missing from this repository/session**. Keep approvals,
logs and sensitive identities in an access-controlled evidence record. Do not
commit credentials, database URLs, raw customer data, backup payloads, or
sensitive identifiers.

| Gate | Required decision/evidence | Accountable owner role(s) | Status |
| --- | --- | --- | --- |
| Scope and authority | Named exercise owner, operator and independent reviewer; purpose and UTC window; explicit approval for this exact pair, artifact, tool, procedure and scope. | Account/release owner; security/data owner. | **Missing** |
| Non-production source/target pair | Exact platform, account, project, environment and database IDs; owner and non-production classification for each; proof the target is separate and disposable. | Source and target environment owners; release owner. | **Missing** |
| Backup artifact and integrity | Restricted artifact reference, source identity, creation time, format, size, encryption-key reference (not key material), exact tool/version and independently established SHA-256 baseline; data classification/masking approval. | Backup/data owner; security/data owner. | **Missing** |
| Environment isolation | Current source/target identity proof; source read-only; target-only write principal; no production credentials or production-network reachability; provider/payment egress and callback ingress blocked; unexpected egress alerted. | Infrastructure/security owner. | **Missing** |
| Restore tool and procedure | Exact approved tool/version; reviewed target-only method and procedure reference; source read-only mode; verified target identity; expected checks and stop method. No command is authorized here. | Database/platform owner; independent reviewer. | **Missing** |
| Access and cost | Named least-privilege principal/operator, target-only scope, start/expiry and revocation plan; estimate, currency, hard ceiling and budget approval. | Account/access owner; security owner; budget owner. | **Missing** |
| Abort criteria | Explicit stop conditions and escalation contact for identity mismatch, production/ambiguous scope, integrity/isolation failure, unexpected writes or provider/payment activity, tool warning/error, missing approval, spend ceiling or verification failure. | Exercise owner; database/platform owner. | **Missing** |
| Cleanup authorization | **Separate** written approval for the exact disposable target/resources, cleanup operator, target-only scope, timing, retention requirements and evidence to preserve first. Restore approval does not imply delete approval. | Target owner; data owner; release owner. | **Missing** |
| Verification and sign-off | Pre-agreed pass/fail thresholds for checksum, schema/data consistency, read-only application checks, isolation/egress, no production effect, cleanup and credential revocation; named independent reviewer. | Database/platform owner; independent reviewer; release owner. | **Missing** |

## Fill-in evidence record — leave blank until the owners provide evidence

Keep the completed record and source evidence in the approved restricted store.
Use references/digests here; never paste secrets or backup payloads. A completed
metadata plan is not an authorization. Do not record `COMPLETE` until a separate
approved workflow has actually run and its results are independently reviewed.

```text
Record/change ID:
Decision/status: BLOCKED / READY FOR OWNER REVIEW / ABORTED / EXECUTED (evidence required)
Purpose and exact scope:
Approval scope fingerprint (from the replacement preflight):
Planned UTC start/end; approved window and expiry:

Exercise owner: person ID / role / written approval reference / timestamp:
Operator: person ID / least-privilege principal / access window:
Independent reviewer: person ID / role / acceptance reference:

SOURCE (must be explicitly non-production)
  Platform:
  Account / project / environment / database IDs:
  Environment name and owner role/person ID:
  Non-production proof reference:
  Source read-only proof reference:

TARGET (must be a distinct, explicitly non-production disposable environment)
  Platform:
  Account / project / environment / database IDs:
  Environment name and owner role/person ID:
  Non-production and disposability proof reference:
  Target identity verification reference:
  Exact disposable resource IDs (no wildcards):

SOURCE/TARGET approvals (separate owner approvals; include evidence reference,
  approver person ID/role, approved-at, expiry, and scope fingerprint):

BACKUP ARTIFACT AND INTEGRITY
  Restricted artifact ID/location reference:
  Artifact owner:
  Source identity reference and creation timestamp (UTC):
  Format / size bytes / encryption-key reference (never key material):
  Data classification: synthetic / masked / other (explain):
  Data-handling and masking approval reference:
  Approved integrity tool/version:
  Checksum algorithm (replacement validator accepts SHA-256):
  Known-good expected checksum:
  Independently observed checksum:
  Integrity evidence reference / verifier person ID / timestamp (UTC):

ISOLATION PROOF
  Boundary (separate account/project/network/dedicated instance):
  Proof reference / verifier person ID / verified-at / valid-through:
  Source read-only; target-only write principal:
  Production credentials absent:
  Production network blocked:
  Provider/payment egress blocked; callback ingress blocked:
  Unexpected egress alerting verified:
  Exact source and target identities in the proof:

APPROVED RESTORE TOOL AND ACCESS
  Tool name and exact version (no latest/range):
  Reviewed procedure reference; database/platform owner and reviewer:
  Source mode read-only / target mode target-only-write:
  Operator person ID / target-only credential principal:
  Access approval reference / start / expiry / revocation plan reference:
  Production credentials used: NO (otherwise stop):

COST, ABORT AND ESCALATION
  Currency:
  Approved estimate:
  Hard spend ceiling:
  Budget owner person ID / approval evidence reference:
  Abort conditions (include every required condition in the preflight):
  Escalation contact reference / accountable role:

SEPARATE CLEANUP AUTHORIZATION (required; restore approval is insufficient)
  Cleanup approval record reference / approver IDs and roles / timestamp / expiry:
  Approval scope fingerprint:
  Exact target and resource IDs authorized:
  Cleanup operator person ID / target-only scope:
  Permitted cleanup timing and method reference:
  Evidence-preservation and retention requirements/reference:

VERIFICATION CRITERIA AND ACCEPTANCE
  Checksum verification and pass/fail threshold:
  Schema and data-consistency checks and thresholds:
  Read-only application smoke checks:
  Isolation/egress and no-production-effect checks:
  Cleanup and credential-revocation checks:
  Independent reviewer person ID / acceptance reference:

ACTUAL EXECUTION RESULTS — leave blank until separately authorized and run
  Execution start/end timestamps (UTC):
  Operator and reviewer:
  Observed results / evidence references:
  Deviations, aborts, unexpected activity and incident reference:
  Cleanup timestamp/result/evidence reference:
  Credential revocation result/timestamp:
  Reviewer sign-off / owner decision / timestamps:
```

Do not populate approvals, identities, results or timestamps with assumptions or
synthetic values. Test fixtures in the repository are synthetic software tests,
not owner evidence.

## Missing items and responsible roles

1. **First unblocker — exact pair and scope:** the account/release owner must
   appoint the exercise owner and independent reviewer and obtain explicit
   source- and target-owner approval for one exact non-production pair. No pair
   or approval is evidenced here.
2. **Artifact:** the backup/data owner must identify an approved non-production
   artifact and provide its source, timestamp and independently established
   integrity baseline; the security/data owner must approve classification and
   masking. No database backup artifact or checksum is present in this repo.
3. **Isolation/tool/access/cost:** infrastructure/security and
   database/platform owners must provide current isolation and egress proof,
   approve the exact tool/version and target-only procedure, and approve
   least-privilege access with expiry/revocation. The budget owner must approve
   the cost ceiling. None is evidenced here.
4. **Abort/cleanup/verification:** the exercise and database/platform owners
   must approve abort conditions and escalation; target/data/release owners must
   issue separate cleanup authorization; the database/platform owner and
   independent reviewer must approve acceptance criteria. None is evidenced
   here.

**Stop here.** No restore rehearsal, restore command, cleanup, database access,
production operation, provider call or payment call was performed. Do not use
the replacement preflight output as permission to proceed. Revisit execution
only after evidence exists, every applicable owner has authorized the exact
scope, and a separately designed execution workflow is independently reviewed.
