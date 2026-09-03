import { eq } from "drizzle-orm";
import { db } from "@/db";
import { wallets } from "@/db/schema";
import { requireAccount } from "@/lib/api-auth";
import { getDeposit, toDepositSummary } from "@/lib/deposits";
import { isMissingRelationError } from "@/lib/schema-compat";

export const dynamic = "force-dynamic";

/**
 * Read-only deposit status for the signed-in owner.
 *
 * Returns the current state of a single deposit reference. It NEVER triggers
 * settlement or calls Paystack — money movement is owned exclusively by
 * POST /api/payments/verify and the webhook (see src/lib/deposits.ts) — so this
 * endpoint is safe for the wallet UI to poll freely.
 *
 * Ownership is enforced: a deposit that does not exist OR belongs to another
 * wallet returns the same 404, so this endpoint can never be used to probe or
 * expose another user's deposit information.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;

    const url = new URL(req.url);
    const ref = (url.searchParams.get("ref") ?? "").trim();
    if (!ref) {
      return Response.json({ ok: false, error: "Missing reference" }, { status: 400 });
    }

    const deposit = await getDeposit(ref);
    // Identical response for "not found" and "not yours" — no oracle.
    if (!deposit || deposit.walletId !== auth.wallet.id) {
      return Response.json({ ok: false, error: "Deposit not found" }, { status: 404 });
    }

    // Fresh balance so the client can show the credited total after settlement.
    const walletRows = await db
      .select({ balance: wallets.balance })
      .from(wallets)
      .where(eq(wallets.id, auth.wallet.id))
      .limit(1);
    const balance = Number(walletRows[0]?.balance ?? auth.wallet.balance);

    const summary = toDepositSummary(deposit);
    return Response.json(
      {
        ok: true,
        deposit: {
          ...summary,
          balance: summary.status === "successful" ? balance : undefined,
        },
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    if (isMissingRelationError(error)) {
      return Response.json(
        { ok: false, error: "Wallet funding is being upgraded. Please try again shortly.", code: "schema_out_of_date" },
        { status: 503 },
      );
    }
    console.error("deposit status error", error);
    return Response.json({ ok: false, error: "Could not load deposit status" }, { status: 500 });
  }
}
