import { settleDeposit } from "@/app/api/wallet/fund/route";
import { verifyPaystackPayment } from "@/lib/payments";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/db";
import { depositRequests } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Called by the wallet page after returning from a Paystack checkout, and safe
 * to poll. Confirms the payment with Paystack, then settles the deposit
 * idempotently. In mock mode deposits settle immediately at init.
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: "Not signed in" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { ref?: string };
    const ref = (body.ref ?? "").trim();
    if (!ref) return Response.json({ ok: false, error: "Missing reference" }, { status: 400 });

    // Ownership check: the deposit must belong to this user's wallet.
    const rows = await db
      .select({ ref: depositRequests.ref, status: depositRequests.status, walletId: depositRequests.walletId })
      .from(depositRequests)
      .where(eq(depositRequests.ref, ref))
      .limit(1);
    const deposit = rows[0];
    if (!deposit) return Response.json({ ok: false, error: "Deposit not found" }, { status: 404 });

    if (deposit.status === "successful") {
      return Response.json({ ok: true, status: "successful", ref });
    }

    const { paid } = await verifyPaystackPayment(ref);
    if (!paid) {
      return Response.json({ ok: true, status: "pending", ref });
    }

    await settleDeposit(ref);
    return Response.json({ ok: true, status: "successful", ref });
  } catch (error) {
    console.error("verify error", error);
    return Response.json({ ok: false, error: "Verification failed" }, { status: 500 });
  }
}
