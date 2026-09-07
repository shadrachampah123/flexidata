import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin/auth";
import { db } from "@/db";
import { wallets, withdrawalRequests, adminAuditLogs, transactions } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { ensureWithdrawalSchema, ensureAdminAuditActions } from "@/lib/seed";

export const dynamic = "force-dynamic";

/** Operational refusals: an answer, not a fault. */
class WithdrawalActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
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
    const body = (await req.json().catch(() => ({}))) as { action?: string; reason?: string };
    const { action } = body;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";

    if (!["approve", "reject"].includes(action ?? "")) {
      return NextResponse.json({ ok: false, error: "Invalid action" }, { status: 400 });
    }

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
      if (withdrawal.status !== "pending") {
        throw new WithdrawalActionError("Only pending requests can be modified", 409);
      }

      if (action === "approve") {
        // Move to processing (ready for payout). For now, as per phase 3, we
        // don't send real money. We set status to processing, meaning it's
        // approved and waiting for provider integration. The gross amount was
        // already deducted from the wallet when the request was created, so
        // approve moves no money.
        await tx
          .update(withdrawalRequests)
          .set({ status: "processing", adminUserId: admin.userId, updatedAt: new Date() })
          .where(eq(withdrawalRequests.id, withdrawalId));

        await tx
          .update(transactions)
          .set({ status: "successful" })
          .where(eq(transactions.ref, withdrawal.ref));

        await tx.insert(adminAuditLogs).values({
          adminUserId: admin.userId,
          targetUserId: withdrawal.userId,
          action: "approve_withdrawal",
          targetRef: withdrawal.ref,
        });
      } else {
        // 2. Lock the user's wallet row before refunding, so concurrent money
        //    operations on the same wallet serialize behind this transaction.
        const [lockedWallet] = await tx
          .select({ id: wallets.id })
          .from(wallets)
          .where(eq(wallets.id, withdrawal.walletId))
          .for("update");
        if (!lockedWallet) {
          // Cannot happen while the FK holds (the wallet row owns the
          // withdrawal); if it ever does, this is a fault — roll back.
          throw new Error(`wallet ${withdrawal.walletId} not found for withdrawal ${withdrawal.ref}`);
        }

        // 3. Refund EXACTLY what the request deducted. `POST /api/wallet/withdraw`
        //    deducts the GROSS amount (`withdrawal_requests.amount`, e.g.
        //    GH₵ 5.00 — not the GH₵ 4.90 net of the fee), so the reversal adds
        //    the same gross figure back. No new calculation is invented here.
        await tx
          .update(wallets)
          .set({ balance: sql`${wallets.balance} + ${withdrawal.amount}` })
          .where(eq(wallets.id, withdrawal.walletId));

        // 4. Ledger/accounting entry: the `withdrawal` ledger row that was
        //    created as `pending` when the request was made becomes `failed`,
        //    carrying the operator's reason.
        await tx
          .update(transactions)
          .set({ status: "failed", providerMessage: reason })
          .where(eq(transactions.ref, withdrawal.ref));

        // 5. Only now mark the withdrawal itself rejected. Still inside the
        //    same transaction: if anything below fails, the refund, the ledger
        //    row and this status change all roll back together.
        await tx
          .update(withdrawalRequests)
          .set({
            status: "rejected",
            adminUserId: admin.userId,
            adminRejectionReason: reason,
            updatedAt: new Date(),
          })
          .where(eq(withdrawalRequests.id, withdrawalId));

        // 6. Admin audit trail. The widened `admin_audit_logs_action_check`
        //    (drizzle/0006 + 0007 / `ensureAdminAuditActions`) admits
        //    `reject_withdrawal`; the partial unique index on
        //    (target_ref, action) additionally makes a replayed audit insert
        //    impossible even if the status guard above were ever bypassed.
        await tx.insert(adminAuditLogs).values({
          adminUserId: admin.userId,
          targetUserId: withdrawal.userId,
          action: "reject_withdrawal",
          reason: reason,
          targetRef: withdrawal.ref,
        });
      }
      // 7. COMMIT — db.transaction commits here; any throw above rolled back
      //    every step (no partial refund, no partial rejection).
      return { ok: true };
    });

    return NextResponse.json(result);
  } catch (err: unknown) {
    if (err instanceof WithdrawalActionError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    // Never echo `err.message` back: it is the driver's text (SQL fragments,
    // constraint and column names). Log the real cause with a correlation id
    // and answer with something an operator can act on.
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
