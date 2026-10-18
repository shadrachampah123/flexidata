import { adminAuditLogs } from "@/db/schema";

/**
 * The action vocabulary already accepted by the shipped admin audit table.
 *
 * This is an accountability boundary, not a new permission model: adding a
 * role, permission, read-event action, or financial-action state still requires
 * owner approval and a reviewed migration. Keeping the vocabulary here in one
 * place prevents a writer from silently inventing an action that the database
 * cannot enforce.
 */
export const ADMIN_AUDIT_ACTIONS = [
  "suspend",
  "activate",
  "delivery_resolved",
  "refund_review",
  "approve_withdrawal",
  "reject_withdrawal",
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];
export type AdminAuditInsert = typeof adminAuditLogs.$inferInsert;

const TARGET_REF = /^[A-Za-z0-9_-]{4,40}$/;
const MAX_REASON_LENGTH = 240;

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[flexidata:admin] invalid ${label} for audit record`);
  }
  return value;
}

/**
 * Build a complete audit INSERT value from server-controlled fields.
 *
 * Callers must obtain both actor and target ids from the server-side gate/live
 * database, never from request JSON. The helper does not execute SQL and does
 * not add a new table or action; it normalizes the existing append-only row
 * shape before the caller inserts it inside its existing transaction.
 */
export function adminAuditValues(input: {
  adminUserId: number;
  targetUserId: number;
  action: AdminAuditAction;
  reason?: string | null;
  targetRef?: string | null;
}): AdminAuditInsert {
  const adminUserId = positiveInteger(input.adminUserId, "admin user id");
  const targetUserId = positiveInteger(input.targetUserId, "target user id");
  if (!ADMIN_AUDIT_ACTIONS.includes(input.action)) {
    throw new Error("[flexidata:admin] invalid audit action");
  }

  const targetRef = input.targetRef === undefined || input.targetRef === null
    ? null
    : input.targetRef.trim();
  if (targetRef !== null && !TARGET_REF.test(targetRef)) {
    throw new Error("[flexidata:admin] invalid target reference for audit record");
  }

  const reason = typeof input.reason === "string" && input.reason.trim()
    ? input.reason.trim().slice(0, MAX_REASON_LENGTH)
    : null;

  return {
    adminUserId,
    targetUserId,
    action: input.action,
    reason,
    targetRef,
  };
}
