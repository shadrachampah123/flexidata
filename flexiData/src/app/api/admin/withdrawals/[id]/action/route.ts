import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin/auth";
import { db } from "@/db";
import { withdrawalRequests, adminAuditLogs, transactions } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { ensureWithdrawalSchema } from "@/lib/seed";

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

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const ref = randomBytes(3).toString("hex").toUpperCase();
  try {
    // `requireAdminApi()` is the route-handler gate: it RETURNS the 404 every
    // other `/api/admin/**` route answers with. This handler used the page gate
    // (`requireAdmin()`), whose `notFound()` throw the catch below swallowed and
    // turned into a 500 — so a denied caller got "Internal Server Error" instead
    // of the identical 404 that keeps the admin area undiscoverable.
    const gate = await requireAdminApi();
    if (!gate.ok) return gate.response;
    const { admin } = gate.context;
    const { id } = await context.params;
    const { action, reason } = await req.json();

    if (!['approve', 'reject'].includes(action)) {
      return NextResponse.json({ ok: false, error: "Invalid action" }, { status: 400 });
    }

    const withdrawalId = parseInt(id, 10);
    // Same additive schema guard the withdrawal route uses, so an admin acting
    // on a database that never received the migration gets a real answer
    // instead of a 500 from the very first statement.
    await ensureWithdrawalSchema();
    const result = await db.transaction(async (tx) => {
      const [withdrawal] = await tx.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, withdrawalId)).for("update");
      if (!withdrawal) throw new WithdrawalActionError("Withdrawal request not found", 404);
      if (withdrawal.status !== "pending") {
        throw new WithdrawalActionError("Only pending requests can be modified", 409);
      }

      if (action === 'approve') {
        // Move to processing (ready for payout). For now, as per phase 3, we don't send real money.
        // We set status to processing, meaning it's approved and waiting for provider integration.
        await tx.update(withdrawalRequests)
          .set({ status: 'processing', adminUserId: admin.userId })
          .where(eq(withdrawalRequests.id, withdrawalId));
          
        await tx.update(transactions)
          .set({ status: 'successful' }) 
          .where(eq(transactions.ref, withdrawal.ref));

        await tx.insert(adminAuditLogs).values({
          adminUserId: admin.userId,
          targetUserId: withdrawal.userId,
          action: "approve_withdrawal",
          targetRef: withdrawal.ref,
        });

      } else if (action === 'reject') {
        // Reject and refund the user's wallet
        await tx.update(withdrawalRequests)
          .set({ status: 'rejected', adminUserId: admin.userId, adminRejectionReason: reason })
          .where(eq(withdrawalRequests.id, withdrawalId));

        // Refund wallet (atomic)
        await tx.execute(sql`UPDATE wallets SET balance = balance + ${withdrawal.amount} WHERE id = ${withdrawal.walletId}`);
        
        await tx.update(transactions)
          .set({ status: 'failed', providerMessage: reason })
          .where(eq(transactions.ref, withdrawal.ref));

        await tx.insert(adminAuditLogs).values({
          adminUserId: admin.userId,
          targetUserId: withdrawal.userId,
          action: "reject_withdrawal",
          reason: reason,
          targetRef: withdrawal.ref,
        });
      }
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
    const cause = (err as { cause?: { message?: string; code?: string } } | null)?.cause;
    console.error(
      `[flexidata] admin withdrawal action failed ref=${ref}` +
        (cause?.code ? ` cause=${cause.code}` : "") +
        (cause?.message ? ` — ${cause.message}` : ""),
      err,
    );
    return NextResponse.json(
      { ok: false, error: `Unable to process this withdrawal action. Please try again. (ref ${ref})` },
      { status: 500 },
    );
  }
}
