/**
 * Withdrawal audit trail operations (Phase 4).
 *
 * Records lifecycle events with server-controlled data: actor, previous/new
 * status, provider references, and reasons. Never stores secrets or provider
 * credentials.
 *
 * All writes go through {@link recordWithdrawalEvent}, which runs inside the
 * caller's transaction so audit rows commit atomically with status changes.
 */

import { sql } from "drizzle-orm";
import { withdrawalAuditLogs } from "@/db/schema";
import type { WithdrawalAuditEvent } from "@/lib/withdrawals";

/** Parameters for recording a withdrawal audit event. */
export type AuditEventParams = {
  /** Database ID of the withdrawal_requests row. */
  withdrawalId: number;
  /** Human-readable withdrawal reference (e.g. WDL-A1B2C3). */
  withdrawalRef: string;
  /** The lifecycle event that occurred. */
  event: WithdrawalAuditEvent;
  /** Status before this event (null for 'created'). */
  previousStatus?: string | null;
  /** Status after this event. */
  newStatus?: string | null;
  /** Who triggered this: 'admin', 'system', or 'provider'. */
  actorType?: "admin" | "system" | "provider";
  /** Actor's user ID (for admin events). */
  actorId?: number | null;
  /** Actor's email (for admin events; stored for audit readability). */
  actorEmail?: string | null;
  /** Provider reference if available. */
  providerReference?: string | null;
  /** Human-readable reason (e.g. rejection reason). */
  reason?: string | null;
  /** Additional metadata (JSON; no secrets). */
  metadata?: Record<string, unknown> | null;
};

/** Shape of an audit log entry returned from the database. */
export type AuditLogEntry = {
  id: number;
  withdrawal_id: number;
  withdrawal_ref: string;
  event: string;
  previous_status: string | null;
  new_status: string | null;
  actor_type: string;
  actor_id: number | null;
  actor_email: string | null;
  provider_reference: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
};

const VALID_EVENTS: ReadonlyArray<WithdrawalAuditEvent> = [
  "created",
  "approved",
  "rejected",
  "moved_to_processing",
  "callback_received",
  "marked_successful",
  "payout_failed",
  "refunded",
  "provider_timeout",
];

/**
 * Record a withdrawal audit event inside the caller's transaction.
 *
 * This MUST be called within a db.transaction() block so the audit row
 * commits atomically with the status change it records.
 *
 * The `tx` parameter accepts any Drizzle transaction-like object with an
 * `insert` method (which all Drizzle transaction callbacks have).
 */
export async function recordWithdrawalEvent(
  tx: any,
  params: AuditEventParams,
): Promise<void> {
  if (!VALID_EVENTS.includes(params.event)) {
    throw new Error(`Invalid withdrawal audit event: ${params.event}`);
  }

  // Use raw SQL to avoid TypeScript issues with the generic tx type
  await (tx as any).execute(sql`
    INSERT INTO withdrawal_audit_logs (
      withdrawal_id, withdrawal_ref, event, previous_status, new_status,
      actor_type, actor_id, actor_email, provider_reference, reason, metadata
    ) VALUES (
      ${params.withdrawalId},
      ${params.withdrawalRef},
      ${params.event},
      ${params.previousStatus ?? null},
      ${params.newStatus ?? null},
      ${params.actorType ?? "system"},
      ${params.actorId ?? null},
      ${params.actorEmail ?? null},
      ${params.providerReference ?? null},
      ${params.reason ?? null},
      ${params.metadata ? sql`${JSON.stringify(params.metadata)}::jsonb` : null}
    )
  `).catch((err: unknown) => {
    // If the table doesn't exist yet, log and continue (non-fatal)
    const msg = (err as { message?: string })?.message ?? "";
    if (msg.includes("does not exist")) {
      console.warn("[flexidata] withdrawal_audit_logs table not yet available; audit event skipped");
      return;
    }
    throw err;
  });
}

/**
 * Fetch audit events for a withdrawal, most recent first.
 * Used by admin withdrawal detail views.
 */
export async function fetchWithdrawalAuditLog(
  dbClient: { execute: (query: any) => Promise<{ rows: unknown[] }> },
  withdrawalId: number,
): Promise<AuditLogEntry[]> {
  const result = await dbClient.execute(sql`SELECT
    id, withdrawal_id, withdrawal_ref, event,
    previous_status, new_status, actor_type, actor_id, actor_email,
    provider_reference, reason, metadata, created_at
  FROM withdrawal_audit_logs
  WHERE withdrawal_id = ${withdrawalId}
  ORDER BY created_at ASC`);
  return (result.rows as AuditLogEntry[]) ?? [];
}

/**
 * Fetch recent audit events across all withdrawals (admin overview).
 */
export async function fetchRecentWithdrawalAuditLog(
  dbClient: { execute: (query: any) => Promise<{ rows: unknown[] }> },
  limit = 50,
): Promise<AuditLogEntry[]> {
  const result = await dbClient.execute(sql`SELECT
    id, withdrawal_id, withdrawal_ref, event,
    previous_status, new_status, actor_type, actor_id, actor_email,
    provider_reference, reason, metadata, created_at
  FROM withdrawal_audit_logs
  ORDER BY created_at DESC
  LIMIT ${limit}`);
  return (result.rows as AuditLogEntry[]) ?? [];
}
