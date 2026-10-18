import { createHash } from "node:crypto";

export type PreflightIO = {
  readPlanFile(path: string): Promise<string>;
  writeLine(line: string): void;
};

export type RestorePlanValidation = {
  valid: boolean;
  fingerprint: string | null;
  errors: string[];
};

type JsonRecord = Record<string, unknown>;

const PLAN_KEYS = [
  "planVersion",
  "operation",
  "restoreExecutionAllowed",
  "cleanupExecutionAllowed",
  "changeRecordId",
  "purpose",
  "timeWindow",
  "participants",
  "source",
  "target",
  "backup",
  "isolation",
  "restoreTool",
  "access",
  "cost",
  "abort",
  "cleanup",
  "verification",
  "approvalScopeFingerprint",
  "approvals",
] as const;

const IDENTITY_KEYS = [
  "platform",
  "accountId",
  "projectId",
  "environmentId",
  "databaseId",
  "environmentName",
  "classification",
] as const;

const REQUIRED_ABORT_CONDITIONS = [
  "identity_mismatch",
  "production_or_ambiguous_environment",
  "artifact_integrity_failure",
  "isolation_or_egress_failure",
  "unexpected_write_or_data",
  "provider_or_payment_activity",
  "tool_error_or_warning",
  "spend_ceiling_reached",
  "missing_or_expired_approval",
  "unexpected_target_or_access",
  "verification_failure",
] as const;

const REQUIRED_VERIFICATION_CRITERIA = [
  "backup_checksum",
  "schema_consistency",
  "data_consistency",
  "application_read_only_smoke",
  "isolation_and_egress",
  "no_production_effect",
  "cleanup_and_credential_revocation",
] as const;

const REQUIRED_APPROVAL_ROLES = {
  exercise_scope: ["account-release-owner", "security-data-owner"],
  source_environment: ["source-environment-owner"],
  target_environment: ["target-environment-owner"],
  backup_data_handling: ["backup-data-owner", "security-data-owner"],
  isolation: ["infrastructure-security-owner"],
  restore_tool: ["database-platform-owner", "independent-reviewer"],
  operator_access: ["account-access-owner", "security-data-owner"],
  cost_ceiling: ["budget-owner"],
  abort_criteria: ["exercise-owner", "database-platform-owner"],
  cleanup: ["target-environment-owner", "data-owner", "account-release-owner"],
  verification: ["database-platform-owner", "independent-reviewer", "account-release-owner"],
} as const;

const APPROVAL_KEYS = Object.keys(REQUIRED_APPROVAL_ROLES);
const PLACEHOLDER = /^(?:unknown|n\/?a|not applicable|tbd|todo|none|null|unset|default|example|sample|placeholder|\*+|<[^>]*>)$/i;
const CREDENTIAL_BEARING_REFERENCE = /(?:postgres(?:ql)?|mysql|redis):\/\/|:\/\/[^/\s:]+:[^@/\s]+@|[?&](?:password|secret|token|api[_-]?key)=/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const EXACT_VERSION = /^v?\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/;
const PRODUCTION_MARKER = /\b(?:prod(?:uction)?|live|primary)\b/i;
const NON_PRODUCTION_MARKER = /\bnon[-_\s]?(?:prod(?:uction)?)\b|\bnot[-_\s]+production\b/gi;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

/**
 * Fingerprints only the declared plan scope; approval records and the
 * fingerprint field itself are excluded so owners can approve this exact
 * metadata without a self-referential hash.
 */
export function computeApprovalScopeFingerprint(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const scope: JsonRecord = Object.create(null) as JsonRecord;
  for (const key of Object.keys(value)) {
    if (key !== "approvals" && key !== "approvalScopeFingerprint") scope[key] = value[key];
  }
  return createHash("sha256").update(stableStringify(scope)).digest("hex");
}

function exactKeys(value: JsonRecord, expected: readonly string[], path: string, errors: string[]): void {
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) errors.push(`${path}.${key} is not an allowed field`);
  }
}

function objectField(
  parent: JsonRecord,
  key: string,
  path: string,
  expected: readonly string[],
  errors: string[],
): JsonRecord {
  const value = parent[key];
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return Object.create(null) as JsonRecord;
  }
  exactKeys(value, expected, path, errors);
  return value;
}

function stringField(
  value: JsonRecord,
  key: string,
  path: string,
  errors: string[],
  options: { reference?: boolean; allowPlaceholder?: boolean } = {},
): string | null {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    errors.push(`${path}.${key} must be a non-empty string`);
    return null;
  }
  const normalized = field.trim();
  if (!options.allowPlaceholder && PLACEHOLDER.test(normalized)) {
    errors.push(`${path}.${key} must identify a specific value, not a placeholder`);
  }
  if (options.reference && CREDENTIAL_BEARING_REFERENCE.test(normalized)) {
    errors.push(`${path}.${key} must be a reference, not a credential or connection string`);
  }
  return normalized;
}

function booleanField(value: JsonRecord, key: string, expected: boolean, path: string, errors: string[]): void {
  if (value[key] !== expected) errors.push(`${path}.${key} must be ${expected}`);
}

function enumField(value: JsonRecord, key: string, allowed: readonly string[], path: string, errors: string[]): string | null {
  const field = value[key];
  if (typeof field !== "string" || !allowed.includes(field)) {
    errors.push(`${path}.${key} must be one of: ${allowed.join(", ")}`);
    return null;
  }
  return field;
}

function timestampField(value: JsonRecord, key: string, path: string, errors: string[]): number | null {
  const timestamp = stringField(value, key, path, errors);
  if (!timestamp) return null;
  if (!UTC_TIMESTAMP.test(timestamp)) {
    errors.push(`${path}.${key} must be an ISO-8601 UTC timestamp ending in Z`);
    return null;
  }
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    errors.push(`${path}.${key} is not a valid timestamp`);
    return null;
  }
  const canonicalWholeSecond = `${new Date(parsed).toISOString().slice(0, 19)}Z`;
  const suppliedWholeSecond = timestamp.replace(/\.\d{1,3}Z$/, "Z");
  if (canonicalWholeSecond !== suppliedWholeSecond) {
    errors.push(`${path}.${key} is not a valid calendar timestamp`);
    return null;
  }
  return parsed;
}

function referenceField(value: JsonRecord, key: string, path: string, errors: string[]): string | null {
  return stringField(value, key, path, errors, { reference: true });
}

function identifierField(value: JsonRecord, key: string, path: string, errors: string[]): string | null {
  const identifier = stringField(value, key, path, errors);
  if (identifier && !IDENTIFIER.test(identifier)) errors.push(`${path}.${key} must be an exact identifier without spaces or wildcards`);
  return identifier;
}

function validateTimeWindow(plan: JsonRecord, now: Date, errors: string[]): { startsAt: number | null; endsAt: number | null } {
  const window = objectField(plan, "timeWindow", "timeWindow", ["startsAt", "endsAt"], errors);
  const startsAt = timestampField(window, "startsAt", "timeWindow", errors);
  const endsAt = timestampField(window, "endsAt", "timeWindow", errors);
  const nowMs = now.getTime();
  if (startsAt !== null && startsAt <= nowMs) errors.push("timeWindow.startsAt must be in the future");
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) errors.push("timeWindow.endsAt must be after startsAt");
  return { startsAt, endsAt };
}

type Identity = {
  platform: string | null;
  accountId: string | null;
  projectId: string | null;
  environmentId: string | null;
  databaseId: string | null;
  environmentName: string | null;
  classification: string | null;
};

function readIdentity(value: JsonRecord, path: string, errors: string[]): Identity {
  const identity = objectField(value, "identity", path, IDENTITY_KEYS, errors);
  const platform = enumField(identity, "platform", ["postgresql"], `${path}.identity`, errors);
  const accountId = identifierField(identity, "accountId", `${path}.identity`, errors);
  const projectId = identifierField(identity, "projectId", `${path}.identity`, errors);
  const environmentId = identifierField(identity, "environmentId", `${path}.identity`, errors);
  const databaseId = identifierField(identity, "databaseId", `${path}.identity`, errors);
  const environmentName = stringField(identity, "environmentName", `${path}.identity`, errors);
  const classification = enumField(identity, "classification", ["non-production"], `${path}.identity`, errors);

  for (const [key, component] of Object.entries({ accountId, projectId, environmentId, databaseId, environmentName })) {
    if (!component) continue;
    const withoutNonProduction = component.replace(NON_PRODUCTION_MARKER, " ");
    if (PRODUCTION_MARKER.test(withoutNonProduction)) {
      errors.push(`${path}.identity.${key} contains a production/live marker`);
    }
  }

  return { platform, accountId, projectId, environmentId, databaseId, environmentName, classification };
}

function identityKey(identity: Identity, fields: readonly (keyof Identity)[]): string {
  return fields.map(field => (identity[field] ?? "").toLocaleLowerCase("en-US")).join("/");
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return IDENTITY_KEYS.every(key => {
    const name = key as keyof Identity;
    return (left[name] ?? "").toLocaleLowerCase("en-US") === (right[name] ?? "").toLocaleLowerCase("en-US");
  });
}

function participantField(
  parent: JsonRecord,
  key: string,
  expectedRole: string,
  errors: string[],
): string | null {
  const participant = objectField(parent, key, `participants.${key}`, ["personId", "displayName", "role"], errors);
  const personId = identifierField(participant, "personId", `participants.${key}`, errors);
  stringField(participant, "displayName", `participants.${key}`, errors);
  const role = enumField(participant, "role", [expectedRole], `participants.${key}`, errors);
  return personId && role ? personId : null;
}

function validateParticipants(plan: JsonRecord, errors: string[]): { owner: string | null; operator: string | null; reviewer: string | null } {
  const participants = objectField(plan, "participants", "participants", ["exerciseOwner", "operator", "reviewer"], errors);
  const owner = participantField(participants, "exerciseOwner", "exercise-owner", errors);
  const operator = participantField(participants, "operator", "database-operator", errors);
  const reviewer = participantField(participants, "reviewer", "independent-reviewer", errors);
  const ids = [owner, operator, reviewer].filter((id): id is string => id !== null).map(id => id.toLocaleLowerCase("en-US"));
  if (new Set(ids).size !== ids.length) errors.push("participants.exerciseOwner, operator, and reviewer must be three distinct people");
  return { owner, operator, reviewer };
}

function validateBackup(
  plan: JsonRecord,
  sourceIdentity: Identity,
  window: { startsAt: number | null; endsAt: number | null },
  now: Date,
  operator: string | null,
  errors: string[],
): void {
  const backup = objectField(plan, "backup", "backup", ["artifactRef", "createdAt", "format", "sizeBytes", "encryptionKeyRef", "sourceIdentity", "integrity", "dataHandling"], errors);
  referenceField(backup, "artifactRef", "backup", errors);
  const createdAt = timestampField(backup, "createdAt", "backup", errors);
  if (createdAt !== null && createdAt > now.getTime()) errors.push("backup.createdAt must not be in the future");
  if (createdAt !== null && window.startsAt !== null && createdAt > window.startsAt) errors.push("backup.createdAt must not be after the planned exercise start");
  stringField(backup, "format", "backup", errors);
  const sizeBytes = backup.sizeBytes;
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) errors.push("backup.sizeBytes must be a positive safe integer");
  referenceField(backup, "encryptionKeyRef", "backup", errors);

  const backupSource = objectField(backup, "sourceIdentity", "backup.sourceIdentity", IDENTITY_KEYS, errors);
  const backupIdentity: Identity = {
    platform: enumField(backupSource, "platform", ["postgresql"], "backup.sourceIdentity", errors),
    accountId: identifierField(backupSource, "accountId", "backup.sourceIdentity", errors),
    projectId: identifierField(backupSource, "projectId", "backup.sourceIdentity", errors),
    environmentId: identifierField(backupSource, "environmentId", "backup.sourceIdentity", errors),
    databaseId: identifierField(backupSource, "databaseId", "backup.sourceIdentity", errors),
    environmentName: stringField(backupSource, "environmentName", "backup.sourceIdentity", errors),
    classification: enumField(backupSource, "classification", ["non-production"], "backup.sourceIdentity", errors),
  };
  if (!sameIdentity(backupIdentity, sourceIdentity)) errors.push("backup.sourceIdentity must exactly match the approved source identity");

  const integrity = objectField(backup, "integrity", "backup.integrity", ["algorithm", "expectedChecksum", "observedChecksum", "evidenceRef", "verifiedBy", "verifiedAt"], errors);
  enumField(integrity, "algorithm", ["sha256"], "backup.integrity", errors);
  const expectedChecksum = stringField(integrity, "expectedChecksum", "backup.integrity", errors);
  const observedChecksum = stringField(integrity, "observedChecksum", "backup.integrity", errors);
  if (expectedChecksum && !SHA256.test(expectedChecksum)) errors.push("backup.integrity.expectedChecksum must be a 64-character SHA-256 hex digest");
  if (observedChecksum && !SHA256.test(observedChecksum)) errors.push("backup.integrity.observedChecksum must be a 64-character SHA-256 hex digest");
  if (expectedChecksum && observedChecksum && expectedChecksum.toLowerCase() !== observedChecksum.toLowerCase()) {
    errors.push("backup.integrity expected and observed checksums do not match");
  }
  referenceField(integrity, "evidenceRef", "backup.integrity", errors);
  const verifiedBy = stringField(integrity, "verifiedBy", "backup.integrity", errors);
  if (operator && verifiedBy && verifiedBy.toLocaleLowerCase("en-US") === operator.toLocaleLowerCase("en-US")) {
    errors.push("backup.integrity.verifiedBy must be independent of the exercise operator");
  }
  const verifiedAt = timestampField(integrity, "verifiedAt", "backup.integrity", errors);
  if (verifiedAt !== null && verifiedAt > now.getTime()) errors.push("backup.integrity.verifiedAt must not be in the future");
  if (verifiedAt !== null && window.startsAt !== null && verifiedAt > window.startsAt) errors.push("backup.integrity.verifiedAt must be before the planned exercise start");

  const dataHandling = objectField(backup, "dataHandling", "backup.dataHandling", ["classification", "approvalEvidenceRef"], errors);
  enumField(dataHandling, "classification", ["synthetic", "masked"], "backup.dataHandling", errors);
  referenceField(dataHandling, "approvalEvidenceRef", "backup.dataHandling", errors);
}

function validateIsolation(
  plan: JsonRecord,
  sourceIdentity: Identity,
  targetIdentity: Identity,
  window: { startsAt: number | null; endsAt: number | null },
  now: Date,
  errors: string[],
): void {
  const isolation = objectField(plan, "isolation", "isolation", [
    "boundary", "proofRef", "verifiedBy", "verifiedAt", "validThrough",
    "sourceIdentity", "targetIdentity", "sourceReadOnly", "targetOnlyWriteIdentity",
    "productionCredentialsAbsent", "productionNetworkBlocked", "providerPaymentEgressBlocked",
    "callbackIngressBlocked", "unexpectedEgressAlerted",
  ], errors);
  enumField(isolation, "boundary", ["separate-account", "separate-project", "isolated-network", "dedicated-instance"], "isolation", errors);
  referenceField(isolation, "proofRef", "isolation", errors);
  stringField(isolation, "verifiedBy", "isolation", errors);
  const verifiedAt = timestampField(isolation, "verifiedAt", "isolation", errors);
  const validThrough = timestampField(isolation, "validThrough", "isolation", errors);
  if (verifiedAt !== null && verifiedAt > now.getTime()) errors.push("isolation.verifiedAt must not be in the future");
  if (verifiedAt !== null && window.startsAt !== null && verifiedAt > window.startsAt) errors.push("isolation.verifiedAt must be before the planned exercise start");
  if (validThrough !== null && window.endsAt !== null && validThrough < window.endsAt) errors.push("isolation.validThrough must cover the planned exercise window");
  for (const key of ["sourceIdentity", "targetIdentity"] as const) {
    const proofIdentity = objectField(isolation, key, `isolation.${key}`, IDENTITY_KEYS, errors);
    const identity: Identity = {
      platform: enumField(proofIdentity, "platform", ["postgresql"], `isolation.${key}`, errors),
      accountId: identifierField(proofIdentity, "accountId", `isolation.${key}`, errors),
      projectId: identifierField(proofIdentity, "projectId", `isolation.${key}`, errors),
      environmentId: identifierField(proofIdentity, "environmentId", `isolation.${key}`, errors),
      databaseId: identifierField(proofIdentity, "databaseId", `isolation.${key}`, errors),
      environmentName: stringField(proofIdentity, "environmentName", `isolation.${key}`, errors),
      classification: enumField(proofIdentity, "classification", ["non-production"], `isolation.${key}`, errors),
    };
    const expectedIdentity = key === "sourceIdentity" ? sourceIdentity : targetIdentity;
    if (!sameIdentity(identity, expectedIdentity)) errors.push(`isolation.${key} must exactly match the declared environment identity`);
  }
  booleanField(isolation, "sourceReadOnly", true, "isolation", errors);
  booleanField(isolation, "targetOnlyWriteIdentity", true, "isolation", errors);
  booleanField(isolation, "productionCredentialsAbsent", true, "isolation", errors);
  booleanField(isolation, "productionNetworkBlocked", true, "isolation", errors);
  booleanField(isolation, "providerPaymentEgressBlocked", true, "isolation", errors);
  booleanField(isolation, "callbackIngressBlocked", true, "isolation", errors);
  booleanField(isolation, "unexpectedEgressAlerted", true, "isolation", errors);
}

function validateTool(plan: JsonRecord, errors: string[]): void {
  const tool = objectField(plan, "restoreTool", "restoreTool", ["name", "version", "procedureRef", "sourceMode", "targetMode"], errors);
  stringField(tool, "name", "restoreTool", errors);
  const version = stringField(tool, "version", "restoreTool", errors);
  if (version && !EXACT_VERSION.test(version)) errors.push("restoreTool.version must be pinned to an exact version, not latest or a range");
  referenceField(tool, "procedureRef", "restoreTool", errors);
  enumField(tool, "sourceMode", ["read-only"], "restoreTool", errors);
  enumField(tool, "targetMode", ["target-only-write"], "restoreTool", errors);
}

function validateAccess(
  plan: JsonRecord,
  operator: string | null,
  window: { endsAt: number | null },
  errors: string[],
): void {
  const access = objectField(plan, "access", "access", ["principalId", "operatorPersonId", "targetWriteScope", "productionCredentialsUsed", "expiresAt", "revocationPlanRef"], errors);
  const principalId = stringField(access, "principalId", "access", errors);
  const operatorPersonId = stringField(access, "operatorPersonId", "access", errors);
  if (operator && operatorPersonId && operator !== operatorPersonId) errors.push("access.operatorPersonId must match participants.operator.personId");
  if (principalId && operatorPersonId && principalId === operatorPersonId) errors.push("access.principalId must identify the provisioned credential, not the operator person record");
  enumField(access, "targetWriteScope", ["target-only"], "access", errors);
  booleanField(access, "productionCredentialsUsed", false, "access", errors);
  const expiresAt = timestampField(access, "expiresAt", "access", errors);
  if (expiresAt !== null && window.endsAt !== null && expiresAt < window.endsAt) errors.push("access.expiresAt must cover the planned exercise window");
  referenceField(access, "revocationPlanRef", "access", errors);
}

function validateCost(plan: JsonRecord, errors: string[]): void {
  const cost = objectField(plan, "cost", "cost", ["currency", "estimatedMinorUnits", "ceilingMinorUnits", "budgetOwnerId", "evidenceRef"], errors);
  const currency = stringField(cost, "currency", "cost", errors);
  if (currency && !/^[A-Z]{3}$/.test(currency)) errors.push("cost.currency must be a three-letter uppercase currency code");
  const estimate = cost.estimatedMinorUnits;
  const ceiling = cost.ceilingMinorUnits;
  if (typeof estimate !== "number" || !Number.isSafeInteger(estimate) || estimate < 0) errors.push("cost.estimatedMinorUnits must be a non-negative safe integer");
  if (typeof ceiling !== "number" || !Number.isSafeInteger(ceiling) || ceiling <= 0) errors.push("cost.ceilingMinorUnits must be a positive safe integer");
  if (typeof estimate === "number" && typeof ceiling === "number" && estimate > ceiling) errors.push("cost.estimatedMinorUnits must not exceed the approved ceiling");
  stringField(cost, "budgetOwnerId", "cost", errors);
  referenceField(cost, "evidenceRef", "cost", errors);
}

function validateAbort(plan: JsonRecord, errors: string[]): void {
  const abort = objectField(plan, "abort", "abort", ["criteria", "escalationContactRef", "escalationOwnerRole"], errors);
  const criteria = abort.criteria;
  if (!Array.isArray(criteria) || criteria.some(item => typeof item !== "string")) {
    errors.push("abort.criteria must be an array of required condition identifiers");
  } else {
    const values = criteria as string[];
    for (const condition of REQUIRED_ABORT_CONDITIONS) {
      if (!values.includes(condition)) errors.push(`abort.criteria is missing ${condition}`);
    }
    if (new Set(values).size !== values.length) errors.push("abort.criteria must not contain duplicates");
    for (const condition of values) {
      if (!(REQUIRED_ABORT_CONDITIONS as readonly string[]).includes(condition)) errors.push(`abort.criteria contains unsupported condition ${condition}`);
    }
  }
  referenceField(abort, "escalationContactRef", "abort", errors);
  stringField(abort, "escalationOwnerRole", "abort", errors);
}

function validateCleanup(plan: JsonRecord, targetIdentity: Identity, operator: string | null, errors: string[]): void {
  const cleanup = objectField(plan, "cleanup", "cleanup", [
    "targetIdentity", "targetResourceIds", "cleanupOperatorPersonId", "scope",
    "preserveEvidenceBeforeCleanup", "retentionEvidenceRef",
  ], errors);
  const cleanupIdentityHolder: JsonRecord = { identity: cleanup.targetIdentity };
  const cleanupIdentity = readIdentity(cleanupIdentityHolder, "cleanup.target", errors);
  if (!sameIdentity(cleanupIdentity, targetIdentity)) errors.push("cleanup.targetIdentity must exactly match the declared target identity");
  const resourceIds = cleanup.targetResourceIds;
  if (!Array.isArray(resourceIds) || resourceIds.length === 0 || resourceIds.some(id => typeof id !== "string" || id.trim().length === 0 || PLACEHOLDER.test(id.trim()) || id.includes("*") || id.includes("?"))) {
    errors.push("cleanup.targetResourceIds must enumerate exact non-placeholder disposable target resources; wildcards are refused");
  } else if (new Set((resourceIds as string[]).map(id => id.toLocaleLowerCase("en-US"))).size !== resourceIds.length) {
    errors.push("cleanup.targetResourceIds must be unique");
  }
  const cleanupOperator = stringField(cleanup, "cleanupOperatorPersonId", "cleanup", errors);
  if (operator && cleanupOperator && operator !== cleanupOperator) errors.push("cleanup.cleanupOperatorPersonId must match the named target-only operator");
  enumField(cleanup, "scope", ["disposable-target-only"], "cleanup", errors);
  booleanField(cleanup, "preserveEvidenceBeforeCleanup", true, "cleanup", errors);
  referenceField(cleanup, "retentionEvidenceRef", "cleanup", errors);
}

function validateVerification(plan: JsonRecord, reviewer: string | null, errors: string[]): void {
  const verification = objectField(plan, "verification", "verification", ["criteria", "passFailRecordRef", "reviewerPersonId"], errors);
  const criteria = verification.criteria;
  if (!Array.isArray(criteria) || criteria.some(item => typeof item !== "string")) {
    errors.push("verification.criteria must be an array of required acceptance criteria");
  } else {
    const values = criteria as string[];
    for (const criterion of REQUIRED_VERIFICATION_CRITERIA) {
      if (!values.includes(criterion)) errors.push(`verification.criteria is missing ${criterion}`);
    }
    if (new Set(values).size !== values.length) errors.push("verification.criteria must not contain duplicates");
    for (const criterion of values) {
      if (!(REQUIRED_VERIFICATION_CRITERIA as readonly string[]).includes(criterion)) errors.push(`verification.criteria contains unsupported criterion ${criterion}`);
    }
  }
  referenceField(verification, "passFailRecordRef", "verification", errors);
  const reviewerPersonId = stringField(verification, "reviewerPersonId", "verification", errors);
  if (reviewer && reviewerPersonId !== reviewer) errors.push("verification.reviewerPersonId must match participants.reviewer.personId");
}

function validateApprovals(
  plan: JsonRecord,
  fingerprint: string | null,
  window: { startsAt: number | null; endsAt: number | null },
  operator: string | null,
  reviewer: string | null,
  now: Date,
  errors: string[],
): void {
  const approvals = objectField(plan, "approvals", "approvals", APPROVAL_KEYS, errors);
  for (const [gate, requiredRoles] of Object.entries(REQUIRED_APPROVAL_ROLES)) {
    if (!Object.prototype.hasOwnProperty.call(approvals, gate)) continue;
    const approval = objectField(approvals, gate, `approvals.${gate}`, ["status", "evidenceRef", "approvedAt", "expiresAt", "scopeFingerprint", "approvers"], errors);
    enumField(approval, "status", ["approved"], `approvals.${gate}`, errors);
    referenceField(approval, "evidenceRef", `approvals.${gate}`, errors);
    const approvedAt = timestampField(approval, "approvedAt", `approvals.${gate}`, errors);
    const expiresAt = timestampField(approval, "expiresAt", `approvals.${gate}`, errors);
    if (approvedAt !== null && approvedAt > now.getTime()) errors.push(`approvals.${gate}.approvedAt must not be in the future`);
    if (approvedAt !== null && window.startsAt !== null && approvedAt > window.startsAt) errors.push(`approvals.${gate}.approvedAt must be no later than the planned exercise start`);
    if (expiresAt !== null && window.endsAt !== null && expiresAt < window.endsAt) errors.push(`approvals.${gate}.expiresAt must cover the planned exercise window`);
    if (approvedAt !== null && expiresAt !== null && expiresAt <= approvedAt) errors.push(`approvals.${gate}.expiresAt must be after approvedAt`);
    const approvedFingerprint = stringField(approval, "scopeFingerprint", `approvals.${gate}`, errors);
    if (fingerprint && approvedFingerprint && approvedFingerprint.toLowerCase() !== fingerprint) errors.push(`approvals.${gate}.scopeFingerprint does not match the current plan scope`);
    const approvers = approval.approvers;
    if (!Array.isArray(approvers)) {
      errors.push(`approvals.${gate}.approvers must be an array`);
      continue;
    }
    const seenPeople = new Set<string>();
    const foundRoles = new Set<string>();
    for (let index = 0; index < approvers.length; index += 1) {
      const approverPath = `approvals.${gate}.approvers[${index}]`;
      const approverValue = approvers[index];
      if (!isRecord(approverValue)) {
        errors.push(`${approverPath} must be an object`);
        continue;
      }
      exactKeys(approverValue, ["personId", "role"], approverPath, errors);
      const personId = identifierField(approverValue, "personId", approverPath, errors);
      const role = enumField(approverValue, "role", requiredRoles, approverPath, errors);
      if (personId) {
        const normalizedId = personId.toLocaleLowerCase("en-US");
        if (seenPeople.has(normalizedId)) errors.push(`${approverPath}.personId is duplicated in this approval gate`);
        seenPeople.add(normalizedId);
        if (operator && normalizedId === operator.toLocaleLowerCase("en-US")) errors.push(`${approverPath}.personId must not be the operator`);
      }
      if (role) foundRoles.add(role);
      if (role === "independent-reviewer" && reviewer && personId !== reviewer) errors.push(`${approverPath} must name the assigned independent reviewer`);
    }
    for (const role of requiredRoles) {
      if (!foundRoles.has(role)) errors.push(`approvals.${gate}.approvers is missing required role ${role}`);
    }
  }
  if (operator && reviewer && operator.toLocaleLowerCase("en-US") === reviewer.toLocaleLowerCase("en-US")) {
    errors.push("the operator and independent reviewer must be different people");
  }
}

export function validateRestorePlan(value: unknown, now = new Date()): RestorePlanValidation {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, fingerprint: null, errors: ["plan root must be a JSON object"] };
  }
  const plan = value;
  exactKeys(plan, PLAN_KEYS, "plan", errors);
  const fingerprint = computeApprovalScopeFingerprint(plan);

  if (plan.planVersion !== 1) errors.push("plan.planVersion must be 1");
  enumField(plan, "operation", ["metadata-preflight-only"], "plan", errors);
  booleanField(plan, "restoreExecutionAllowed", false, "plan", errors);
  booleanField(plan, "cleanupExecutionAllowed", false, "plan", errors);
  stringField(plan, "changeRecordId", "plan", errors);
  stringField(plan, "purpose", "plan", errors);

  const storedFingerprint = stringField(plan, "approvalScopeFingerprint", "plan", errors);
  if (storedFingerprint && !SHA256.test(storedFingerprint)) errors.push("plan.approvalScopeFingerprint must be a 64-character SHA-256 hex digest");
  if (storedFingerprint && fingerprint && storedFingerprint.toLowerCase() !== fingerprint) errors.push("plan.approvalScopeFingerprint does not match the declared plan scope");

  const window = validateTimeWindow(plan, now, errors);
  const participants = validateParticipants(plan, errors);
  const sourceHolder = objectField(plan, "source", "source", ["identity"], errors);
  const targetHolder = objectField(plan, "target", "target", ["identity", "disposable"], errors);
  const sourceIdentity = readIdentity(sourceHolder, "source", errors);
  const targetIdentity = readIdentity(targetHolder, "target", errors);
  booleanField(targetHolder, "disposable", true, "target", errors);

  const sameEnvironment = identityKey(sourceIdentity, ["platform", "accountId", "projectId", "environmentId"])
    === identityKey(targetIdentity, ["platform", "accountId", "projectId", "environmentId"]);
  const sameDatabase = identityKey(sourceIdentity, ["platform", "accountId", "projectId", "databaseId"])
    === identityKey(targetIdentity, ["platform", "accountId", "projectId", "databaseId"]);
  if (sameEnvironment || sameDatabase || sameIdentity(sourceIdentity, targetIdentity)) {
    errors.push("source and target must be distinct, explicitly identified non-production environments and databases");
  }

  validateBackup(plan, sourceIdentity, window, now, participants.operator, errors);
  validateIsolation(plan, sourceIdentity, targetIdentity, window, now, errors);
  validateTool(plan, errors);
  validateAccess(plan, participants.operator, window, errors);
  validateCost(plan, errors);
  validateAbort(plan, errors);
  validateCleanup(plan, targetIdentity, participants.operator, errors);
  validateVerification(plan, participants.reviewer, errors);
  validateApprovals(plan, fingerprint, window, participants.operator, participants.reviewer, now, errors);

  return { valid: errors.length === 0, fingerprint, errors };
}

function usage(): string {
  return [
    "Usage: npm run preflight:restore-plan -- --plan <metadata-plan.json>",
    "       npm run preflight:restore-plan -- --help",
    "",
    "This DB-free command validates declared plan metadata only. It never restores or cleans up.",
    "--apply is permanently refused; no execution workflow is implemented.",
  ].join("\n");
}

export async function runRestorePlanPreflight(
  args: string[],
  io: PreflightIO,
  now = new Date(),
): Promise<number> {
  if (args.some(argument => /^--apply(?:=|$)/i.test(argument))) {
    io.writeLine("REFUSED: --apply is permanently disabled. This tool has no restore or cleanup execution path.");
    io.writeLine("No plan was read; no database, provider, payment system, or environment was contacted.");
    io.writeLine("No restore or cleanup ran. No rehearsal was performed.");
    return 2;
  }
  if (args.length === 1 && args[0] === "--help") {
    io.writeLine(usage());
    return 0;
  }
  if (args.length !== 2 || args[0] !== "--plan" || args[1].trim().length === 0) {
    io.writeLine(usage());
    return 2;
  }

  let text: string;
  try {
    text = await io.readPlanFile(args[1]);
  } catch {
    io.writeLine("BLOCKED: unable to read the local plan file. No external system was contacted.");
    return 1;
  }

  let plan: unknown;
  try {
    plan = JSON.parse(text) as unknown;
  } catch {
    io.writeLine("BLOCKED: plan is not valid JSON. No external system was contacted.");
    return 1;
  }

  const result = validateRestorePlan(plan, now);
  if (result.fingerprint) io.writeLine(`Calculated approval-scope SHA-256: ${result.fingerprint}`);
  if (!result.valid) {
    io.writeLine(`BLOCKED: plan metadata failed ${result.errors.length} check(s).`);
    for (const error of result.errors) io.writeLine(`- ${error}`);
    io.writeLine("No restore or cleanup ran. No rehearsal was performed.");
    io.writeLine("Evidence references and approval records were not fetched, authenticated, or independently verified.");
    return 1;
  }

  io.writeLine("PLAN METADATA: COMPLETE — declared gates and in-plan consistency checks passed.");
  io.writeLine("This does not authenticate evidence, grant authorization, or approve execution.");
  io.writeLine("No restore or cleanup ran. No rehearsal was performed.");
  io.writeLine("No database, provider, payment system, or remote environment was contacted.");
  return 0;
}

export const restorePlanPreflightRequirements = {
  abortConditions: REQUIRED_ABORT_CONDITIONS,
  verificationCriteria: REQUIRED_VERIFICATION_CRITERIA,
  approvalRoles: REQUIRED_APPROVAL_ROLES,
} as const;
