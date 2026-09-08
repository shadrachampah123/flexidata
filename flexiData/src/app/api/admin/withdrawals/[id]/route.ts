import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin/auth";
import { db } from "@/db";
import { withdrawalRequests, users, wallets, transactions, withdrawalAuditLogs } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

/**
 * GET /api/admin/withdrawals/[id]
 *
 * Detailed withdrawal info including audit trail.
 */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const { id } = await context.params;
  const withdrawalId = parseInt(id, 10);
  if (!Number.isInteger(withdrawalId) || withdrawalId <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid withdrawal id" }, { status: 400 });
  }

  // Fetch the withdrawal with user/wallet info
  const [withdrawal] = await db
    .select({
      id: withdrawalRequests.id,
      ref: withdrawalRequests.ref,
      userId: withdrawalRequests.userId,
      walletId: withdrawalRequests.walletId,
      amount: withdrawalRequests.amount,
      fee: withdrawalRequests.fee,
      netAmount: withdrawalRequests.netAmount,
      status: withdrawalRequests.status,
      destinationMethod: withdrawalRequests.destinationMethod,
      destinationDetails: withdrawalRequests.destinationDetails,
      adminUserId: withdrawalRequests.adminUserId,
      adminRejectionReason: withdrawalRequests.adminRejectionReason,
      idempotencyKey: withdrawalRequests.idempotencyKey,
      providerReference: withdrawalRequests.providerReference,
      providerStatus: withdrawalRequests.providerStatus,
      providerMessage: withdrawalRequests.providerMessage,
      processedAt: withdrawalRequests.processedAt,
      completedAt: withdrawalRequests.completedAt,
      currency: withdrawalRequests.currency,
      createdAt: withdrawalRequests.createdAt,
      updatedAt: withdrawalRequests.updatedAt,
      userEmail: users.email,
      userName: users.name,
      userPhone: users.phone,
      walletNumber: wallets.number,
      walletBalance: wallets.balance,
    })
    .from(withdrawalRequests)
    .leftJoin(users, eq(withdrawalRequests.userId, users.id))
    .leftJoin(wallets, eq(withdrawalRequests.walletId, wallets.id))
    .where(eq(withdrawalRequests.id, withdrawalId))
    .limit(1);

  if (!withdrawal) {
    return NextResponse.json({ ok: false, error: "Withdrawal not found" }, { status: 404, headers: NO_STORE });
  }

  // Fetch the audit trail
  let auditTrail: unknown[] = [];
  try {
    auditTrail = await db
      .select()
      .from(withdrawalAuditLogs)
      .where(eq(withdrawalAuditLogs.withdrawalId, withdrawalId))
      .orderBy(withdrawalAuditLogs.createdAt);
  } catch {
    // Table might not exist yet on un-migrated databases
    auditTrail = [];
  }

  // Fetch the ledger row
  const [ledgerRow] = await db
    .select({
      ref: transactions.ref,
      status: transactions.status,
      amount: transactions.amount,
      createdAt: transactions.createdAt,
      providerMessage: transactions.providerMessage,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.ref, withdrawal.ref),
        eq(transactions.walletId, withdrawal.walletId),
        eq(transactions.type, "withdrawal"),
      ),
    )
    .limit(1);

  return NextResponse.json(
    {
      ok: true,
      withdrawal,
      auditTrail,
      ledger: ledgerRow || null,
    },
    { headers: NO_STORE },
  );
}
