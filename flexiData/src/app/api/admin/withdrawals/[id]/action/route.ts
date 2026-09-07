import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/auth";
import { db } from "@/db";
import { withdrawalRequests, adminAuditLogs, transactions } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin();
    const { admin } = auth;
    const { id } = await context.params;
    const { action, reason } = await req.json();

    if (!['approve', 'reject'].includes(action)) {
      return NextResponse.json({ ok: false, error: "Invalid action" }, { status: 400 });
    }

    const withdrawalId = parseInt(id, 10);
    const result = await db.transaction(async (tx) => {
      const [withdrawal] = await tx.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, withdrawalId)).for("update");
      if (!withdrawal) throw new Error("Not found");
      if (withdrawal.status !== "pending") throw new Error("Only pending requests can be modified");

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
  } catch (err: any) {
    console.error("Admin action error:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
