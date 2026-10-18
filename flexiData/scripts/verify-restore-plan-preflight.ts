import assert from "node:assert/strict";
import {
  computeApprovalScopeFingerprint,
  restorePlanPreflightRequirements,
  runRestorePlanPreflight,
  validateRestorePlan,
  type PreflightIO,
} from "./restore-plan-preflight-core";

const TEST_NOW = new Date("2026-10-18T12:00:00.000Z");
const GOOD_CHECKSUM = "a".repeat(64);
const REQUIRED_APPROVALS = {
  exercise_scope: [
    { personId: "person-account-release", role: "account-release-owner" },
    { personId: "person-security-data", role: "security-data-owner" },
  ],
  source_environment: [
    { personId: "person-source-owner", role: "source-environment-owner" },
  ],
  target_environment: [
    { personId: "person-target-owner", role: "target-environment-owner" },
  ],
  backup_data_handling: [
    { personId: "person-backup-owner", role: "backup-data-owner" },
    { personId: "person-security-data", role: "security-data-owner" },
  ],
  isolation: [
    { personId: "person-infrastructure-security", role: "infrastructure-security-owner" },
  ],
  restore_tool: [
    { personId: "person-database-platform", role: "database-platform-owner" },
    { personId: "person-reviewer", role: "independent-reviewer" },
  ],
  operator_access: [
    { personId: "person-account-access", role: "account-access-owner" },
    { personId: "person-security-data", role: "security-data-owner" },
  ],
  cost_ceiling: [
    { personId: "person-budget-owner", role: "budget-owner" },
  ],
  abort_criteria: [
    { personId: "person-exercise-owner", role: "exercise-owner" },
    { personId: "person-database-platform", role: "database-platform-owner" },
  ],
  cleanup: [
    { personId: "person-target-owner", role: "target-environment-owner" },
    { personId: "person-data-owner", role: "data-owner" },
    { personId: "person-account-release", role: "account-release-owner" },
  ],
  verification: [
    { personId: "person-database-platform", role: "database-platform-owner" },
    { personId: "person-reviewer", role: "independent-reviewer" },
    { personId: "person-account-release", role: "account-release-owner" },
  ],
} as const;

function sourceIdentity(): Record<string, unknown> {
  return {
    platform: "postgresql",
    accountId: "account-np-001",
    projectId: "project-source-qa",
    environmentId: "environment-source-qa",
    databaseId: "database-source-qa",
    environmentName: "qa-source",
    classification: "non-production",
  };
}

function targetIdentity(): Record<string, unknown> {
  return {
    platform: "postgresql",
    accountId: "account-np-001",
    projectId: "project-target-qa",
    environmentId: "environment-target-qa",
    databaseId: "database-target-qa",
    environmentName: "qa-restore-target",
    classification: "non-production",
  };
}

function makeCompletePlan(): Record<string, unknown> {
  const source = sourceIdentity();
  const target = targetIdentity();
  const approvals: Record<string, unknown> = {};
  for (const [gate, approvers] of Object.entries(REQUIRED_APPROVALS)) {
    approvals[gate] = {
      status: "approved",
      evidenceRef: `restricted-evidence://approvals/${gate}-record-001`,
      approvedAt: "2026-10-18T10:00:00Z",
      expiresAt: "2026-11-02T00:00:00Z",
      scopeFingerprint: "",
      approvers: structuredClone(approvers),
    };
  }

  const plan: Record<string, unknown> = {
    planVersion: 1,
    operation: "metadata-preflight-only",
    restoreExecutionAllowed: false,
    cleanupExecutionAllowed: false,
    changeRecordId: "CHANGE-RESTORE-2026-014",
    purpose: "Metadata-only preparation for an owner-approved non-production restore exercise",
    timeWindow: {
      startsAt: "2026-11-01T10:00:00Z",
      endsAt: "2026-11-01T11:00:00Z",
    },
    participants: {
      exerciseOwner: { personId: "person-exercise-owner", displayName: "Exercise Owner", role: "exercise-owner" },
      operator: { personId: "person-operator", displayName: "Database Operator", role: "database-operator" },
      reviewer: { personId: "person-reviewer", displayName: "Independent Reviewer", role: "independent-reviewer" },
    },
    source: { identity: source },
    target: { identity: target, disposable: true },
    backup: {
      artifactRef: "restricted-evidence://backups/artifact-record-001",
      createdAt: "2026-10-17T10:00:00Z",
      format: "postgresql-custom",
      sizeBytes: 2048,
      encryptionKeyRef: "restricted-evidence://keys/key-record-001",
      sourceIdentity: structuredClone(source),
      integrity: {
        algorithm: "sha256",
        expectedChecksum: GOOD_CHECKSUM,
        observedChecksum: GOOD_CHECKSUM,
        evidenceRef: "restricted-evidence://integrity/check-record-001",
        verifiedBy: "person-backup-verifier",
        verifiedAt: "2026-10-18T09:00:00Z",
      },
      dataHandling: {
        classification: "synthetic",
        approvalEvidenceRef: "restricted-evidence://data-handling/approval-record-001",
      },
    },
    isolation: {
      boundary: "separate-project",
      proofRef: "restricted-evidence://isolation/proof-record-001",
      verifiedBy: "person-isolation-verifier",
      verifiedAt: "2026-10-18T09:00:00Z",
      validThrough: "2026-11-01T11:30:00Z",
      sourceIdentity: structuredClone(source),
      targetIdentity: structuredClone(target),
      sourceReadOnly: true,
      targetOnlyWriteIdentity: true,
      productionCredentialsAbsent: true,
      productionNetworkBlocked: true,
      providerPaymentEgressBlocked: true,
      callbackIngressBlocked: true,
      unexpectedEgressAlerted: true,
    },
    restoreTool: {
      name: "pg_restore",
      version: "18.4.2",
      procedureRef: "restricted-evidence://procedures/reviewed-procedure-001",
      sourceMode: "read-only",
      targetMode: "target-only-write",
    },
    access: {
      principalId: "credential-target-only-001",
      operatorPersonId: "person-operator",
      targetWriteScope: "target-only",
      productionCredentialsUsed: false,
      expiresAt: "2026-11-01T11:30:00Z",
      revocationPlanRef: "restricted-evidence://access/revocation-plan-001",
    },
    cost: {
      currency: "GHS",
      estimatedMinorUnits: 500,
      ceilingMinorUnits: 2500,
      budgetOwnerId: "person-budget-owner",
      evidenceRef: "restricted-evidence://cost/approval-record-001",
    },
    abort: {
      criteria: [...restorePlanPreflightRequirements.abortConditions],
      escalationContactRef: "restricted-evidence://incident/escalation-contact-001",
      escalationOwnerRole: "database-platform-owner",
    },
    cleanup: {
      targetIdentity: structuredClone(target),
      targetResourceIds: ["target-db-qa-001", "target-volume-qa-001"],
      cleanupOperatorPersonId: "person-operator",
      scope: "disposable-target-only",
      preserveEvidenceBeforeCleanup: true,
      retentionEvidenceRef: "restricted-evidence://retention/preservation-plan-001",
    },
    verification: {
      criteria: [...restorePlanPreflightRequirements.verificationCriteria],
      passFailRecordRef: "restricted-evidence://verification/criteria-record-001",
      reviewerPersonId: "person-reviewer",
    },
    approvalScopeFingerprint: "",
    approvals,
  };
  bindFingerprint(plan);
  return plan;
}

function bindFingerprint(plan: Record<string, unknown>): void {
  const fingerprint = computeApprovalScopeFingerprint(plan);
  assert.ok(fingerprint);
  plan.approvalScopeFingerprint = fingerprint;
  const approvals = plan.approvals as Record<string, Record<string, unknown>>;
  for (const approval of Object.values(approvals)) approval.scopeFingerprint = fingerprint;
}

function clonePlan(): Record<string, unknown> {
  return structuredClone(makeCompletePlan());
}

function validate(plan: Record<string, unknown>) {
  return validateRestorePlan(plan, TEST_NOW);
}

function pass(message: string): void {
  console.log(`PASS ${message}`);
}

async function main(): Promise<void> {
  const complete = validate(makeCompletePlan());
  assert.equal(complete.valid, true, complete.errors.join("\n"));
  pass("complete metadata-only synthetic plan validates without external access");

  const incomplete = validate({ planVersion: 1, operation: "metadata-preflight-only" });
  assert.equal(incomplete.valid, false);
  assert.ok(incomplete.errors.some(error => error.includes("source")));
  assert.ok(incomplete.errors.some(error => error.includes("approvals")));
  pass("incomplete plan is blocked with required-field diagnostics");

  const production = clonePlan();
  const productionTarget = production.target as Record<string, unknown>;
  const productionIdentity = productionTarget.identity as Record<string, unknown>;
  productionIdentity.environmentName = "prod-primary";
  bindFingerprint(production);
  const productionResult = validate(production);
  assert.equal(productionResult.valid, false);
  assert.ok(productionResult.errors.some(error => error.includes("production/live marker")));
  pass("production-marked target is refused");

  const ambiguous = clonePlan();
  const ambiguousTarget = ambiguous.target as Record<string, unknown>;
  const ambiguousIdentity = ambiguousTarget.identity as Record<string, unknown>;
  delete ambiguousIdentity.environmentId;
  bindFingerprint(ambiguous);
  const ambiguousResult = validate(ambiguous);
  assert.equal(ambiguousResult.valid, false);
  assert.ok(ambiguousResult.errors.some(error => error.includes("identity.environmentId")));
  pass("ambiguous target identity is refused");

  const sameEnvironment = clonePlan();
  const sameSource = (sameEnvironment.source as Record<string, unknown>).identity as Record<string, unknown>;
  const sameTarget = (sameEnvironment.target as Record<string, unknown>).identity as Record<string, unknown>;
  sameTarget.accountId = sameSource.accountId;
  sameTarget.projectId = sameSource.projectId;
  sameTarget.environmentId = sameSource.environmentId;
  bindFingerprint(sameEnvironment);
  assert.ok(validate(sameEnvironment).errors.some(error => error.includes("source and target must be distinct")));
  pass("source/target identity collision is refused");

  const missingApproval = clonePlan();
  const missingApprovals = missingApproval.approvals as Record<string, unknown>;
  delete missingApprovals.exercise_scope;
  assert.ok(validate(missingApproval).errors.some(error => error.includes("approvals.exercise_scope")));
  pass("missing explicit owner approval is blocked");

  const invalidIntegrity = clonePlan();
  const backup = invalidIntegrity.backup as Record<string, unknown>;
  const integrity = backup.integrity as Record<string, unknown>;
  integrity.observedChecksum = "b".repeat(64);
  bindFingerprint(invalidIntegrity);
  assert.ok(validate(invalidIntegrity).errors.some(error => error.includes("checksums do not match")));
  pass("mismatched backup integrity evidence is blocked");

  const malformedIntegrity = clonePlan();
  const malformedBackup = malformedIntegrity.backup as Record<string, unknown>;
  const malformedDigest = malformedBackup.integrity as Record<string, unknown>;
  malformedDigest.expectedChecksum = "not-a-sha256";
  malformedDigest.observedChecksum = "not-a-sha256";
  bindFingerprint(malformedIntegrity);
  assert.ok(validate(malformedIntegrity).errors.some(error => error.includes("64-character SHA-256")));
  pass("malformed checksum metadata is blocked");

  const failedIsolation = clonePlan();
  const isolation = failedIsolation.isolation as Record<string, unknown>;
  isolation.providerPaymentEgressBlocked = false;
  bindFingerprint(failedIsolation);
  assert.ok(validate(failedIsolation).errors.some(error => error.includes("providerPaymentEgressBlocked must be true")));
  pass("isolation or provider/payment egress failure is blocked");

  const missingCleanupApproval = clonePlan();
  const cleanupApprovals = missingCleanupApproval.approvals as Record<string, unknown>;
  delete cleanupApprovals.cleanup;
  assert.ok(validate(missingCleanupApproval).errors.some(error => error.includes("approvals.cleanup")));
  pass("missing separate cleanup authorization is blocked");

  const pendingCleanupApproval = clonePlan();
  const pendingApprovals = pendingCleanupApproval.approvals as Record<string, Record<string, unknown>>;
  pendingApprovals.cleanup.status = "pending";
  assert.ok(validate(pendingCleanupApproval).errors.some(error => error.includes("approvals.cleanup.status")));
  pass("non-approved cleanup authorization is blocked");

  const missingAbort = clonePlan();
  const abort = missingAbort.abort as Record<string, unknown>;
  abort.criteria = (abort.criteria as string[]).filter(condition => condition !== "spend_ceiling_reached");
  bindFingerprint(missingAbort);
  assert.ok(validate(missingAbort).errors.some(error => error.includes("spend_ceiling_reached")));
  pass("missing abort condition is blocked");

  const badPrerequisites = clonePlan();
  (badPrerequisites.restoreTool as Record<string, unknown>).version = "latest";
  (badPrerequisites.access as Record<string, unknown>).productionCredentialsUsed = true;
  const cost = badPrerequisites.cost as Record<string, unknown>;
  cost.estimatedMinorUnits = 3000;
  bindFingerprint(badPrerequisites);
  const prerequisiteErrors = validate(badPrerequisites).errors;
  assert.ok(prerequisiteErrors.some(error => error.includes("pinned to an exact version")));
  assert.ok(prerequisiteErrors.some(error => error.includes("productionCredentialsUsed must be false")));
  assert.ok(prerequisiteErrors.some(error => error.includes("must not exceed the approved ceiling")));
  pass("unpinned tool, production credential, and over-budget plans are blocked");

  const staleFingerprint = clonePlan();
  const staleTarget = staleFingerprint.target as Record<string, unknown>;
  const staleIdentity = staleTarget.identity as Record<string, unknown>;
  staleIdentity.databaseId = "database-target-changed";
  assert.ok(validate(staleFingerprint).errors.some(error => error.toLowerCase().includes("fingerprint does not match")));
  pass("approvals bound to a different source/target plan are refused");

  let readCount = 0;
  const refusedOutput: string[] = [];
  const refusalIO: PreflightIO = {
    readPlanFile: async () => {
      readCount += 1;
      return JSON.stringify(makeCompletePlan());
    },
    writeLine: line => refusedOutput.push(line),
  };
  const refusalCode = await runRestorePlanPreflight(["--plan", "synthetic-plan.json", "--apply"], refusalIO, TEST_NOW);
  assert.equal(refusalCode, 2);
  assert.equal(readCount, 0, "--apply refuses before even reading the plan");
  assert.ok(refusedOutput.join("\n").includes("--apply is permanently disabled"));
  pass("--apply is refused before plan I/O and cannot enter an execution path");

  const completeOutput: string[] = [];
  const completeIO: PreflightIO = {
    readPlanFile: async () => JSON.stringify(makeCompletePlan()),
    writeLine: line => completeOutput.push(line),
  };
  const completeCode = await runRestorePlanPreflight(["--plan", "synthetic-plan.json"], completeIO, TEST_NOW);
  const output = completeOutput.join("\n");
  assert.equal(completeCode, 0);
  assert.ok(output.includes("PLAN METADATA: COMPLETE"));
  assert.ok(output.includes("No restore or cleanup ran. No rehearsal was performed."));
  assert.doesNotMatch(output, /rehearsal (?:has been )?completed/i);
  assert.ok(output.includes("does not authenticate evidence"));
  pass("complete synthetic plan reports metadata only and explicitly no rehearsal");

  console.log("All restore-plan preflight safety checks passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
