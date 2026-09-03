import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireAccount } from "@/lib/api-auth";
import { createDepositRequest, DepositInputError } from "@/lib/deposits";
import { isPaystackConfigured, PaystackConfigError, PaystackRequestError } from "@/lib/paystack";
import { paymentsProvider } from "@/lib/payments";
import { isMissingRelationError } from "@/lib/schema-compat";

export const dynamic = "force-dynamic";

type Body = { method?: string; amount?: number };

/**
 * Start a wallet deposit.
 *
 * All money-safety lives in `src/lib/deposits.ts`: the amount is validated and
 * recorded server-side (integer pesewas) before Paystack is called, and the
 * wallet is only ever credited by the idempotent, transactional settle path
 * shared by this route, /api/payments/verify and the Paystack webhook. The
 * Paystack secret key never appears here.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;
    const { wallet } = auth;

    // Real Paystack deposits need a configured key; mock mode never does.
    if (paymentsProvider() === "paystack" && !isPaystackConfigured()) {
      return Response.json(
        { ok: false, error: "Wallet funding is not available right now.", code: "paystack_unconfigured" },
        { status: 503 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const amount = Number(body.amount);

    const accountRows = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, auth.userId))
      .limit(1);
    const email = accountRows[0]?.email ?? `${wallet.number}@flexidata.app`;

    const result = await createDepositRequest({
      walletId: wallet.id,
      walletNumber: wallet.number,
      email,
      method: body.method ?? "",
      amountGhs: amount,
    });

    if (result.status === "pending") {
      // Real gateway (Paystack): hand the browser the hosted checkout URL.
      return Response.json({
        ok: true,
        status: "pending",
        ref: result.ref,
        authorizationUrl: result.authorizationUrl,
        provider: result.provider,
      });
    }

    // Mock (instant) settlement — already credited atomically.
    return Response.json({
      ok: true,
      status: "successful",
      ref: result.ref,
      balance: result.balance,
      method: result.methodLabel,
      provider: result.provider,
    });
  } catch (error) {
    if (error instanceof DepositInputError) {
      return Response.json({ ok: false, error: error.message }, { status: 400 });
    }
    if (error instanceof PaystackConfigError) {
      console.error("fund config error:", error.message);
      return Response.json(
        { ok: false, error: "Wallet funding is not available right now.", code: "paystack_unconfigured" },
        { status: 503 },
      );
    }
    if (error instanceof PaystackRequestError) {
      console.error("fund init error:", error.message);
      return Response.json(
        { ok: false, error: "Could not start the payment. Please try again.", code: "paystack_init_failed" },
        { status: 502 },
      );
    }
    if (isMissingRelationError(error)) {
      console.error("fund schema error: deposit_requests table missing — run `npx drizzle-kit push`.");
      return Response.json(
        { ok: false, error: "Wallet funding is being upgraded. Please try again shortly.", code: "schema_out_of_date" },
        { status: 503 },
      );
    }
    console.error("fund error", error);
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Something went wrong" },
      { status: 500 },
    );
  }
}
