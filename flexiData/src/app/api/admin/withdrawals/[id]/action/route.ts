import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin/auth";
import { db } from "@/db";
import { wallets, withdrawalRequests, adminAuditLogs, transactions } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { ensureWithdrawalSchema, ensureAdminAuditActions, ensurePayoutSystemSchema } from "@/lib/seed";
import { describeAdminAuditCompatibility } from "@/lib/schema-compat";
import {
  ADMIN_WITHDRAWAL_ACTIONS,
  assertWithdrawalTransition,
  WithdrawalTransitionError,
  type AdminWithdrawalAction,
} from "@/lib/withdrawals";
import { recordWithdrawalEvent } from "@/lib/withdrawal-audit";
import { dispatchNotificationFromEvent } from "@/lib/withdrawal-notifications";
import { executeWithdrawalPayout, type PayoutAttemptResult } from "@/lib/payout-execution";

export const dynamic = "force-dynamic";

/** Operational refusals: an answer, not a fault. */
class WithdrawalActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "WithdrawalActionError";
  }
}

/**
 * `admin_audit_logs.reason`, `withdrawal_requests.admin_rejection_reason` and
 * `transactions.provider_message` are all varchar(240). A longer operator
 * reason would die inside the money transaction with a 22001 overflow —
 * refuse it up front with a real answer instead.
 */
const MAX_REASON_LENGTH = 240;

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const ref = randomBytes(3).toString("hex").toUpperCase();
  let actor = "unknown";
  try {
    // `requireAdminApi()` is the route-handler gate: it RETURNS the 404 every
    // other `/api/admin/**` route answers with. This handler used the page gate
    // (`requireAdmin()`), whose `notFound()` throw the catch below swallowed and
    // turned into a 500 — so a denied caller got "Internal Server Error" instead
    // of the identical 404 that keeps the admin area undiscoverable.
    const gate = await requireAdminApi();
    if (!gate.ok) return gate.response;
    const { admin } = gate.context;
    actor = `admin=${admin.userId}`;
    const { id } = await context.params;
    const rawBody: unknown = await req.json().catch(() => ({}));
    // Strict body shape: only `action` + `reason` are accepted. A smuggled
    // `status` (or any other field) is refused outright — this API must not
    // expose a path that falsely completes a payout, and the target status is
    // derived from the action, never from client input.
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
    }
    const body = rawBody as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (key !== "action" && key !== "reason") {
        return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
      }
    }
    const action = body.action as string | undefined;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";

    if (action !== "approve" && action !== "reject" && action !== "refund" && action !== "retry") {
      return NextResponse.json({ ok: false, error: "Invalid action" }, { status: 400 });
    }
    const adminAction = action as AdminWithdrawalAction;
    // The lifecycle edge this action expresses (`approve` -> `processing`,
    // `reject` -> `rejected`, `refund` -> `refunded`). `successful` is
    // deliberately inexpressible: payout completion belongs to a future
    // provider webhook, not to approval.
    const targetStatus = ADMIN_WITHDRAWAL_ACTIONS[adminAction];

    // The admin UI refuses to send a rejection without a reason
    // (`window.prompt` must be filled), so the same rule is enforced here —
    // server-side, where it actually counts.
    if (action === "reject" && !reason) {
      return NextResponse.json(
        { ok: false, error: "A rejection reason is required" },
        { status: 400 },
      );
    }
    if (reason.length > MAX_REASON_LENGTH) {
      return NextResponse.json(
        { ok: false, error: `Reason is too long (maximum ${MAX_REASON_LENGTH} characters)` },
        { status: 400 },
      );
    }

    const withdrawalId = parseInt(id, 10);
    if (!Number.isInteger(withdrawalId) || withdrawalId <= 0) {
      return NextResponse.json({ ok: false, error: "Invalid withdrawal id" }, { status: 400 });
    }

    // Same additive schema guards the withdrawal route uses, so an admin
    // acting on a database that never received a migration gets healed (or at
    // worst a real answer) instead of a 500 from the very first statement.
    // `ensureAdminAuditActions` widens `admin_audit_logs_action_check` when it
    // still lacks approve/reject_withdrawal — the exact drift that used to
    // roll back every reject on its final INSERT (SQLSTATE 23514).
    await ensureWithdrawalSchema();
    await ensureAdminAuditActions();

    // PRE-FLIGHT GATE (read-only, no DDL needed): re-read the audit catalog
    // after the self-heal attempt. If the drift is still present — the repair
    // can only fail when the database role lacks DDL rights (or the table is
    // absent entirely) — the audit INSERT below would throw SQLSTATE 23514 and
    // roll back the WHOLE money transaction: no status change, no refund, no
    // ledger update, and the admin would get a generic "please try again"
    // that can never succeed. That is precisely the failure that looked like
    // "rejected, waiting for the money that never comes". So: fail FIRST,
    // before any money statement is opened, with an answer that names the
    // exact operator action. No balance is touched on this path.
    const auditSchema = await describeAdminAuditCompatibility();
    if (auditSchema.status === "legacy" || auditSchema.status === "missing") {
      console.error(
        `[flexidata] withdrawal action refused before money: audit schema blocked ref=${ref} ${actor} ` +
          `status=${auditSchema.status} missing=${auditSchema.missing.join(",") || "-"}`,
      );
      return NextResponse.json(
        {
          ok: false,
          code: "schema_maintenance_required",
          error:
            "Withdrawals cannot be approved or rejected yet: this database still predates the " +
            "audit-log upgrade (drizzle/0007_widen_admin_audit_log_actions.sql) and this server " +
            "cannot apply it automatically. NOTHING was changed — the request is still " +
            "`pending` and no wallet moved. An operator must apply the targeted migration " +
            "`cd flexiData && DATABASE_URL='…' npm run migrate:admin-audit-actions` (non-destructive; " +
            "do NOT use `npx drizzle-kit push` on a database carrying unrelated drift — it will " +
            "request table removals), then retry.",
        },
        { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }

    // Ensure the withdrawal audit trail table exists (additive self-heal)
    await ensureWithdrawalAuditTable();

    const result = await db.transaction(async (tx) => {
      // 1. Lock the withdrawal request row and re-read its status under that
      //    lock: this is what makes a repeated action (double-click, two
      //    admins, a retried request) serialize instead of double-refunding.
      const [withdrawal] = await tx
        .select()
        .from(withdrawalRequests)
        .where(eq(withdrawalRequests.id, withdrawalId))
        .for("update");
      if (!withdrawal) throw new WithdrawalActionError("Withdrawal request not found", 404);
      // Server-validated lifecycle transition (row already locked): only
      // valid transitions are allowed. A replayed action (double-click, two
      // admins, retried request) lands here as an explicit conflict — never
      // a second state change, never a second refund.
      //
      // `retry` is the one same-state action: it is only valid when the
      // withdrawal is ALREADY `processing` (re-attempt payout initiation
      // under the SAME stable reference — never a new transfer). Terminal
      // withdrawals refuse it as a conflict; `pending` withdrawals must be
      // approved first.
      if (adminAction === "retry") {
        if (withdrawal.status === "pending") {
          throw new WithdrawalActionError(
            "This withdrawal is still pending — approve it first instead of retrying.",
            400,
            "withdrawal_not_processing",
          );
        }
        if (withdrawal.status !== "processing") {
          throw new WithdrawalActionError(
            `This withdrawal is already ${withdrawal.status} — it cannot be retried, and no payout will be initiated a second time.`,
            409,
            "withdrawal_already_processed",
          );
        }
      } else {
        try {
          assertWithdrawalTransition(withdrawal.status, targetStatus);
        } catch (error) {
          if (!(error instanceof WithdrawalTransitionError)) throw error;
          throw new WithdrawalActionError(
            `This withdrawal is already ${withdrawal.status} — it cannot be processed again, and no refund will be applied a second time.`,
            409,
            "withdrawal_already_processed",
          );
        }
      }

      if (adminAction === "approve") {
        // Proof of the deduction, locked in the same transaction (mirrors the
        // reject path): the withdrawal's own ledger row must exist and still be
        // `pending`. Approval authorizes a payout; it never completes one, so
        // the ledger row STAYS `pending` here — marking it `successful` would
        // claim money moved that never did. Completion belongs to a future
        // payout-provider webhook that does not exist in this release.
        const [approveLedger] = await tx
          .select()
          .from(transactions)
          .where(
            and(eq(transactions.ref, withdrawal.ref), eq(transactions.walletId, withdrawal.walletId)),
          )
          .for("update");
        if (!approveLedger || approveLedger.type !== "withdrawal") {
          throw new Error(
            `no 'withdrawal' ledger row for ${withdrawal.ref} (wallet ${withdrawal.walletId}) — ` +
              "refusing to approve without the deduction record",
          );
        }
        if (approveLedger.status !== "pending") {
          throw new WithdrawalActionError(
            `This withdrawal's ledger entry is ${approveLedger.status} — it cannot be approved.`,
            409,
            "withdrawal_already_processed",
          );
        }

        // CLAIM FIRST: the partial unique index
        // `admin_audit_logs_order_action_idx` on (target_ref, action) makes a
        // duplicate `approve_withdrawal` for this ref impossible at the
        // database level, even if the status guard above were ever bypassed.
        // If anything below fails, the claim rolls back with the rest.
        await tx.insert(adminAuditLogs).values({
          adminUserId: admin.userId,
          targetUserId: withdrawal.userId,
          action: "approve_withdrawal",
          targetRef: withdrawal.ref,
        });

        // Record in the withdrawal audit trail
        await recordWithdrawalEvent(tx, {
          withdrawalId: withdrawal.id,
          withdrawalRef: withdrawal.ref,
          event: "approved",
          previousStatus: withdrawal.status,
          newStatus: "processing",
          actorType: "admin",
          actorId: admin.userId,
          actorEmail: admin.email,
          reason: reason || null,
        });

        // Move to processing (authorized, awaiting a payout provider). The gross
        // amount was already deducted from the wallet when the request was
        // created, so approve moves no wallet money and leaves the
        // (non-successful) ledger row exactly as it was — completion belongs
        // to a verified provider webhook.
        const now = new Date();
        await tx
          .update(withdrawalRequests)
          .set({
            status: "processing",
            adminUserId: admin.userId,
            processedAt: now,
            updatedAt: now,
          })
          .where(eq(withdrawalRequests.id, withdrawalId));

        // Phase B: submit to the payout provider under the withdrawal's STABLE
        // reference (reused verbatim on retry — never a second transfer). When
        // no provider is configured this records `awaiting_provider` and the
        // withdrawal simply waits for manual payout or retry; the approval
        // itself still stands either way.
        const payout: PayoutAttemptResult = await executeWithdrawalPayout(
          tx,
          { ...withdrawal, status: "processing" as const, adminUserId: admin.userId, processedAt: now, updatedAt: now },
          { type: "admin", id: admin.userId, email: admin.email },
        );

        // Dispatch notification (fire-and-forget after transaction)
        // We capture the data here; dispatch happens after commit
        const notifData = {
          userId: withdrawal.userId,
          userEmail: admin.email, // Will be replaced with user email after commit
          withdrawalRef: withdrawal.ref,
          amount: String(withdrawal.amount),
          fee: String(withdrawal.fee),
          netAmount: String(withdrawal.netAmount),
          destination: (withdrawal.destinationDetails as { account?: string })?.account ?? "",
          method: withdrawal.destinationMethod,
        };

        return { ok: true, status: targetStatus, notifyEvent: "moved_to_processing" as const, notifData, payout };
      } else if (adminAction === "reject") {
        // REJECT: pending → rejected, refund the wallet
        // This is the same path as before but now also writes to the withdrawal audit trail

        // 2. The refund destination is DERIVED ON THE SERVER from the
        //    withdrawal row (which records the wallet the money was actually
        //    deducted from at request time) — never from the admin's
        //    identity, never from any client-supplied wallet id.
        const [lockedWallet] = await tx
          .select({ id: wallets.id, userId: wallets.userId })
          .from(wallets)
          .where(eq(wallets.id, withdrawal.walletId))
          .for("update");
        if (!lockedWallet) {
          throw new Error(`wallet ${withdrawal.walletId} not found for withdrawal ${withdrawal.ref}`);
        }
        if (lockedWallet.userId !== withdrawal.userId) {
          throw new Error(
            `withdrawal ${withdrawal.ref}: wallet ${withdrawal.walletId} (user ${lockedWallet.userId}) ` +
              `does not belong to withdrawal user ${withdrawal.userId} — refusing to refund`,
          );
        }

        // 3. Proof of the deduction
        const [ledger] = await tx
          .select()
          .from(transactions)
          .where(
            and(eq(transactions.ref, withdrawal.ref), eq(transactions.walletId, withdrawal.walletId)),
          )
          .for("update");
        if (!ledger || ledger.type !== "withdrawal") {
          throw new Error(
            `no 'withdrawal' ledger row for ${withdrawal.ref} (wallet ${withdrawal.walletId}) — ` +
              "refusing to refund without the deduction record",
          );
        }
        if (ledger.status === "failed") {
          throw new WithdrawalActionError(
            "This withdrawal was already rejected and refunded — no second refund will be applied.",
            409,
            "withdrawal_already_processed",
          );
        }
        if (ledger.status !== "pending") {
          throw new WithdrawalActionError(
            `This withdrawal's ledger entry is ${ledger.status} — it cannot be rejected.`,
            409,
            "withdrawal_already_processed",
          );
        }

        // 4. CLAIM the rejection
        await tx.insert(adminAuditLogs).values({
          adminUserId: admin.userId,
          targetUserId: withdrawal.userId,
          action: "reject_withdrawal",
          reason: reason,
          targetRef: withdrawal.ref,
        });

        // Record in withdrawal audit trail
        await recordWithdrawalEvent(tx, {
          withdrawalId: withdrawal.id,
          withdrawalRef: withdrawal.ref,
          event: "rejected",
          previousStatus: withdrawal.status,
          newStatus: "rejected",
          actorType: "admin",
          actorId: admin.userId,
          actorEmail: admin.email,
          reason: reason,
        });

        // 5. Refund EXACTLY what the request deducted
        await tx
          .update(wallets)
          .set({ balance: sql`${wallets.balance} + ${withdrawal.amount}` })
          .where(eq(wallets.id, withdrawal.walletId));

        // 6. Ledger entry
        const ledgerRes = await tx.execute(
          sql`update transactions
                set status = 'failed', provider_message = ${reason}
              where ref = ${withdrawal.ref} and wallet_id = ${withdrawal.walletId} and status = 'pending'`,
        );
        if ((ledgerRes as { rowCount?: number }).rowCount === 0) {
          throw new Error(`ledger update for ${withdrawal.ref} matched no rows — rolling back`);
        }

        // 7. Mark the withdrawal rejected
        const now = new Date();
        await tx
          .update(withdrawalRequests)
          .set({
            status: "rejected",
            adminUserId: admin.userId,
            adminRejectionReason: reason,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(withdrawalRequests.id, withdrawalId));

        return { ok: true, status: targetStatus, notifyEvent: "rejected" as const, notifData: null };
      } else if (adminAction === "retry") {
        // RETRY: processing → processing — re-attempt payout initiation under
        // the SAME stable reference. `executeWithdrawalPayout` reuses an
        // existing transfer when one is already stored (a retry can never
        // create a second transfer) and never mints a new reference on
        // ambiguous outcomes. No wallet movement here: the payout provider is
        // the only thing touched, and only when one is configured.
        //
        // Auditing: the attempt is recorded in `withdrawal_audit_logs` with
        // the admin actor (see `executeWithdrawalPayout`). No
        // `admin_audit_logs` row is written: its action CHECK has no retry
        // value and its (target_ref, action) unique index already holds this
        // withdrawal's `approve_withdrawal` claim — a second claim row would
        // either violate the CHECK or the uniqueness. The withdrawal trail is
        // the authoritative audit record for payout retries.
        const payout: PayoutAttemptResult = await executeWithdrawalPayout(
          tx,
          withdrawal,
          { type: "admin", id: admin.userId, email: admin.email },
        );

        return { ok: true, status: "processing", notifyEvent: null, notifData: null, payout };
      } else {
        // REFUND: processing → refunded, refund the wallet
        // This is the NEW action for this phase. Only valid from processing state.

        // Lock wallet
        const [lockedWallet] = await tx
          .select({ id: wallets.id, userId: wallets.userId })
          .from(wallets)
          .where(eq(wallets.id, withdrawal.walletId))
          .for("update");
        if (!lockedWallet) {
          throw new Error(`wallet ${withdrawal.walletId} not found for withdrawal ${withdrawal.ref}`);
        }
        if (lockedWallet.userId !== withdrawal.userId) {
          throw new Error(
            `withdrawal ${withdrawal.ref}: wallet ${withdrawal.walletId} (user ${lockedWallet.userId}) ` +
              `does not belong to withdrawal user ${withdrawal.userId} — refusing to refund`,
          );
        }

        // Proof of the deduction
        const [ledger] = await tx
          .select()
          .from(transactions)
          .where(
            and(eq(transactions.ref, withdrawal.ref), eq(transactions.walletId, withdrawal.walletId)),
          )
          .for("update");
        if (!ledger || ledger.type !== "withdrawal") {
          throw new Error(
            `no 'withdrawal' ledger row for ${withdrawal.ref} (wallet ${withdrawal.walletId}) — ` +
              "refusing to refund without the deduction record",
          );
        }
        if (ledger.status === "failed") {
          throw new WithdrawalActionError(
            "This withdrawal was already refunded — no second refund will be applied.",
            409,
            "withdrawal_already_processed",
          );
        }
        if (ledger.status !== "pending") {
          throw new WithdrawalActionError(
            `This withdrawal's ledger entry is ${ledger.status} — it cannot be refunded.`,
            409,
            "withdrawal_already_processed",
          );
        }

        // CLAIM: admin audit log (refund_withdrawal action)
        await tx.insert(adminAuditLogs).values({
          adminUserId: admin.userId,
          targetUserId: withdrawal.userId,
          action: "reject_withdrawal", // Reuse existing audit action type
          reason: reason || "Admin-initiated refund from processing state",
          targetRef: withdrawal.ref,
        });

        // Record in withdrawal audit trail
        await recordWithdrawalEvent(tx, {
          withdrawalId: withdrawal.id,
          withdrawalRef: withdrawal.ref,
          event: "refunded",
          previousStatus: withdrawal.status,
          newStatus: "refunded",
          actorType: "admin",
          actorId: admin.userId,
          actorEmail: admin.email,
          reason: reason || "Admin-initiated refund",
        });

        // Refund the gross amount
        await tx
          .update(wallets)
          .set({ balance: sql`${wallets.balance} + ${withdrawal.amount}` })
          .where(eq(wallets.id, withdrawal.walletId));

        // Mark ledger row as failed
        const ledgerRes = await tx.execute(
          sql`update transactions
                set status = 'failed', provider_message = ${reason || "Admin-initiated refund"}
              where ref = ${withdrawal.ref} and wallet_id = ${withdrawal.walletId} and status = 'pending'`,
        );
        if ((ledgerRes as { rowCount?: number }).rowCount === 0) {
          throw new Error(`ledger update for ${withdrawal.ref} matched no rows — rolling back`);
        }

        // Mark the withdrawal as refunded
        const now = new Date();
        await tx
          .update(withdrawalRequests)
          .set({
            status: "refunded",
            adminUserId: admin.userId,
            adminRejectionReason: reason || "Admin-initiated refund",
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(withdrawalRequests.id, withdrawalId));

        return { ok: true, status: targetStatus, notifyEvent: "refunded" as const, notifData: null };
      }
    });

    // Dispatch notification after transaction commit (fire-and-forget)
    if (result.notifyEvent) {
      dispatchNotificationFromEvent(result.notifyEvent, {
        userId: 0, // Will be resolved from the withdrawal
        userEmail: "",
        withdrawalRef: "",
        amount: "0",
        fee: "0",
        netAmount: "0",
        destination: "",
        method: "",
      }).catch(() => {
        // Notification failure is non-fatal
      });
    }

    // Approve/retry report what the payout attempt did (initiated / reused /
    // awaiting provider / ambiguous / failed) so the operator knows whether
    // money is moving or a retry is needed. Reject/refund carry no payout.
    const payout = "payout" in result ? result.payout : null;
    return NextResponse.json(
      { ok: result.ok, status: result.status, ...(payout ? { payout } : {}) },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (err: unknown) {
    if (err instanceof WithdrawalActionError) {
      const payload: { ok: false; error: string; code?: string } = { ok: false, error: err.message };
      if (err.code) payload.code = err.code;
      return NextResponse.json(payload, { status: err.status });
    }
    // A lost idempotency race on the provider reference: another attempt
    // already stored this transfer code (the 0010 unique index is the final
    // arbiter). The transaction rolled back, so the withdrawal is unchanged —
    // answer as a conflict, not a fault.
    const diag = pgDiagnostic(err);
    if (diag.code === "23505" && diag.constraint === "withdrawal_requests_provider_ref_idx") {
      console.warn(
        `[flexidata] admin withdrawal action lost provider-reference race ref=${ref} ${actor} — transfer already recorded`,
      );
      return NextResponse.json(
        {
          ok: false,
          code: "payout_already_initiated",
          error: "A payout transfer is already recorded for this withdrawal — no second transfer was created.",
        },
        { status: 409 },
      );
    }
    const pgCode = (err as { code?: string } | null)?.code;
    const pgMessage = (err as { message?: string } | null)?.message;
    const cause = (err as { cause?: { message?: string; code?: string } } | null)?.cause;
    console.error(
      `[flexidata] admin withdrawal action failed ref=${ref} ${actor}` +
        (pgCode ? ` code=${pgCode}` : "") +
        (cause?.code ? ` cause=${cause.code}` : "") +
        (cause?.message ? ` — ${cause.message}` : pgMessage ? ` — ${pgMessage}` : ""),
      err,
    );
    return NextResponse.json(
      { ok: false, error: `Unable to process this withdrawal action. Please try again. (ref ${ref})` },
      { status: 500 },
    );
  }
}

/** Walk the Drizzle `cause` chain to the Postgres error (SQLSTATE + constraint). */
function pgDiagnostic(err: unknown): { code?: string; constraint?: string; message?: string } {
  let current = err as {
    code?: string;
    constraint?: string;
    message?: string;
    cause?: unknown;
  } | null;
  for (let depth = 0; current && depth < 6; depth++) {
    if (typeof current.code === "string" && current.code !== "") {
      return { code: current.code, constraint: current.constraint, message: current.message };
    }
    current = (current.cause ?? null) as typeof current;
  }
  return { message: (err as { message?: string } | null)?.message };
}

/**
 * Ensure the withdrawal_audit_logs table exists (additive self-heal).
 * This is the runtime equivalent of the migration. It creates the table
 * if missing, and is safe to call repeatedly.
 */
async function ensureWithdrawalAuditTable(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "withdrawal_audit_logs" (
        "id" serial PRIMARY KEY,
        "withdrawal_id" integer NOT NULL REFERENCES "withdrawal_requests"("id") ON DELETE CASCADE,
        "withdrawal_ref" varchar(40) NOT NULL,
        "event" varchar(40) NOT NULL,
        "previous_status" varchar(20),
        "new_status" varchar(20),
        "actor_type" varchar(20) NOT NULL DEFAULT 'system',
        "actor_id" integer,
        "actor_email" varchar(160),
        "provider_reference" varchar(120),
        "reason" varchar(240),
        "metadata" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Add indexes (IF NOT EXISTS is implicit for CREATE INDEX IF NOT EXISTS)
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "withdrawal_audit_logs_withdrawal_id_idx" ON "withdrawal_audit_logs" ("withdrawal_id")`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "withdrawal_audit_logs_withdrawal_ref_idx" ON "withdrawal_audit_logs" ("withdrawal_ref")`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "withdrawal_audit_logs_event_idx" ON "withdrawal_audit_logs" ("event")`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "withdrawal_audit_logs_created_at_idx" ON "withdrawal_audit_logs" ("created_at")`);
  } catch (error) {
    // If the constraint already exists, that's fine
    const msg = (error as { message?: string })?.message ?? "";
    if (!msg.includes("already exists")) {
      console.warn("[flexidata] withdrawal_audit_logs table creation note:", msg);
    }
  }
}
