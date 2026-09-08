import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/api-auth";
import { db } from "@/db";
import { withdrawalRequests } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { ensureWithdrawalSchema } from "@/lib/seed";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

/**
 * GET /api/wallet/withdrawals
 *
 * The signed-in user's own withdrawal history. Returns all withdrawals
 * for the user's wallet, most recent first.
 */
export async function GET() {
  const auth = await requireAccount();
  if (!auth.ok) return auth.response;

  await ensureWithdrawalSchema();

  const withdrawals = await db
    .select({
      id: withdrawalRequests.id,
      ref: withdrawalRequests.ref,
      amount: withdrawalRequests.amount,
      fee: withdrawalRequests.fee,
      netAmount: withdrawalRequests.netAmount,
      status: withdrawalRequests.status,
      destinationMethod: withdrawalRequests.destinationMethod,
      destinationDetails: withdrawalRequests.destinationDetails,
      providerReference: withdrawalRequests.providerReference,
      providerStatus: withdrawalRequests.providerStatus,
      createdAt: withdrawalRequests.createdAt,
      processedAt: withdrawalRequests.processedAt,
      completedAt: withdrawalRequests.completedAt,
      rejectionReason: withdrawalRequests.adminRejectionReason,
      currency: withdrawalRequests.currency,
    })
    .from(withdrawalRequests)
    .where(eq(withdrawalRequests.walletId, auth.wallet.id))
    .orderBy(desc(withdrawalRequests.createdAt))
    .limit(50);

  return NextResponse.json(
    {
      ok: true,
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        ref: w.ref,
        amount: Number(w.amount),
        fee: Number(w.fee),
        netAmount: Number(w.netAmount),
        status: w.status,
        method: w.destinationMethod,
        destination: (w.destinationDetails as { account?: string })?.account ?? "",
        network: (w.destinationDetails as { network?: string })?.network ?? "",
        providerReference: w.providerReference,
        createdAt: w.createdAt?.toISOString(),
        processedAt: w.processedAt?.toISOString() ?? null,
        completedAt: w.completedAt?.toISOString() ?? null,
        rejectionReason: w.rejectionReason ?? null,
      })),
    },
    { headers: NO_STORE },
  );
}
