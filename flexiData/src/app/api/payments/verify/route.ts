import { eq } from "drizzle-orm";
import { db } from "@/db";
import { wallets } from "@/db/schema";
import { requireAccount } from "@/lib/api-auth";
import { getDeposit, reconcileDeposit } from "@/lib/deposits";
import { PaystackConfigError, PaystackRequestError } from "@/lib/paystack";
import { isMissingRelationError } from "@/lib/schema-compat";

export const dynamic = "force-dynamic";

/**
 * Called by the wallet page after returning from a Paystack checkout, and safe
 * to poll. Confirms the payment directly with Paystack — the redirect itself
 * proves nothing — then settles the deposit idempotently (reference + exact
 * pesewa amount + currency are checked inside `reconcileDeposit`). Scoped to
 * the signed-in owner of the deposit; responses carry only public state.
 *
 * In mock mode deposits settle immediately at init, so this is a harmless
 * no-op success there.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => ({}))) as { ref?: string };
    const ref = (body.ref ?? "").trim();
    if (!ref) return Response.json({ ok: false, error: "Missing reference" }, { status: 400 });

    const deposit = await getDeposit(ref);
    if (!deposit || deposit.walletId !== auth.wallet.id) {
      // Same response for "not yours" and "does not exist".
      return Response.json({ ok: false, error: "Deposit not found" }, { status: 404 });
    }

    const summary = await reconcileDeposit(ref);
    if (!summary) return Response.json({ ok: false, error: "Deposit not found" }, { status: 404 });

    // Re-read the balance AFTER settling so the client shows the credited total.
    const walletRows = await db
      .select({ balance: wallets.balance })
      .from(wallets)
      .where(eq(wallets.id, auth.wallet.id))
      .limit(1);
    const balance = Number(walletRows[0]?.balance ?? auth.wallet.balance);

    return Response.json(
      {
        ok: true,
        status: summary.status,
        ref: summary.ref,
        amount: summary.amount,
        balance: summary.status === "successful" ? balance : undefined,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    if (error instanceof PaystackConfigError || error instanceof PaystackRequestError) {
      console.error("deposit verify error:", error.message);
      return Response.json(
        { ok: false, error: "Could not confirm the payment yet. Please try again in a moment.", code: "verify_unavailable" },
        { status: 502 },
      );
    }
    if (isMissingRelationError(error)) {
      return Response.json(
        { ok: false, error: "Wallet funding is being upgraded. Please try again shortly.", code: "schema_out_of_date" },
        { status: 503 },
      );
    }
    console.error("verify error", error);
    return Response.json({ ok: false, error: "Verification failed" }, { status: 500 });
  }
}
