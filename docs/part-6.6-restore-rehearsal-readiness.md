# Part 6.6 — non-production restore-rehearsal readiness

**Status: BLOCKED — preparation only. No restore rehearsal has been run.** This
checklist is not an execution plan or authorization. It does not authorize
production access, restore, cleanup, or provider/payment activity. Source and
target for any future exercise must both be explicitly approved
**non-production** environments.

## Evidence available at this checkpoint

- The Part 6.4 runbook records F-10 (restore test and migration window) as **not
  performed** and asks for a restore test on a non-production copy. It does not
  attach an artifact, checksum, pair identity, isolation proof, or approval.
- The release roadmap records that no rehearsal has been performed. Passing
  synthetic tests or CI is not restore evidence.
- The handoff refers to an offline preflight in commit `18daf03`, but that
  commit is not present in this checkout or any advertised GitHub branch. GitHub
  could not resolve the supplied short SHA, so its exact diff and test commands
  are unavailable for review or reproduction. Do not treat the reported
  preflight behavior as independently verified.
- Repository inspection found no database backup artifact or integrity
  baseline. The only tracked files matching “snapshot” are Drizzle schema
  metadata, not database backups. No owner approvals, environment identities,
  isolation evidence, access/cost approval, restore-tool approval, or cleanup
  authorization were supplied in this repository/session. No external store or
  environment was queried; this means **not evidenced here**, not that an
  artifact cannot exist elsewhere.

## Owner approval and evidence checklist

Keep evidence in an access-controlled change/incident record. Record references
and digests here; do not commit credentials, database URLs, raw customer data,
or backup payloads.

| Gate | Required owner decision / evidence | Required approver(s) | Status |
| --- | --- | --- | --- |
| Scope and authority | Named exercise owner, operator, independent reviewer, purpose, time window, and explicit written approval for this exact rehearsal. | Account/release owner; security/data owner for data handling. | **Missing** |
| Non-production source/target pair | Exact project/account and logical environment identifiers for both source and target; source and target owners; evidence both are non-production; target is isolated and disposable. Do not use a production source, target, credential, or ambiguous environment for this exercise. | Owners of both environments; release owner. | **Missing** |
| Backup artifact and integrity baseline | Artifact ID/location reference, creation time, source identity, format, encryption/key reference (not key material), tool/version, size or other baseline, checksum algorithm and known-good checksum from the artifact owner. Confirm data classification and masking/synthetic-data approval. | Backup/data owner; security/data owner. | **Missing** |
| Environment isolation | Evidence of separate account/project/network or equivalent boundary; target-only write credentials; no production credentials/secrets; restricted egress preventing provider/payment calls and callbacks; verified target identity before any write. | Infrastructure/security owner. | **Missing** |
| Restore tooling and method | Approved tool and exact version; reviewed target-only procedure; expected duration; read-only source handling; target identity guard; expected schema/data checks; documented way to stop safely. No command is authorized by this checklist. | Database/platform owner; independent reviewer. | **Missing** |
| Access and cost controls | Named least-privilege operator identity; temporary access window and revocation plan; approved cost estimate, spend ceiling, budget owner, and any required change window. | Account owner; finance/budget owner; security owner. | **Missing** |
| Abort criteria | Explicit stop conditions and escalation contact: identity mismatch; production/shared credentials or unclear lineage; integrity mismatch; isolation or egress failure; unexpected writes/data; unexpected provider/payment traffic; tool warning/error; spend limit reached; missing evidence or approval. | Exercise owner; database/platform owner. | **Missing** |
| Cleanup authorization | Separate written approval naming the exact disposable target/resources, cleanup operator, permitted cleanup scope, timing, data-retention requirements, and evidence to preserve first. Approval to restore does not imply approval to delete. | Target owner; data owner; release owner. | **Missing** |
| Post-rehearsal verification | Pre-agreed checks for artifact integrity, target schema/data consistency, application/read-only smoke checks, isolation and egress, no production effect, cleanup result, and credential revocation. Define pass/fail thresholds and who signs off. | Database/platform owner; independent reviewer; release owner. | **Missing** |

## Evidence record template — leave blank until approved and executed

```text
Record/change ID:
Decision: BLOCKED / APPROVED FOR THIS NON-PRODUCTION EXERCISE / ABORTED / COMPLETE
Approval date and expiry:
Exercise owner / operator / independent reviewer:
Purpose and scope:
Source environment ID (non-production evidence reference):
Target environment ID (non-production, disposable evidence reference):
Backup artifact ID and source timestamp:
Integrity algorithm + known-good baseline reference:
Data classification / masking approval reference:
Isolation and egress proof reference:
Restore tool + exact version / reviewed procedure reference:
Access identity + access expiry / revocation proof:
Approved spend ceiling / budget owner:
Abort conditions / escalation contact:
Cleanup authorization reference (separate approval):
Execution start/end (UTC):
Observed results and integrity verification reference:
Deviations / aborts / incident reference:
Cleanup result and verification reference:
Post-rehearsal verification / reviewer sign-off:
Owner final decision and date:
```

Do not fill the template with assumptions. Store sensitive source/target details,
checksums if they reveal sensitive identifiers, logs, and approvals in the
approved restricted evidence store; this file is only a checklist.

## Blockers and smallest next actions

1. **Owner approval and pair:** the account/release owner must name the exercise
   owner and independent reviewer, select and explicitly approve both
   non-production environments, and provide evidence that their identities and
   isolation are unambiguous.
2. **Backup and integrity:** the backup/data owner must identify an approved
   non-production artifact and provide its creation/source details and
   independently established integrity baseline. The security/data owner must
   approve classification and masking.
3. **Isolation, tooling, access, and cost:** infrastructure/database/security
   owners must approve the exact tool/version and target-only procedure, prove
   isolation and restricted egress, name least-privilege access with expiry,
   and approve the cost ceiling.
4. **Abort, cleanup, and verification:** the release and target/data owners must
   approve abort criteria and contacts, issue separate cleanup authorization,
   and approve post-exercise checks and sign-off roles.
5. **Preflight source review:** provide the full commit SHA or an accessible
   branch containing the cited `18daf03` commit. Until its exact diff is
   available, the refusal boundary, isolation checks, artifact integrity checks,
   cleanup safeguards, tests, and documentation cannot be independently
   reviewed or published as verified.

**Stop here.** No rehearsal, restore, cleanup, production connection, or
provider/payment call was performed for this preparation. Revisit execution only
after every applicable approval and evidence item above is present and the
preflight has been independently reviewed. A completed checklist alone is not
proof of a completed rehearsal; the final record needs actual execution and
post-cleanup verification evidence.
