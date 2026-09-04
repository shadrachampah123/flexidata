import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireAccount } from "@/lib/api-auth";
import { createDepositRequest, DepositInputError } from "@/lib/deposits";
import { requestOrigin } from "@/lib/notifications";
import { isPaystackConfigured, PaystackConfigError, PaystackRequestError } from "@/lib/paystack";
import { paymentsProvider } from "@/lib/payments";
import { isMissingRelationError } from "@/lib/schema-compat";

export const dynamic = "force-dynamic";

type Body = { method?: string; amount?: number; source?: string };

/**
 * Start a wallet deposit.
 *
 * All money-safety lives in `src/lib/deposits.ts`: the amount is validated and
 * recorded server-side (integer pesewas) before Paystack is called, and the
 * wallet is only ever credited by the idempotent, transactional settle path
 * shared by this route, /api/payments/verify and the Paystack webhook. The
 * Paystack secret key never appears here.
 *
 * The wallet that gets credited is always the signed-in user's own
 * (`auth.wallet`), resolved from the session — never from the request body, so
 * a caller cannot aim a deposit at somebody else's wallet.
 */
export async function POST(req: Request) {
  try {
    // Fail-closed production lock: the wallet must never be funded through the
    // mock provider, and a missing Paystack key must never fall back to mock.
    // Checked before authentication so the endpoint cannot be used to create
    // wallet funds in an improperly configured production runtime at all.
    if (process.env.NODE_ENV === "production") {
      try {
        // Belt: `paymentsProvider()` throws on a production lockout
        // (PAYMENTS_PROVIDER=mock, or no Paystack key configured).
        const provider = paymentsProvider();
        // Braces: even if provider resolution ever changed to return a
        // non-Paystack gateway instead of throwing, demo/mock funding is
        // refused outright here — before auth, before any DB write.
        if (provider !== "paystack") {
          console.error(`fund production lockout: resolved provider "${provider}" is not paystack`);
          return Response.json(
            { ok: false, error: "Wallet funding is not available right now.", code: "demo_funding_disabled" },
            { status: 503 },
          );
        }
      } catch (error) {
        if (error instanceof PaystackConfigError) {
          console.error(
            `fund production lockout: ${error.message}`,
          );
          return Response.json(
            { ok: false, error: "Wallet funding is not available right now.", code: "paystack_unconfigured" },
            { status: 503 },
          );
        }
        throw error;
      }
    }

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
    // The public origin this request arrived on (forwarding headers first, the
    // way the password-reset links resolve it) — used for Paystack's callback
    // URL when APP_BASE_URL is not set, so the customer lands back on THIS
    // deployment's wallet page after paying.
    const origin = requestOrigin(req);

    const result = await createDepositRequest({
      walletId: wallet.id,
      walletNumber: wallet.number,
      email,
      method: body.method ?? "",
      amountGhs: amount,
      // Metadata hint only — Paystack's hosted checkout collects (and debits)
      // the mobile-money wallet itself; nothing here can move money.
      momoNumber: typeof body.source === "string" ? body.source : null,
      requestOrigin: origin,
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
      { ok: false, error: "Wallet funding failed unexpectedly. Please try again.", code: "fund_failed" },
      { status: 500 },
    );
  }
}
