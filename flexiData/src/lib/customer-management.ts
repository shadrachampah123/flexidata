import "server-only";

import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { adminAuditLogs, users } from "@/db/schema";
import { isSchemaIncompatibleError } from "@/lib/schema-compat";

/**
 * Phase 2, Step 1 — customer account status (suspend / activate).
 *
 * This is the ONLY write surface the customer-management step adds, and it is
 * deliberately kept OUT of `src/lib/admin` (the Phase 1 read-only observation
 * layer) so that directory's guarantee — every statement runs inside a
 * read-only transaction — remains trivially verifiable.
 *
 * Money-safety: this module touches exactly two tables, `users` and
 * `admin_audit_logs`. It can never reach `wallets`, `transactions`,
 * `deposit_requests`, `checkout_orders` or any other financial table.
 *
 * Audit safety: the status UPDATE is conditional (`status <> next`), and the
 * audit row is inserted only when that UPDATE actually changed a row, inside
 * one transaction. Replaying the same action is therefore a no-op that writes
 * nothing — no duplicate audit records.
 *
 * The acting admin is always supplied by the caller from the server-side admin
 * gate (`AdminContext.admin.userId`); nothing in this module accepts an admin
 * identity from a request body.
 */

export type AccountAction = "suspend" | "activate";
export type AccountStatus = "active" | "suspended";

export const NEXT_STATUS: Record<AccountAction, AccountStatus> = {
  suspend: "suspended",
  activate: "active",
};

export type CustomerStatusResult =
  | { ok: true; accountStatus: AccountStatus; changed: boolean }
  | { ok: false; error: "user-not-found" | "admin-account" | "schema-drift" };

const MAX_REASON_LENGTH = 240;

export async function setCustomerStatus(input: {
  /** The authenticated administrator (from the gate, never browser input). */
  adminUserId: number;
  /** The customer account being acted on. */
  targetUserId: number;
  action: AccountAction;
  /** Operator-supplied context, optional and clamped. */
  reason?: string | null;
}): Promise<CustomerStatusResult> {
  const nextStatus = NEXT_STATUS[input.action];
  const reason =
    typeof input.reason === "string" && input.reason.trim()
      ? input.reason.trim().slice(0, MAX_REASON_LENGTH)
      : null;

  try {
    return await db.transaction(async (tx) => {
      const target = await tx
        .select({ id: users.id, isAdmin: users.isAdmin })
        .from(users)
        .where(eq(users.id, input.targetUserId))
        .limit(1);

      if (!target[0]) return { ok: false, error: "user-not-found" as const };

      // One admin must not be able to suspend an administrator account and
      // lock every operator out. Activation is harmless and stays allowed.
      if (target[0].isAdmin && input.action === "suspend") {
        return { ok: false, error: "admin-account" as const };
      }

      // Conditional UPDATE: only flips rows that are not already in the target
      // state. The row count tells us whether anything actually changed, which
      // is what prevents duplicate audit records on replay.
      const updated = await tx
        .update(users)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(and(eq(users.id, input.targetUserId), ne(users.status, nextStatus)))
        .returning({ id: users.id });

      if (updated.length > 0) {
        await tx.insert(adminAuditLogs).values({
          adminUserId: input.adminUserId,
          targetUserId: input.targetUserId,
          action: input.action,
          reason,
        });
      }

      return { ok: true as const, accountStatus: nextStatus, changed: updated.length > 0 };
    });
  } catch (error) {
    if (isSchemaIncompatibleError(error)) {
      console.error(
        "[flexidata:admin] customer status change refused — the database is missing the " +
          "customer-management schema (users.status / admin_audit_logs). Run `npx drizzle-kit push`.",
        error,
      );
      return { ok: false, error: "schema-drift" as const };
    }
    throw error;
  }
}
